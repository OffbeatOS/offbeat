# offbeat

Self-hosted music discovery for Lidarr. Find new artists based on what you already listen to, add them to Lidarr in one click, and follow downloads as they land. Native streaming is planned.

> **Status:** early development. The app shell, server, and packaging are in place; features arrive phase by phase (see [PLAN.md](PLAN.md)).

## Quick start (Docker)

```yaml
services:
  offbeat:
    image: ghcr.io/xwolvos/offbeat:latest
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
    volumes:
      - ./config:/app/config
```

Then open `http://<host>:3001`. Everything Offbeat stores (database, encryption key, image cache, logs) lives in the config volume, so backing up Offbeat means backing up that folder.

## Configuration

Integrations and discovery settings are configured in the web UI. Environment variables cover deployment only:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Listen port |
| `CONFIG_DIR` | `./config` (`/app/config` in Docker) | Where state is stored |
| `BASE_URL` | none | Subpath when behind a reverse proxy, for example `/music` |
| `PUID` / `PGID` | `1000` | User and group the container runs as |
| `TZ` | `UTC` | Timezone for schedules |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

## Development

Requires Node 22.22.3+ or 24.15+ (Angular 22 needs it). `.nvmrc` pins the version CI and Docker use; with nvm or fnm, `nvm use` picks it up. `npm install` refuses to run on an older Node.

```sh
npm install
npm run dev        # API on :3001 with reload, Angular on :4200 proxying /api
```

Other scripts, all run from the repo root:

| Script | What it does |
| --- | --- |
| `npm run build` | Builds `shared`, `web`, and `server` |
| `npm start` | Runs the production build on :3001 |
| `npm run lint` | ESLint plus the no em dash check |
| `npm run typecheck` | Type checks every workspace |
| `npm test` | Server tests (Vitest) and web tests (Angular + Vitest) |
| `npm run db:generate` | Generates a Drizzle migration after editing `server/src/db/schema.ts` |

Migrations run automatically on boot.

### Layout

```
server/   Fastify API, jobs, integrations, SQLite via Drizzle
web/      Angular app (served by the server in production)
shared/   API contract types used by both
```

## License

[MIT](LICENSE)
