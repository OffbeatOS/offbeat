#!/bin/sh
# The admin CLI inside the container, for example:
#   docker exec -it offbeat offbeat reset-password admin
# Runs as PUID:PGID, like the server, so it never leaves files in the config
# volume that Offbeat cannot read.
set -e
cd /app
if [ "$(id -u)" = "0" ]; then
  exec su-exec "$PUID:$PGID" node /app/server/dist/cli.js "$@"
fi
exec node /app/server/dist/cli.js "$@"
