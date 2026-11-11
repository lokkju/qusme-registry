import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import { capture } from '../vendor/qusme-nostr/result.ts';
import { parseSiteDefinition, type SiteDefinition } from '../vendor/qusme-nostr/siteDef.ts';
import { parseJsonText } from '../vendor/qusme-nostr/validate.ts';
import type { Layout } from './layout.ts';

/** The largest signed event this registry publishes: the 64 KiB storage relays accept (spec 9.1). */
export const MAX_EVENT_BYTES = 65_536;

export const SCHEMA_PATH = new URL('../schema/site-definition.schema.json', import.meta.url);

/** A definition file that passed every check. */
export interface Definition {
  id: string;
  /** Path relative to the repository root. */
  file: string;
  /** The file's JSON value, keys in file order. This is what gets signed. */
  json: Record<string, unknown>;
  /** The value as lokkju/qusme's parser reads it. */
  definition: SiteDefinition;
}

export interface Problem {
  file: string;
  message: string;
}

let schemaValidator: ReturnType<Ajv2020['compile']> | undefined;

function validator(): ReturnType<Ajv2020['compile']> {
  if (schemaValidator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    schemaValidator = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
  }
  return schemaValidator;
}

function schemaMessage(e: ErrorObject): string {
  const where = e.instancePath === '' ? '(root)' : e.instancePath;
  const extra =
    e.keyword === 'additionalProperties'
      ? ` (${String((e.params as { additionalProperty: string }).additionalProperty)})`
      : e.keyword === 'enum'
        ? ` (${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')})`
        : '';
  return `schema: ${where} ${e.message ?? e.keyword}${extra}`;
}

/** JSON with object keys sorted, for comparing two definitions by meaning, not key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/** The event content for a definition: its JSON, compact, keys in file order. */
export function definitionContent(def: Pick<Definition, 'json'>): string {
  return JSON.stringify(def.json);
}

/**
 * Checks one definition file's text as the registry requires: the JSON Schema (which refuses
 * unknown keys, strategies, counters and locator kinds), lokkju/qusme's parser with no field
 * left unusable and no locator skipped, the file name equal to `id`, an account pattern with a
 * capture group, and an event that fits a relay's size limit.
 */
export function checkDefinitionText(
  file: string,
  text: string
): { definition: Definition } | { problems: string[] } {
  const parsedJson = capture(() => parseJsonText(text, ''));
  if (!parsedJson.ok) return { problems: [`not valid JSON: ${parsedJson.error.message}`] };
  const json = parsedJson.value;
  const problems: string[] = [];
  const validate = validator();
  if (!validate(json)) problems.push(...(validate.errors ?? []).map(schemaMessage));
  const parsed = parseSiteDefinition(json);
  if (!parsed.ok) {
    problems.push(`parser: ${parsed.error.message}`);
    return { problems };
  }
  const definition = parsed.value;
  for (const f of definition.unusableFields ?? []) {
    problems.push(`parser: field ${f.name} would be unusable: ${f.reason}`);
  }
  const expected = basename(file, '.json');
  if (definition.id !== expected) {
    problems.push(`id ${definition.id} differs from the file name ${expected}.json`);
  }
  const record = json as Record<string, unknown>;
  if (definition.account !== undefined) {
    const groups = (new RegExp(`${definition.account.extract}|`).exec('')?.length ?? 1) - 1;
    if (groups < 1) problems.push('account.extract has no capture group');
  } else if (record.account !== undefined) {
    problems.push('parser: account would be ignored (its locator is of an unknown kind)');
  }
  const rawFields = Array.isArray(record.fields)
    ? (record.fields as Record<string, unknown>[])
    : [];
  for (const field of definition.fields) {
    const raw = rawFields.find((f) => f?.name === field.name);
    const listed = Array.isArray(raw?.locators) ? raw.locators.length : 0;
    if (field.locators.length !== listed) {
      problems.push(`parser: field ${field.name} would skip a locator of an unknown kind`);
    }
  }
  // id, pubkey, sig and the tags written by events.ts, at their full lengths.
  const overhead = 64 + 64 + 128 + 200 + 2 * definition.id.length + 2 * definition.name.length;
  const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(record))) + overhead;
  if (bytes > MAX_EVENT_BYTES) {
    problems.push(`the signed event would be about ${bytes} bytes, over ${MAX_EVENT_BYTES}`);
  }
  if (problems.length > 0) return { problems };
  return { definition: { id: definition.id, file, json: record, definition } };
}

/** Reads and checks every `sites/*.json`. */
export function loadDefinitions(paths: Layout): { definitions: Definition[]; problems: Problem[] } {
  const definitions: Definition[] = [];
  const problems: Problem[] = [];
  const names = readdirSync(paths.sites)
    .filter((n) => !n.startsWith('.'))
    .sort();
  for (const name of names) {
    const file = relative(paths.root, join(paths.sites, name));
    if (!name.endsWith('.json')) {
      problems.push({ file, message: 'sites/ holds only <id>.json files' });
      continue;
    }
    const result = checkDefinitionText(file, readFileSync(join(paths.sites, name), 'utf8'));
    if ('problems' in result) {
      for (const message of result.problems) problems.push({ file, message });
    } else {
      definitions.push(result.definition);
    }
  }
  return { definitions, problems };
}
