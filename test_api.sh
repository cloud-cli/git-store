#!/bin/bash

export DATA_PATH=/tmp/test-git-data
export PORT=3000

# Start server in background
node index.js &
SERVER_PID=$!

# Wait for server to start
sleep 2

echo "Testing: Create Repo"
curl -X POST http://localhost:3000/repos/owner1/repo1
echo ""

echo "Testing: Create a file and stage it"
mkdir -p /tmp/test-git-data/owner1/repo1
echo "hello" > /tmp/test-git-data/owner1/repo1/test.txt
echo "Testing: Stage file"
curl -X POST -H "Content-Type: application/json" -d '{"files":["test.txt"]}' http://localhost:3000/repos/owner1/repo1/stage
echo ""

echo "Testing: Commit"
curl -X POST -H "Content-Type: application/json" -d '{"message":"initial commit"}' http://localhost:3000/repos/owner1/repo1/commit
echo ""

echo "Testing: Get Log"
curl -X GET http://localhost:3000/repos/owner1/repo1/log
echo ""

echo "Testing: Add Tag"
curl -X POST -H "Content-Type: application/json" -d '{"name":"v1"}' http://localhost:3000/repos/owner1/repo1/tags
echo ""

echo "Testing: Add Branch"
curl -X POST -H "Content-Type: application/json" -d '{"name":"feature-branch"}' http://localhost:3000/repos/owner1/repo1/branches
echo ""

# Cleanup
kill $SERVER_PID
rm -rf /tmp/test-git-data
