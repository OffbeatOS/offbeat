# syntax=docker/dockerfile:1

# Keep in sync with .nvmrc. Angular 22 requires Node 22.22.3 or newer.
ARG NODE_VERSION=22.23.3

# Build stage: install everything, compile shared, web, and server, then drop
# dev dependencies so only runtime packages are copied forward.
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src

COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# better-sqlite3 13 has no install script: its N-API binaries for every
# platform (including linuxmusl amd64 and arm64) ship inside the package and
# are picked at load time. npm still runs node-gyp because binding.gyp exists,
# which fails without a toolchain, so skip scripts. The remaining install
# scripts belong to dev tools that also ship platform prebuilds.
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# Runtime stage
FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache su-exec tini

ENV NODE_ENV=production \
    PORT=3001 \
    CONFIG_DIR=/app/config \
    PUID=1000 \
    PGID=1000

WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/shared/package.json ./shared/
COPY --from=build /src/shared/dist ./shared/dist
COPY --from=build /src/server/package.json ./server/
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/server/drizzle ./server/drizzle
COPY --from=build /src/web/dist/web/browser ./web/dist/web/browser

# Fail the build (per architecture) if the SQLite binary cannot load.
RUN node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# `docker exec -it offbeat offbeat reset-password <user>` (see the README).
COPY docker/offbeat.sh /usr/local/bin/offbeat
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/offbeat

EXPOSE 3001
VOLUME ["/app/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}${BASE_URL%/}/api/v1/status" > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
