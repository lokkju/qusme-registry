import { openSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { decode } from 'nostr-tools/nip19';
import { hexToBytes } from 'nostr-tools/utils';
import { decodeNcryptsec } from '../vendor/qusme-nostr/nip49.ts';

/**
 * Environment variables the publisher key is read from. The ncryptsec (NIP-49) form is the
 * recommended one: the encrypted key can sit in a SOPS file or a password manager entry, and the
 * passphrase is typed at a prompt or supplied separately.
 */
export const ENV_NCRYPTSEC = 'QUSME_REGISTRY_NCRYPTSEC';
export const ENV_PASSPHRASE = 'QUSME_REGISTRY_PASSPHRASE';
export const ENV_NSEC = 'QUSME_REGISTRY_NSEC';

export type Prompt = (question: string) => Promise<string>;

/** Reads a line from the controlling terminal without echoing it. */
export const promptHidden: Prompt = (question) =>
  new Promise((resolve, reject) => {
    let fd: number;
    try {
      fd = openSync('/dev/tty', 'r');
    } catch {
      reject(new Error('no terminal to prompt on'));
      return;
    }
    const input = new ReadStream(fd);
    process.stderr.write(question);
    input.setRawMode(true);
    let value = '';
    const finish = (error?: Error): void => {
      input.setRawMode(false);
      input.destroy();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    input.on('data', (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('cancelled'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    });
  });

/**
 * The publisher's secret key from the environment: `QUSME_REGISTRY_NCRYPTSEC` with
 * `QUSME_REGISTRY_PASSPHRASE` or a prompt, or `QUSME_REGISTRY_NSEC` (nsec or hex). Error messages
 * never include the values.
 */
export async function loadSecretKey(
  env: NodeJS.ProcessEnv = process.env,
  prompt: Prompt = promptHidden
): Promise<Uint8Array> {
  const ncryptsec = env[ENV_NCRYPTSEC]?.trim();
  const nsec = env[ENV_NSEC]?.trim();
  if (ncryptsec && nsec) throw new Error(`set ${ENV_NCRYPTSEC} or ${ENV_NSEC}, not both`);
  if (ncryptsec) {
    const passphrase = env[ENV_PASSPHRASE] ?? (await prompt(`passphrase for ${ENV_NCRYPTSEC}: `));
    try {
      return decodeNcryptsec(ncryptsec, passphrase);
    } catch {
      throw new Error(`${ENV_NCRYPTSEC} does not decrypt (wrong passphrase, or not an ncryptsec)`);
    }
  }
  if (nsec) {
    if (/^[0-9a-f]{64}$/.test(nsec)) return hexToBytes(nsec);
    try {
      const decoded = decode(nsec);
      if (decoded.type === 'nsec') return decoded.data;
    } catch {
      // fall through to the generic message, which does not repeat the value
    }
    throw new Error(`${ENV_NSEC} is neither an nsec nor 64 hex characters`);
  }
  throw new Error(
    `no publisher key: set ${ENV_NCRYPTSEC} (and ${ENV_PASSPHRASE}, or type it at the prompt) or ${ENV_NSEC}`
  );
}
