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

## Phase 1: Library and requests (done)

- [x] Onboarding wizard: admin account, Lidarr connection with test, profile and folder dropdowns
- [x] Local accounts and sessions
- [x] Lidarr client with caching
- [x] Library screen
- [x] Search, Artist page, Album page, one-click add with saved defaults
- [x] Activity screen: queue, history, failures, retry
- [x] Bottom bar shows live download activity

## Phase 2: Discovery (in progress)

- [x] Recommendation engine (see [architecture](docs/architecture.md#discovery-engine)); works without any key through ListenBrainz
- [ ] Discover page with sections, mode switch, feedback, quick add
- [x] Blocklist (artists and tags)
- [x] Last.fm connection (optional step in onboarding, and in Settings), moved from phase 1 since discovery is its first use
- [x] Per-user Last.fm and ListenBrainz usernames
- [ ] Scheduled refresh with a manual trigger

## Phase 3: Multi-user and extras

- Users and permissions (add artists, add albums, change monitoring, delete, access flows)
- Reverse-proxy header auth, optional local-network auto-login
- Notifications
  - Channels: ntfy, Discord, Gotify, and generic webhooks
  - Events: album imported, download failed, import blocked, and new release from a monitored artist
  - Each channel chooses which events it receives, with a Send Test button
  - Admin-configured channels at first; per-user preferences follow the users and permissions work
  - Messages link back to the album or artist in Offbeat when a base URL is set
  - Failed deliveries are retried and logged, and never block the rest of Offbeat
- Lidarr webhook receiver (Settings, Connect, Webhook in Lidarr) for instant Activity updates on grab and import; polling stays as the fallback
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
- Native streaming API for the Offbeat web app
- Subsonic API, so existing third-party clients (mobile and desktop) can stream from Offbeat too

## Distribution (ongoing)

- Unraid Community Applications template
- Bare-metal release tarball and a sample systemd unit
- README with quick start, screenshots, and configuration reference

## Open decisions

- **Preview source (phase 5).** Which service provides short previews for artists not in the library.

## Later

Ideas for after Phase 5, roughly grouped. Not scheduled or committed.

- **Inbox:** a per-user feed of new and upcoming releases from library artists, nearby shows, and personalized discoveries, with read, saved and dismissed states
- **Artist news:** optional RSS feeds matched against library and recommended artists, shown in the Inbox
- **Synced playlists:** playlists that stay in sync with Spotify, Last.fm or ListenBrainz, beyond one-time imports
- **Profile:** favorites and listening history
- **Wanted view:** missing albums and quality upgrades from Lidarr, in Activity
- **Theming:** light mode and alternate color palettes
- **Admin tools:** storage health checks, a scheduled tasks page, and a server-wide date format
- **More playback destinations:** Plex and Jellyfin, including per-user Plex accounts
- **More listening history sources:** Koito, plus scrobbling from Offbeat's own player
- **Authentication:** native OpenID Connect login; group-based roles, trusted proxy IPs and a logout URL for proxy auth
- **Public API:** API keys and published endpoint documentation
- **Docs site:** GitHub Pages documentation once the README outgrows itself

## Non-goals

- **Replacing Lidarr.** Offbeat is built on top of Lidarr. Library management, monitoring, indexers and download clients stay in Lidarr.
- **Downloading from streaming services.** No integrations that pull audio from streaming platforms against their terms.

Have an opinion? Start a thread in [Discussions](https://github.com/OffbeatOS/offbeat/discussions).
