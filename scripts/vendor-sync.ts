/**
 * Copies the site definition parser and its imports from lokkju/qusme's packages/nostr into
 * vendor/qusme-nostr, byte for byte, and records the commit and each file's git blob id in
 * vendor/qusme-nostr/UPSTREAM.json. test/vendor.test.ts checks the files against those ids.
 *
 *   pnpm vendor:sync            # lokkju/qusme's main
 *   pnpm vendor:sync <commit>   # a given commit, branch or tag
 *
 * Needs `gh` logged in with read access to lokkju/qusme.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VENDOR_DIR, VENDOR_FILES, type VendorManifest } from '../src/vendor.ts';

const REPO = 'lokkju/qusme';
const SRC = 'packages/nostr/src';

const gh = (args: string[]): string =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

const ref = process.argv[2] ?? 'main';
const commit = gh([
  'api',
  `repos/${REPO}/commits/${encodeURIComponent(ref)}`,
  '--jq',
  '.sha',
]).trim();

const files: Record<string, string> = {};
for (const name of VENDOR_FILES) {
  const path = `${SRC}/${name}`;
  const api = `repos/${REPO}/contents/${path}?ref=${commit}`;
  const blob = gh(['api', api, '--jq', '.sha']).trim();
  const text = gh(['api', '-H', 'Accept: application/vnd.github.raw', api]);
  for (const m of text.matchAll(/from '\.\/([^']+)'/g)) {
    const dep = m[1] as string;
    if (!(VENDOR_FILES as readonly string[]).includes(dep)) {
      throw new Error(`${name} imports ./${dep}, which is not in VENDOR_FILES (src/vendor.ts)`);
    }
  }
  writeFileSync(join(VENDOR_DIR, name), text);
  files[name] = blob;
}
for (const existing of readdirSync(VENDOR_DIR)) {
  if (existing.endsWith('.ts') && !(existing in files)) rmSync(join(VENDOR_DIR, existing));
}
const manifest: VendorManifest = { repo: REPO, path: SRC, commit, files };
writeFileSync(join(VENDOR_DIR, 'UPSTREAM.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`vendored ${VENDOR_FILES.length} files from ${REPO}@${commit}`);
