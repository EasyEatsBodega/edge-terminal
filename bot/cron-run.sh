#!/bin/bash
# Edge Terminal — cron runner
# Pulls latest code, restarts service if changed, then runs the bot
cd /root/edge-terminal

# Save current commit hash
OLD_HASH=$(git rev-parse HEAD)

# Pull latest
git pull --ff-only 2>/dev/null

# Check if code changed
NEW_HASH=$(git rev-parse HEAD)

if [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo "$(date): New code detected, restarting edge-bot service..."
  systemctl restart edge-bot
  sleep 3
fi

# Run the bot (one-shot mode for cron)
node /root/edge-terminal/bot/edge-bot.mjs --run
