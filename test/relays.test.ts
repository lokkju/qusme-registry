import { bytesToHex } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { publishEventsCommand, relayListCommand } from '../src/commands.ts';
import { ENV_NSEC } from '../src/keys.ts';
import { writePublisherPubkey } from '../src/publisher.ts';
import { publishToRelays } from '../src/relays.ts';
import { example, tempRegistry, testIo, writeSite } from './helpers.ts';

/** Events each fake relay accepted, by URL. */
const received = new Map<string, unknown[]>();

/**
 * A WebSocket that is a relay: it accepts every EVENT, except on a URL containing `reject`, and
 * never connects on a URL containing `down`.
 */
class FakeRelaySocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      if (url.includes('down')) {
        this.readyState = 3;
        this.onerror?.(new Error('refused'));
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 1);
  }
  send(text: string): void {
    const [type, event] = JSON.parse(text) as [string, { id: string }];
    if (type !== 'EVENT') return;
    const accept = !this.url.includes('reject');
    if (accept) received.set(this.url, [...(received.get(this.url) ?? []), event]);
    const reply = ['OK', event.id, accept, accept ? '' : 'blocked: not on the list'];
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 1);
  }
  close(): void {
    this.readyState = 3;
  }
}

const relayOptions = {
  websocketImplementation: FakeRelaySocket as unknown as typeof WebSocket,
  timeoutMs: 2000,
};

describe('publishing to relays', () => {
  it('reports each relay and event, and keeps going past failures', async () => {
    received.clear();
    const paths = tempRegistry();
    const key = generateSecretKey();
    writePublisherPubkey(paths, getPublicKey(key));
    writeSite(paths, example());
    writeSite(paths, { ...example(), id: 'second' });
    const t = testIo({ [ENV_NSEC]: bytesToHex(key) });
    t.io.relayOptions = relayOptions;

    expect(
      await relayListCommand(
        paths,
        ['--relay', 'wss://good.relay/', '--publish', '--also', 'wss://indexer.relay/'],
        t.io
      )
    ).toBe(0);
    expect(received.get('wss://indexer.relay/')).toHaveLength(1);

    const code = await publishEventsCommand(
      paths,
      ['--to-relay-list', '--relay', 'wss://reject.relay/', '--relay', 'wss://down.relay/'],
      t.io
    );
    expect(code).toBe(1);
    expect(received.get('wss://good.relay/')).toHaveLength(3); // the relay list, then two sites
    const lines = t.err.filter((l) => /^(ok|FAIL)/.test(l));
    expect(lines.filter((l) => l.startsWith('ok  ') && l.includes('good.relay'))).toHaveLength(3);
    expect(lines.filter((l) => l.includes('reject.relay') && l.includes('blocked'))).toHaveLength(
      2
    );
    expect(lines.filter((l) => l.includes('down.relay') && l.includes('connect'))).toHaveLength(2);
  });

  it('returns an empty report for no relays', async () => {
    expect(await publishToRelays([], ['wss://good.relay/'], relayOptions)).toEqual([]);
  });
});
