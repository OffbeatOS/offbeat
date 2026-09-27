/**
 * Prints a readable sample of recommendations for reviewing quality, per
 * mode and per source mix, without storing anything or touching Lidarr's
 * library (it only uses Lidarr's artist lookup).
 *
 *   CONFIG_DIR=./config npx tsx server/scripts/discover-sample.ts [--seeds "Artist, Artist"] [--user 1] [--top 15]
 *
 * Without --seeds it uses the user's real seeds (library plus listening
 * history). Runs ListenBrainz alone, then ListenBrainz with Last.fm when a
 * Last.fm key is connected.
 */
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadOrCreateSecretKey, prepareConfigDir } from '../src/config-dir.js';
import { openDatabase } from '../src/db/index.js';
import { type Ranked, type Seed, MODES, normalizeName } from '../src/discovery/engine.js';
import { currentClient } from '../src/integrations/lidarr/settings.js';

const { values } = parseArgs({
  options: { seeds: { type: 'string' }, user: { type: 'string', default: '1' }, top: { type: 'string', default: '15' } },
});

const config = loadConfig();
const paths = prepareConfigDir(config.configDir);
const app = await buildApp({
  config: { ...config, logLevel: 'error' },
  db: openDatabase(paths.database),
  secretKey: loadOrCreateSecretKey(paths.secretKey),
  imageCacheDir: paths.imageCache,
  webRoot: null,
  activity: { autoStart: false },
  discovery: { schedule: null },
});

async function seedsFromNames(names: string[]): Promise<Seed[]> {
  const lidarr = currentClient(app.settings)();
  if (!lidarr) throw new Error('Lidarr is not connected in this config');
  const seeds: Seed[] = [];
  for (const name of names) {
    const found = (await lidarr.lookupArtists(name)).find((a) => normalizeName(a.artistName) === normalizeName(name));
    if (found) seeds.push({ mbid: found.foreignArtistId, name: found.artistName, weight: 1, inLibrary: true, plays: 0 });
    else console.error(`No exact match for seed "${name}"; skipped`);
  }
  return seeds;
}

const top = Number(values.top);
const seeds = values.seeds
  ? await seedsFromNames(values.seeds.split(',').map((s) => s.trim()).filter(Boolean))
  : await app.discovery.seedsFor(Number(values.user));

const listeners = (n: number | null) => (n === null ? 'n/a' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const reason = (r: Ranked) => (r.reason.via ? `${r.reason.via}, like ${r.reason.seed}` : r.reason.seed);
const table = (rows: Ranked[]) =>
  [
    '| # | Artist | Score | Because you like | Seeds | Sources | Listeners |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows
      .slice(0, top)
      .map(
        (r, i) =>
          `| ${i + 1} | ${r.name} | ${r.score.toFixed(0)} | ${reason(r)} | ${r.seeds.length} | ${r.sources.map((s) => (s === 'lastfm' ? 'LF' : 'LB')).join('+')} | ${listeners(r.listeners)} |`,
      ),
  ].join('\n');

console.log(`Seeds (${seeds.length}): ${seeds.map((s) => `${s.name}${s.plays ? ` (${s.plays} plays)` : ''}`).join(', ')}\n`);
const runs = [{ label: 'ListenBrainz only', useLastfm: false }];
if (app.sources.lastfm()) runs.push({ label: 'ListenBrainz + Last.fm', useLastfm: true });
for (const run of runs) {
  // No variety, so the two source mixes compare cleanly.
  const computed = await app.discovery.compute(seeds, { useLastfm: run.useLastfm, random: () => 0.5 });
  for (const mode of MODES) {
    console.log(`### ${run.label}: ${mode[0]!.toUpperCase()}${mode.slice(1)}\n\n${table(computed.modes[mode])}\n`);
  }
}
await app.close();
