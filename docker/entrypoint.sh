#!/bin/sh
# Runs Offbeat as PUID:PGID so files in the config volume match the host user.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG_DIR"
  # Only fix ownership when it is wrong, so large image caches do not slow boot.
  if [ "$(stat -c %u:%g "$CONFIG_DIR")" != "$PUID:$PGID" ]; then
    echo "Setting ownership of $CONFIG_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$CONFIG_DIR"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

# Already started as a non-root user (for example `docker run --user`).
exec "$@"
