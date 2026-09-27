# Architecture

How Offbeat is put together. For what is planned, see the [roadmap](../ROADMAP.md); for how it looks, see [design](design/README.md).

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node 22 LTS (or 24), TypeScript (strict) | Version pinned in `.nvmrc` |
| Server | Fastify | `@fastify/static` serves the built frontend |
| Database | SQLite via `better-sqlite3` | Prebuilt binaries for every platform ship in the package |
| ORM and migrations | Drizzle | Migrations run automatically on boot |
| Scheduling | `croner` | In-process jobs |
| Rate limiting | `bottleneck` | One limiter per upstream service |
| Validation | Zod | API input and upstream response parsing |
| Auth | argon2id password hashes, HTTP-only session cookies | Reverse-proxy header auth later |
| Frontend | Angular (standalone components, signals) | Builds to static files served by Fastify |
| Monorepo | npm workspaces | `shared`, `server`, `web` |

## One process, one port

A single Node process (default port `3001`) does three things:

1. Serves the REST API under `<BASE_URL>/api/v1`
2. Serves the compiled Angular app for every other route (SPA fallback to `index.html`, with `<base href>` rewritten for `BASE_URL`)
3. Runs background jobs in-process (Lidarr library sync today; discovery refresh and flow runs later)

Keeping the footprint small is deliberate: no Redis, no external database, nothing that needs a second container.

## One config directory

All state lives in `CONFIG_DIR` (default `./config`, `/app/config` in Docker):

```
config/
  offbeat.db        SQLite database
  secret.key        generated on first boot, encrypts stored API keys
  cache/images/     proxied artwork, capped with least recently used eviction
  logs/
```

Backing up Offbeat means backing up this folder.

## Settings live in the UI

Environment variables cover deployment only. Everything else (Lidarr URL and key, add defaults, discovery tuning) is configured through onboarding and Settings, and stored in SQLite. Add defaults out of the box: adding an artist monitors their latest album and future releases, adding one album monitors just that album, Lidarr searches right away, and everything Offbeat adds is tagged `offbeat`. Sections that hold credentials are encrypted as a whole with AES-256-GCM using `secret.key`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port, default `3001` |
| `CONFIG_DIR` | Config directory path |
| `BASE_URL` | Subpath for reverse proxies, for example `/music` |
| `PUID` / `PGID` | Container user and group (Docker only) |
| `TZ` | Timezone for schedules |
| `TRUST_PROXY` | Trust `X-Forwarded-*` headers |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

## Repo layout

```
offbeat/
  server/              Fastify app
    src/
      api/             route modules, one per resource
      auth/            sessions, password hashing, route guard, login throttling
      catalog/         search, artist and album pages, adds
      crypto/          secret box for stored credentials
      db/              Drizzle schema (migrations in server/drizzle/)
      integrations/    lidarr/, musicbrainz/ (lastfm/, listenbrainz/, navidrome/, slskd/ later)
      library/         cached Lidarr library, artwork cache and image proxy
      settings/        typed, encrypted settings store
    test/              Vitest suites and fakes for Lidarr and MusicBrainz
  web/                 Angular app
    src/app/
      core/            API client, session, guards
      shared/          shell, design tokens, shared components
      features/        one folder per screen
  shared/              TypeScript types shared by server and web (API contracts)
  docs/                architecture, design system, mockups
  Dockerfile, docker-compose.yml, .github/
```

## App shell

The shell has three regions: sidebar, main content, and a bottom bar. In phases 1 to 4 the bottom bar shows download activity; in phase 5 it becomes the audio player. It lives outside the router outlet so playback survives navigation. Signed-in pages render inside the shell; onboarding and sign-in are full-page.

## Security model

- Every API route requires a session unless it is explicitly public (`status`, `setup/state`, `setup/admin` before an admin exists, `auth/*`). Admin-only routes are marked by role.
- Sessions are random tokens in HTTP-only, `SameSite=Lax` cookies scoped to `BASE_URL`, stored server side only as SHA-256 hashes. `Secure` is set when the request arrived over HTTPS through a trusted proxy.
- State-changing requests must be `application/json`, which cross-site forms cannot send.
- Failed logins are throttled per client address (proxy aware when `TRUST_PROXY` is set). Unknown usernames take as long as wrong passwords.
- The Lidarr API key never reaches the browser. Artwork is proxied: Lidarr artwork is fetched server side with the key, and public artwork only through HMAC-signed URLs to an allowlist of hosts, re-checked on every redirect.
- Upstream failures are returned as readable 422 or 503 errors, never 401, so they cannot look like an expired session.

## Integrations

The MusicBrainz ID (MBID) is the join key across every service. Pages are routed by MBID, so the same page works before and after an artist is added.

**Lidarr (required).** API v1 with the `X-Api-Key` header, through one rate limiter per instance.
- `GET /artist` for the library, cached in SQLite and refreshed in the background (stale after 5 minutes, full sync every 15)
- `GET /wanted/missing` for missing album counts
- `GET /artist/lookup` and `/album/lookup` for search (`lidarr:<mbid>` looks up one artist)
- `POST /artist` to add, `PUT /album/monitor` to monitor one album, `POST /command` for `AlbumSearch`
- `GET /album?artistId=` for per-album status. Use `statistics.totalTrackCount`: `trackCount` is 0 for unmonitored artists.
- `GET /command` to wait for a new artist's refresh and post-add actions before monitoring a single album (they would otherwise reset it), and to show albums Lidarr is searching for
- `GET /queue` and `GET /history` for Activity; `DELETE /queue/:id` to cancel, or to retry with `blocklist=true` followed by a fresh `AlbumSearch`
- `GET /qualityprofile`, `/metadataprofile`, `/rootfolder` for onboarding
- `/MediaCover/...` for artwork, proxied

**MusicBrainz.** Release groups and track lists for artists not in Lidarr. Hard limit of 1 request per second with a descriptive `User-Agent` (`Offbeat/<version> ( https://github.com/OffbeatOS/offbeat )`). Responses are cached in SQLite for a week and served stale if MusicBrainz is unavailable.

**Cover Art Archive.** Album art by release group MBID, proxied and cached. When it has no cover, Offbeat falls back to the one Lidarr has, then to a flat placeholder (`GET /images/album/:mbid` picks the source).

**Last.fm (planned, recommended).** `artist.getSimilar`, `artist.getTopTags`, `artist.getInfo`, `tag.getTopArtists`, `user.getTopArtists`.

**ListenBrainz (planned, optional).** Per-user listening history as an alternative to Last.fm.

**Navidrome (phase 4).** Subsonic API for publishing flow libraries and smart playlists.

**slskd (phase 4).** External Soulseek client, used through its REST API. Offbeat does not embed a Soulseek client.

**Ticketmaster (phase 3, optional).** Nearby shows.

## Activity

One server-side poller reads Lidarr's queue, commands, and history, and pushes a snapshot to every open tab over Server-Sent Events (`GET /api/v1/events`). Browsers never poll Lidarr, and ten open tabs cost the same as one.

- **Cadence.** Every 3 seconds while something is moving and someone is watching, 30 seconds when idle, 15 or 120 seconds with no tabs open. After anything that can lead to a grab (an add, Search Missing, a retry) or a new "grabbed" event in Lidarr's history (a search started in Lidarr), it stays at the fast rate for three minutes: a small download can be grabbed and imported between two idle polls.
- **States.** Lidarr's client status and tracked download state become one plain state: adding, searching, queued, downloading, importing, paused, import blocked, failed. Import blocked and failed go under Needs Attention with a plain-English reason, Lidarr's own messages behind a toggle, and a link to the right Lidarr page.
- **Adds are non-blocking.** `POST /albums/:mbid` answers 202 at once; the add runs in the background and reports back as an `add-result` event. A failed add shows under Needs Attention with Retry.
- **Attribution.** Items added through Offbeat say who asked for them (from `requests`); everything else says "Added in Lidarr".
- When an item leaves the queue, album statuses and the library cache refresh.

## Discovery engine

Planned for phase 2. Runs as a scheduled job per user; results are cached so the Discover page renders instantly.

1. **Seeds.** Library artists, weighted by the user's Last.fm or ListenBrainz play counts when available (equal weight otherwise).
2. **Candidates.** For each seed, fetch similar artists. Score each candidate as the sum of `match x seed_weight` across all seeds, so artists recommended by many seeds rise to the top.
3. **Filter.** Remove artists already in Lidarr, blocklisted artists, and artists carrying blocklisted tags.
4. **Mode.**
   - *Safer:* favor high match scores and multiple seed hits.
   - *Balanced:* default blend.
   - *Deeper:* add a second hop (similar of similar) and penalize high Last.fm listener counts.
5. **Variety.** Add a small random factor so the page changes between refreshes.
6. **Feedback.** Thumbs up or down adjusts tag weights for future runs. "Never show this" adds to the blocklist.
7. **Explanations.** Store the strongest seed for each recommendation so the UI can show "Because you like X."

Discover sections: Top Picks for You, Albums to Start With, Explore by Tag, and (phase 3) Local Shows. Users can reorder or hide sections.

## Data model

Current tables (see `server/src/db/schema.ts`):

- `users` (id, username unique regardless of case, password_hash, role, permissions, lastfm_username, listenbrainz_username, created_at)
- `sessions` (sha256 of token, user_id, expires_at)
- `settings` (key, value json or ciphertext, encrypted flag)
- `library_artists` (cached Lidarr artists: ids, names, sort name, monitoring, stats, missing albums, artwork paths)
- `musicbrainz_cache` (request path, body, fetched_at)
- `requests` (user_id, artist and album MBIDs, Lidarr ids) to attribute adds to users
- `jobs` (name, last run, last success, error)

Planned: `artist_cache`, `similar_cache`, `recommendations`, `feedback`, `blocklist` (phase 2); `flows`, `flow_runs`, `flow_tracks`, `playlists`, `playlist_tracks` (phase 4).

## API

All routes live under `/api/v1`. Implemented:

- `GET /status` health check (used by the Docker healthcheck)
- `GET /setup/state`, `POST /setup/admin`, `POST /setup/lidarr/test`, `POST /setup/lidarr`
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /settings/lidarr`, `PUT /settings/lidarr`
- `GET /library`, `POST /library/refresh`
- `GET /search?q=`
- `GET /artists/:mbid`, `POST /artists/:mbid` (add), `PATCH /artists/:mbid` (monitoring)
- `GET /albums/:mbid`, `POST /albums/:mbid` (add), `PATCH /albums/:mbid` (monitoring), `POST /albums/:mbid/search`
- `GET /activity`, `POST /activity/:id/retry`, `DELETE /activity/:id` (cancel a download)
- `GET /events` (Server-Sent Events: `activity` snapshots and `add-result`)
- `GET /images/artist/:id`, `GET /images/album/:mbid`, `GET /images/remote` (signed)

Planned: `/discover` and `/blocklist` (phase 2), `/users` (phase 3), `/flows` and `/playlists` (phase 4). An OpenAPI spec generated from the Zod schemas is planned.

## Details that save pain later

- Every route is under `/api/v1` from day one.
- `BASE_URL` works from day one; retrofitting a subpath into an SPA is painful.
- The Lidarr URL Offbeat uses is the one reachable from its container (often `http://lidarr:8686`), not the browser URL. Onboarding says so.
- Every upstream request has one deadline that covers the whole exchange, body included (`server/src/integrations/http.ts`). `AbortSignal.timeout()` alone can be garbage collected mid-body and never fire.
- Background loops start themselves (Activity polling starts in the app's `onReady` hook) and a stuck iteration is abandoned, never left to stop the loop.
- Render from cache first, refresh in the background. Pages should never wait on upstream APIs they do not need.
- Offbeat never writes directly into the user's music library. Library changes go through Lidarr; generated flow files go in Offbeat's own folder.
