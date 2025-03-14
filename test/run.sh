#!/bin/bash
# run this script from docker:
# docker run -it --rm -v $(pwd):/dir -w /dir --network=test_default node:20 bash
# npm install
# test/run.sh

export INPUT_TARGETCHAINURL="ws://test_collator_alice_1:9944"
export INPUT_WASMPATH="test/data/new-wasm"
# Will fail `1010: Invalid Transaction: Transaction call is not expected`
# system.InvalidSpecName rococo vs westend
#export INPUT_WASMPATH="https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2412/asset_hub_westend_runtime.compact.compressed.wasm"
export INPUT_ACCOUNT="//Alice"
export INPUT_RELAYCHAINURL="ws://test_node_alice_1:9944"  # optional, if needed

#export  SUBWASM_VERSION=0.19.1
#wget https://github.com/chevdor/subwasm/releases/download/v${SUBWASM_VERSION}/subwasm_linux_amd64_v${SUBWASM_VERSION}.deb
#dpkg -i subwasm_linux_amd64_v${SUBWASM_VERSION}.deb
#subwasm --version

node dist/index.js