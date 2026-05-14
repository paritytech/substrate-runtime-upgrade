import core from '@actions/core';
import { createClient, getSs58AddressInfo } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getPolkadotSigner } from '@polkadot-api/signer';
import { Bytes } from '@polkadot-api/substrate-bindings';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, blake2AsU8a, encodeAddress } from '@polkadot/util-crypto';
import { u8aEq, u8aToHex, hexToU8a } from '@polkadot/util';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const downloadFile = async (url, outputPath) => {
  console.log(`Downloading file from ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  fs.writeFileSync(outputPath, new Uint8Array(await res.arrayBuffer()));
  console.log(`Downloaded to: ${outputPath}`);
};

function getSpecVersion(chainInfo) {
  const match = chainInfo.match(/🔥 Core version:\s+([a-zA-Z0-9-]+)-(\d+)/);
  return {
    version: match ? parseInt(match[2]) : null,
    chain: match ? match[1] : null,
  };
}

async function connectChain(url) {
  const provider = getWsProvider(url);
  const client = createClient(provider);
  const api = client.getUnsafeApi();
  return { url, client, api };
}

function ss58ToPublicKey(addressOrHex) {
  if (typeof addressOrHex === 'string' && addressOrHex.startsWith('0x')) {
    return hexToU8a(addressOrHex);
  }
  const info = getSs58AddressInfo(addressOrHex);
  if (!info.isValid) throw new Error(`Invalid SS58 address: ${addressOrHex}`);
  return info.publicKey;
}

async function rawRpc(client, method, params = []) {
  return new Promise((resolve, reject) => {
    client._request(method, params, { onSuccess: resolve, onError: reject });
  });
}

async function validateTransaction(client, txBytes) {
  const finalized = await rawRpc(client, 'chain_getFinalizedHead', []);
  const txSource = new Uint8Array([2]);
  const txEnc = Bytes(txBytes.length).enc(txBytes);
  const blockHashBytes = hexToU8a(finalized);
  const callData = u8aToHex(new Uint8Array([...txSource, ...txEnc, ...blockHashBytes]));
  return rawRpc(client, 'state_call', [
    'TaggedTransactionQueue_validate_transaction', callData, finalized,
  ]);
}

function interpretValidateResult(resultHex) {
  if (!resultHex || resultHex === '0x') return { ok: false, reason: 'empty response' };
  if (resultHex.startsWith('0x00')) return { ok: true };
  if (resultHex === '0x010003') return { ok: true, reason: 'stale nonce (encoding+signature accepted)' };
  return { ok: false, reason: `runtime rejected: ${resultHex}` };
}

async function waitForAuthorizedUpgrade(api, expectedCodeHashHex, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = await api.query.System.AuthorizedUpgrade.getValue();
    if (pending) {
      const actualHex = pending.code_hash?.asHex
        ? pending.code_hash.asHex()
        : u8aToHex(pending.code_hash);
      if (actualHex === expectedCodeHashHex) return true;
      throw new Error(`authorizedUpgrade hash mismatch on chain: got ${actualHex}, expected ${expectedCodeHashHex}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function buildXcmRelayCall(relayApi, targetApi, codeHashHex) {
  const innerEncoded = await targetApi.tx.System.authorize_upgrade({ code_hash: codeHashHex }).getEncodedData();
  const paraId = await targetApi.query.ParachainInfo.ParachainId.getValue();
  const dest = {
    type: 'V4',
    value: { parents: 0, interior: { type: 'X1', value: [{ type: 'Parachain', value: paraId }] } },
  };
  const message = {
    type: 'V4',
    value: [
      { type: 'UnpaidExecution', value: { weight_limit: { type: 'Unlimited' }, check_origin: undefined } },
      {
        type: 'Transact',
        value: {
          origin_kind: { type: 'Superuser' },
          require_weight_at_most: { ref_time: 1_000_000_000n, proof_size: 100_000n },
          call: innerEncoded,
        },
      },
    ],
  };
  return relayApi.tx.XcmPallet.send({ dest, message });
}

async function main() {
  try {
    await cryptoWaitReady();

    const targetChainUrl = core.getInput('targetChainUrl');
    const accountSecret = core.getInput('account');
    const relaychainUrl = core.getInput('relaychainUrl');
    const dryRun = core.getBooleanInput('dryRun');

    let wasmPath = core.getInput('wasmPath');
    let currentRuntimeSpec = null;
    let newRuntimeSpec = null;

    console.log(`Connecting to target chain ${targetChainUrl}`);
    const target = await connectChain(targetChainUrl);
    const targetVersion = await target.api.constants.System.Version();
    currentRuntimeSpec = { version: targetVersion.spec_version, chain: targetVersion.spec_name };
    console.log(`Current runtime: specName=${currentRuntimeSpec.chain}, specVersion=${currentRuntimeSpec.version}`);

    try {
      if (wasmPath.startsWith('http')) {
        const filename = path.basename(new URL(wasmPath).pathname);
        wasmPath = path.join(__dirname, filename);
        await downloadFile(core.getInput('wasmPath'), wasmPath);
      }
      if (!fs.existsSync(wasmPath)) {
        throw new Error(`WASM file not found: ${wasmPath}`);
      }
      try {
        const wasmInfo = execSync(`subwasm info ${wasmPath}`, { encoding: 'utf-8' });
        console.log("New runtime info:\n", wasmInfo);
        newRuntimeSpec = getSpecVersion(wasmInfo);
      } catch (err) {
        console.warn('Warning: subwasm info failed:', err.message);
      }
    } catch (err) {
      console.log('::error:: ' + err.message);
      process.exit(1);
    }

    if (currentRuntimeSpec && newRuntimeSpec) {
      if (currentRuntimeSpec.chain !== newRuntimeSpec.chain) {
        console.log(`::error:: Invalid spec name: expected '${currentRuntimeSpec.chain}', got '${newRuntimeSpec.chain}'`);
        process.exit(1);
      }
      if (currentRuntimeSpec.version >= newRuntimeSpec.version) {
        console.log(`::error:: Invalid version, new version should be greater: old: ${currentRuntimeSpec.version}, new: ${newRuntimeSpec.version}`);
        process.exit(1);
      }
      console.log(`Spec Version: ${currentRuntimeSpec.version} -> ${newRuntimeSpec.version}`);
    }

    console.log('Reading WASM file...');
    const wasmCode = fs.readFileSync(wasmPath);
    const codeHashBytes = blake2AsU8a(wasmCode, 256);
    const codeHashHex = u8aToHex(codeHashBytes);
    console.log(`New runtime code hash: ${codeHashHex}`);

    let manager = target;
    if (relaychainUrl) {
      console.log(`Connecting to manager (relay) chain ${relaychainUrl}`);
      manager = await connectChain(relaychainUrl);
    }

    let signer = null;
    let signerAddress = null;
    let signerPubKey = null;
    let isProxySudo = false;
    let sudoKeyAddress = null;
    let sudoKeyPubKey = null;
    if (accountSecret) {
      const pair = new Keyring({ type: 'sr25519' }).addFromUri(accountSecret);
      signerAddress = pair.address;
      signerPubKey = pair.publicKey;
      signer = getPolkadotSigner(pair.publicKey, 'Sr25519', async (bytes) => pair.sign(bytes));
      console.log(`Using account: ${signerAddress}`);

      sudoKeyAddress = await manager.api.query.Sudo.Key.getValue();
      if (!sudoKeyAddress) {
        core.setFailed('Sudo key is not set on the chain (sudo pallet may have been removed).');
        process.exit(1);
      }
      sudoKeyPubKey = ss58ToPublicKey(sudoKeyAddress);
      console.log(`Sudo key on chain: ${encodeAddress(sudoKeyPubKey, 42)}`);

      const isSudo = u8aEq(signerPubKey, sudoKeyPubKey);
      console.log(`Is account sudo: ${isSudo}`);
      if (!isSudo) {
        const [delegates] = await manager.api.query.Proxy.Proxies.getValue(sudoKeyAddress);
        isProxySudo = (delegates || []).some(d => u8aEq(ss58ToPublicKey(d.delegate), signerPubKey));
        console.log(`Is account proxy for sudo: ${isProxySudo}`);
      }
      if (!isSudo && !isProxySudo) {
        core.setFailed('Key does not have permission to update the runtime (not sudo or proxy for sudo).');
        process.exit(1);
      }
    } else {
      console.log('::warning:: Account is not set');
    }

    let submitUpgradeCall = true;
    const existing = await target.api.query.System.AuthorizedUpgrade.getValue();
    if (existing) {
      const existingHex = existing.code_hash?.asHex
        ? existing.code_hash.asHex()
        : u8aToHex(existing.code_hash);
      if (existingHex === codeHashHex) {
        console.log('Upgrade call already submitted, skipping authorize step...');
        submitUpgradeCall = false;
      } else {
        console.log(`::error:: Another runtime is already waiting to be applied (${existingHex})`);
        process.exit(1);
      }
    }

    if (submitUpgradeCall) {
      let tx;
      if (relaychainUrl) {
        const xcmCall = await buildXcmRelayCall(manager.api, target.api, codeHashHex);
        tx = manager.api.tx.Sudo.sudo({ call: xcmCall.decodedCall });
      } else {
        const inner = target.api.tx.System.authorize_upgrade({ code_hash: codeHashHex });
        tx = manager.api.tx.Sudo.sudo({ call: inner.decodedCall });
      }

      if (isProxySudo) {
        tx = manager.api.tx.Proxy.proxy({
          real: { type: 'Id', value: sudoKeyAddress },
          force_proxy_type: undefined,
          call: tx.decodedCall,
        });
      }

      const encoded = await tx.getEncodedData();
      const encodedHex = u8aToHex(encoded);
      console.log(`upgradeCall: ${encodedHex}`);

      if (!signer) {
        console.log(`::notice:: No account key is provided. Submit manually: ${encodedHex}`);
        process.exit(1);
      }

      if (dryRun) {
        const txBytes = await tx.sign(signer);
        console.log('DRY RUN: validating signed authorizeUpgrade via TaggedTransactionQueue_validate_transaction...');
        const resultHex = await validateTransaction(manager.client, txBytes);
        const verdict = interpretValidateResult(resultHex);
        console.log(`  validate_transaction result: ${resultHex}`);
        if (!verdict.ok) {
          core.setFailed(`Dry-run validation failed: ${verdict.reason}`);
          process.exit(1);
        }
        console.log(`  Runtime accepted the extrinsic${verdict.reason ? ` (${verdict.reason})` : ''}`);
      } else {
        console.log('Submitting authorizeUpgrade extrinsic and waiting for finalization...');
        const result = await tx.signAndSubmit(signer);
        if (!result.ok) {
          core.setFailed(`authorizeUpgrade failed in block ${result.block.hash}: ${JSON.stringify(result.dispatchError)}`);
          process.exit(1);
        }
        console.log(`authorizeUpgrade finalized in block ${result.block.hash} (#${result.block.number}), tx index ${result.block.index}`);
      }
    }

    if (dryRun) {
      console.log('DRY RUN: Skip submitting applyAuthorizedUpgrade extrinsic (unsigned)...');
    } else {
      console.log('Waiting for chain to receive AuthorizedUpgrade event (5m)...');
      const ok = await waitForAuthorizedUpgrade(target.api, codeHashHex, 5 * 60 * 1000);
      if (!ok) {
        core.setFailed('Timeout, chain did not receive system.authorizedUpgrade message');
        process.exit(1);
      }

      console.log('Submitting applyAuthorizedUpgrade extrinsic (unsigned)...');
      const applyTx = target.api.tx.System.apply_authorized_upgrade({ code: new Uint8Array(wasmCode) });
      const wireBytes = await applyTx.getBareTx();
      const wireHex = u8aToHex(wireBytes);
      const txHash = await rawRpc(target.client, 'author_submitExtrinsic', [wireHex]);
      console.log(`applyAuthorizedUpgrade submitted, txHash: ${txHash}`);
      console.log('Runtime upgrade successfully submitted.');
    }

    process.exit(0);
  } catch (error) {
    core.setFailed(`Action failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}

main();
