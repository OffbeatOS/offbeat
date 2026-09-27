# Roadmap

Offbeat is an open-source, self-hosted music discovery and (eventually) streaming suite. The first phases cover discovery: find new artists, add them to Lidarr, track downloads, and build scheduled discovery playlists. Later phases add native streaming so Offbeat becomes an all-in-one music app.

- **Distribution:** Docker (primary) or a bare-metal Node install.
- **No website.** The README is the landing page.

How it is built is in [docs/architecture.md](docs/architecture.md); how it looks is in [docs/design](docs/design/README.md). Want to help? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Phase 0: Scaffold (done)

- [x] npm workspaces monorepo with `server`, `web`, `shared`
- [x] Fastify serving `/api/v1/status` and the built Angular app
- [x] SQLite with Drizzle, auto-migrate on boot, `CONFIG_DIR` handling
- [x] App shell with tokens, sidebar, empty bottom bar
- [x] Dockerfile (multi-stage, Alpine, PUID/PGID) and a docker-compose example
- [x] GitHub Actions: lint, typecheck, test, and a multi-arch (amd64 and arm64) image pushed to GHCR on version tags

## Phase 1: Library and requests (in progress)

- [x] Onboarding wizard: admin account, Lidarr connection with test, profile and folder dropdowns
- [ ] Optional Last.fm step in onboarding
- [x] Local accounts and sessions
- [x] Lidarr client with caching
- [x] Library screen
- [x] Search, Artist page, Album page, one-click add with saved defaults
- [x] Activity screen: queue, history, failures, retry
- [x] Bottom bar shows live download activity

## Phase 2: Discovery

- Recommendation engine (see [architecture](docs/architecture.md#discovery-engine))
- Discover page with sections, mode switch, feedback, quick add
- Blocklist (artists and tags)
- Per-user Last.fm and ListenBrainz usernames
- Scheduled refresh with a manual trigger

## Phase 3: Multi-user and extras

- Users and permissions (add artists, add albums, change monitoring, delete, access flows)
- Reverse-proxy header auth, optional local-network auto-login
- Notifications (Gotify, generic webhooks)
- Shows via Ticketmaster
- Admin password reset CLI

## Phase 4: Flows and playlists

- Flow editor (schedule, track count, source mix, focus tags and artists, deep dive, live preview)
- slskd integration for downloads into a dedicated Offbeat folder, never the main library
- File reuse from an existing library (hardlink, copy, or download)
- Playlist import (simple JSON track lists, Spotify-style exports)
- Navidrome publishing (flow library and smart playlists)

## Phase 5: Streaming

- Audio playback from the library with ffmpeg transcoding
- Player in the bottom bar, full Now Playing view, queue drawer
- Play actions on every card and track row
- Short previews for artists not yet in the library
- Evaluate implementing the Subsonic API so existing mobile clients work

## Distribution (ongoing)

- Unraid Community Applications template
- Bare-metal release tarball and a sample systemd unit
- README with quick start, screenshots, and configuration reference

## Open decisions

- **Streaming architecture (phase 5).** A native streaming API only, or also the Subsonic API for third-party clients.
- **Preview source (phase 5).** Which service provides short previews for artists not in the library.

Have an opinion on one of these? Start a thread in [Discussions](https://github.com/OffbeatOS/offbeat/discussions).
