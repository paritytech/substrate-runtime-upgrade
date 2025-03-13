#!/bin/bash

export INPUT_TARGETCHAINURL="wss://your-target-chain-url"
export INPUT_WASMPATH="data/new-wasm" #"./path/to/your/runtime.wasm"
export INPUT_ACCOUNT="your mnemonic or secret key"
export INPUT_RELAYCHAINURL="wss://your-relaychain-url"  # optional, if needed

node dist/index.js