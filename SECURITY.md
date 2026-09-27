# Security policy

Offbeat stores Lidarr API keys and handles logins, and it is often exposed through a reverse proxy, so security reports matter a lot.

## Reporting a vulnerability

Please do not open a public issue.

- **Preferred:** use GitHub's [private vulnerability reporting](https://github.com/OffbeatOS/offbeat/security/advisories/new).
- **Or email** xwolv@proton.me.

Include what you found, how to reproduce it, the Offbeat version, and how it is deployed (Docker or bare metal, `BASE_URL`, reverse proxy). You will get an acknowledgement within a week. Once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Supported versions

Offbeat is pre-1.0. Security fixes go into the latest release only, so please stay up to date.

## Scope

Especially interesting:

- Authentication or session bypass, including through `BASE_URL` or reverse-proxy headers
- Anything that exposes the Lidarr API key (or other stored credentials) to a browser, a log, or another host
- Making the image proxy fetch arbitrary URLs
- Cross-site request forgery or scripting
- Offbeat writing outside its config directory or into the music library directly

Out of scope: problems in Lidarr, MusicBrainz, or other upstream services themselves, and attacks that need someone who is already an Offbeat admin.
