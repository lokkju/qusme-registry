import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCommand } from '../src/commands.ts';
import { resolveBase } from '../src/history.ts';
import { commitAll, example, git, tempRegistry, testIo, writeSite } from './helpers.ts';

describe('version history', () => {
  const setup = () => {
    const paths = tempRegistry();
    writeSite(paths, example());
    const base = commitAll(paths);
    return { paths, base };
  };

  it('passes an unchanged definition', async () => {
    const { paths, base } = setup();
    const t = testIo();
    expect(await validateCommand(paths, ['--base', base], t.io)).toBe(0);
  });

  it('refuses a change without a version bump', async () => {
    const { paths, base } = setup();
    const d = example();
    const field = (d.fields as { label: string }[])[0] as { label: string };
    field.label = 'Compose';
    writeSite(paths, d);
    const t = testIo();
    expect(await validateCommand(paths, ['--base', base], t.io)).toBe(1);
    expect(t.all()).toMatch(/version 2026\.11\.1 is not newer than 2026\.11\.1/);
  });

  it('refuses a lower version', async () => {
    const { paths, base } = setup();
    writeSite(paths, { ...example(), version: '2026.10.9' });
    const t = testIo();
    expect(await validateCommand(paths, ['--base', base], t.io)).toBe(1);
    expect(t.all()).toMatch(/not newer than 2026\.11\.1/);
  });

  it('accepts a change with a newer version, compared numerically', async () => {
    const { paths, base } = setup();
    writeSite(paths, { ...example(), version: '2026.11.10', name: 'Renamed' });
    const t = testIo();
    expect(await validateCommand(paths, ['--base', base], t.io)).toBe(0);
  });

  it('ignores key order', async () => {
    const { paths, base } = setup();
    const { id, ...rest } = example();
    writeSite(paths, { ...rest, id });
    expect(await validateCommand(paths, ['--base', base], testIo().io)).toBe(0);
  });

  it('accepts a new site at any version and a removed one', async () => {
    const { paths, base } = setup();
    writeSite(paths, { ...example(), id: 'second', version: '2020.1.1' });
    rmSync(join(paths.sites, 'example.json'));
    expect(await validateCommand(paths, ['--base', base], testIo().io)).toBe(0);
  });

  it('defaults to the first parent on the base branch itself', () => {
    const { paths, base } = setup();
    writeSite(paths, { ...example(), version: '2026.11.2' });
    commitAll(paths);
    expect(resolveBase(paths.root, undefined, {})).toBe(base);
  });

  it('defaults to the merge base with origin/main on a branch', () => {
    const { paths, base } = setup();
    git(paths, 'update-ref', 'refs/remotes/origin/main', base);
    git(paths, 'checkout', '-q', '-b', 'topic');
    commitAll(paths);
    commitAll(paths);
    expect(resolveBase(paths.root, undefined, {})).toBe(base);
  });
});
