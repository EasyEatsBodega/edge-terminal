#!/bin/bash
# Edge Terminal — cron runner
# Pulls latest code, restarts service if changed, then runs the bot
# Uses a lock file to prevent overlapping runs

LOCKFILE="/tmp/edge-bot-cron.lock"

# If another cron is already running, skip this one
if [ -f "$LOCKFILE" ]; then
  # Check if the lock is stale (older than 10 min = something went wrong)
  if [ $(($(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0))) -gt 600 ]; then
    echo "$(date): Stale lock detected, removing..."
    rm -f "$LOCKFILE"
  else
    echo "$(date): Another run in progress, skipping."
    exit 0
  fi
fi

# Create lock
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

cd /root/edge-terminal

# Save current commit hash
OLD_HASH=$(git rev-parse HEAD)

# Pull latest — reset any local changes (state.json/config.json are gitignored so they're safe)
git fetch origin main 2>/dev/null
git reset --hard origin/main 2>/dev/null

# Check if code changed
NEW_HASH=$(git rev-parse HEAD)

if [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo "$(date): New code detected ($OLD_HASH → $NEW_HASH), restarting edge-bot service..."
  systemctl restart edge-bot
  sleep 3
fi

# Run the bot (one-shot mode for cron)
node /root/edge-terminal/bot/edge-bot.mjs --run
