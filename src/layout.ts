import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where things live in a registry checkout. Tests point it at a temporary copy. */
export interface Layout {
  root: string;
  /** `sites/<id>.json`, one definition per file. */
  sites: string;
  /** `events/<id>.json`, the signed event for each site's published version. */
  events: string;
  /** `publisher/pubkey.json`, the registry publisher's public key. */
  publisherKey: string;
  /** `publisher/relay-list.json`, the publisher's signed NIP-65 relay list. */
  relayList: string;
  /** `dist/`, build output; not committed. */
  dist: string;
}

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function layout(root: string = REPO_ROOT): Layout {
  return {
    root,
    sites: join(root, 'sites'),
    events: join(root, 'events'),
    publisherKey: join(root, 'publisher', 'pubkey.json'),
    relayList: join(root, 'publisher', 'relay-list.json'),
    dist: join(root, 'dist'),
  };
}
