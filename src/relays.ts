import { AbstractRelay } from 'nostr-tools/abstract-relay';
import type { NostrEvent } from 'nostr-tools/core';
import { verifyEvent } from 'nostr-tools/pure';

export interface PublishOutcome {
  relay: string;
  eventId: string;
  ok: boolean;
  /** The relay's OK message, or why the event never got one. */
  message: string;
}

export interface PublishOptions {
  timeoutMs?: number;
  /** For tests: a WebSocket class to connect with. */
  websocketImplementation?: typeof WebSocket;
}

/**
 * Sends every event to every relay and reports each relay's answer. Never throws for a relay
 * failure; the caller decides what a partial result means.
 */
export async function publishToRelays(
  events: NostrEvent[],
  relays: string[],
  options: PublishOptions = {}
): Promise<PublishOutcome[]> {
  const timeout = options.timeoutMs ?? 10_000;
  const perRelay = relays.map(async (url): Promise<PublishOutcome[]> => {
    const relay = new AbstractRelay(url, {
      verifyEvent,
      ...(options.websocketImplementation === undefined
        ? {}
        : { websocketImplementation: options.websocketImplementation }),
    });
    relay.publishTimeout = timeout;
    try {
      await relay.connect({ timeout });
    } catch (error) {
      const message = `could not connect: ${(error as Error).message}`;
      return events.map((e) => ({ relay: url, eventId: e.id, ok: false, message }));
    }
    const outcomes: PublishOutcome[] = [];
    for (const event of events) {
      try {
        const message = await relay.publish(event);
        outcomes.push({ relay: url, eventId: event.id, ok: true, message });
      } catch (error) {
        outcomes.push({ relay: url, eventId: event.id, ok: false, message: String(error) });
      }
    }
    relay.close();
    return outcomes;
  });
  return (await Promise.all(perRelay)).flat();
}
