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

// Function to parce subwasm output
function getSpecVersion(chainInfo) {
    try {
        const match = chainInfo.match(/🔥 Core version:\s+([a-zA-Z0-9-]+)-(\d+)/);
        return {
            version: match ? parseInt(match[2]) : null,
            chain: match ? match[1] : null
        };
    } catch (error) {
        console.log("ERROR fetching runtime metadata:", error);
        return { version: null, chain: null };
    }
}

async function main() {
  try {
    // 1. Read inputs
    const targetChainUrl = core.getInput('targetChainUrl');
    const accountSecret = core.getInput('account');
    const relaychainUrl = core.getInput('relaychainUrl');
    const dryRun = core.getBooleanInput('dryRun');
    const wsProviderTargetChain = new WsProvider(targetChainUrl);
    const apiTargetChain = await ApiPromise.create({ provider: wsProviderTargetChain });

    let wasmPath = core.getInput('wasmPath');
    let currentRuntimeSpec = null;
    let newRuntimeSpec = null;

    // 2. Print current runtime info (simulate using subwasm)
    try {
      const chainInfo = execSync(`subwasm info ${targetChainUrl}`, { encoding: 'utf-8' });
      console.log("Current runtime info:\n", chainInfo);
      currentRuntimeSpec = getSpecVersion(chainInfo);
    } catch (err) {
        console.warn("Warning: Could not retrieve chain info via subwasm. Ensure the tool is installed.", err.message);
        console.log("Current runtime info:", (await apiTargetChain.query.system.lastRuntimeUpgrade()).toString());
    }

    // 3. Print new runtime info
    try {
        if (wasmPath.startsWith('http')) {
            const filename = path.basename(new URL(wasmPath).pathname);
            wasmPath = path.join(__dirname, filename); // Save in the same directory
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
          console.warn("Warning: Could not retrieve WASM file info via subwasm. Ensure the tool is installed.", err.message);
        }
    } catch (err) {
        console.log("::error::", err.message);
        process.exit(1);
    }

    // Compare version only if subwasm output is available
    if (currentRuntimeSpec && newRuntimeSpec) {
        console.log("currentRuntimeSpec", currentRuntimeSpec)
        console.log("newRuntimeSpec", newRuntimeSpec)
        if (currentRuntimeSpec.chain === newRuntimeSpec.chain) {
            console.log("Spec Name:", newRuntimeSpec.chain);
        } else {
            console.log(`::error:: Invalid spec name for new runtime, expected: '${currentRuntimeSpec.chain}', got: '${newRuntimeSpec.chain}'`);
            process.exit(1);
        }
        if (currentRuntimeSpec.version < newRuntimeSpec.version) {
            console.log(`Spec Version: ${currentRuntimeSpec.version} -> ${newRuntimeSpec.version}`);
        } else {
            console.log(`::error:: Invalid version, new version should be greater: old: ${currentRuntimeSpec.version}, new: ${newRuntimeSpec.version}`);
            process.exit(1);
        }
    }



    // 4. Load WASM code (from URL or local file)
    let wasmCode;
    console.log("Reading WASM file...");
    wasmCode = fs.readFileSync(wasmPath);

    // 5. Compute code hash for the runtime upgrade
    const codeHash = blake2AsHex(wasmCode);
    console.log(`New runtime code hash: ${codeHash}`);

    // 6. Connect to manager chain API (for account queries, etc.)
    let apiManager;
    if (relaychainUrl) {
        const provider = new WsProvider(relaychainUrl);
        apiManager = await ApiPromise.create({ provider });
    } else {
        apiManager = apiTargetChain;
    }

    let account;
    let isProxySudo = false;
    if (accountSecret) {
        // 7. Load account from secret/mnemonic
        const keyring = new Keyring({ type: 'sr25519' });
        account = keyring.addFromUri(accountSecret);
        console.log(`Using account: ${account.address}`);

        // 8. Check if the account is the sudo key
        const sudoKey = (await apiManager.query.sudo.key()).toString();
        const isSudo = account.address === sudoKey;
        console.log(`Is account sudo: ${isSudo}`);

        // 9. If not sudo, check if account is proxy for sudo
        if (!isSudo) {
          const proxies = await apiManager.query.proxy.proxies(sudoKey);
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

        // 10. If neither sudo nor proxy, fail.
        if (!isSudo && !isProxySudo) {
          core.setFailed("Key does not have permission to update the runtime (not sudo or proxy for sudo).");
          process.exit(1);
        }

        // 11. Check if account has sufficient balance for the fee
        const { data: balance } = await apiManager.query.system.account(account.address);
        const existentialDeposit = parseInt(apiManager.consts.balances.existentialDeposit);
        const estimatedTxFee = parseInt(apiManager.consts.transactionPayment?.defaultTransactionByteFee) || 1000000000;
        if (balance.free < (estimatedTxFee + existentialDeposit)) {
            console.log(`balance.free: ${balance.free}`);
            console.log(`estimatedTxFee + existentialDeposit: ${(estimatedTxFee + existentialDeposit)}`);
            console.log("::error:: Account has insufficient balance for transaction");
            process.exit(1);
        }
    } else {
        account = false;
        console.log("::warning:: Account is not set");
    }

    // 12. Check if there is already an authorized upgrade in progress
    let submitUpgradeCall = true;
    const authorizedUpgrade = await apiTargetChain.query.system.authorizedUpgrade();
    if (authorizedUpgrade.isSome) {
      if (authorizedUpgrade.unwrap().codeHash.toString() === codeHash){
        console.log("Upgrade call already submitted, skipping...");
        submitUpgradeCall = false;
      } else {
        console.log(`Already submitted runtime hash: ${authorizedUpgrade.unwrap().codeHash.toString()}`);
        console.log(`Our hash: ${codeHash}`);
        console.log("::error:: Another runtime is already waiting to be applied");
        process.exit(1);
      }
    }

    if (submitUpgradeCall) {
        // 13. Build the authorizeUpgrade extrinsic
        let upgradeCall = apiManager.tx.system.authorizeUpgrade(codeHash);

        // 14. If relaychain URL is provided, wrap the call in an XCM envelope.
        if (relaychainUrl) {
          console.log("Wrapping the call in an XCM envelope for relaychain submission...");
          const paraid = await apiTargetChain.query.parachainInfo.parachainId();
          const upgradeCallInfo =
            await apiTargetChain.call.transactionPaymentCallApi.queryCallInfo(
              upgradeCall.method,
              upgradeCall.method.toU8a().length
            );
          const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: paraid }] } } };
          const message = {
            V4: [
                  {
                    UnpaidExecution: {
                      weightLimit: 'Unlimited',
                      checkOrigin: null,
                    },
                  },
                  {
                    Transact: {
                      originKind: 'Superuser',
                      requireWeightAtMost: upgradeCallInfo.weight,
                      call: {
                        encoded: upgradeCall.method.toHex(),
                      },
                    },
                  },
               ]
            };
          upgradeCall = apiManager.tx.xcmPallet.send(dest, message);
          console.log(`upgradeCall: ${upgradeCall.method.toHex()}`);
        }

        // 15. Wrap the call in sudo (or proxy+sudo) if needed.
        console.log("Wrapping the call in sudo...");
        upgradeCall = apiManager.tx.sudo.sudo(upgradeCall);
        console.log(`upgradeCall: ${upgradeCall.method.toHex()}`);
        if (isProxySudo) {
          console.log("Wrapping the call in proxy...");
          // Wrap the call in a proxy call: note that proxyType is set to null (i.e. any)
          upgradeCall = apiManager.tx.proxy.proxy(sudoKey, null, upgradeCall);
          console.log(`upgradeCall: ${upgradeCall.method.toHex()}`);
        }
        if (dryRun) {
            console.log("DRY RUN: Skip submitting authorizeUpgrade extrinsic...");
        } else if (!account){
            console.log(`::notice:: No account key is provided. Please run the following transaction and restart the job to finish the upgrade.
                Call: system.authorizeUpgrade(${codeHash})
                Encoded call: ${upgradeCall.method.toHex()}`);
            process.exit(1);
        } else {
            // 16. Submit RPC call 1: authorizeUpgrade.
            console.log("Submitting authorizeUpgrade extrinsic...");
            await new Promise(async (resolve, reject) => {
              const unsub = await upgradeCall.signAndSend(account, (result) => {
                console.log(`Current status: ${result.status}`);
                if (result.status.isInBlock || result.status.isFinalized) {
                  console.log(`Extrinsic included in block: ${result.status}`);
                  unsub();
                  resolve();
                }
              }).catch(reject);
            });
        }
    }
    if (dryRun) {
        console.log("DRY RUN: Skip submitting applyAuthorizedUpgrade extrinsic (unsigned)...");
    } else {
        // 17. Verify that authorizeUpgrade was successful by checking system.authorizedUpgrade.
        console.log("Waiting 60s for chain to receive AuthorizedUpgrade event");
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Sleep for 2 seconds
            const authorizedUpgrade = await apiTargetChain.query.system.authorizedUpgrade();
            if (authorizedUpgrade.isSome) {
                if (authorizedUpgrade.unwrap().codeHash.toString() === codeHash){
                    console.log("authorizeUpgrade RPC call successful.");
                    break;
                } else {
                  console.log(`authorizedUpgrade.unwrap().codeHash: ${authorizedUpgrade.unwrap().codeHash.toString()}`);
                  console.log(`codeHash: ${codeHash}`);
                  core.setFailed("First RPC call failed: system.authorizedUpgrade did not match expected code hash.");
                  process.exit(1);
                }
            }
            if (i === 29) {
              core.setFailed("Timeout, chain did not receive system.authorizedUpgrade message");
              process.exit(1);
            }
        }

        // 18. Submit RPC call 2: applyAuthorizedUpgrade (unsigned) via target chain.
        console.log("Submitting applyAuthorizedUpgrade extrinsic (unsigned)...");
        const applyUpgradeCall = apiTargetChain.tx.system.applyAuthorizedUpgrade(`0x${wasmCode.toString("hex")}`);
        // Note: .send() here is used to broadcast an unsigned extrinsic.
        await new Promise(async (resolve, reject) => {
          const unsub = await applyUpgradeCall.send(({ status }) => {
            console.log(`applyAuthorizedUpgrade status: ${status}`);
            if (status.isFinalized) {
              console.log(`applyAuthorizedUpgrade finalized in block: ${status.asFinalized.toString()}`);
              unsub();
              resolve();
            }
          }).catch(reject);
        });

        console.log("Runtime upgrade successfully submitted.");
    }
    process.exit(0);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
    process.exit(1);
  }
}

main();
