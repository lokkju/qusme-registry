import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { NostrEvent } from 'nostr-tools/core';
import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encodeNcryptsec, NCRYPTSEC_MAX_LOG_N } from '../vendor/qusme-nostr/nip49.ts';
import { parseSiteDefinitionEvent } from '../vendor/qusme-nostr/siteDef.ts';
import { type Definition, loadDefinitions, type Problem } from './definitions.ts';
import {
  buildSiteDefEvent,
  checkPublishedEvents,
  nextCreatedAt,
  type PublishedEvent,
  publishState,
  readPublishedEvent,
  writePublishedEvent,
} from './events.ts';
import { checkVersions, resolveBase } from './history.ts';
import { ENV_PASSPHRASE, loadSecretKey, type Prompt, promptHidden } from './keys.ts';
import type { Layout } from './layout.ts';
import {
  buildRelayList,
  parseRelayArg,
  type RelayEntry,
  readPublisherPubkey,
  readRelayList,
  writePublisherPubkey,
} from './publisher.ts';
import { type PublishOptions, publishToRelays } from './relays.ts';
import { buildSnapshot } from './snapshot.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  prompt: Prompt;
  now: () => number;
  /** For tests: how relays are reached. */
  relayOptions?: PublishOptions;
}

export const defaultIo = (): Io => ({
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  prompt: promptHidden,
  now: () => Math.floor(Date.now() / 1000),
});

class UsageError extends Error {}

const rel = (paths: Layout, path: string): string => relative(paths.root, path) || '.';

function report(io: Io, problems: Problem[]): void {
  for (const p of problems) io.err(`${p.file}: ${p.message}`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path: string, events: NostrEvent[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

interface Checked {
  definitions: Definition[];
  pubkey: string | undefined;
  problems: Problem[];
  notes: string[];
}

/** Every check `pnpm validate` makes. */
export function check(
  paths: Layout,
  options: { base?: string; history?: boolean },
  io: Io
): Checked {
  const { definitions, problems } = loadDefinitions(paths);
  const notes: string[] = [];
  let pubkey: string | undefined;
  try {
    pubkey = readPublisherPubkey(paths);
  } catch (error) {
    problems.push({ file: rel(paths, paths.publisherKey), message: (error as Error).message });
  }
  problems.push(...checkPublishedEvents(paths, definitions, pubkey));
  if (existsSync(paths.relayList)) {
    const file = rel(paths, paths.relayList);
    if (pubkey === undefined) {
      problems.push({
        file,
        message: 'publisher/pubkey.json has no pubkey to verify this against',
      });
    } else {
      try {
        readRelayList(JSON.parse(readFileSync(paths.relayList, 'utf8')), pubkey);
      } catch (error) {
        problems.push({ file, message: (error as Error).message });
      }
    }
  }
  if (options.history !== false) {
    const base = resolveBase(paths.root, options.base, io.env);
    if (base === undefined) notes.push('no base commit found; version history not checked');
    else {
      problems.push(...checkVersions(paths, definitions, base));
      notes.push(`versions checked against ${base.slice(0, 12)}`);
    }
  }
  return { definitions, pubkey, problems, notes };
}

export async function validateCommand(paths: Layout, argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { base: { type: 'string' }, 'no-history': { type: 'boolean' } },
  });
  const result = check(
    paths,
    { ...(values.base === undefined ? {} : { base: values.base }), history: !values['no-history'] },
    io
  );
  for (const note of result.notes) io.err(note);
  if (result.problems.length > 0) {
    report(io, result.problems);
    io.err(`${result.problems.length} problem(s)`);
    return 1;
  }
  io.out(`${result.definitions.length} definition(s) valid`);
  return 0;
}

/** Signs every definition with a key made for the run, and checks each event parses back. */
function signThrowaway(
  definitions: Definition[],
  relays: RelayEntry[],
  now: number
): { pubkey: string; events: NostrEvent[]; relayList: NostrEvent } {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const events = definitions.map((def) => buildSiteDefEvent(def, secretKey, now));
  const relayList = buildRelayList(relays, secretKey, now);
  secretKey.fill(0);
  for (const event of events) {
    const parsed = parseSiteDefinitionEvent(event, { publisherPubkey: pubkey });
    if (!parsed.ok) throw new Error(`a dry-run event does not parse back: ${parsed.error.message}`);
  }
  return { pubkey, events, relayList };
}

const DRY_RUN_RELAYS: RelayEntry[] = [{ url: 'ws://localhost:7777' }];

async function loadMatchingKey(
  paths: Layout,
  io: Io
): Promise<{ key: Uint8Array; pubkey: string }> {
  const pubkey = readPublisherPubkey(paths);
  if (pubkey === undefined) {
    throw new UsageError('publisher/pubkey.json has no pubkey; run pnpm keygen first (README)');
  }
  const key = await loadSecretKey(io.env, io.prompt);
  if (getPublicKey(key) !== pubkey) {
    key.fill(0);
    throw new UsageError('the key from the environment is not the one in publisher/pubkey.json');
  }
  return { key, pubkey };
}

function relayTargets(paths: Layout, pubkey: string, relays: string[], toList: boolean): string[] {
  const targets = relays.map((r) => parseRelayArg(r).url);
  if (toList) {
    if (!existsSync(paths.relayList)) {
      throw new UsageError('--to-relay-list: no publisher/relay-list.json; run pnpm relay-list');
    }
    const list = readRelayList(JSON.parse(readFileSync(paths.relayList, 'utf8')), pubkey);
    targets.push(...list.writeRelays);
  }
  return [...new Set(targets)];
}

async function publish(io: Io, events: NostrEvent[], relays: string[]): Promise<boolean> {
  if (relays.length === 0 || events.length === 0) return true;
  const outcomes = await publishToRelays(events, relays, io.relayOptions);
  let ok = true;
  for (const o of outcomes) {
    io.err(`${o.ok ? 'ok  ' : 'FAIL'} ${o.relay} ${o.eventId.slice(0, 12)} ${o.message}`);
    ok &&= o.ok;
  }
  return ok;
}

export async function publishEventsCommand(paths: Layout, argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      relay: { type: 'string', multiple: true, default: [] },
      'to-relay-list': { type: 'boolean' },
      all: { type: 'boolean' },
      base: { type: 'string' },
    },
  });
  const checked = check(paths, values.base === undefined ? {} : { base: values.base }, io);
  for (const note of checked.notes) io.err(note);
  if (checked.problems.length > 0) {
    report(io, checked.problems);
    io.err('not signing: fix the problems above (pnpm validate)');
    return 1;
  }
  const now = io.now();
  if (values['dry-run']) {
    if (values.relay.length > 0 || values['to-relay-list']) {
      throw new UsageError('--dry-run signs with a throwaway key and never publishes');
    }
    const dir = join(paths.dist, 'dry-run');
    const { pubkey, events } = signThrowaway(checked.definitions, DRY_RUN_RELAYS, now);
    writeJsonl(join(dir, 'events.jsonl'), events);
    io.out(`dry run: signed ${events.length} event(s) with throwaway key ${pubkey}`);
    io.out(`wrote ${rel(paths, join(dir, 'events.jsonl'))}`);
    return 0;
  }
  const { key, pubkey } = await loadMatchingKey(paths, io);
  const signed: NostrEvent[] = [];
  const all: NostrEvent[] = [];
  try {
    for (const def of checked.definitions) {
      const published: PublishedEvent | undefined = readPublishedEvent(paths, def.id, pubkey);
      const state = publishState(def, published);
      if ('message' in state) throw new Error(`${state.file}: ${state.message}`);
      if (state.kind === 'current') {
        all.push(state.published.event);
        continue;
      }
      const event = buildSiteDefEvent(def, key, nextCreatedAt(published?.event, now));
      const file = writePublishedEvent(paths, event);
      io.out(`signed ${def.id} ${def.definition.version} -> ${file}`);
      signed.push(event);
      all.push(event);
    }
  } finally {
    key.fill(0);
  }
  const out = values.all ? all : signed;
  writeJsonl(join(paths.dist, 'events.jsonl'), out);
  io.out(`wrote ${out.length} event(s) to ${rel(paths, join(paths.dist, 'events.jsonl'))}`);
  if (signed.length > 0) io.out('commit events/ so the snapshot and the next run see them');
  const targets = relayTargets(paths, pubkey, values.relay, values['to-relay-list'] === true);
  return (await publish(io, out, targets)) ? 0 : 1;
}

export async function snapshotCommand(paths: Layout, argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean' }, out: { type: 'string' } },
  });
  const checked = check(paths, { history: false }, io);
  if (checked.problems.length > 0) {
    report(io, checked.problems);
    return 1;
  }
  if (values['dry-run']) {
    const { pubkey, events, relayList } = signThrowaway(
      checked.definitions,
      DRY_RUN_RELAYS,
      io.now()
    );
    const out = values.out ?? join(paths.dist, 'dry-run', 'snapshot.json');
    writeJson(out, buildSnapshot(pubkey, relayList, events));
    io.out(`dry run: wrote ${rel(paths, out)} (${events.length} definition(s), throwaway key)`);
    return 0;
  }
  const pubkey = checked.pubkey;
  if (pubkey === undefined) throw new UsageError('publisher/pubkey.json has no pubkey');
  if (!existsSync(paths.relayList)) {
    throw new UsageError('no publisher/relay-list.json; run pnpm relay-list (README)');
  }
  const relayList = JSON.parse(readFileSync(paths.relayList, 'utf8')) as NostrEvent;
  const events: NostrEvent[] = [];
  const missing: string[] = [];
  for (const def of checked.definitions) {
    const state = publishState(def, readPublishedEvent(paths, def.id, pubkey));
    if ('message' in state) throw new Error(`${state.file}: ${state.message}`);
    if (state.kind === 'current') events.push(state.published.event);
    else missing.push(def.id);
  }
  if (missing.length > 0) {
    io.err(`not signed at their current version: ${missing.join(', ')}; run pnpm publish-events`);
    return 1;
  }
  const out = values.out ?? join(paths.dist, 'snapshot.json');
  writeJson(out, buildSnapshot(pubkey, relayList, events));
  io.out(`wrote ${rel(paths, out)} (${events.length} definition(s))`);
  return 0;
}

export async function relayListCommand(paths: Layout, argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      relay: { type: 'string', multiple: true, default: [] },
      publish: { type: 'boolean' },
      also: { type: 'string', multiple: true, default: [] },
    },
  });
  if (values.relay.length === 0) throw new UsageError('give at least one --relay');
  const relays = values.relay.map(parseRelayArg);
  const { key, pubkey } = await loadMatchingKey(paths, io);
  let event: NostrEvent;
  try {
    let previous: NostrEvent | undefined;
    if (existsSync(paths.relayList)) {
      previous = readRelayList(JSON.parse(readFileSync(paths.relayList, 'utf8')), pubkey).event;
    }
    event = buildRelayList(relays, key, nextCreatedAt(previous, io.now()));
  } finally {
    key.fill(0);
  }
  writeJson(paths.relayList, event);
  io.out(`wrote ${rel(paths, paths.relayList)}; commit it`);
  if (!values.publish) return 0;
  const targets = [
    ...new Set([...relays.map((r) => r.url), ...values.also.map((a) => parseRelayArg(a).url)]),
  ];
  return (await publish(io, [event], targets)) ? 0 : 1;
}

export async function keygenCommand(paths: Layout, argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      'log-n': { type: 'string', default: String(NCRYPTSEC_MAX_LOG_N) },
      force: { type: 'boolean' },
    },
  });
  if (readPublisherPubkey(paths) !== undefined && !values.force) {
    throw new UsageError('publisher/pubkey.json already names a key; --force replaces it');
  }
  if (values.out !== undefined && existsSync(values.out)) {
    throw new UsageError(`${values.out} exists; refusing to overwrite it`);
  }
  const logN = Number(values['log-n']);
  let passphrase = io.env[ENV_PASSPHRASE];
  if (passphrase === undefined) {
    passphrase = await io.prompt('new passphrase: ');
    if ((await io.prompt('again: ')) !== passphrase) throw new UsageError('passphrases differ');
  }
  if (passphrase.length < 12) throw new UsageError('use a passphrase of at least 12 characters');
  const key = generateSecretKey();
  let ncryptsec: string;
  let pubkey: string;
  try {
    pubkey = getPublicKey(key);
    // 0x01: the key has never been handled unencrypted (NIP-49).
    ncryptsec = encodeNcryptsec(key, passphrase, { logN, keySecurity: 0x01 });
  } finally {
    key.fill(0);
  }
  if (values.out === undefined) io.out(ncryptsec);
  else {
    writeFileSync(values.out, `${ncryptsec}\n`, { mode: 0o600, flag: 'wx' });
    io.err(`wrote the ncryptsec to ${values.out} (mode 600)`);
  }
  writePublisherPubkey(paths, pubkey);
  io.err(`publisher pubkey ${pubkey}`);
  io.err(`          npub   ${npubEncode(pubkey)}`);
  io.err(`wrote ${rel(paths, paths.publisherKey)}; commit it`);
  return 0;
}

export type Command = (paths: Layout, argv: string[], io: Io) => Promise<number>;

/** Runs a command as a script: usage errors and failures become a message and exit code. */
export async function main(command: Command, paths: Layout, argv: string[], io = defaultIo()) {
  try {
    return await command(paths, argv, io);
  } catch (error) {
    io.err(`error: ${(error as Error).message}`);
    return 2;
  }
}
