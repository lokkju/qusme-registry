import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitBlobId, VENDOR_DIR, VENDOR_FILES, type VendorManifest } from '../src/vendor.ts';

const manifest = JSON.parse(
  readFileSync(join(VENDOR_DIR, 'UPSTREAM.json'), 'utf8')
) as VendorManifest;

describe('vendored @qusme/nostr parser', () => {
  it('is byte for byte the upstream files at the recorded commit', () => {
    expect(manifest.repo).toBe('lokkju/qusme');
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(manifest.files).sort()).toEqual([...VENDOR_FILES].sort());
    for (const name of VENDOR_FILES) {
      const bytes = readFileSync(join(VENDOR_DIR, name));
      expect(gitBlobId(bytes), `${name} was edited; run pnpm vendor:sync`).toBe(
        manifest.files[name]
      );
    }
  });

  it('holds exactly the listed files, and they import only each other', () => {
    const present = readdirSync(VENDOR_DIR).filter((n) => n.endsWith('.ts'));
    expect(present.sort()).toEqual([...VENDOR_FILES].sort());
    for (const name of VENDOR_FILES) {
      const text = readFileSync(join(VENDOR_DIR, name), 'utf8');
      for (const m of text.matchAll(/from '\.\/([^']+)'/g)) {
        expect(VENDOR_FILES).toContain(m[1]);
      }
    }
  });
});
