import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/commands.ts';
import { type Layout, layout, REPO_ROOT } from '../src/layout.ts';

/** Definitions used by tests and CI's dry runs; never published. */
export const FIXTURE_SITES = join(REPO_ROOT, 'test', 'fixtures', 'sites');

export const EXAMPLE = JSON.parse(
  readFileSync(join(FIXTURE_SITES, 'example.json'), 'utf8')
) as Record<string, unknown>;

/** A deep copy of the example definition, for mutating in a test. */
export const example = (): Record<string, unknown> => structuredClone(EXAMPLE);

/** An empty registry checkout in a temporary directory, as a git repository. */
export function tempRegistry(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'qusme-registry-'));
  const paths = layout(root);
  mkdirSync(paths.sites);
  mkdirSync(paths.events);
  mkdirSync(join(root, 'publisher'));
  writeFileSync(paths.publisherKey, '{ "pubkey": null }\n');
  git(paths, 'init', '-q', '-b', 'main');
  return paths;
}

export function git(paths: Layout, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', paths.root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
    { encoding: 'utf8' }
  ).trim();
}

export function commitAll(paths: Layout, message = 'test'): string {
  git(paths, 'add', '-A');
  git(paths, 'commit', '-q', '--allow-empty', '-m', message);
  return git(paths, 'rev-parse', 'HEAD');
}

export function writeSite(paths: Layout, value: Record<string, unknown>, id?: string): void {
  writeFileSync(
    join(paths.sites, `${id ?? String(value.id)}.json`),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

/** An Io that records output, with a fixed clock and no terminal. */
export function testIo(env: NodeJS.ProcessEnv = {}, now = 1_800_000_000) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = now;
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env,
    prompt: async () => {
      throw new Error('no prompt in tests');
    },
    now: () => clock,
  };
  return {
    io,
    out,
    err,
    all: () => [...out, ...err].join('\n'),
    advance: (seconds: number) => {
      clock += seconds;
    },
  };
}
