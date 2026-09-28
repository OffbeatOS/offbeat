// Enforces "released migrations are permanent" (CONTRIBUTING.md): every
// migration in the latest release tag must be unchanged here, and its journal
// entry too. New migrations are fine; editing, reordering, or deleting a
// released one fails. Needs the release tags (CI checks out full history).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const DIR = 'server/drizzle';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// Compare content, not line endings (a Windows checkout may convert them).
const normalize = (text) => text.replace(/\r\n/g, '\n');

let tag;
try {
  tag = git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD').trim();
} catch {
  console.error('No release tag found, so released migrations cannot be checked. Fetch tags (git fetch --tags).');
  process.exit(1);
}

const released = JSON.parse(git('show', `${tag}:${DIR}/meta/_journal.json`)).entries;
const current = JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, 'utf8')).entries;
const problems = [];

released.forEach((entry, i) => {
  const now = current[i];
  if (!now || now.tag !== entry.tag || now.when !== entry.when || now.idx !== entry.idx) {
    problems.push(`journal entry ${i} (${entry.tag}) was changed, reordered, or removed`);
  }
  const file = `${DIR}/${entry.tag}.sql`;
  if (!existsSync(file)) {
    problems.push(`${file} was deleted`);
  } else if (normalize(readFileSync(file, 'utf8')) !== normalize(git('show', `${tag}:${file}`))) {
    problems.push(`${file} was edited`);
  }
});

if (problems.length) {
  console.error(`Released migrations are permanent (they shipped in ${tag}). Add a new migration instead:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Migrations: ${released.length} released in ${tag} are unchanged; ${current.length - released.length} new.`);
