## How to Generate Test Data?

### **onboard_call.json**

1. Run test containers:  
   ```bash
   docker-compose up -d
   ```

2. Get state and WASM:  
   ```bash
   docker exec test_collator_alice_1 bash -c 'polkadot-parachain export-genesis-state --chain asset-hub-rococo-local' > state
   docker exec test_collator_alice_1 bash -c 'polkadot-parachain export-genesis-wasm --chain asset-hub-rococo-local' > wasm
   ```

3. Use [Polkadot.js](https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9944#/sudo) to sign `parasSudoWrapper.sudoScheduleParaInitialize(id, genesis)`:  
   - Click **"Submit Sudo"**  
   - Select **"Sign (no submission)"**  

4. Copy the signed data into `onboard_call.json`.

### **new-wasm**

1. Run the following command to get WASM from any version:  
   ```bash
   docker run parity/polkadot-parachain:stable2412 export-genesis-wasm --chain asset-hub-rococo-local --raw > new-wasm
   ```