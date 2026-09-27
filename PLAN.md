# Offbeat: Project Plan

Offbeat is an open-source, self-hosted music discovery and (eventually) streaming suite. The first phases cover discovery: find new artists, add them to Lidarr, track downloads, and build scheduled discovery playlists. Later phases add native streaming so Offbeat becomes an all-in-one music app.

- **Repo:** `github.com/OffbeatOS/offbeat`
- **Image:** `ghcr.io/offbeatos/offbeat`
- **Distribution:** Docker (primary) or bare-metal Node install, the same model as Seerr
- **No website.** The README is the landing page.

---

## 1. Working agreements

These apply to every change, including code, UI copy, docs, and commit messages.

1. **No em dashes anywhere.** Not in UI copy, commit messages, comments, docs, or generated content. Use commas, periods, colons, or parentheses instead.
2. **Definition of done is "verified live in a real browser."** A feature is not complete because the code looks right or tests pass. Run the app, exercise the feature in a browser, and confirm it works end to end.
3. **Design mockups are the source of truth for UI.** See `docs/design/` and Section 8.
4. **Keep the footprint small.** One process, one port, SQLite, no Redis, no external database. Anything that adds a required container needs a strong reason.
5. **Every upstream call is cached and rate limited.** MusicBrainz in particular enforces 1 request per second.
6. **Small, reviewable commits** with conventional commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`).

---

## 2. Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node 22 LTS, TypeScript (strict) | |
| Server | Fastify | `@fastify/static` serves the built frontend |
| Database | SQLite via `better-sqlite3` | Native module, must build per architecture |
| ORM / migrations | Drizzle | Migrations run automatically on boot |
| Scheduling | `croner` | In-process jobs |
| Rate limiting | `bottleneck` | One limiter per upstream service |
| Validation | Zod | API input and upstream response parsing |
| Auth | argon2 password hashes, HTTP-only session cookies | Reverse-proxy header auth later |
| Frontend | Angular (standalone components, signals) | Builds to static files served by Fastify |
| Monorepo | npm workspaces | |

---

## 3. Architecture

### One process, one port

A single Node process (default port `3001`) does three things:

1. Serves the REST API under `/api/v1`
2. Serves the compiled Angular app for every other route (SPA fallback to `index.html`)
3. Runs background jobs in-process (discovery refresh, Lidarr sync, flow runs)

### One config directory

All state lives in `CONFIG_DIR` (default `./config`, `/app/config` in Docker):

```
config/
  offbeat.db        SQLite database
  secret.key        generated on first boot, encrypts stored API keys
  cache/images/     cached artist and album art
  logs/
```

Backing up Offbeat means backing up this folder.

### Settings live in the UI

Environment variables are limited to deployment concerns. Everything else (Lidarr URL, API keys, discovery tuning) is configured through onboarding and Settings, and stored in SQLite with secrets encrypted using `secret.key`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port, default `3001` |
| `CONFIG_DIR` | Config directory path |
| `BASE_URL` | Subpath for reverse proxies, e.g. `/music` |
| `PUID` / `PGID` | Container user and group (Docker only) |
| `TZ` | Timezone for schedules |
| `TRUST_PROXY` | Trust `X-Forwarded-*` headers |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

### Repo layout

```
offbeat/
  server/            Fastify app, jobs, integrations, db
    src/
      api/           route modules, one per resource
      integrations/  lidarr/, lastfm/, listenbrainz/, musicbrainz/, coverart/, navidrome/, slskd/
      discovery/     recommendation engine
      jobs/          scheduled and queued work
      db/            drizzle schema and migrations
      auth/
  web/               Angular app
    src/app/
      core/          api client, auth, state
      shared/        shared components and design tokens
      features/      discover/, search/, library/, artist/, album/, activity/, flows/, settings/, onboarding/
  shared/            TypeScript types shared by server and web (API contracts)
  docs/
    design/          mockups (source of truth for UI)
  Dockerfile
  docker-compose.yml
  .github/workflows/
```

### Frontend shell requirement

The app shell has three regions: left sidebar, main content, and a **bottom bar**. The bottom bar exists from day one. In phases 1 through 4 it shows download activity; in phase 5 it becomes the audio player. The player must live outside the router outlet so playback survives navigation. Build the shell this way now so streaming does not require a layout rewrite.

---

## 4. Integrations

The MusicBrainz ID (MBID) is the universal join key across every service.

**Lidarr (required).** API v1 with the `X-Api-Key` header.
- `GET /api/v1/artist` for the library
- `GET /api/v1/artist/lookup?term=` for search
- `POST /api/v1/artist` to add (requires `qualityProfileId`, `metadataProfileId`, `rootFolderPath`, `monitored`, `addOptions.searchForMissingAlbums`)
- `GET /api/v1/album?artistId=` for releases and per-album status
- `GET /api/v1/queue` and `/api/v1/history` for Activity
- `GET /api/v1/qualityprofile`, `/metadataprofile`, `/rootfolder` to populate onboarding dropdowns
- Artists are keyed by `foreignArtistId` (an MBID)

**Last.fm (recommended).** Free API key.
- `artist.getSimilar` (match score 0 to 1), `artist.getTopTags`, `artist.getInfo`
- `tag.getTopArtists` for tag exploration
- `user.getTopArtists` for per-user listening weight

**ListenBrainz (optional).** Per-user listening history as an alternative to Last.fm.

**MusicBrainz.** Canonical metadata and release groups. Hard limit of 1 req/sec with a descriptive `User-Agent` (`Offbeat/<version> (https://github.com/OffbeatOS/offbeat)`). Cache aggressively.

**Cover Art Archive.** Album art by release group MBID. Cache to `config/cache/images`.

**Navidrome (phase 4).** Subsonic API for publishing flow libraries and smart playlists.

**slskd (phase 4).** External Soulseek client, used via its REST API for flow and playlist downloads. Offbeat does not embed a Soulseek client.

**Ticketmaster (phase 3, optional).** Nearby shows.

---

## 5. Discovery engine

Runs as a scheduled job per user; results are cached so the Discover page renders instantly.

1. **Seeds.** Library artists, weighted by the user's Last.fm or ListenBrainz play counts when available (equal weight otherwise).
2. **Candidates.** For each seed, fetch similar artists. Score each candidate as the sum of `match x seed_weight` across all seeds, so artists recommended by many seeds rise to the top.
3. **Filter.** Remove artists already in Lidarr, blocklisted artists, and artists carrying blocklisted tags.
4. **Mode.**
   - *Safer:* favor high match scores and multiple seed hits.
   - *Balanced:* default blend.
   - *Deeper:* add a second hop (similar of similar) and penalize high Last.fm listener counts.
5. **Variety.** Add a small random factor so the page changes between refreshes.
6. **Feedback.** Thumbs up/down on recommendations adjusts tag weights for future runs. "Never show this" adds to the blocklist.
7. **Explanations.** Store the strongest seed for each recommendation so the UI can show "Because you like X."

Discover sections: Top Picks for You, Albums to Start With, Explore by Tag, and (phase 3) Local Shows. Users can reorder or hide sections.

---

## 6. Data model (initial sketch)

- `users` (id, username, password_hash, role, permissions json, lastfm_username, listenbrainz_username, created_at)
- `sessions`
- `settings` (key, value json, encrypted flag)
- `artist_cache` (mbid, name, image, tags json, listeners, fetched_at)
- `similar_cache` (source_mbid, target_mbid, match, fetched_at)
- `recommendations` (user_id, artist_mbid, score, reason_seed_mbid, section, generated_at)
- `feedback` (user_id, artist_mbid, value, created_at)
- `blocklist` (user_id, kind [artist|tag], value)
- `requests` (id, user_id, artist_mbid, album_mbid, lidarr_id, created_at) to attribute Lidarr adds to Offbeat users
- `flows`, `flow_runs`, `flow_tracks` (phase 4)
- `playlists`, `playlist_tracks` (phase 4)
- `jobs` (name, last_run, status, error)

---

## 7. API outline

All routes under `/api/v1`. Generate an OpenAPI spec from Zod schemas.

- `GET /status` health check (used by Docker healthcheck)
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /setup/state`, `POST /setup/admin`, `POST /setup/lidarr/test`, `POST /setup/lidarr`, `POST /setup/lastfm`
- `GET /discover`, `POST /discover/refresh`, `POST /discover/feedback`
- `GET /search?q=`
- `GET /artists/:mbid`, `POST /artists/:mbid` (add to Lidarr), `PATCH /artists/:mbid` (monitoring)
- `GET /albums/:mbid`, `POST /albums/:mbid`
- `GET /library`
- `GET /activity`, `POST /activity/:id/retry`
- `GET|POST|PATCH|DELETE /blocklist`
- `GET|PUT /settings/:section`
- `GET|POST|PATCH|DELETE /users` (admin)
- Phase 4: `/flows`, `/playlists`

---

## 8. Design

### Mockups

`docs/design/` contains the mockups. They are standalone HTML files with inline styles.

**Important:** these files use a small template syntax from the design tool (`<sc-for>`, `<sc-if>`, `{{ }}` holes, and a `DCLogic` script block holding sample data). They are **visual reference, not code to port.** Rebuild every screen as Angular components using the tokens below. Match layout, spacing, colors, and type exactly.

| File | Screen |
| --- | --- |
| `Main.dc.html` | Discover (desktop) |
| `Artist.dc.html` | Artist page |
| `Mobile.dc.html` | Discover (mobile, 390px) |
| `Search.dc.html` | Search results |
| `Library.dc.html` | Library grid |
| `Activity.dc.html` | Activity (requests, downloads, failures) |
| `Flows.dc.html` | Flow list and editor |
| `Onboarding.dc.html` | Setup wizard, Lidarr step |
| `Settings.dc.html` | Settings, Integrations section |
| `Shows.dc.html` | Shows (concert listings) |
| `Album.dc.html` | Album page (partial state shown) |

### Principles

- Apple Music style minimalism: album art forward, generous whitespace, very little chrome.
- One accent color, used sparingly (active nav, logo dot, quick-add buttons). Everything else is grayscale.
- Never crowded. Fewer, well-chosen sections beat many rows.
- Avoid generic AI-app tropes: no gradient washes, no emoji, no left-border accent cards, no Inter/Roboto.
- Dark theme first. A light theme can come later via the same tokens.

### Design tokens

Put these in one file (`web/src/app/shared/tokens.scss` as CSS custom properties) and use them everywhere.

**Color: surfaces**

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#111113` | App background |
| `--bg-sidebar` | `#161618` | Sidebar, mobile tab bar |
| `--bg-bar` | `#19191C` | Bottom bar |
| `--surface` | `#18181B` | Cards, pills |
| `--surface-input` | `#1A1A1D` | Inputs, selects |
| `--surface-2` | `#1E1E21` | Segmented control track, secondary pills, selected list item |
| `--surface-3` | `#232327` | Active nav item, tertiary buttons, tag chips |
| `--surface-4` | `#34343A` | Selected segment |

**Color: borders**

| Token | Value | Use |
| --- | --- | --- |
| `--divider` | `#1F1F23` | List row dividers |
| `--border-sidebar` | `#222226` | Sidebar edge |
| `--border-bar` | `#25252A` | Bottom bar top edge |
| `--border-input` | `#2C2C31` | Inputs, tag pills |
| `--border-button` | `#34343A` | Outlined buttons |

**Color: text**

| Token | Value | Use |
| --- | --- | --- |
| `--text` | `#F2F2F2` | Primary |
| `--text-2` | `#B4B4BA` | Secondary, inactive nav, "In Library" |
| `--text-3` | `#9A9AA0` | Captions, metadata |
| `--text-4` | `#8E8E95` | Source labels, inactive steps |

**Color: accent and status**

| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#FF6B4A` | Active nav icon, logo dot, quick add, toggles |
| `--on-accent` | `#1A0D08` | Icons and text on accent |
| `--status-progress` | `#6CB4FF` | Downloading, searching, progress bars |
| `--status-failed` | `#FF8A7A` | Failed text and icons |
| `--status-failed-bg` | `#1C1719` | Failed row background |
| `--status-failed-border` | `#3A2626` | Failed row border |
| `--track` | `#2E2E33` | Progress and slider tracks |

Primary buttons are `--text` fill with `--bg` text (white pill, dark label).

**Status chip states** (use identically everywhere):

| State | Treatment |
| --- | --- |
| Not in Library | Outlined "Add" pill button with plus icon |
| Requested / Searching | `--status-progress` text |
| Downloading | `--status-progress` text with percentage and 3px progress bar |
| In Library | `--text-2` with check icon |
| Partial | `--text-3` text, e.g. "2 missing" |
| Failed | `--status-failed` with alert icon, plus Retry action |

**Typography**

Font: [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans), weights 400, 500, 600, 700. Fallback: `-apple-system, 'Helvetica Neue', sans-serif`. Self-host the font files so the app works offline.

| Role | Size / weight / tracking |
| --- | --- |
| Artist hero name | 76px / 700 / -0.035em |
| Page title | 34px / 700 / -0.025em |
| Wordmark | 22px / 700 / -0.03em, lowercase "offbeat" with accent dot |
| Section heading | 20px / 600 / -0.01em |
| Card title | 17px / 600 |
| Body / list title | 14 to 15px / 500 |
| Caption / metadata | 13px / 400 |
| Small / chip | 12px / 500 |
| Overline | 13px / 600 / 0.06em uppercase |

**Radius:** 5 to 6px small art thumbnails, 8px album art and nav items, 10px inputs and segmented controls, 12px cards and hero tiles, fully rounded for pills and buttons, 50% for artist images.

**Spacing and layout:**
- Sidebar width 232px, bottom bar height 72px
- Page padding 40px top, 48px sides
- Section gap 44px, heading to content 16px
- Grid gap 20px; album rows are 6 columns on desktop, library artist grid 7 columns
- Touch targets at least 44px on mobile

**Icons:** 24px viewBox stroke icons at 1.8px stroke, `currentColor`. Use Lucide or match its style.

### Shared components to build

- App shell (sidebar, content, bottom bar)
- Sidebar nav item (active state)
- Mobile tab bar and mini bar
- Segmented control (discovery mode)
- Filter pill group
- Artist card (circle) and artist feature card (Top Picks)
- Album card (square) with optional status chip
- Status chip (all states above)
- List row (Activity, Search albums, Flow preview)
- Section header
- Slider and toggle
- Form field (label, input, helper text), select
- Empty, loading, and error states for every screen (not in mockups, follow the same style)

---

## 9. Roadmap

### Phase 0: Scaffold
- npm workspaces monorepo with `server`, `web`, `shared`
- Fastify serving `/api/v1/status` and the built Angular app
- SQLite with Drizzle, auto-migrate on boot, `CONFIG_DIR` handling
- App shell with tokens, sidebar, empty bottom bar
- Dockerfile (multi-stage, `node:22-alpine`, PUID/PGID), docker-compose example
- GitHub Actions: lint, typecheck, test, multi-arch (amd64 + arm64) build pushed to GHCR on tags

### Phase 1: Library and requests
- Onboarding wizard (admin account, Lidarr connection with test, profile/folder dropdowns, optional Last.fm)
- Local auth and sessions
- Lidarr client with caching
- Search, Artist page, Album page, one-click add with defaults
- Library screen
- Activity screen (queue, history, failures, retry)
- Bottom bar shows live download activity

### Phase 2: Discovery
- Recommendation engine (Section 5)
- Discover page with sections, mode switch, feedback, quick add
- Blocklist (artists and tags)
- Per-user Last.fm / ListenBrainz usernames
- Scheduled refresh with manual trigger

### Phase 3: Multi-user and extras
- Users and permissions (add artists, add albums, change monitoring, delete, access flows)
- Reverse-proxy header auth, optional local-network auto-login
- Notifications (Gotify, generic webhooks)
- Shows via Ticketmaster
- Admin password reset CLI

### Phase 4: Flows and playlists
- Flow editor (schedule, track count, source mix, focus tags/artists, deep dive, live preview)
- slskd integration for downloads into a dedicated Offbeat folder, never the main library
- File reuse from existing library (hardlink, copy, or download)
- Playlist import (simple JSON track lists, Spotify-style exports)
- Navidrome publishing (flow library and smart playlists)

### Phase 5: Streaming
- Audio playback from the library with ffmpeg transcoding
- Player in the bottom bar, full Now Playing view, queue drawer
- Play actions on every card and track row
- Short previews for artists not yet in the library
- Evaluate implementing the Subsonic API so existing mobile clients work

### Distribution (ongoing)
- Unraid Community Applications template
- Bare-metal release tarball and sample systemd unit
- README with quick start, screenshots, and configuration reference

---

## 10. Details that save pain later

- Prefix every route with `/api/v1` from day one.
- Support `BASE_URL` for subpath reverse proxies from day one. Retrofitting this into an SPA is painful.
- The Lidarr URL Offbeat uses is the one reachable from its container (often `http://lidarr:8686`), not the browser URL. Say so in onboarding.
- Render from cache first, refresh in the background. The Discover page should never wait on upstream APIs.
- Encrypt stored API keys with the generated `secret.key`.
- Offbeat never writes directly into the user's main music library. Library changes go through Lidarr; generated flow files go in Offbeat's own folder.

---

## 11. Open decisions

- **Streaming architecture (phase 5).** Build a native streaming API only, or also implement the Subsonic API for third-party clients.
- **Preview source (phase 5).** Which service provides short previews for artists not in the library.
