# offbeat

[![CI](https://github.com/OffbeatOS/offbeat/actions/workflows/ci.yml/badge.svg)](https://github.com/OffbeatOS/offbeat/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/OffbeatOS/offbeat?sort=semver)](https://github.com/OffbeatOS/offbeat/releases/latest)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Foffbeatos%2Foffbeat-2496ED?logo=docker&logoColor=white)](https://github.com/OffbeatOS/offbeat/pkgs/container/offbeat)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Self-hosted music discovery for Lidarr. Find new artists based on what you already have, add them to Lidarr in one click, and follow downloads as they land. Native streaming is planned.

> **Status: 0.1, early.** The library and request side works today (see below); discovery is next. Versions before 1.0 may include breaking changes between releases, so read the release notes before upgrading. See the [roadmap](ROADMAP.md) for what is done and what is coming.

## What works in 0.1

- **Library.** Your Lidarr library as a fast, filterable grid, served from a local cache so it stays usable even when Lidarr is down.
- **Search, Artist, and Album pages.** Look up anything on MusicBrainz, see what you already have track by track, and add an artist or a single album in one click.
- **Sensible adds.** Adding an artist monitors their latest album and future releases; adding one album gets just that album. Lidarr searches right away, and everything Offbeat adds is tagged `offbeat`. All of it can be changed in Settings.
- **Activity.** Searches, downloads, and imports update live, with plain-English reasons when an import is blocked, and Retry or Cancel in one click. The bottom bar shows the current download on every page.
- **One small container.** One process, one port, SQLite. No external database or cache.

Coming next: discovery (recommendations from your library and listening history, each with an explanation), then multi-user, flows and playlists, and streaming.

Offbeat talks to Lidarr for everything in your library; it never writes to your music folders itself.

## Quick start (Docker)

Images are published for `linux/amd64` and `linux/arm64` as `ghcr.io/offbeatos/offbeat`. Pin a version (`0.1`) rather than `latest` while Offbeat is pre-1.0.

With `docker run`:

```sh
docker run -d --name offbeat --restart unless-stopped \
  -p 3001:3001 \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -v "$(pwd)/config:/app/config" \
  ghcr.io/offbeatos/offbeat:0.1
```

Or with Compose (the same file is in [docker-compose.yml](docker-compose.yml)):

```yaml
services:
  offbeat:
    image: ghcr.io/offbeatos/offbeat:0.1
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
