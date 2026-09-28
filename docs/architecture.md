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
| `SESSION_COOKIE` | Session cookie name (default `offbeat_session`); set a different one per instance when several share a host |

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
- **Roles and permissions.** Admins can do everything. Members can browse and use their own Discover, feedback, and blocklist, plus what an admin grants: add artists, add albums (also Search Missing and Retry), change monitoring, delete from Lidarr (removing downloads), and use Flows. A route declares its permission and the guard enforces it on the server; the web app only hides what would be refused. A test lists every API route and fails if one is not public, admin only, permission gated, or on an explicit list open to any signed-in user.
- **Accounts.** Admins add users and reset passwords, but never choose them: Offbeat makes a temporary password (shown once), and until the user replaces it every route except changing it answers 403. A temporary password works for 7 days. A reset signs the user out everywhere; removing a user does too, and their requests then read "requested by sam (removed)" (user ids are never reused, so a new account with the same name is never credited). The last admin can never be demoted or removed, and nobody removes themselves. Role and permission changes apply on the next request, without signing in again: the server rereads the user every time, and the web app refreshes who is signed in after any 403 and when the tab regains focus, leaving admin pages and hiding buttons as needed.
- **Sign-in methods** (`server/src/auth/sign-in.ts`, `network.ts`). Each request is identified by, in order: the proxy header, but only when the TCP connection comes from a configured trusted proxy (addresses or CIDR ranges, empty by default); then the session cookie; then local network auto-login. The real client address is the socket address, or through trusted proxies the nearest `X-Forwarded-For` entry that is not one of them; forwarding headers from anything else make a request unverifiable, so never local. Inside Docker, the bridge gateway and Docker Desktop's gateway (found at startup from the routing table and `gateway.docker.internal`) can stand for any visitor, so they never count as local and cannot be saved in a local network range. An optional shared secret (a header the proxy adds, compared in constant time) makes the username count only when the secret comes with it, so a proxy route that passes on a visitor's own header cannot sign anyone in; the secret is stored encrypted and never sent to the browser. Auto-login and auto-created proxy users are always Members. Unknown proxy usernames get a "no Offbeat account" answer unless auto-create is on, and a sign-out URL sends Sign out to the proxy. Public routes (such as the Lidarr webhook) skip all of this and check their own token.
- **Admin CLI.** `offbeat reset-password`, `list-users`, and `make-admin` (`server/src/cli.ts`; `docker exec -it offbeat offbeat ...` in the container, which drops to PUID:PGID) recover access when no admin can sign in. They work while the server runs, since SQLite is in WAL mode with a busy timeout, and refuse to run when there is no database at `CONFIG_DIR` rather than creating an empty one.
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
- A single-album add leaves the artist monitored (Lidarr only searches, re-grabs, and upgrades albums of monitored artists), with future releases off and only that album monitored, whatever "Monitor new artists" says. Lidarr leaves an artist added with no albums to monitor unmonitored, so Offbeat re-applies it after the post-add actions. An artist already in Lidarr but unmonitored becomes monitored with future releases off; one the user already monitors is left as it is. Monitoring an unmonitored artist again also resumes any of its albums still marked monitored, so in that case `POST /albums/:mbid` answers 409 naming those albums, and the add goes ahead only with `resumeMonitoring: true` (the UI asks first: Add anyway or Cancel).
- Deleting an artist while Lidarr is still refreshing it makes Lidarr add it back ("Adding missing parent artist"). Anything that removes artists must wait until no RefreshArtist is queued or running.
- `GET /queue` and `GET /history` for Activity; `DELETE /queue/:id` to cancel, or to retry with `blocklist=true` followed by a fresh `AlbumSearch`
- `GET /qualityprofile`, `/metadataprofile`, `/rootfolder` for onboarding
- `/MediaCover/...` for artwork, proxied

**MusicBrainz.** Release groups and track lists for artists not in Lidarr. Hard limit of 1 request per second with a descriptive `User-Agent` (`Offbeat/<version> ( https://github.com/OffbeatOS/offbeat )`). Responses are cached in SQLite for a week and served stale if MusicBrainz is unavailable.

**Cover Art Archive.** Album art by release group MBID, proxied and cached. When it has no cover, Offbeat falls back to the one Lidarr has, then to a flat placeholder (`GET /images/album/:mbid` picks the source).

**ListenBrainz (built in, no key).** The default source for discovery, so recommendations work with no API key. Similar artists come from the ListenBrainz Labs similarity data, keyed by MBID, so no name matching is needed. Users can add a ListenBrainz username in Settings, Account to weight seeds by their listening history (checked with `/1/user/<name>/listen-count` when saved).

**Last.fm (optional, preferred when present).** An admin adds an API key in onboarding or Settings, Integrations; it is checked with Last.fm, stored encrypted, and only its last four characters reach the browser. When connected, Last.fm is the preferred source for similar artists and tags, alongside ListenBrainz. Users can add a Last.fm username in Settings, Account (checked with `user.getInfo`). Methods: `artist.getSimilar`, `artist.getTopTags`, `artist.getInfo`, `tag.getTopArtists`, `user.getTopArtists`. Paced at five requests per second.

**Navidrome (phase 4).** Subsonic API for publishing flow libraries and smart playlists.

**slskd (phase 4).** External Soulseek client, used through its REST API. Offbeat does not embed a Soulseek client.

**Ticketmaster (later, optional).** Nearby shows.

## Activity

One server-side poller reads Lidarr's queue, commands, and history, and pushes a snapshot to every open tab over Server-Sent Events (`GET /api/v1/events`). Browsers never poll Lidarr, and ten open tabs cost the same as one.

- **Cadence.** Every 3 seconds while something is moving and someone is watching, 30 seconds when idle, 15 or 120 seconds with no tabs open. After anything that can lead to a grab (an add, Search Missing, a retry) or a new "grabbed" event in Lidarr's history (a search started in Lidarr), it stays at the fast rate for three minutes: a small download can be grabbed and imported between two idle polls.
- **States.** Lidarr's client status and tracked download state become one plain state: adding, searching, queued, downloading, importing, paused, import blocked, failed. Import blocked and failed go under Needs Attention with a plain-English reason, Lidarr's own messages behind a toggle, and a link to the right Lidarr page.
- **Adds are non-blocking.** `POST /albums/:mbid` answers 202 at once; the add runs in the background and reports back as an `add-result` event. A failed add shows under Needs Attention with Retry.
- **Attribution.** Items added through Offbeat say who asked for them (from `requests`); everything else says "Added in Lidarr".
- When an item leaves the queue, album statuses and the library cache refresh.
- **Lidarr webhook** (`server/src/api/webhook.ts`). Lidarr calls `POST /api/v1/webhooks/lidarr` on grab, import, upgrade, and download or import failure. It is a public route that checks only Basic auth (user `offbeat`, a random token as password, compared in constant time), never a token in the URL. The body is not trusted: any event just makes Activity poll Lidarr now, then quickly for a few minutes. Polling on a timer (30 seconds with a browser watching and nothing moving) stays as the fallback. Set Up Automatically asks Lidarr to send its Test event to the callback address first and saves only if Lidarr succeeded and the event reached this Offbeat; it then updates Offbeat's existing webhook in Lidarr (found by id, name, or receiver path) rather than adding another. Lidarr requires unique names even when testing, so a test of the existing webhook carries its id.
- **Notifications** (`server/src/notifications`). Discord and generic webhook channels, configured by admins, each with its own events. Sources: Lidarr's history, read during Activity polls (album imported and download failed, one message per album download however many history entries it has); Activity's Needs Attention (an import newly blocked or stuck); and Lidarr's calendar every 15 minutes (an album appearing for a monitored artist, skipping artists in their first day). The first look at each source only records where things stand. Sending runs in the background, one message at a time per channel: a 429 from Discord waits as long as Discord says, other failures retry after 30 seconds, 2 minutes, and 10 minutes, and every attempt is logged in `deliveries` (the latest 200). Discord messages disable all mentions. URLs are checked when saved and again before each send: http or https only, never a link-local address (cloud metadata), and redirects are not followed. The Discord token and the webhook secret are stored encrypted and never sent to the browser.
- **Stuck imports.** Lidarr can leave a finished download in "importing" for good when it will not import it on its own (for example a match below 80%), without saying why on the queue item. After an hour in that state (counted from when Offbeat first saw it, since the queue has no completion time), the item moves to Needs Attention as Import stuck. Offbeat asks Lidarr's Manual Import preview for the rejections once, in the background, and explains them in plain words, with a link to Lidarr's queue, where Manual Import is.

## Discovery engine

Works with no API key: ListenBrainz is always a source, and a Last.fm key adds a second, preferred one. Scoring is pure functions in `server/src/discovery/engine.ts`; fetching, caching, and storage are in `discovery.ts`. Each user is refreshed daily at 4:00 and on demand (`POST /discover/refresh`); results for all three modes are stored, so Discover renders instantly.

1. **Seeds.** Library artists (weight 1) plus artists the user plays (ListenBrainz or Last.fm username, three plays or more), with plays adding weight on a log scale. At most 60 seeds.
2. **Similar artists.** Per seed, ListenBrainz session-based similarity (keyed by MBID) and, when connected, Last.fm `artist.getSimilar`. ListenBrainz counts sessions, so popular artists score high next to anything: its scores are divided by listeners to the power 0.3 (ListenBrainz popularity data), with a floor of 20,000 and counts below a quarter of the list's typical one not trusted (the data has gaps for some big artists). With both sources, a match is 0.6 Last.fm plus 0.4 ListenBrainz, so artists both agree on rank highest; when one source knows nothing about a seed, the other counts in full.
3. **Names.** Everything is keyed by MBID. A Last.fm suggestion ListenBrainz does not corroborate is checked by name through Lidarr's artist lookup, and the first exact match wins: Last.fm gives no MBID for some artists, and a wrong one for some shared names (several bands are called Face to Face).
4. **Score.** Each candidate sums `match x seed_weight` over its seeds, so artists several seeds agree on rise.
5. **Filter.** Remove library artists, seeds, Various Artists, blocklisted artists and tags, and artists the user gave a thumbs down.
6. **Mode.**
   - *Safer:* squared matches (strong ones count most) and a bigger boost for several seeds.
   - *Balanced:* the plain sum with a small boost for several seeds.
   - *Deeper:* adds a second hop (the similar artists of its own top 12 picks, at half weight) and divides by the log of listeners, squared.
7. **Variety.** Each score is multiplied by a random factor within 10 percent, seeded per refresh.
8. **Explanations.** The seed behind the strongest match: "Because you like X", or for Deeper's second hop, "Y, which is like X". No seed explains more than 3 of the top 10: a pick whose strongest seed is full is explained by another contributing seed with room, if that seed contributed at least half as much, and otherwise moves below the top 10. So every part of a library gets a voice.
9. **Enrichment.** Names, disambiguation, and artwork from Lidarr's artist lookup (Last.fm has no real artist images). Genres from Last.fm's top tags when connected (filtered to real genres), otherwise from MusicBrainz's curated genres (for the top 30 per mode in a refresh, at one request per second), never free-form tags.
10. **Feedback.** Thumbs up or down adjusts tag weights: each rating counts +1 or -1 for the artist's genres, and a pick's score is multiplied by 1 + 0.15 times the sum of tanh(weight / 2) over its genres, clamped to 0.4 to 1.6 (`taste.ts`). The per-seed cap is applied again after re-weighting. "Never show this" adds to the blocklist. Settings, Discovery lists blocked artists and tags, and the artists hidden by a thumbs down, each with a way to undo it. A thumbs down or block hides the pick at once, since stored recommendations are filtered when read rather than rewritten, so undoing it brings the pick back in place; a refresh follows a minute after the last change.

Every upstream answer is cached in `source_cache` (similar artists and popularity 7 days, lookups 30 days, listening stats 1 day) and served stale if a source is down. `server/scripts/discover-sample.ts` prints a sample per mode and source mix for reviewing quality.

Discover sections: Top Picks for You (with quick add), Albums to Start With (each top pick's most played studio album: MusicBrainz release groups ranked by ListenBrainz listeners), Explore by Tag (genres across the recommendations, weighted by score), and later Local Shows. In Settings, Discovery each user can reorder sections (by dragging, or with Move up and Move down for keyboard and touch) and hide them, and choose the default mode: Discover opens with it when the URL names no mode, and a mode in the URL always wins. Refresh Now there shows the running refresh step by step (library and listening, similar artists, artist details, albums). A tag page lists the best-known artists MusicBrainz tags with that genre (ranked by ListenBrainz listeners), their starting albums, and the genres that go with it in the user's recommendations.

## Data model

Current tables (see `server/src/db/schema.ts`):

- `users` (id, username unique regardless of case, password_hash, role, permissions, lastfm_username, listenbrainz_username, discover_prefs (JSON: default mode and section layout), last_seen_at (updated at most every five minutes), must_change_password, temporary_password_expires_at, created_at)
- `sessions` (sha256 of token, user_id, expires_at)
- `settings` (key, value json or ciphertext, encrypted flag)
- `library_artists` (cached Lidarr artists: ids, names, sort name, monitoring, stats, missing albums, artwork paths)
- `musicbrainz_cache` (request path, body, fetched_at)
- `deliveries` (channel, event, title, message, status, attempts, error, created_at, updated_at): recent notification sends
- `requests` (user_id, requested_by, artist and album MBIDs, Lidarr ids) to attribute adds to users; `requested_by` keeps the username after the user is removed
- `source_cache` (key, body, fetched_at): discovery's upstream answers
- `recommendations` (user_id, mode, payload, generated_at): each user's latest recommendations per mode
- `feedback` (user_id, artist_mbid, name, value, genres, created_at): thumbs up (+1) or down (-1), with the artist's genres at the time
- `blocklist` (id, user_id, kind, key, name, source, created_at): blocked artists (keyed by MBID) and tags (keyed lowercase)
- `jobs` (name, last run, last success, error)

Planned: `flows`, `flow_runs`, `flow_tracks`, `playlists`, `playlist_tracks` (phase 4).

## API

All routes live under `/api/v1`. Implemented:

- `GET /status` health check (used by the Docker healthcheck)
- `GET /setup/state`, `POST /setup/admin`, `POST /setup/lidarr/test`, `POST /setup/lidarr`
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /settings/lidarr`, `PUT /settings/lidarr`
- `GET /settings/lastfm`, `PUT /settings/lastfm` (checked with Last.fm), `DELETE /settings/lastfm` (admin)
- `GET /discover?mode=safer|balanced|deeper` (Top Picks, Albums to Start With, Explore by Tag; no mode means the user's default), `POST /discover/refresh`, `GET /discover/status`, `GET` and `PUT /discover/preferences`, `POST /discover/feedback`
- `GET /blocklist` (blocked artists and tags, and hidden artists), `POST /blocklist`, `DELETE /blocklist/:id`
- `GET /tags/:tag` (a tag page)
- `GET /account`, `PUT /account/listening` (each user's Last.fm and ListenBrainz usernames, checked with each service), `PUT /account/password`
- `GET`, `PUT`, and `DELETE /settings/lidarr/webhook`, `POST /settings/lidarr/webhook/test`, `POST /settings/lidarr/webhook/token` (admins only); `POST /webhooks/lidarr` (Lidarr, Basic auth)
- `GET` and `PUT /settings/notifications` (the link address), `PUT` and `DELETE /settings/notifications/:channel`, `POST /settings/notifications/:channel/test` (admins only)
- `GET /users`, `POST /users` (answers with a temporary password), `PATCH /users/:id` (role and permissions), `POST /users/:id/password` (a new temporary password), `DELETE /users/:id`: admins only
- `GET /library`, `POST /library/refresh`
- `GET /search?q=`
- `GET /artists/:mbid`, `POST /artists/:mbid` (add), `PATCH /artists/:mbid` (monitoring)
- `GET /albums/:mbid`, `POST /albums/:mbid` (add), `PATCH /albums/:mbid` (monitoring), `POST /albums/:mbid/search`
- `GET /activity`, `POST /activity/:id/retry`, `DELETE /activity/:id` (cancel a download)
- `GET /events` (Server-Sent Events: `activity` snapshots and `add-result`)
- `GET /images/artist/:id`, `GET /images/album/:mbid`, `GET /images/remote` (signed)

Planned: `/flows` and `/playlists` (phase 4). An OpenAPI spec generated from the Zod schemas is planned.

## Details that save pain later

- Every route is under `/api/v1` from day one.
- `BASE_URL` works from day one; retrofitting a subpath into an SPA is painful.
- The Lidarr URL Offbeat uses is the one reachable from its container (often `http://lidarr:8686`), not the browser URL. Onboarding says so.
- Every upstream request has one deadline that covers the whole exchange, body included (`server/src/integrations/http.ts`). `AbortSignal.timeout()` alone can be garbage collected mid-body and never fire.
- Background loops start themselves (Activity polling starts in the app's `onReady` hook) and a stuck iteration is abandoned, never left to stop the loop.
- Render from cache first, refresh in the background. Pages should never wait on upstream APIs they do not need.
- Offbeat never writes directly into the user's music library. Library changes go through Lidarr; generated flow files go in Offbeat's own folder.
