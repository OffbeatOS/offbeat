# syntax=docker/dockerfile:1

# Build stage: install everything, compile shared, web, and server, then drop
# dev dependencies so only runtime packages are copied forward.
FROM node:22-alpine AS build
WORKDIR /src

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# better-sqlite3 ships prebuilt binaries for linuxmusl amd64 and arm64, but npm
# still tries node-gyp because a binding.gyp is present. No install script in
# the tree is needed (the rest are dev tools with platform prebuilds), so skip them.
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# Runtime stage
FROM node:22-alpine
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
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3001
VOLUME ["/app/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}${BASE_URL%/}/api/v1/status" > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
