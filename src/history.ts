import { execFileSync } from 'node:child_process';
import { compareSiteVersions } from '../vendor/qusme-nostr/siteDef.ts';
import { canonicalJson, type Definition, type Problem } from './definitions.ts';
import type { Layout } from './layout.ts';

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The commit to compare definitions against. An explicit ref wins. Otherwise: the merge base with
 * the pull request's target (`GITHUB_BASE_REF`) or with `origin/main`; on that branch itself,
 * where the merge base is HEAD, its first parent. `undefined` outside a git checkout or in a
 * repository with a single commit and nothing to compare.
 */
export function resolveBase(
  root: string,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (explicit !== undefined) {
    const sha = git(root, ['rev-parse', '--verify', `${explicit}^{commit}`]);
    if (sha === undefined) throw new Error(`--base ${explicit} is not a commit`);
    return sha;
  }
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (head === undefined) return undefined;
  const target = env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'origin/main';
  const base = git(root, ['merge-base', target, 'HEAD']);
  if (base !== undefined && base !== head) return base;
  return git(root, ['rev-parse', '--verify', 'HEAD^1']);
}

/** A file's text at a commit, or `undefined` if it did not exist there. */
export function readAtCommit(root: string, commit: string, file: string): string | undefined {
  return git(root, ['show', `${commit}:${file}`]);
}

/**
 * Every definition that differs from its copy at `base` must carry a newer version. A file new
 * since `base` may start at any version; one that did not parse at `base` is not compared.
 */
export function checkVersions(paths: Layout, definitions: Definition[], base: string): Problem[] {
  const problems: Problem[] = [];
  for (const def of definitions) {
    const before = readAtCommit(paths.root, base, def.file);
    if (before === undefined) continue;
    let old: Record<string, unknown>;
    try {
      old = JSON.parse(before) as Record<string, unknown>;
    } catch {
      continue;
    }
    const oldVersion = typeof old.version === 'string' ? old.version : undefined;
    if (canonicalJson(old) === canonicalJson(def.json)) continue;
    let newer: boolean;
    try {
      newer =
        oldVersion === undefined || compareSiteVersions(def.definition.version, oldVersion) > 0;
    } catch {
      newer = true;
    }
    if (!newer) {
      problems.push({
        file: def.file,
        message: `changed since ${base.slice(0, 12)} but version ${def.definition.version} is not newer than ${oldVersion}`,
      });
    }
  }
  return problems;
}
