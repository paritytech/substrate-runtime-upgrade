import core from '@actions/core';
import { getWsProvider } from '@polkadot-api/ws-provider';
import { createClient } from '@polkadot-api/substrate-client';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import * as scale from '@polkadot-api/substrate-bindings';
import { Binary } from 'polkadot-api';
import { getPolkadotSigner } from '@polkadot-api/signer';
import { Keyring } from '@polkadot/keyring';
import { blake2AsU8a, encodeAddress } from '@polkadot/util-crypto';
import { u8aEq, u8aToHex, hexToU8a, u8aConcat } from '@polkadot/util';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import axios from 'axios';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const downloadFile = async (url, outputPath) => {
  console.log(`Downloading file from ${url}...`);
  const response = await axios({ url, method: 'GET', responseType: 'arraybuffer' });
  fs.writeFileSync(outputPath, response.data);
  console.log(`Downloaded to: ${outputPath}`);
};

function getSpecVersion(chainInfo) {
  const match = chainInfo.match(/🔥 Core version:\s+([a-zA-Z0-9-]+)-(\d+)/);
  return {
    version: match ? parseInt(match[2]) : null,
    chain: match ? match[1] : null,
  };
}

function rpcCall(client, method, params = []) {
  return new Promise((resolve, reject) => {
    client._request(method, params, { onSuccess: resolve, onError: reject });
  });
}

async function connectChain(url) {
  const provider = getWsProvider(url);
  const client = createClient(provider);
  const metadataHex = await rpcCall(client, 'state_getMetadata', []);
  const metadataBytes = hexToU8a(metadataHex);
  const decoded = decAnyMetadata(metadataBytes);
  const metadata = unifyMetadata(decoded);
  const lookupFn = getLookupFn(metadata);
  const builder = getDynamicBuilder(lookupFn);
  return { url, client, metadata, metadataBytes, lookupFn, builder };
}

async function chainState(chain) {
  const runtimeVersion = await rpcCall(chain.client, 'state_getRuntimeVersion', []);
  const genesisHashHex = await rpcCall(chain.client, 'chain_getBlockHash', ['0x0']);
  const finalizedHashHex = await rpcCall(chain.client, 'chain_getFinalizedHead', []);
  const finalizedHeader = await rpcCall(chain.client, 'chain_getHeader', [finalizedHashHex]);
  const finalizedNumber = parseInt(finalizedHeader.number, 16);
  return {
    specVersion: runtimeVersion.specVersion,
    transactionVersion: runtimeVersion.transactionVersion,
    specName: runtimeVersion.specName,
    genesisHashHex,
    genesisHash: hexToU8a(genesisHashHex),
    finalizedHashHex,
    finalizedHash: hexToU8a(finalizedHashHex),
    finalizedNumber,
  };
}

async function readStorage(chain, palletName, itemName) {
  const palletHash = u8aToHex(scale.Twox128(new TextEncoder().encode(palletName))).slice(2);
  const itemHash = u8aToHex(scale.Twox128(new TextEncoder().encode(itemName))).slice(2);
  const key = '0x' + palletHash + itemHash;
  const value = await rpcCall(chain.client, 'state_getStorage', [key]);
  return value ? hexToU8a(value) : null;
}

async function readSudoKey(chain) {
  const bytes = await readStorage(chain, 'Sudo', 'Key');
  if (!bytes) return null;
  return bytes.length === 33 ? bytes.slice(1) : bytes;
}

async function getAccountNonce(chain, accountPubKey) {
  const palletHash = u8aToHex(scale.Twox128(new TextEncoder().encode('System'))).slice(2);
  const itemHash = u8aToHex(scale.Twox128(new TextEncoder().encode('Account'))).slice(2);
  const accountHash = u8aToHex(scale.Blake2128Concat(accountPubKey)).slice(2);
  const key = '0x' + palletHash + itemHash + accountHash;
  const raw = await rpcCall(chain.client, 'state_getStorage', [key]);
  if (!raw) return 0;
  const bytes = hexToU8a(raw);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

async function readProxies(chain, sudoPubKey) {
  const palletHash = u8aToHex(scale.Twox128(new TextEncoder().encode('Proxy'))).slice(2);
  const itemHash = u8aToHex(scale.Twox128(new TextEncoder().encode('Proxies'))).slice(2);
  const accountHash = u8aToHex(scale.Twox64Concat(sudoPubKey)).slice(2);
  const key = '0x' + palletHash + itemHash + accountHash;
  const raw = await rpcCall(chain.client, 'state_getStorage', [key]);
  if (!raw) return [];
  const bytes = hexToU8a(raw);
  const proxies = [];
  let offset = 0;
  const len = bytes[offset];
  offset += 1;
  const numProxies = len >> 2;
  for (let i = 0; i < numProxies; i++) {
    proxies.push(bytes.slice(offset, offset + 32));
    offset += 32;
    while (offset < bytes.length && bytes[offset] !== undefined && offset < (1 + 32 * (i + 1) + (i + 1))) {
      offset++;
    }
  }
  return proxies;
}

function buildSignedExtensions(chain, runtime, nonce) {
  const exts = chain.metadata.extrinsic.signedExtensions[0]
    ?? Object.values(chain.metadata.extrinsic.signedExtensions)[0];
  const out = {};
  const empty = new Uint8Array(0);
  for (const ext of exts) {
    let value, additionalSigned;
    switch (ext.identifier) {
      case 'CheckSpecVersion':
        value = empty;
        additionalSigned = scale.u32.enc(runtime.specVersion);
        break;
      case 'CheckTxVersion':
        value = empty;
        additionalSigned = scale.u32.enc(runtime.transactionVersion);
        break;
      case 'CheckGenesis':
        value = empty;
        additionalSigned = runtime.genesisHash;
        break;
      case 'CheckMortality':
        value = new Uint8Array([0]);
        additionalSigned = runtime.genesisHash;
        break;
      case 'CheckNonce':
        value = scale.compact.enc(BigInt(nonce));
        additionalSigned = empty;
        break;
      case 'CheckWeight':
      case 'CheckNonZeroSender':
      case 'WeightReclaim':
      case 'StorageWeightReclaim':
        value = empty;
        additionalSigned = empty;
        break;
      case 'ChargeTransactionPayment':
        value = scale.compact.enc(0n);
        additionalSigned = empty;
        break;
      case 'ChargeAssetTxPayment':
        value = new Uint8Array([0, 0]);
        additionalSigned = empty;
        break;
      case 'CheckMetadataHash':
        value = new Uint8Array([0]);
        additionalSigned = new Uint8Array([0]);
        break;
      default: {
        const valCodec = chain.builder.buildDefinition(ext.type);
        const addlCodec = chain.builder.buildDefinition(ext.additionalSigned);
        value = encodeDefault(chain.lookupFn, valCodec, ext.type);
        additionalSigned = encodeDefault(chain.lookupFn, addlCodec, ext.additionalSigned);
        break;
      }
    }
    out[ext.identifier] = { identifier: ext.identifier, value, additionalSigned };
  }
  return out;
}

function encodeDefault(lookupFn, codec, typeId) {
  const def = lookupFn(typeId);
  switch (def.type) {
    case 'void':
      return new Uint8Array(0);
    case 'primitive':
      switch (def.value) {
        case 'bool': return new Uint8Array([0]);
        case 'u8': case 'i8': return new Uint8Array(1);
        case 'u16': case 'i16': return new Uint8Array(2);
        case 'u32': case 'i32': return new Uint8Array(4);
        case 'u64': case 'i64': return new Uint8Array(8);
        case 'u128': case 'i128': return new Uint8Array(16);
        case 'u256': case 'i256': return new Uint8Array(32);
        case 'char': case 'str': return new Uint8Array([0]);
        default: return new Uint8Array(0);
      }
    case 'compact':
      return new Uint8Array([0]);
    case 'option':
      return new Uint8Array([0]);
    case 'result':
      return new Uint8Array(u8aConcat([0], encodeDefault(lookupFn, null, def.value.ok.id)));
    case 'array': {
      const inner = encodeDefault(lookupFn, null, def.value.id);
      const result = new Uint8Array(inner.length * def.len);
      for (let i = 0; i < def.len; i++) result.set(inner, i * inner.length);
      return result;
    }
    case 'sequence':
      return new Uint8Array([0]);
    case 'struct': {
      const parts = [];
      for (const [, fieldType] of Object.entries(def.value)) {
        parts.push(encodeDefault(lookupFn, null, fieldType.id));
      }
      return parts.length ? u8aConcat(...parts) : new Uint8Array(0);
    }
    case 'tuple': {
      const parts = def.value.map(t => encodeDefault(lookupFn, null, t.id));
      return parts.length ? u8aConcat(...parts) : new Uint8Array(0);
    }
    case 'enum': {
      const firstName = Object.keys(def.value)[0];
      const variant = def.value[firstName];
      const idx = variant.idx;
      const variantBody = variant.type === 'void'
        ? new Uint8Array(0)
        : encodeDefault(lookupFn, null, variant.value?.id ?? variant.value);
      return u8aConcat(new Uint8Array([idx]), variantBody);
    }
    case 'bitSequence':
      return new Uint8Array([0]);
    default:
      console.log(`Warning: unhandled type kind '${def.type}' for default encoding, using empty bytes`);
      return new Uint8Array(0);
  }
}

function buildSudoCall(chain, innerCallBytes) {
  const sudoEnc = chain.builder.buildCall('Sudo', 'sudo');
  // For sudo.sudo, the inner Call has type ID matching the chain's RuntimeCall.
  // The easiest path is to encode by concatenating the variant byte (pallet idx) and the inner bytes manually:
  // sudo.sudo's only argument is the inner Call (an enum). The enum's variant data is already the inner call bytes (pallet_idx + call_idx + args).
  const outer = new Uint8Array([sudoEnc.location[0], sudoEnc.location[1], ...innerCallBytes]);
  return outer;
}

function buildAuthorizeUpgradeCall(chain, codeHashHex) {
  const enc = chain.builder.buildCall('System', 'authorize_upgrade');
  const args = enc.codec.enc({ code_hash: codeHashHex });
  return new Uint8Array([enc.location[0], enc.location[1], ...args]);
}

function buildApplyAuthorizedUpgradeCall(chain, codeBytes) {
  const enc = chain.builder.buildCall('System', 'apply_authorized_upgrade');
  const args = enc.codec.enc({ code: Binary.fromBytes(codeBytes) });
  return new Uint8Array([enc.location[0], enc.location[1], ...args]);
}

function buildProxyCall(chain, sudoPubKeyHex, innerCallBytes) {
  const enc = chain.builder.buildCall('Proxy', 'proxy');
  const lookup = chain.lookupFn;
  const argsType = lookup(enc.codec ? enc.codec : undefined);
  // Manually build: pallet_idx + call_idx + MultiAddress(Id(pubkey)) + ProxyType(None) + Call(bytes)
  const realBytes = u8aConcat(new Uint8Array([0]), hexToU8a(sudoPubKeyHex));
  const forceProxyType = new Uint8Array([0]);
  return u8aConcat(
    new Uint8Array([enc.location[0], enc.location[1]]),
    realBytes,
    forceProxyType,
    innerCallBytes,
  );
}

async function readAuthorizedUpgrade(chain) {
  const bytes = await readStorage(chain, 'System', 'AuthorizedUpgrade');
  if (!bytes || bytes.length < 32) return null;
  return { codeHash: bytes.slice(0, 32) };
}

async function submitExtrinsic(chain, txHex) {
  return rpcCall(chain.client, 'author_submitExtrinsic', [txHex]);
}

async function validateTransaction(chain, txBytes) {
  const finalized = await rpcCall(chain.client, 'chain_getFinalizedHead', []);
  const txSource = new Uint8Array([2]);
  const txEnc = scale.Bytes(txBytes.length).enc(txBytes);
  const blockHashBytes = hexToU8a(finalized);
  const callData = u8aToHex(u8aConcat(txSource, txEnc, blockHashBytes));
  return rpcCall(chain.client, 'state_call', [
    'TaggedTransactionQueue_validate_transaction', callData, finalized,
  ]);
}

function interpretValidateResult(resultHex) {
  if (!resultHex || resultHex === '0x') return { ok: false, reason: 'empty response' };
  if (resultHex.startsWith('0x00')) return { ok: true };
  if (resultHex === '0x010003') return { ok: true, reason: 'stale nonce (encoding+signature accepted)' };
  return { ok: false, reason: `runtime rejected: ${resultHex}` };
}

async function waitForAuthorizedUpgrade(chain, expectedCodeHashHex, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = await readAuthorizedUpgrade(chain);
    if (pending) {
      const actualHex = u8aToHex(pending.codeHash);
      if (actualHex === expectedCodeHashHex) return true;
      throw new Error(`authorizedUpgrade hash mismatch on chain: got ${actualHex}, expected ${expectedCodeHashHex}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  try {
    const targetChainUrl = core.getInput('targetChainUrl');
    const accountSecret = core.getInput('account');
    const relaychainUrl = core.getInput('relaychainUrl');
    const dryRun = core.getBooleanInput('dryRun');

    let wasmPath = core.getInput('wasmPath');
    let currentRuntimeSpec = null;
    let newRuntimeSpec = null;

    console.log(`Connecting to target chain ${targetChainUrl}`);
    const targetChain = await connectChain(targetChainUrl);
    const targetRuntime = await chainState(targetChain);
    currentRuntimeSpec = { version: targetRuntime.specVersion, chain: targetRuntime.specName };
    console.log(`Current runtime: specName=${targetRuntime.specName}, specVersion=${targetRuntime.specVersion}`);

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

    let managerChain = targetChain;
    let managerRuntime = targetRuntime;
    if (relaychainUrl) {
      console.log(`Connecting to manager (relay) chain ${relaychainUrl}`);
      managerChain = await connectChain(relaychainUrl);
      managerRuntime = await chainState(managerChain);
    }

    let signerAccount;
    let isProxySudo = false;
    let sudoKeyBytes;
    if (accountSecret) {
      const keyring = new Keyring({ type: 'sr25519' });
      const pair = keyring.addFromUri(accountSecret);
      signerAccount = pair;
      console.log(`Using account: ${pair.address}`);

      sudoKeyBytes = await readSudoKey(managerChain);
      if (!sudoKeyBytes) {
        core.setFailed('Sudo key is not set on the chain (sudo pallet may have been removed).');
        process.exit(1);
      }
      const sudoKeyDisplay = encodeAddress(sudoKeyBytes, 42);
      console.log(`Sudo key on chain: ${sudoKeyDisplay}`);

      const isSudo = u8aEq(pair.publicKey, sudoKeyBytes);
      console.log(`Is account sudo: ${isSudo}`);
      if (!isSudo) {
        const delegates = await readProxies(managerChain, sudoKeyBytes);
        isProxySudo = delegates.some(d => u8aEq(d, pair.publicKey));
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
    const existing = await readAuthorizedUpgrade(targetChain);
    if (existing) {
      const existingHex = u8aToHex(existing.codeHash);
      if (existingHex === codeHashHex) {
        console.log('Upgrade call already submitted, skipping authorize step...');
        submitUpgradeCall = false;
      } else {
        console.log(`::error:: Another runtime is already waiting to be applied (${existingHex})`);
        process.exit(1);
      }
    }

    if (submitUpgradeCall) {
      let innerCall = buildAuthorizeUpgradeCall(targetChain, codeHashHex);

      if (relaychainUrl) {
        console.log('::error:: XCM relay-routed sudo is not implemented in the papi rewrite yet. Use parachain-level sudo (omit relaychainUrl).');
        process.exit(1);
      }

      let outerCall = buildSudoCall(managerChain, innerCall);

      if (isProxySudo) {
        outerCall = buildProxyCall(managerChain, u8aToHex(sudoKeyBytes), outerCall);
      }

      console.log(`upgradeCall: ${u8aToHex(outerCall)}`);

      if (!signerAccount) {
        console.log(`::notice:: No account key is provided. Submit manually: ${u8aToHex(outerCall)}`);
        process.exit(1);
      }

      const nonce = await getAccountNonce(managerChain, signerAccount.publicKey);
      const signedExtensions = buildSignedExtensions(managerChain, managerRuntime, nonce);
      const polkadotSigner = getPolkadotSigner(
        signerAccount.publicKey,
        'Sr25519',
        (bytes) => signerAccount.sign(bytes, { withType: false }),
      );
      const txBytes = await polkadotSigner.signTx(
        outerCall,
        signedExtensions,
        managerChain.metadataBytes,
        managerRuntime.finalizedNumber,
        (data) => blake2AsU8a(data, 256),
      );
      const txHex = u8aToHex(txBytes);

      if (dryRun) {
        console.log('DRY RUN: validating signed authorizeUpgrade via TaggedTransactionQueue_validate_transaction...');
        const resultHex = await validateTransaction(managerChain, txBytes);
        const verdict = interpretValidateResult(resultHex);
        console.log(`  validate_transaction result: ${resultHex}`);
        if (!verdict.ok) {
          core.setFailed(`Dry-run validation failed: ${verdict.reason}`);
          process.exit(1);
        }
        console.log(`  Runtime accepted the extrinsic${verdict.reason ? ` (${verdict.reason})` : ''}`);
      } else {
        console.log('Submitting authorizeUpgrade extrinsic...');
        const txHash = await submitExtrinsic(managerChain, txHex);
        console.log(`authorizeUpgrade submitted, txHash: ${txHash}`);
      }
    }

    if (dryRun) {
      console.log('DRY RUN: Skip submitting applyAuthorizedUpgrade extrinsic (unsigned)...');
    } else {
      console.log('Waiting for chain to receive AuthorizedUpgrade event (5m)...');
      const ok = await waitForAuthorizedUpgrade(targetChain, codeHashHex, 5 * 60 * 1000);
      if (!ok) {
        core.setFailed('Timeout, chain did not receive system.authorizedUpgrade message');
        process.exit(1);
      }

      console.log('Submitting applyAuthorizedUpgrade extrinsic (unsigned)...');
      const callBytes = buildApplyAuthorizedUpgradeCall(targetChain, wasmCode);
      const extrinsic = u8aConcat(new Uint8Array([0x04]), callBytes);
      const lengthBytes = scale.compact.enc(BigInt(extrinsic.length));
      const wireBytes = u8aConcat(lengthBytes, extrinsic);
      const wireHex = u8aToHex(wireBytes);
      const txHash = await submitExtrinsic(targetChain, wireHex);
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
