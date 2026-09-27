// Enforces the "no em dashes anywhere" working agreement (CONTRIBUTING.md)
// across source, docs, and config. Exits non-zero and lists every hit.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const EM_DASH = String.fromCharCode(0x2014);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', '.git', 'coverage', 'config']);
const TEXT_EXT = /\.(?:ts|mjs|js|json|html|scss|css|md|ya?ml|sh|sql|txt)$|^(?:Dockerfile|\.[a-z]+ignore)$/;

const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
    } else if (TEXT_EXT.test(entry.name) && entry.name !== 'package-lock.json') {
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes(EM_DASH)) hits.push(`${path.relative('.', full)}:${i + 1}`);
        });
    }
  }
}

walk('.');

if (hits.length > 0) {
  console.error(`Em dashes are not allowed (see CONTRIBUTING.md). Found ${hits.length}:`);
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
