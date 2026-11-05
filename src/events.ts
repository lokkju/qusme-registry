import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { NostrEvent } from 'nostr-tools/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { KIND_SITE_DEF } from '../vendor/qusme-nostr/kinds.ts';
import {
  compareSiteVersions,
  parseSiteDefinitionEvent,
  type SiteDefinitionEvent,
} from '../vendor/qusme-nostr/siteDef.ts';
import {
  canonicalJson,
  type Definition,
  definitionContent,
  MAX_EVENT_BYTES,
  type Problem,
} from './definitions.ts';
import type { Layout } from './layout.ts';

/** A signed `KIND_SITE_DEF` event for one definition (spec 7.6): addressable, `d` = site id. */
export function buildSiteDefEvent(
  def: Definition,
  secretKey: Uint8Array,
  createdAt: number
): NostrEvent {
  const { id, name, version } = def.definition;
  return finalizeEvent(
    {
      kind: KIND_SITE_DEF,
      created_at: createdAt,
      tags: [
        ['d', id],
        ['alt', `qus.me site definition: ${name} ${version}`],
      ],
      content: definitionContent(def),
    },
    secretKey
  );
}

export interface PublishedEvent {
  file: string;
  event: NostrEvent;
  parsed: SiteDefinitionEvent;
}

/** The committed signed event for one site, if any; throws if it does not verify. */
export function readPublishedEvent(
  paths: Layout,
  id: string,
  publisherPubkey: string
): PublishedEvent | undefined {
  const path = join(paths.events, `${id}.json`);
  if (!existsSync(path)) return undefined;
  const event = JSON.parse(readFileSync(path, 'utf8')) as NostrEvent;
  const parsed = parseSiteDefinitionEvent(event, { publisherPubkey });
  const file = relative(paths.root, path);
  if (!parsed.ok) throw new Error(`${file}: ${parsed.error.message}`);
  if (parsed.value.definition.id !== id) throw new Error(`${file}: d is not ${id}`);
  return { file, event, parsed: parsed.value };
}

/** Ids with a committed event in `events/`. */
export function publishedIds(paths: Layout): string[] {
  if (!existsSync(paths.events)) return [];
  return readdirSync(paths.events)
    .filter((n) => n.endsWith('.json'))
    .map((n) => basename(n, '.json'))
    .sort();
}

/** Writes a signed event to `events/<d>.json`. */
export function writePublishedEvent(paths: Layout, event: NostrEvent): string {
  const d = event.tags.find((t) => t[0] === 'd')?.[1] as string;
  const path = join(paths.events, `${d}.json`);
  mkdirSync(paths.events, { recursive: true });
  writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`);
  return relative(paths.root, path);
}

export type PublishState =
  | { kind: 'current'; published: PublishedEvent }
  | { kind: 'unpublished'; published?: PublishedEvent };

/**
 * Compares a definition with its committed event: `current` when the event's content is this
 * definition, `unpublished` when there is no event or it holds an older version. A committed event
 * that is newer than the file, or holds different content under the same version, is a problem.
 */
export function publishState(
  def: Definition,
  published: PublishedEvent | undefined
): PublishState | Problem {
  if (published === undefined) return { kind: 'unpublished' };
  const order = compareSiteVersions(def.definition.version, published.parsed.definition.version);
  if (order < 0) {
    return {
      file: def.file,
      message: `version ${def.definition.version} is older than the published ${published.parsed.definition.version} in ${published.file}`,
    };
  }
  if (order > 0) return { kind: 'unpublished', published };
  if (canonicalJson(JSON.parse(published.event.content)) !== canonicalJson(def.json)) {
    return {
      file: def.file,
      message: `differs from ${published.file} under the same version ${def.definition.version}; bump the version`,
    };
  }
  return { kind: 'current', published };
}

/**
 * Checks `events/` against the definitions: every event verifies against the publisher key, is
 * no newer than its definition, and has a definition. Without a publisher key, `events/` must be
 * empty.
 */
export function checkPublishedEvents(
  paths: Layout,
  definitions: Definition[],
  publisherPubkey: string | undefined
): Problem[] {
  const problems: Problem[] = [];
  const ids = new Set(definitions.map((d) => d.id));
  for (const id of publishedIds(paths)) {
    const file = relative(paths.root, join(paths.events, `${id}.json`));
    if (publisherPubkey === undefined) {
      problems.push({
        file,
        message: 'publisher/pubkey.json has no pubkey to verify this against',
      });
      continue;
    }
    if (!ids.has(id)) {
      problems.push({ file, message: `no sites/${id}.json; delete the event with its definition` });
    }
  }
  if (publisherPubkey === undefined) return problems;
  for (const def of definitions) {
    let published: PublishedEvent | undefined;
    try {
      published = readPublishedEvent(paths, def.id, publisherPubkey);
    } catch (error) {
      problems.push({ file: def.file, message: (error as Error).message });
      continue;
    }
    const state = publishState(def, published);
    if ('message' in state) problems.push(state);
    else if (published !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(published.event));
      if (bytes > MAX_EVENT_BYTES) {
        problems.push({ file: published.file, message: `${bytes} bytes, over ${MAX_EVENT_BYTES}` });
      }
    }
  }
  return problems;
}

/** A `created_at` for a new event: now, but always after the event it replaces. */
export function nextCreatedAt(previous: NostrEvent | undefined, now: number): number {
  return previous === undefined ? now : Math.max(now, previous.created_at + 1);
}
