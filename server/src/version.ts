import { readFileSync } from 'node:fs';

// server/package.json sits one level above both src/ and dist/.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const VERSION = pkg.version;

/** How Offbeat identifies itself to MusicBrainz, ListenBrainz, and Last.fm. */
export const USER_AGENT = `Offbeat/${VERSION} ( https://github.com/OffbeatOS/offbeat )`;
