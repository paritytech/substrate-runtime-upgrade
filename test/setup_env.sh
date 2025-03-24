#!/bin/bash

docker-compose up -d

curl -H "Content-Type: application/json" --data '@data/onboard_call.json' localhost:9944
