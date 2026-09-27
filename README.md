# offbeat

[![CI](https://github.com/OffbeatOS/offbeat/actions/workflows/ci.yml/badge.svg)](https://github.com/OffbeatOS/offbeat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Self-hosted music discovery for Lidarr. Find new artists based on what you already have, add them to Lidarr in one click, and follow downloads as they land. Native streaming is planned.

> **Status:** early development. Onboarding, accounts, the Library, Search, and the Artist and Album pages with one-click adds work today; the Activity screen is next. See the [roadmap](ROADMAP.md) for what is done and what is coming.

## What it does

- **Library.** Your Lidarr library as a fast, filterable grid, served from a local cache so it stays usable even when Lidarr is down.
- **Search, Artist, and Album pages.** Look up anything on MusicBrainz, see what you already have track by track, and add an artist or a single album with your saved defaults.
- **Discovery (phase 2).** Recommendations built from your library and listening history, with an explanation for each one.
- **One small container.** One process, one port, SQLite. No external database or cache.

Offbeat talks to Lidarr for everything in your library; it never writes to your music folders itself.

## Quick start (Docker)

No release has been published yet, so for now build the image from source:

```sh
git clone https://github.com/OffbeatOS/offbeat.git
cd offbeat
docker build -t offbeat .
```

Then run it with Compose (use `image: offbeat` until a release is published):

```yaml
services:
  offbeat:
    image: ghcr.io/offbeatos/offbeat:latest
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

Open `http://<host>:3001`, create the admin account, and connect Lidarr. Use the Lidarr address Offbeat can reach from its container (often `http://lidarr:8686` on a shared Docker network), not necessarily the one in your browser.

Everything Offbeat stores (database, encryption key, image cache, logs) lives in the config volume, so backing up Offbeat means backing up that folder.

## Configuration

Integrations and add behavior are configured in the web UI. Environment variables cover deployment only:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Listen port |
| `CONFIG_DIR` | `./config` (`/app/config` in Docker) | Where state is stored |
| `BASE_URL` | none | Subpath when behind a reverse proxy, for example `/music` |
| `PUID` / `PGID` | `1000` | User and group the container runs as |
| `TZ` | `UTC` | Timezone for schedules |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers (set this behind a reverse proxy) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md): it covers setup, running without a real Lidarr, the checks CI runs, and the project's working agreements. Questions and ideas go to [Discussions](https://github.com/OffbeatOS/offbeat/discussions); security problems go through [SECURITY.md](SECURITY.md).

- [Roadmap](ROADMAP.md)
- [Architecture](docs/architecture.md)
- [Design system and mockups](docs/design/README.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
