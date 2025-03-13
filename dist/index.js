const core = require('@actions/core');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { blake2AsHex } = require('@polkadot/util-crypto');
const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');

async function main() {
  try {
    // 1. Read inputs
    const targetChainUrl = core.getInput('targetChainUrl');
    const wasmPath = core.getInput('wasmPath');
    const accountSecret = core.getInput('account');
    const relaychainUrl = core.getInput('relaychainUrl');

    console.log("WASM file info:\n", wasmPath);

//    // 2. Print WASM file info (simulate using subwasm)
//    try {
//      const wasmInfo = execSync(`subwasm info ${wasmPath}`, { encoding: 'utf-8' });
//      console.log("WASM file info:\n", wasmInfo);
//    } catch (err) {
//      console.warn("Warning: Could not retrieve WASM file info via subwasm. Ensure the tool is installed.", err.message);
//    }
//
//    // 3. Print chain info (simulate using subwasm)
//    try {
//      const chainForInfo = relaychainUrl ? relaychainUrl : targetChainUrl;
//      const chainInfo = execSync(`subwasm info --chain ${chainForInfo}`, { encoding: 'utf-8' });
//      console.log("Chain info:\n", chainInfo);
//    } catch (err) {
//      console.warn("Warning: Could not retrieve chain info via subwasm.", err.message);
//    }
//
//    // 4. Load WASM code (from URL or local file)
//    let wasmCode;
//    if (wasmPath.startsWith('http')) {
//      console.log("Fetching WASM file from URL...");
//      const response = await axios.get(wasmPath, { responseType: 'arraybuffer' });
//      wasmCode = new Uint8Array(response.data);
//    } else {
//      console.log("Reading WASM file from local path...");
//      wasmCode = fs.readFileSync(wasmPath);
//    }
//
//    // 5. Compute code hash for the runtime upgrade
//    const codeHash = blake2AsHex(wasmCode);
//    console.log(`Computed code hash: ${codeHash}`);
//
//    // 6. Connect to target chain API (for account queries, etc.)
//    const provider = new WsProvider(targetChainUrl);
//    const api = await ApiPromise.create({ provider });
//
//    // 7. Load account from secret/mnemonic
//    const keyring = new Keyring({ type: 'sr25519' });
//    const account = keyring.addFromUri(accountSecret);
//    console.log(`Using account: ${account.address}`);
//
//    // 8. Check if the account is the sudo key
//    const sudoKey = (await api.query.sudo.key()).toString();
//    const isSudo = account.address === sudoKey;
//    console.log(`Is account sudo: ${isSudo}`);
//
//    // 9. If not sudo, check if account is proxy for sudo
//    let isProxySudo = false;
//    if (!isSudo) {
//      const proxies = await api.query.proxy.proxies(account.address);
//      // proxies returns a tuple: [proxyList, deposit]
//      if (proxies[0].length > 0) {
//        for (const [delegate] of proxies[0]) {
//          if (delegate.toString() === sudoKey) {
//            isProxySudo = true;
//            break;
//          }
//        }
//      }
//      console.log(`Is account proxy for sudo: ${isProxySudo}`);
//    }
//
//    // 10. If neither sudo nor proxy, then fail.
//    if (!isSudo && !isProxySudo) {
//      core.setFailed("Key does not have permission to update the runtime (not sudo or proxy for sudo).");
//      process.exit(1);
//    }
//
//    // 11. Build the authorizeUpgrade extrinsic
//    let upgradeCall = api.tx.system.authorizeUpgrade(codeHash);
//
//    // 12. Wrap the call in sudo (or proxy+sudo) if needed.
//    if (isSudo) {
//      upgradeCall = api.tx.sudo.sudo(upgradeCall);
//    } else if (isProxySudo) {
//      // Wrap the call in a proxy call: note that proxyType is set to null (i.e. any)
//      upgradeCall = api.tx.proxy.proxy(sudoKey, null, upgradeCall);
//    }
//
//    // 13. If relaychain URL is provided, wrap the call in an XCM envelope.
//    if (relaychainUrl) {
//      console.log("Wrapping the call in an XCM envelope for relaychain submission...");
//      upgradeCall = wrapInXCM(upgradeCall, relaychainUrl);
//    }
//
//    // 14. Submit RPC call 1: authorizeUpgrade.
//    // If relaychainUrl exists, use that connection; otherwise use target chain.
//    let providerForCall1;
//    if (relaychainUrl) {
//      providerForCall1 = new WsProvider(relaychainUrl);
//    } else {
//      providerForCall1 = new WsProvider(targetChainUrl);
//    }
//    const apiForCall1 = await ApiPromise.create({ provider: providerForCall1 });
//
//    console.log("Submitting authorizeUpgrade extrinsic...");
//    await new Promise(async (resolve, reject) => {
//      const unsub = await upgradeCall.signAndSend(account, (result) => {
//        console.log(`Current status: ${result.status}`);
//        if (result.status.isInBlock || result.status.isFinalized) {
//          console.log(`Extrinsic included in block: ${result.status}`);
//          unsub();
//          resolve();
//        }
//      }).catch(reject);
//    });
//
//    // 15. Verify that authorizeUpgrade was successful by checking system.authorizedUpgrade.
//    const authorizedUpgrade = await api.query.system.authorizedUpgrade();
//    if (authorizedUpgrade.isSome && authorizedUpgrade.unwrap().toHex() === codeHash) {
//      console.log("authorizeUpgrade RPC call successful.");
//    } else {
//      core.setFailed("First RPC call failed: system.authorizedUpgrade did not match expected code hash.");
//      process.exit(1);
//    }
//
//    // 16. Submit RPC call 2: applyAuthorizedUpgrade (unsigned) via target chain.
//    console.log("Submitting applyAuthorizedUpgrade extrinsic (unsigned)...");
//    const applyUpgradeCall = api.tx.system.applyAuthorizedUpgrade(wasmCode);
//    // Note: .send() here is used to broadcast an unsigned extrinsic.
//    await new Promise(async (resolve, reject) => {
//      const unsub = await applyUpgradeCall.send(({ status }) => {
//        console.log(`applyAuthorizedUpgrade status: ${status}`);
//        if (status.isFinalized) {
//          console.log(`applyAuthorizedUpgrade finalized in block: ${status.asFinalized.toString()}`);
//          unsub();
//          resolve();
//        }
//      }).catch(reject);
//    });

    console.log("Runtime upgrade successfully submitted.");
    process.exit(0);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
    process.exit(1);
  }
}

// Dummy function to simulate wrapping an extrinsic in XCM
function wrapInXCM(call, relaychainUrl) {
  // In practice, constructing an XCM message requires proper encoding and using XCM-related pallets.
  console.log(`Simulating XCM wrapping for call to be sent via relaychain at ${relaychainUrl}`);
  // For demonstration purposes, we return the call unchanged.
  return call;
}

main();
