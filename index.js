const core = require('@actions/core');
const github = require('@actions/github');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { blake2AsHex, cryptoWaitReady } = require('@polkadot/util-crypto');
const fetch = require('node-fetch');

async function run() {
  try {
    // Get inputs
    const chain = core.getInput('chain', { required: true });
    const network = core.getInput('network', { required: true });
    const nodeUrl = core.getInput('node_url', { required: true });
    const sudoKey = core.getInput('sudo_key', { required: true });
    const maxReleasesToCheck = parseInt(core.getInput('max_releases_to_check', { required: false })) || 10;

    // Connect to the node
    core.info(`Connecting to node at ${nodeUrl}...`);
    const provider = new WsProvider(nodeUrl);
    const api = await ApiPromise.create({ provider });

    // Get the current runtime version
    const currentVersion = await api.rpc.state.getRuntimeVersion();
    core.info(`Current runtime version: ${currentVersion.specVersion}`);

    // Find the latest WASM file from GitHub releases
    const wasmFileUrl = await findLatestWasmFile(chain, network, maxReleasesToCheck);
    if (!wasmFileUrl) {
      throw new Error(`Could not find a suitable WASM file for ${chain}-${network}`);
    }

    core.info(`Found WASM file: ${wasmFileUrl}`);

    // Perform the upgrade
    const hash = await chainUpgradeFromUrl(api, wasmFileUrl, sudoKey);
    core.info(`Upgrade successful! New runtime hash: ${hash}`);

    // Set output
    core.setOutput('runtime_hash', hash);

    // Disconnect from the node
    await api.disconnect();

  } catch (error) {
    core.setFailed(error.message);
  }
}

async function findLatestWasmFile(chain, network, maxReleasesToCheck) {
  core.info(`Looking for latest WASM file for ${chain}-${network}...`);

  try {
    const response = await fetch('https://api.github.com/repos/paritytech/polkadot-sdk/releases');
    const releases = await response.json();

    if (!Array.isArray(releases)) {
      throw new Error('Failed to fetch releases from GitHub API');
    }

    core.info(`Found ${releases.length} releases, checking up to ${maxReleasesToCheck}`);

    // Check each release for the WASM file
    for (let i = 0; i < Math.min(releases.length, maxReleasesToCheck); i++) {
      const release = releases[i];
      core.info(`Checking release: ${release.tag_name}`);

      if (!release.assets || !Array.isArray(release.assets)) {
        core.info('No assets found in this release, skipping');
        continue;
      }

      // Look for a matching WASM file
      const wasmPattern = new RegExp(`^${chain}-${network}_runtime-v\\d+\\.compact\\.compressed\\.wasm$`);
      const asset = release.assets.find(asset => wasmPattern.test(asset.name));

      if (asset) {
        core.info(`Found matching WASM file: ${asset.name}`);
        return asset.browser_download_url;
      }
    }

    return null;
  } catch (error) {
    core.warning(`Error fetching releases: ${error.message}`);
    return null;
  }
}

async function chainUpgradeFromUrl(api, wasmFileUrl, sudoKey) {
  // The filename of the runtime/PVF we want to upgrade to
  core.info(`Upgrading chain with file from URL: ${wasmFileUrl}`);

  const fetchResponse = await fetch(wasmFileUrl);
  const file = await fetchResponse.arrayBuffer();

  const buff = Buffer.from(file);
  const hash = blake2AsHex(buff);
  await performChainUpgrade(api, buff.toString("hex"), sudoKey);

  return hash;
}

async function performChainUpgrade(api, code, sudoKey) {
  await cryptoWaitReady();

  const keyring = new Keyring({ type: "sr25519" });
  const sudo = keyring.addFromUri(sudoKey);

  core.info(`Using sudo key: ${sudo.address}`);

  return new Promise(async (resolve, reject) => {
    try {
      const unsub = await api.tx.sudo
        .sudoUncheckedWeight(api.tx.system.setCodeWithoutChecks(`0x${code}`), {
          refTime: 1,
        })
        .signAndSend(sudo, (result) => {
          core.info(`Current status is ${result.status}`);

          if (result.status.isInBlock) {
            core.info(`Transaction included at blockHash ${result.status.asInBlock}`);
          } else if (result.status.isFinalized) {
            core.info(`Transaction finalized at blockHash ${result.status.asFinalized}`);
            unsub();
            return resolve();
          } else if (result.isError) {
            unsub();
            if (result.status.isInvalid) {
              // Allow `invalid` tx, since we will validate the hash of the `code` later
              core.warning(`Transaction invalid: ${JSON.stringify(result)}`);
              return resolve();
            } else {
              core.error(`Transaction Error: ${JSON.stringify(result)}`);
              return reject(new Error(`Transaction error: ${JSON.stringify(result)}`));
            }
          }
        });
    } catch (error) {
      reject(error);
    }
  });
}

run();
