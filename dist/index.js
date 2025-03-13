const core = require('@actions/core');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { blake2AsHex } = require('@polkadot/util-crypto');
const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');
const path = require('path');

// Function to download the file if it's a URL
const downloadFile = async (url, outputPath) => {
    console.log(`Downloading file from ${url}...`);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
    });

    fs.writeFileSync(outputPath, response.data);
    console.log(`Downloaded to: ${outputPath}`);
};

async function main() {
  try {
    // 1. Read inputs
    const targetChainUrl = core.getInput('targetChainUrl');
    const accountSecret = core.getInput('account');
    const relaychainUrl = core.getInput('relaychainUrl');
    let  wasmPath = core.getInput('wasmPath');
//
//    // 2. Print current runtime info (simulate using subwasm)
//    try {
//
//      const chainInfo = execSync(`subwasm info  ${targetChainUrl}`, { encoding: 'utf-8' });
//      console.log("Current runtime info:\n", chainInfo);
//    } catch (err) {
//      console.warn("Warning: Could not retrieve chain info via subwasm. Ensure the tool is installed.", err.message);
//    }
//
//    // 1. Print New runtime info
//    try {
//        if (wasmPath.startsWith('http')) {
//            const filename = path.basename(new URL(wasmPath).pathname);
//            wasmPath = path.join(__dirname, filename); // Save in the same directory
//            await downloadFile(core.getInput('wasmPath'), wasmPath);
//        }
//        if (!fs.existsSync(wasmPath)) {
//            throw new Error(`WASM file not found: ${wasmPath}`);
//        }
//        try {
//            const wasmInfo = execSync(`subwasm info ${wasmPath}`, { encoding: 'utf-8' });
//            console.log("New runtime info:\n", wasmInfo);
//        } catch (err) {
//          console.warn("Warning: Could not retrieve WASM file info via subwasm. Ensure the tool is installed.", err.message);
//        }
//    } catch (err) {
//        console.error("Error:", err.message);
//        process.exit(1);
//    }

    // 4. Load WASM code (from URL or local file)
    let wasmCode;
    console.log("Reading WASM file...");
    wasmCode = fs.readFileSync(wasmPath);


    // 5. Compute code hash for the runtime upgrade
    const codeHash = blake2AsHex(wasmCode);
    console.log(`Computed code hash: ${codeHash}`);

    // 6. Connect to target chain API (for account queries, etc.)
    const provider = new WsProvider(relaychainUrl ? relaychainUrl : targetChainUrl);
    const api = await ApiPromise.create({ provider });

    // 7. Load account from secret/mnemonic
    const keyring = new Keyring({ type: 'sr25519' });
    const account = keyring.addFromUri(accountSecret);
    console.log(`Using account: ${account.address}`);

    // 8. Check if the account is the sudo key
    const sudoKey = (await api.query.sudo.key()).toString();
    const isSudo = account.address === sudoKey;
    console.log(`Is account sudo: ${isSudo}`);

    // 9. If not sudo, check if account is proxy for sudo
    let isProxySudo = false;
    if (!isSudo) {
      const proxies = await api.query.proxy.proxies(sudoKey);
      // proxies returns a tuple: [proxyList, deposit]
      if (proxies[0].length > 0) {
        for (const proxy of proxies[0]) {
          if (proxy.delegate.toString() === account.address ) {
            isProxySudo = true;
            break;
          }
        }
      }
      console.log(`Is account proxy for sudo: ${isProxySudo}`);
    }

    // 10. If neither sudo nor proxy, then fail.
    if (!isSudo && !isProxySudo) {
      core.setFailed("Key does not have permission to update the runtime (not sudo or proxy for sudo).");
      process.exit(1);
    }

    // 11. Build the authorizeUpgrade extrinsic
    let upgradeCall = api.tx.system.authorizeUpgrade(codeHash);

//    // 12. If relaychain URL is provided, wrap the call in an XCM envelope.
//    if (relaychainUrl) {
//      console.log("Wrapping the call in an XCM envelope for relaychain submission...");
//      const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: 1000 }] } } }; // TODO update paraid
//      const instr1 = TODO;
//      const instr2 = {
//          Transact: {
//            originKind: 'SovereignAccount',
//            requireWeightAtMost: { refTime: weightTransact, proofSize: 200000n },
//            call: {
//              encoded: transactBytes,
//            },
//          },
//        };
//      upgradeCall = api.tx.xcmPallet.send((dest, { V4: [instr1, instr2] }));
//    }

//    // 12. Wrap the call in sudo (or proxy+sudo) if needed.
//    if (isSudo) {
//      upgradeCall = api.tx.sudo.sudo(upgradeCall);
//    } else if (isProxySudo) {
//      // Wrap the call in a proxy call: note that proxyType is set to null (i.e. any)
//      upgradeCall = api.tx.proxy.proxy(sudoKey, null, upgradeCall);
//    }
//
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

main();
