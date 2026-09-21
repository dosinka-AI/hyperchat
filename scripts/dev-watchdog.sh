#!/bin/bash
# Keeps the Next dev server alive. Requires 3 consecutive failed probes
# (90s apart) before restarting, and gives a freshly started server 75s of
# grace while Turbopack compiles, so it never kills a booting server.
FAILS=0
GRACE=0
while true; do
  sleep 30
  if [ "$GRACE" -gt 0 ]; then
    GRACE=$((GRACE - 1))
    continue
  fi
  if curl -s -o /dev/null --max-time 5 http://127.0.0.1:3000/; then
    FAILS=0
  else
    FAILS=$((FAILS + 1))
    if [ "$FAILS" -ge 3 ]; then
      pkill -f "next-server" 2>/dev/null
      pkill -f "bun run dev" 2>/dev/null
      sleep 3
      cd /home/z/my-project || exit 1
      nohup bun run dev > dev.log 2>&1 &
      GRACE=2
      FAILS=0
      echo "$(date '+%F %T') watchdog: restarted dev server" >> /home/z/my-project/watchdog.log
    fi
  fi
done
