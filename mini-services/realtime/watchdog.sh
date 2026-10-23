#!/bin/bash
# Restarts the realtime service when it is not listening on :3003
if ! curl -s -m 2 "http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling" | head -c 1 | grep -q "0"; then
  echo "[watchdog $(date)] service down — restarting" >> /home/z/my-project/mini-services/realtime/dev.log
  pkill -f "bun index.ts" 2>/dev/null
  pkill -f "realtime/run.sh" 2>/dev/null
  cd /home/z/my-project/mini-services/realtime
  setsid nohup ./run.sh > /dev/null 2>&1 < /dev/null &
fi
