#!/bin/bash
cd "$(dirname "$0")"
export UPLOAD_DIR="/home/z/my-project/uploads"
while true; do
  echo "[run.sh] starting realtime service $(date)" >> dev.log
  bun index.ts >> dev.log 2>&1
  echo "[run.sh] service exited (code $?) — restarting in 1s" >> dev.log
  sleep 1
done
