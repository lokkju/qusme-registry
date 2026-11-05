import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'nostr-tools/core';
import { nsecEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  keygenCommand,
  publishEventsCommand,
  relayListCommand,
  snapshotCommand,
  validateCommand,
} from '../src/commands.ts';
import { ENV_NCRYPTSEC, ENV_NSEC, ENV_PASSPHRASE } from '../src/keys.ts';
import type { Layout } from '../src/layout.ts';
import { writePublisherPubkey } from '../src/publisher.ts';
import { type Snapshot, verifySnapshot } from '../src/snapshot.ts';
import { decodeNcryptsec, encodeNcryptsec } from '../vendor/qusme-nostr/nip49.ts';
import { parseSiteDefinitionEvent } from '../vendor/qusme-nostr/siteDef.ts';
import { example, tempRegistry, testIo, writeSite } from './helpers.ts';

const readJson = <T = NostrEvent>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const readJsonl = (path: string): NostrEvent[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));

function registryWithKey(): { paths: Layout; key: Uint8Array; pubkey: string } {
  const paths = tempRegistry();
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  writePublisherPubkey(paths, pubkey);
  writeSite(paths, example());
  return { paths, key, pubkey };
}

/** Every way the secret key could appear in output. */
const secretForms = (key: Uint8Array): string[] => [bytesToHex(key), nsecEncode(key)];

describe('publish-events, relay-list and snapshot', () => {
  it('signs, publishes nothing twice, re-signs a new version and builds a snapshot', async () => {
    const { paths, key, pubkey } = registryWithKey();
    const env = { [ENV_NSEC]: nsecEncode(key) };
    const t = testIo(env);

    expect(await publishEventsCommand(paths, [], t.io)).toBe(0);
    const first = readJson(join(paths.events, 'example.json'));
    const parsed = parseSiteDefinitionEvent(first, { publisherPubkey: pubkey });
    expect(parsed.ok && parsed.value.definition.version).toBe('2026.11.1');
    expect(first.tags).toEqual([
      ['d', 'example'],
      ['alt', 'qus.me site definition: Example (local test page) 2026.11.1'],
    ]);
    expect(readJsonl(join(paths.dist, 'events.jsonl'))).toEqual([first]);

    t.advance(-100); // a clock behind the last event must still produce a newer created_at
    expect(await publishEventsCommand(paths, [], t.io)).toBe(0);
    expect(readJsonl(join(paths.dist, 'events.jsonl'))).toEqual([]);
    expect(await publishEventsCommand(paths, ['--all'], t.io)).toBe(0);
    expect(readJsonl(join(paths.dist, 'events.jsonl'))).toEqual([first]);

    writeSite(paths, { ...example(), version: '2026.11.2' });
    expect(await publishEventsCommand(paths, [], t.io)).toBe(0);
    const second = readJson(join(paths.events, 'example.json'));
    expect(second.created_at).toBeGreaterThan(first.created_at);
    expect(await validateCommand(paths, [], t.io)).toBe(0);

    await expect(snapshotCommand(paths, [], t.io)).rejects.toThrow(/no publisher\/relay-list/);
    expect(
      await relayListCommand(
        paths,
        ['--relay', 'wss://relay.one/', '--relay', 'wss://relay.two/#read'],
        t.io
      )
    ).toBe(0);
    expect(await snapshotCommand(paths, [], t.io)).toBe(0);

    const snapshot = readJson(join(paths.dist, 'snapshot.json')) as Snapshot;
    const verified = verifySnapshot(snapshot, pubkey);
    expect(verified.definitions.map((d) => d.definition.version)).toEqual(['2026.11.2']);
    expect(verified.relayList.writeRelays).toEqual(['wss://relay.one/']);
    expect(snapshot.siteDefinitions).toEqual([second]);

    for (const form of secretForms(key)) expect(t.all()).not.toContain(form);
  });

  it('refuses to snapshot a definition whose current version is unsigned', async () => {
    const { paths, key } = registryWithKey();
    const t = testIo({ [ENV_NSEC]: bytesToHex(key) });
    expect(await publishEventsCommand(paths, [], t.io)).toBe(0);
    expect(await relayListCommand(paths, ['--relay', 'wss://relay.one/'], t.io)).toBe(0);
    writeSite(paths, { ...example(), version: '2026.11.2' });
    expect(await snapshotCommand(paths, [], t.io)).toBe(1);
    expect(t.all()).toMatch(/not signed at their current version: example/);
  });

  it('reads an ncryptsec with the passphrase from the environment or a prompt', async () => {
    const { paths, key } = registryWithKey();
    const ncryptsec = encodeNcryptsec(key, 'correct horse battery', { logN: 16 });
    const env = { [ENV_NCRYPTSEC]: ncryptsec, [ENV_PASSPHRASE]: 'correct horse battery' };
    const t = testIo(env);
    expect(await publishEventsCommand(paths, [], t.io)).toBe(0);

    const prompted = registryWithKey();
    const t2 = testIo({
      [ENV_NCRYPTSEC]: encodeNcryptsec(prompted.key, 'typed at the tty', { logN: 16 }),
    });
    const asked: string[] = [];
    t2.io.prompt = async (q) => {
      asked.push(q);
      return 'typed at the tty';
    };
    expect(await publishEventsCommand(prompted.paths, [], t2.io)).toBe(0);
    expect(asked).toHaveLength(1);
    for (const form of [...secretForms(key), 'correct horse battery']) {
      expect(t.all()).not.toContain(form);
    }
  });

  it('refuses a wrong passphrase, a key that is not the publisher, and a missing key', async () => {
    const { paths, key } = registryWithKey();
    const wrong = testIo({
      [ENV_NCRYPTSEC]: encodeNcryptsec(key, 'right passphrase', { logN: 16 }),
      [ENV_PASSPHRASE]: 'wrong passphrase',
    });
    await expect(publishEventsCommand(paths, [], wrong.io)).rejects.toThrow(/does not decrypt/);

    const other = generateSecretKey();
    const t = testIo({ [ENV_NSEC]: bytesToHex(other) });
    await expect(publishEventsCommand(paths, [], t.io)).rejects.toThrow(/not the one in publisher/);

    await expect(publishEventsCommand(paths, [], testIo().io)).rejects.toThrow(/no publisher key/);
    const both = testIo({ [ENV_NSEC]: 'x', [ENV_NCRYPTSEC]: 'y' });
    await expect(publishEventsCommand(paths, [], both.io)).rejects.toThrow(/not both/);
    for (const form of secretForms(other)) expect(t.all()).not.toContain(form);
  });

  it('refuses a definition that is invalid before signing anything', async () => {
    const { paths, key } = registryWithKey();
    writeSite(paths, { ...example(), homepage: 'x' });
    const t = testIo({ [ENV_NSEC]: bytesToHex(key) });
    expect(await publishEventsCommand(paths, [], t.io)).toBe(1);
    expect(t.all()).toMatch(/not signing/);
  });

  it('dry-runs with a throwaway key without touching events/ or publisher/', async () => {
    const paths = tempRegistry();
    writeSite(paths, example());
    const t = testIo();
    expect(await publishEventsCommand(paths, ['--dry-run'], t.io)).toBe(0);
    expect(await snapshotCommand(paths, ['--dry-run'], t.io)).toBe(0);
    const snapshot = readJson(join(paths.dist, 'dry-run', 'snapshot.json')) as Snapshot;
    expect(verifySnapshot(snapshot, snapshot.publisher).definitions).toHaveLength(1);
    expect(readJsonl(join(paths.dist, 'dry-run', 'events.jsonl'))).toHaveLength(1);
    expect(readJson(paths.publisherKey)).toEqual({ pubkey: null });
    await expect(
      publishEventsCommand(paths, ['--dry-run', '--relay', 'wss://relay.one/'], t.io)
    ).rejects.toThrow(/never publishes/);
  });

  it('validate refuses a committed event that does not verify', async () => {
    const { paths, key } = registryWithKey();
    const t = testIo({ [ENV_NSEC]: bytesToHex(key) });
    expect(await publishEventsCommand(paths, [], t.io)).toBe(0);
    const path = join(paths.events, 'example.json');
    const event = readJson(path);
    event.content = event.content.replace('280', '281');
    writeFileSync(path, JSON.stringify(event));
    expect(await validateCommand(paths, ['--no-history'], t.io)).toBe(1);
    expect(t.all()).toMatch(/does not verify/);
  });
});

describe('snapshot verification', () => {
  async function snapshotFixture() {
    const { paths, key, pubkey } = registryWithKey();
    const t = testIo({ [ENV_NSEC]: bytesToHex(key) });
    await publishEventsCommand(paths, [], t.io);
    await relayListCommand(paths, ['--relay', 'wss://relay.one/'], t.io);
    await snapshotCommand(paths, [], t.io);
    return { snapshot: readJson(join(paths.dist, 'snapshot.json')) as Snapshot, key, pubkey };
  }

  it('round-trips through the parser against the pinned key', async () => {
    const { snapshot, pubkey } = await snapshotFixture();
    expect(verifySnapshot(JSON.parse(JSON.stringify(snapshot)), pubkey).definitions).toHaveLength(
      1
    );
  });

  it('rejects a tampered definition event', async () => {
    const { snapshot, pubkey } = await snapshotFixture();
    const tampered = structuredClone(snapshot);
    const e = tampered.siteDefinitions[0] as { content: string };
    e.content = e.content.replace('"maxLength":280', '"maxLength":2800');
    expect(() => verifySnapshot(tampered, pubkey)).toThrow(/does not verify/);
  });

  it('rejects a tampered relay list', async () => {
    const { snapshot, pubkey } = await snapshotFixture();
    const tampered = structuredClone(snapshot);
    tampered.relayList.tags = [['r', 'wss://evil.example/']];
    expect(() => verifySnapshot(tampered, pubkey)).toThrow(/does not verify/);
  });

  it('rejects events re-signed by another key, even with a matching publisher field', async () => {
    const { snapshot, pubkey } = await snapshotFixture();
    const other = generateSecretKey();
    const forged = structuredClone(snapshot);
    const original = forged.siteDefinitions[0] as {
      kind: number;
      tags: string[][];
      content: string;
    };
    forged.siteDefinitions = [finalizeEvent({ ...original, created_at: 1_900_000_000 }, other)];
    expect(() => verifySnapshot(forged, pubkey)).toThrow(/registry publisher key/);
    forged.publisher = getPublicKey(other);
    expect(() => verifySnapshot(forged, pubkey)).toThrow(/pinned key/);
  });
});

describe('keygen', () => {
  it('writes an ncryptsec and the pubkey, and never prints the secret key', async () => {
    const paths = tempRegistry();
    const out = join(paths.root, 'publisher.ncryptsec');
    const t = testIo({ [ENV_PASSPHRASE]: 'a long enough passphrase' });
    expect(await keygenCommand(paths, ['--out', out, '--log-n', '16'], t.io)).toBe(0);
    const ncryptsec = readFileSync(out, 'utf8').trim();
    const key = decodeNcryptsec(ncryptsec, 'a long enough passphrase');
    expect(readJson(paths.publisherKey)).toEqual({ pubkey: getPublicKey(key) });
    for (const form of secretForms(key)) expect(t.all()).not.toContain(form);
    await expect(keygenCommand(paths, ['--log-n', '16'], t.io)).rejects.toThrow(/already names/);
  });

  it('refuses a short passphrase and mismatched prompts', async () => {
    const paths = tempRegistry();
    await expect(
      keygenCommand(paths, [], testIo({ [ENV_PASSPHRASE]: 'short' }).io)
    ).rejects.toThrow(/at least 12/);
    const t = testIo();
    let n = 0;
    t.io.prompt = async () => `passphrase number ${n++}`;
    await expect(keygenCommand(paths, [], t.io)).rejects.toThrow(/differ/);
  });
});

describe('validate', () => {
  it('passes the repository as committed', async () => {
    const { layout } = await import('../src/layout.ts');
    expect(await validateCommand(layout(), ['--no-history'], testIo().io)).toBe(0);
  });

  it('refuses an event without a definition, and events without a publisher key', async () => {
    const { paths, key } = registryWithKey();
    const t = testIo({ [ENV_NSEC]: bytesToHex(key) });
    expect(await publishEventsCommand(paths, [], t.io)).toBe(0);
    rmSync(join(paths.sites, 'example.json'));
    expect(await validateCommand(paths, ['--no-history'], t.io)).toBe(1);
    expect(t.all()).toMatch(/no sites\/example\.json/);
    writeFileSync(paths.publisherKey, '{ "pubkey": null }\n');
    expect(await validateCommand(paths, ['--no-history'], t.io)).toBe(1);
    expect(t.all()).toMatch(/no pubkey to verify this against/);
  });
});
