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

## Phase 2: Discovery (done)

- [x] Recommendation engine (see [architecture](docs/architecture.md#discovery-engine)); works without any key through ListenBrainz
- [x] Discover page: Top Picks, Albums to Start With, Explore by Tag, mode switch, quick add
- [x] Tag pages
- [x] Feedback: thumbs up and down, and "never show this", with Undo
- [x] Blocklist (artists and tags) and hidden artists, managed in Settings, Discovery
- [x] Section controls: reorder and hide Discover sections per user
- [x] Settings, Discovery: default mode
- [x] Last.fm connection (optional step in onboarding, and in Settings), moved from phase 1 since discovery is its first use
- [x] Per-user Last.fm and ListenBrainz usernames
- [x] Scheduled daily refresh
- [x] Refresh Now in Settings, with progress
- [x] Activity flags imports stuck for over an hour, with Lidarr's reason and a link to Manual Import

## Phase 3: Multi-user and extras (done)

- [x] Users and permissions (add artists, add albums, change monitoring, delete, and flows, kept for when Flows arrive), with temporary passwords for new users and resets
- [x] Reverse-proxy header auth (trusted proxies, an optional shared secret, a sign-out page) and optional local-network auto-login
- [x] Notifications
  - Channels: Discord and generic webhooks (ntfy and Gotify later)
  - Events: album imported, download failed, import blocked, and new release from a monitored artist
  - Each channel chooses which events it receives, with a Send Test button
  - Channels are configured by admins (per-user preferences later)
  - Messages link back to the album or artist in Offbeat when "Link back to Offbeat" is set
  - Failed deliveries are retried and logged, and never block the rest of Offbeat
- [x] Lidarr webhook receiver (Settings, Integrations, Lidarr, Instant updates) for instant Activity updates on grab and import; polling stays as the fallback. Set Up Automatically creates or updates it after a test
- [x] Admin password reset CLI (`offbeat reset-password`, `list-users`, `make-admin`)
- [x] Since 0.3.0: adding an artist monitors all their albums by default (0.3.1), and tag pages show their artists in about two seconds, with starting albums found much faster (0.3.2)

## Phase 4: Streaming (in progress)

- [x] Library access: read audio through a read-only music folder mount, indexed by Lidarr's track files (paths, durations, quality), with a path mapping setting and a health check
- [x] Streaming: direct play with HTTP range requests, and ffmpeg transcoding for formats the browser cannot play
- [x] Player in the bottom bar, full Now Playing view, queue drawer, play actions on every card and track row, lock screen and media keys, keyboard shortcuts, and a Stream permission
- [x] Listening history: plays recorded locally and used as Discover seeds, with optional ListenBrainz submission
- [x] Short previews for artists not yet in the library (from Deezer)
- [ ] Subsonic API (OpenSubsonic), so existing third-party clients (mobile and desktop) can stream from Offbeat too, with per-user app passwords

## Distribution (ongoing)

- Unraid Community Applications template
- Bare-metal release tarball and a sample systemd unit
- README with quick start, screenshots, and configuration reference

## Open decisions

- **Preview source (phase 4, decided).** Deezer: it matched more artists than iTunes (66 of 67 recommended and 18 of 19 lesser-known, against 64 and 16), and its terms fit a non-commercial open source project; iTunes only allows previews that promote sales on Apple's store.

## Later

Ideas for after Phase 4, roughly grouped. Not scheduled or committed.

- **Inbox:** a per-user feed of new and upcoming releases from library artists, nearby shows, and personalized discoveries, with read, saved and dismissed states
- **Artist news:** optional RSS feeds matched against library and recommended artists, shown in the Inbox
- **Synced playlists:** playlists that stay in sync with Spotify, Last.fm or ListenBrainz, beyond one-time imports
- **Profile:** favorites and listening history
- **Wanted view:** missing albums and quality upgrades from Lidarr, in Activity
- **Theming:** light mode and alternate color palettes
- **Admin tools:** storage health checks, a scheduled tasks page, and a server-wide date format
- **More playback destinations:** Plex and Jellyfin, including per-user Plex accounts
- **More listening history sources:** Koito, plus scrobbling from Offbeat's own player
- **Authentication:** native OpenID Connect login, and group-based roles for proxy auth
- **Public API:** API keys and published endpoint documentation
- **Shows:** nearby concerts for library and recommended artists via Ticketmaster, with location and radius, and a Local Shows section on Discover
- **More notifications:** ntfy and Gotify channels, and per-user notification preferences
- **Docs site:** GitHub Pages documentation once the README outgrows itself
- **Soulseek downloads:** slskd as an optional source for single tracks, if there's demand
- **Flows:** self-refreshing playlists built from the library and discovery data, with a schedule, source mix and focus tags
- **Playlists:** importing JSON track lists and Spotify-style exports, and publishing to Navidrome

## Non-goals

- **Replacing Lidarr.** Offbeat is built on top of Lidarr. Library management, monitoring, indexers and download clients stay in Lidarr.
- **Downloading from streaming services.** No integrations that pull audio from streaming platforms against their terms.

Have an opinion? Start a thread in [Discussions](https://github.com/OffbeatOS/offbeat/discussions).
