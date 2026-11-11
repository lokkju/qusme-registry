import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { checkDefinitionText, SCHEMA_PATH } from '../src/definitions.ts';
import {
  COUNTER_NAMES,
  INJECTION_STRATEGIES,
  LOCATOR_SOURCES,
  parseSiteDefinition,
} from '../vendor/qusme-nostr/siteDef.ts';
import { example } from './helpers.ts';

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

// biome-ignore lint/suspicious/noExplicitAny: mutations reach into nested definition JSON
type Mutation = (d: Record<string, any>) => void;

/** Cases the schema and the parser must agree on. */
const AGREE: [string, boolean, Mutation][] = [
  ['the example', true, () => {}],
  ['empty match (Mastodon)', true, (d) => (d.match = [])],
  [
    'no account or intents',
    true,
    (d) => {
      delete d.account;
      delete d.intents;
    },
  ],
  ['no constraints', true, (d) => delete d.fields[0].constraints],
  ['leading-zero month', true, (d) => (d.version = '2026.01.1')],
  ['missing id', false, (d) => delete d.id],
  ['missing fields', false, (d) => delete d.fields],
  ['empty fields', false, (d) => (d.fields = [])],
  ['uppercase id', false, (d) => (d.id = 'Example')],
  ['id with a slash', false, (d) => (d.id = 'a/b')],
  ['month 13', false, (d) => (d.version = '2026.13.1')],
  ['month 0', false, (d) => (d.version = '2026.0.1')],
  ['semver', false, (d) => (d.version = '1.2.3')],
  ['two-digit year', false, (d) => (d.version = '26.10.1')],
  ['bad match pattern', false, (d) => (d.match = ['example.com'])],
  ['wildcard inside a host', false, (d) => (d.match = ['https://ex*ample.com/*'])],
  ['empty name', false, (d) => (d.name = '')],
  ['locator without en', false, (d) => (d.fields[0].locators[0].name = { de: ['x'] })],
  ['empty locator names', false, (d) => (d.fields[0].locators[0].name.en = [])],
  ['bad language tag', false, (d) => (d.fields[0].locators[0].name.EN = ['x'])],
  ['no locators', false, (d) => (d.fields[0].locators = [])],
  ['empty inject', false, (d) => (d.fields[0].inject = [])],
  ['repeated strategy', false, (d) => (d.fields[0].inject = ['paste', 'paste'])],
  ['maxLength 0', false, (d) => (d.fields[0].constraints.maxLength = 0)],
  ['fractional maxLength', false, (d) => (d.fields[0].constraints.maxLength = 1.5)],
  ['bad intent name', false, (d) => (d.intents = { '1x': 'https://x/' })],
  ['account without extract', false, (d) => delete d.account.extract],
  ['field name over 128', false, (d) => (d.fields[0].name = 'x'.repeat(129))],
  ['placeholder locator', true, (d) => (d.fields[0].locators[0].by = 'placeholder')],
  ['name locator, explicit', true, (d) => (d.fields[0].locators[0].by = 'name')],
  ['by not a string', false, (d) => (d.fields[0].locators[0].by = 1)],
  [
    'account template',
    true,
    (d) => (d.account.extract = { pattern: d.account.extract, template: '{1}@{host}' }),
  ],
  ['extract object without a pattern', false, (d) => (d.account.extract = { template: '{1}' })],
  ['mastodon counter', true, (d) => (d.fields[0].constraints.counter = 'mastodon')],
];

/** Cases only the schema refuses: clients skip these, the registry must not publish them. */
const SCHEMA_ONLY: [string, Mutation][] = [
  ['unknown top-level key', (d) => (d.homepage = 'https://example.com/')],
  ['unknown field key', (d) => (d.fields[0].placeholder = 'x')],
  ['unknown constraint', (d) => (d.fields[0].constraints.minLength = 1)],
  ['unknown injection strategy', (d) => (d.fields[0].inject = ['typeKeys'])],
  ['unknown counter', (d) => (d.fields[0].constraints.counter = 'bytes')],
  ['unknown locator kind', (d) => (d.fields[0].locators[0].by = 'xpath')],
  ['unknown account locator kind', (d) => (d.account.locator.by = 'xpath')],
  [
    'extract object without a template',
    (d) => (d.account.extract = { pattern: d.account.extract }),
  ],
];

/** Cases only the parser refuses; JSON Schema can't express them. */
const PARSER_ONLY: [string, Mutation][] = [
  ['clipboard not last', (d) => (d.fields[0].inject = ['clipboard', 'paste'])],
  ['repeated field name', (d) => d.fields.push(structuredClone(d.fields[0]))],
  ['extract not a regular expression', (d) => (d.account.extract = '(')],
  [
    'template with an unknown placeholder',
    (d) => (d.account.extract = { pattern: d.account.extract, template: '{1}@{origin}' }),
  ],
  [
    'template naming a missing group',
    (d) => (d.account.extract = { pattern: d.account.extract, template: '{2}@{host}' }),
  ],
];

const mutated = (m: Mutation): Record<string, unknown> => {
  const d = example();
  m(d);
  return d;
};

describe('schema/site-definition.schema.json', () => {
  it('lists the same strategies, counters and locator kinds as the parser', () => {
    expect(schema.$defs.locator.properties.by.enum).toEqual([...LOCATOR_SOURCES]);
    expect(schema.$defs.field.properties.inject.items.enum).toEqual([...INJECTION_STRATEGIES]);
    expect(schema.$defs.field.properties.constraints.properties.counter.enum).toEqual([
      ...COUNTER_NAMES,
    ]);
  });

  it.each(AGREE)('agrees with the parser: %s', (_name, valid, m) => {
    const d = mutated(m);
    expect(validate(d)).toBe(valid);
    expect(parseSiteDefinition(d).ok).toBe(valid);
  });

  it.each(SCHEMA_ONLY)('refuses what clients would skip: %s', (_name, m) => {
    const d = mutated(m);
    expect(validate(d)).toBe(false);
    const parsed = parseSiteDefinition(d);
    expect(parsed.ok).toBe(true);
    expect(checkDefinitionText('sites/example.json', JSON.stringify(d))).toHaveProperty('problems');
  });

  it.each(PARSER_ONLY)('leaves to the parser: %s', (_name, m) => {
    const d = mutated(m);
    expect(validate(d)).toBe(true);
    expect(parseSiteDefinition(d).ok).toBe(false);
    expect(checkDefinitionText('sites/example.json', JSON.stringify(d))).toHaveProperty('problems');
  });
});

describe('checkDefinitionText', () => {
  const problems = (d: unknown, file = 'sites/example.json'): string[] => {
    const r = checkDefinitionText(file, JSON.stringify(d));
    return 'problems' in r ? r.problems : [];
  };

  it('accepts the example', () => {
    expect(problems(example())).toEqual([]);
  });

  it('names the unknown strategy, counter and key', () => {
    expect(problems(mutated((d) => (d.fields[0].inject = ['typeKeys'])))).toEqual(
      expect.arrayContaining([expect.stringMatching(/typeKeys/)])
    );
    expect(problems(mutated((d) => (d.fields[0].constraints.counter = 'bytes')))).toEqual(
      expect.arrayContaining([expect.stringMatching(/unknown counter bytes/)])
    );
    expect(problems(mutated((d) => (d.homepage = 'x')))).toEqual(
      expect.arrayContaining([expect.stringMatching(/additional properties \(homepage\)/)])
    );
  });

  it('requires the file name to be the id', () => {
    expect(problems(example(), 'sites/other.json')).toEqual([
      'id example differs from the file name other.json',
    ]);
  });

  it('names a locator or account the parser would skip', () => {
    expect(problems(mutated((d) => (d.fields[0].locators[0].by = 'xpath')))).toEqual(
      expect.arrayContaining(['parser: field text would skip a locator of an unknown kind'])
    );
    expect(problems(mutated((d) => (d.account.locator.by = 'xpath')))).toEqual(
      expect.arrayContaining([
        'parser: account would be ignored (its locator is of an unknown kind)',
      ])
    );
  });

  it('requires a capture group in account.extract', () => {
    expect(problems(mutated((d) => (d.account.extract = '@[a-z]+')))).toEqual([
      'account.extract has no capture group',
    ]);
  });

  it('refuses JSON a client would refuse', () => {
    const r = checkDefinitionText('sites/example.json', '{"__proto__": {}}');
    expect(r).toHaveProperty('problems');
    expect(checkDefinitionText('sites/example.json', '{')).toHaveProperty('problems');
  });

  it('refuses a definition too large for a relay', () => {
    const d = mutated((d) => (d.fields[0].label = 'x'.repeat(70_000)));
    expect(problems(d)).toEqual([expect.stringMatching(/over 65536/)]);
  });
});
