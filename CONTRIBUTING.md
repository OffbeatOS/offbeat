# Contributing to Offbeat

Thanks for helping. Offbeat is early, so the most useful contributions right now are bug reports from real setups, fixes, and work on the current phase in the [roadmap](ROADMAP.md). For anything bigger than a small fix, open an issue or a [discussion](https://github.com/OffbeatOS/offbeat/discussions) first so we can agree on the approach before you spend time on it.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Working agreements

These apply to every change: code, UI copy, docs, and commit messages.

1. **No em dashes, and no emoji.** Use commas, periods, colons, or parentheses instead. `npm run lint` checks for em dashes.
2. **Done means verified in a real browser.** Passing tests are not enough. Run the app, use the feature end to end, and say in your pull request what you checked.
3. **The mockups are the source of truth for UI.** Match [docs/design](docs/design/README.md) and use the tokens; never hard-code a color.
4. **Keep the footprint small.** One process, one port, SQLite. Anything that adds a required container needs a strong reason.
5. **Every upstream call is cached and rate limited.** MusicBrainz in particular allows one request per second.
6. **Never leak credentials.** The Lidarr API key must never reach the browser or a log. Artwork goes through the image proxy.
7. **Small, reviewable commits** with conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
8. **Released migrations are permanent.** Real installs have run every migration up to 0.1.0 and later. Never edit, reorder, or delete a committed migration; change the schema only by adding a new one.

## Using AI tools

AI coding assistants are welcome here. Offbeat itself is developed with AI assistance, under the same rules below. What matters is that the work is tested and that a person stands behind it.

- **You are the author.** Understand every line you submit, be able to explain why it is written that way, and be ready to maintain it. "The AI wrote it" is not an answer in review.
- **Same bar as any change.** Tests pass, new behavior has tests, and you verified it in a real browser. AI-written code gets no shortcut on the working agreements above.
- **Say so in the pull request** when AI wrote a substantial part of it. This is not held against you; it tells reviewers where to look harder.
- **Answer review yourself.** Do not relay reviewer questions to an AI and paste back its replies.
- **Issues and security reports must be confirmed by a person.** Reproduce the problem yourself before reporting it. Unverified AI-generated reports, especially "vulnerabilities" nobody reproduced, will be closed.
- **Keep secrets out of AI tools.** Do not paste API keys, passwords, or unscrubbed logs into them.
- **Only submit what you have the right to submit.** Do not include code copied from projects with incompatible licenses, whoever or whatever produced it.

## Setting up

You need Node 22.22.3+ or 24.15+ (`.nvmrc` pins the version CI uses; `nvm use` or `fnm use` picks it up). `npm install` refuses older versions.

```sh
npm install
npm run dev        # API on :3001 with reload, Angular on :4200 proxying /api
```

Open http://localhost:4200 and go through onboarding. Development state lives in `server/config/`, which is gitignored; delete it to start over.

### Without a real Lidarr

A fake Lidarr ships with the tests and is handy for UI work and for trying large libraries:

```sh
npx tsx server/test/run-fake-lidarr.ts --artists 2000 --port 8699
```

It prints a URL and API key to enter in onboarding. Like real Lidarr, its artwork endpoint requires the key, and it logs any request that arrives without one.

If you test against your own Lidarr, set Settings, Integrations, Lidarr to not monitor new artists, not search when adding, and tag added artists (for example `offbeat-test`), so your library is easy to clean up afterwards.

## Checks

Run these before opening a pull request; CI runs the same ones.

```sh
npm run lint        # ESLint and the em dash check
npm run typecheck
npm test            # server (Vitest) and web (Angular with Vitest)
npm run build
```

Server tests talk to fake Lidarr and MusicBrainz servers in `server/test/`, never the internet. If you change how Offbeat talks to Lidarr, make the fake behave like the real thing first, so the test would have caught the bug.

After changing `server/src/db/schema.ts`, run `npm run db:generate` and commit the new migration. Migrations run on boot and must never be edited once released.

## Pull requests

- Keep each pull request focused on one change.
- Fill in the template, including what you verified in a browser. Screenshots help for any UI change, at desktop and at phone width (390px).
- Update the docs when behavior changes: the README for user-facing setup, [docs/architecture.md](docs/architecture.md) for how things work.
- Pull requests are squash merged, so the title becomes the commit message. Use a conventional prefix there too.

## Where things live

See the [architecture overview](docs/architecture.md#repo-layout). In short: `server/` is the Fastify API, `web/` is the Angular app, and `shared/` holds the API types both use.

## Licensing

Offbeat is MIT licensed. By contributing, you agree your contributions are licensed the same way.
