#!/bin/bash
# Restarts the dev server if it is not responding; waits until ready.
# NOTE: must launch via the double-fork daemonizer — the sandbox reaps
# agent-shell lineage processes (single setsid/nohup dies at command
# boundaries); a double-forked daemon re-parented to PID 1 survives.
if ! curl -s -m 2 -o /dev/null http://localhost:3000/; then
  python3 /home/z/.agent-bin/daemonize.py bash -c 'export UPLOAD_DIR=/home/z/my-project/uploads NEXT_TELEMETRY_DISABLED=1 INTERNAL_TOKEN=ghostline-internal-dev; cd /home/z/my-project && exec bun run dev'
  for i in $(seq 1 30); do
    sleep 1
    if curl -s -m 2 -o /dev/null http://localhost:3000/; then break; fi
  done
fi
# wait for the in-process realtime service
for i in $(seq 1 15); do
  if curl -s -m 2 "http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling" 2>/dev/null | head -c1 | grep -q "0"; then break; fi
  sleep 1
done
