import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import type { Layout } from './layout.ts';

/** NIP-65 relay list metadata. */
export const KIND_RELAY_LIST = 10002;

const HEX64 = /^[0-9a-f]{64}$/;
const RELAY_URL = /^wss?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/;

/** The publisher's public key from `publisher/pubkey.json`, or `undefined` before it is set. */
export function readPublisherPubkey(paths: Layout): string | undefined {
  if (!existsSync(paths.publisherKey)) return undefined;
  const value = JSON.parse(readFileSync(paths.publisherKey, 'utf8')) as { pubkey?: unknown };
  if (value.pubkey === null || value.pubkey === undefined) return undefined;
  if (typeof value.pubkey !== 'string' || !HEX64.test(value.pubkey)) {
    throw new Error('publisher/pubkey.json: pubkey must be 64 lowercase hex characters or null');
  }
  return value.pubkey;
}

export function writePublisherPubkey(paths: Layout, pubkey: string): void {
  writeFileSync(paths.publisherKey, `${JSON.stringify({ pubkey }, null, 2)}\n`);
}

export type RelayMarker = 'read' | 'write';

export interface RelayEntry {
  url: string;
  /** Absent: both read and write. */
  marker?: RelayMarker;
}

/** Parses `wss://relay.example` or `wss://relay.example#write` / `#read`. */
export function parseRelayArg(arg: string): RelayEntry {
  const m = /^(.*?)(?:#(read|write))?$/.exec(arg) as RegExpExecArray;
  const url = m[1] as string;
  if (!RELAY_URL.test(url)) throw new Error(`not a relay URL: ${url}`);
  return m[2] === undefined ? { url } : { url, marker: m[2] as RelayMarker };
}

/** A signed NIP-65 relay list (kind 10002). */
export function buildRelayList(
  relays: RelayEntry[],
  secretKey: Uint8Array,
  createdAt: number
): NostrEvent {
  if (relays.length === 0) throw new Error('a relay list needs at least one relay');
  const template: EventTemplate = {
    kind: KIND_RELAY_LIST,
    created_at: createdAt,
    tags: relays.map((r) => (r.marker === undefined ? ['r', r.url] : ['r', r.url, r.marker])),
    content: '',
  };
  return finalizeEvent(template, secretKey);
}

export interface RelayList {
  event: NostrEvent;
  relays: RelayEntry[];
  /** Relays without a marker or marked `write`: where the publisher's events are fetched from. */
  writeRelays: string[];
}

/** Verifies a NIP-65 relay list against the publisher key and reads its relays. */
export function readRelayList(event: unknown, publisherPubkey: string): RelayList {
  const e = event as NostrEvent;
  if (typeof e !== 'object' || e === null || !Array.isArray(e.tags)) {
    throw new Error('relay list: not an event');
  }
  if (e.kind !== KIND_RELAY_LIST) throw new Error(`relay list: kind ${e.kind}, not 10002`);
  if (e.pubkey !== publisherPubkey) throw new Error('relay list: not signed by the publisher key');
  // A fresh object, so a verification mark nostr-tools cached on the input can't vouch for it.
  const { id, pubkey, sig, kind, created_at, tags, content } = e;
  if (!verifyEvent({ id, pubkey, sig, kind, created_at, tags, content }))
    throw new Error('relay list: id or signature does not verify');
  const relays: RelayEntry[] = [];
  for (const tag of e.tags) {
    if (tag[0] !== 'r') continue;
    const marker = tag[2];
    const entry = parseRelayArg(tag[1] ?? '');
    if (marker === 'read' || marker === 'write') entry.marker = marker;
    relays.push(entry);
  }
  if (relays.length === 0) throw new Error('relay list: no r tags');
  const writeRelays = relays.filter((r) => r.marker !== 'read').map((r) => r.url);
  return { event: e, relays, writeRelays };
}
