import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * lokkju/qusme's packages/nostr files vendored into vendor/qusme-nostr: the site definition
 * parser and everything it imports. `pnpm vendor:sync` refreshes them.
 */
export const VENDOR_FILES = [
  'kinds.ts',
  'nip44.ts',
  'nip49.ts',
  'result.ts',
  'signer.ts',
  'siteDef.ts',
  'validate.ts',
] as const;

export const VENDOR_DIR = fileURLToPath(new URL('../vendor/qusme-nostr/', import.meta.url));

/** vendor/qusme-nostr/UPSTREAM.json. */
export interface VendorManifest {
  repo: string;
  path: string;
  commit: string;
  /** File name to its git blob id at `commit`. */
  files: Record<string, string>;
}

/** The git blob id of a file's bytes, as `git hash-object` computes it. */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
