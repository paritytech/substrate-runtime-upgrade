# How to Test the JS Script Locally

> **Note:** This is not a developer instruction. If you have **Node.js** and **Zombinet** installed locally, you can run the script without using Docker.

## 1. Run Docker Compose
Start the required environment using Docker Compose:

```sh
cd test
./setup_env.sh
```

## 2. Open Polkadot.js Explorer
Use the following links to access the local nodes:

- [Explorer (Node 1)](https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9944#/explorer)
- [Explorer (Node 2)](https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9955#/explorer)

![Polkadot.js Explorer](https://github.com/user-attachments/assets/b211eacd-0367-404d-a098-f4dc383ec3f7)

## 3. Run the Script from Docker
Execute the following commands inside a Docker container:

```sh
cd substrate-runtime-upgrade
docker run -it --rm -v $(pwd):/dir -w /dir --network=test_default node:20 bash
  npm install
  test/run.sh
```

## 4. Verify the Version (Wait ~2 Minutes)
After the script completes, verify the version upgrade by checking the second node:

- [Check Version](https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9955#/explorer)

![Version Check](https://github.com/user-attachments/assets/e8ea482b-6a28-45de-9310-498ba277d3a6)

## 5. Cleanup
Shut down the test environment and remove volumes:

```sh
cd test
docker-compose down -v
```
