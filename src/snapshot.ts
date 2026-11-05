import type { NostrEvent } from 'nostr-tools/core';
import {
  parseSiteDefinitionEvent,
  type SiteDefinitionEvent,
} from '../vendor/qusme-nostr/siteDef.ts';
import { type RelayList, readRelayList } from './publisher.ts';

export const SNAPSHOT_FORMAT = 'qusme-registry-snapshot/1';

/**
 * The bundle lokkju/qusme's service and extension builds include (spec 10.3). Every value in it
 * is public; nothing in it needs to be secret or trusted on its own, since a consumer verifies
 * each event against the publisher key it pins in its own source.
 */
export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  /** The registry publisher's public key, lowercase hex. Informational: consumers pin their own. */
  publisher: string;
  /** The publisher's signed NIP-65 relay list (kind 10002): where devices refresh from. */
  relayList: NostrEvent;
  /** One signed `KIND_SITE_DEF` event per site, sorted by `d`. */
  siteDefinitions: NostrEvent[];
}

export function buildSnapshot(
  publisher: string,
  relayList: NostrEvent,
  events: NostrEvent[]
): Snapshot {
  const d = (e: NostrEvent): string => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  const siteDefinitions = [...events].sort((a, b) => (d(a) < d(b) ? -1 : d(a) > d(b) ? 1 : 0));
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, publisher, relayList, siteDefinitions };
  verifySnapshot(snapshot, publisher);
  return snapshot;
}

export interface VerifiedSnapshot {
  relayList: RelayList;
  definitions: SiteDefinitionEvent[];
}

/**
 * Checks a snapshot the way a consumer should: the format, the relay list and every site
 * definition event against the pinned publisher key, with lokkju/qusme's parser, and one event per
 * site. Throws on the first failure.
 */
export function verifySnapshot(value: unknown, pinnedPubkey: string): VerifiedSnapshot {
  const s = value as Partial<Snapshot>;
  if (typeof s !== 'object' || s === null) throw new Error('snapshot: not an object');
  if (s.format !== SNAPSHOT_FORMAT) throw new Error(`snapshot: format is not ${SNAPSHOT_FORMAT}`);
  if (s.publisher !== pinnedPubkey) throw new Error('snapshot: publisher is not the pinned key');
  const relayList = readRelayList(s.relayList, pinnedPubkey);
  if (!Array.isArray(s.siteDefinitions)) throw new Error('snapshot: siteDefinitions missing');
  const seen = new Set<string>();
  const definitions = s.siteDefinitions.map((event, i) => {
    const parsed = parseSiteDefinitionEvent(event, { publisherPubkey: pinnedPubkey });
    if (!parsed.ok) throw new Error(`snapshot: siteDefinitions[${i}]: ${parsed.error.message}`);
    const { id } = parsed.value.definition;
    if (seen.has(id)) throw new Error(`snapshot: more than one event for ${id}`);
    seen.add(id);
    return parsed.value;
  });
  return { relayList, definitions };
}
