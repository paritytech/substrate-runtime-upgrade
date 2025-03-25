# Runtime Upgrade GitHub Action

This GitHub Action automates the process of upgrading the runtime of a Substrate-based blockchain using the Polkadot JS API.

## Features

- Connects to a target Substrate-based chain via WebSocket.
- Fetches and validates the current and new runtime WASM code.
- Checks if the provided account has the necessary sudo or proxy privileges.
- Submits the `authorizeUpgrade` and `applyAuthorizedUpgrade` extrinsics.
- Supports both standalone chains and parachains with relaychain validation.
- Option for dry-run validation (no transaction submission).

## Inputs

| Name           | Description                                                          | Required |
|----------------|----------------------------------------------------------------------|----------|
| `targetChainUrl` | WebSocket URL of the target chain.                                   | ✅ |
| `wasmPath` | Path or URL to the WASM runtime file.                                | ✅ |
| `account` | Secret or mnemonic of the account used to sign transactions.         | ✅ |
| `relaychainUrl` | WebSocket URL of the relaychain (for parachain upgrade via **XCM**). | ❌ |
| `dryRun` | If set to `true`, only validates inputs and skips transaction submission. | ❌ |

## Usage

```yaml
jobs:
  runtime-upgrade:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Install subwasm ${{ env.SUBWASM_VERSION }}
        env:
          SUBWASM_VERSION: 0.19.1
        run: |
          wget https://github.com/chevdor/subwasm/releases/download/v${{ env.SUBWASM_VERSION }}/subwasm_linux_amd64_v${{ env.SUBWASM_VERSION }}.deb
          sudo dpkg -i subwasm_linux_amd64_v${{ env.SUBWASM_VERSION }}.deb
          subwasm --version

      - name: Perform runtime upgrade
        uses: paritytech/substrate-runtime-upgrade@main
        with:
          targetChainUrl: "wss://your-chain-url"
          wasmPath: "https://your-wasm-file-url"
          account: ${{ secrets.ACCOUNT_SECRET }}
          relaychainUrl: "wss://your-relaychain-url"  # Optional
          dryRun: "false"  # Optional (set to true for dry run)
```

## Workflow

1. Connects to the target chain using the provided WebSocket URL.
2. Fetches and validates the current and new runtime WASM details using `subwasm` (if installed).
3. Computes the WASM code hash and verifies if an upgrade is already authorized.
4. Ensures the account has sudo or proxy permissions.
5. Checks for sufficient account balance to cover transaction fees.
6. Submits the `authorizeUpgrade` extrinsic (if not in dry-run mode).
7. Waits for the upgrade to be applied.
8. Broadcasts the `applyAuthorizedUpgrade` extrinsic to finalize the upgrade (if not in dry-run mode).
9. If `dryRun` is set to `true`, no transactions are submitted, and only the inputs are validated.

## Prerequisites

- The account used must be the **sudo key** or a **proxy** for the sudo key.
- The target chain must support **runtime upgrades** via `authorizeUpgrade` and `applyAuthorizedUpgrade`.
- The `subwasm` CLI tool is optional but recommended for runtime verification.

## Notes

- If the provided WASM file is a URL, it will be downloaded before processing.
- If an authorized upgrade is already pending, the action will fail unless the hash matches.
- The relaychain URL is only required if submitting the upgrade via a relaychain using **XCM**.
- The `dryRun` option allows you to validate inputs without submitting any transactions.
