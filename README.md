# qusme-registry

The site registry for [qus.me](https://github.com/lokkju/qusme): one JSON definition per site, telling the qus.me extension and service how to recognize a site, find the signed-in account, and fill a field such as a post composer. Definitions are data, never code. The registry publisher key signs each one as a Nostr `KIND_SITE_DEF` event (kind 31236, addressable, `d` = site id), and qus.me builds bundle a snapshot of those signed events. Devices refresh from relays and accept a definition only when its signature verifies against the publisher key pinned in their build and its version is newer than the one they hold. The specification is lokkju/qusme's `docs/spec.md`, sections 7.6 and 10.

## Layout

| Path | What it holds |
|---|---|
| `sites/<id>.json` | One definition per file; the file name is the site id |
| `schema/site-definition.schema.json` | JSON Schema for a definition, for editors and as the first validation pass |
| `events/<id>.json` | The signed event for each site's published version, committed by the operator after signing |
| `publisher/pubkey.json` | The registry publisher's public key (hex), `null` until the operator creates the key |
| `publisher/relay-list.json` | The publisher's signed NIP-65 relay list (kind 10002), once published |
| `vendor/qusme-nostr/` | lokkju/qusme's site definition parser, copied byte for byte (see below) |
| `example/index.html` | A local test page that `sites/example.json` describes |
| `src/`, `scripts/`, `test/` | The tooling |

```sh
mise install && pnpm install
pnpm validate                  # every definition, against the base branch's versions
pnpm publish-events --dry-run  # sign everything with a throwaway key
pnpm snapshot --dry-run        # build a snapshot with a throwaway key
pnpm test
```

## Definition format

`sites/example.json`, which describes `example/index.html` served on localhost:

```json
{
  "id": "example",
  "version": "2026.11.1",
  "name": "Example (local test page)",
  "match": ["http://localhost/*", "http://127.0.0.1/*"],
  "account": {
    "locator": { "role": "status", "name": { "en": ["Signed in"] } },
    "extract": "Signed in as @([A-Za-z0-9_]{1,15})"
  },
  "intents": { "compose": "{origin}/example/?text={text}" },
  "fields": [
    {
      "name": "text",
      "label": "Post text",
      "locators": [{ "role": "textbox", "name": { "en": ["Post text"], "de": ["Beitragstext"] } }],
      "inject": ["paste", "insertText", "native", "clipboard"],
      "constraints": { "maxLength": 280, "counter": "default" }
    }
  ]
}
```

- `id`: lowercase letters and digits, optionally separated by `.`, `_` or `-`; at most 128 characters. It must equal the file name, and it becomes the event's `d` tag, so renaming a site makes a new site.
- `version`: CalVer `YYYY.MM.N`, the year and month of the change and a counter that restarts at 1 each month (`2026.11.1`, `2026.11.2`, `2026.12.1`). Versions compare numerically, so `2026.11.10` is newer than `2026.11.9`. Every change to a definition needs a newer version, because a device ignores anything that isn't newer than what it has.
- `name`: the display name.
- `match`: WebExtension match patterns (`https://x.com/*`, `https://*.example.com/*`). It may be empty for a site with no fixed hosts, such as Mastodon; each destination then supplies its own `match` in its override (spec 10.1).
- `account` (optional): `locator` finds the element that names the signed-in account, and `extract` is a regular expression whose first capture group is the account.
- `intents` (optional): URL templates by name, with `{text}` and `{origin}` (the origin of the first `match` pattern) placeholders.
- `fields`: at least one, names unique.
  - `name`: the field's name in drafts (`text`); `label`: what the UI shows.
  - `locators`: ARIA role and accessible names, keyed by `document.documentElement.lang`, with `en` required as the fallback. A field matches when any locator does.
  - `inject`: injection strategies in the order tried, from `paste`, `insertText`, `native` and `clipboard` (spec 11.6). No repeats, and `clipboard` is last when present, since all it does is ask the user to paste.
  - `constraints` (optional): `maxLength` and the `counter` that measures it: `default` (code points), `graphemes` (Bluesky's unit) or `twitter-text` (X's weighting).

A destination's `override` merges over a definition by the rules in spec 10.2: objects merge key by key, scalars replace, `null` removes a key, arrays (including `match`, `locators` and `inject`) replace whole, and `fields` merge by `name`.

### Stricter than clients

Clients ignore keys they don't know and skip a field that names an unknown strategy or counter, so a newer registry never breaks an older build. The registry refuses all three: a definition here may use only what the current parser understands. A new strategy or counter lands in lokkju/qusme first, then in `vendor/qusme-nostr` by `pnpm vendor:sync`, then in a definition.

## Adding or changing a site

1. Add or edit `sites/<id>.json`. Locators for a real site must be checked against the live page, in every language the definition lists.
2. Set `version` to a newer CalVer than the one on `main`.
3. Run `pnpm validate` and open a PR. CI runs the same checks.

`pnpm validate` checks that every file:

- parses as JSON a client would accept (no `__proto__`-style keys, no deep nesting);
- passes the JSON Schema, which refuses unknown keys, injection strategies and counters;
- passes lokkju/qusme's own parser (`parseSiteDefinition`) with no field left unusable, which also covers what the schema can't express: unique field names, `clipboard` last, and `extract` being a regular expression;
- has an `id` equal to its file name and an `extract` with a capture group;
- fits in a 64 KiB event, the size storage relays accept;
- has a newer version than its copy at the base commit if it changed. The base is the merge base with the PR's target branch, or with `origin/main`; on `main` itself, the previous commit. `--base <ref>` overrides it.

It also checks `events/` and `publisher/`: each committed event verifies against the publisher key with `parseSiteDefinitionEvent`, has a definition, and is no newer than it, and a definition whose version matches its event has the same content.

## Publishing

Publishing is the operator's job, from a machine that holds the publisher key. The production key is not in this repository, not in CI and not in any CI secret; CI signs only with throwaway keys made for the run.

The key comes from the environment and is never printed:

- `QUSME_REGISTRY_NCRYPTSEC`: the key encrypted with a passphrase (NIP-49). The passphrase comes from `QUSME_REGISTRY_PASSPHRASE` or, when that's unset, a prompt on the terminal. This is the intended form.
- `QUSME_REGISTRY_NSEC`: the bare key, as an `nsec` or 64 hex characters, for tests and emergencies.

Every command that signs refuses a key that isn't the one in `publisher/pubkey.json`.

```sh
pnpm publish-events                    # sign every definition whose version has no event yet
pnpm publish-events --to-relay-list    # ...and publish them to the relay list's write relays
pnpm publish-events --relay wss://nos.lol --relay wss://relay.ditto.pub
pnpm publish-events --all --to-relay-list   # republish every current event, signing what's new
pnpm snapshot                          # dist/snapshot.json from events/ and the relay list
```

`publish-events` validates first and signs nothing if anything fails. For each definition without an event at its current version it writes `events/<id>.json`, with a `created_at` later than the event it replaces, so relays keep the newer one. It writes the events it signed (or, with `--all`, every current event) to `dist/events.jsonl`, one per line, and publishes those to the relays given, reporting each relay's answer and exiting non-zero if any relay refused or couldn't be reached. Commit `events/` afterwards: it's how the next run and the snapshot know what is published.

`pnpm relay-list --relay <url>[#read|#write] ... [--publish] [--also <url>]` signs the publisher's NIP-65 relay list into `publisher/relay-list.json` and, with `--publish`, sends it to those relays and any `--also` relays (an indexer such as `wss://purplepag.es` helps other clients find it). A relay without a marker is both read and write; devices fetch definitions from the write relays.

## Snapshot format

`pnpm snapshot` writes `dist/snapshot.json`, which lokkju/qusme's service and extension builds include (spec 10.3). It refuses to run unless every definition has a committed event at its current version and the relay list exists.

```json
{
  "format": "qusme-registry-snapshot/1",
  "publisher": "<publisher pubkey, 64 hex>",
  "relayList": { "kind": 10002, "tags": [["r", "wss://nos.lol"]], "...": "a signed event" },
  "siteDefinitions": [
    { "kind": 31236, "tags": [["d", "example"], ["alt", "qus.me site definition: Example (local test page) 2026.11.1"]], "content": "<definition JSON>", "...": "a signed event" }
  ]
}
```

- `format`: `qusme-registry-snapshot/1`. A change an older reader would misread gets a new number.
- `publisher`: the publisher pubkey. It's informational: a consumer pins the pubkey in its own source and refuses a snapshot whose `publisher` differs.
- `relayList`: the publisher's signed kind 10002, as committed in `publisher/relay-list.json`. Devices refresh by fetching the publisher's current kind 10002 from these relays, then `KIND_SITE_DEF` events from its write relays.
- `siteDefinitions`: one signed `KIND_SITE_DEF` per site, sorted by `d`. Each event's content is the definition file's JSON, compact, keys in file order. The tags are `d` (the site id) and a NIP-31 `alt`.

Every value is a complete signed Nostr event, so a consumer verifies the snapshot with the same code it uses for events from relays: `parseSiteDefinitionEvent(event, { publisherPubkey })` from `@qusme/nostr` for each site definition, and a signature and author check on the relay list. `verifySnapshot` in `src/snapshot.ts` does exactly that, and the tests run it against tampered and re-signed snapshots. `pnpm snapshot --dry-run` writes the same format to `dist/dry-run/snapshot.json` under a throwaway key, for testing a consumer before the production key exists.

## The parser

Validation uses lokkju/qusme's parser itself, not a reimplementation: `vendor/qusme-nostr/` holds `siteDef.ts` and the six files it imports from `packages/nostr/src`, unchanged, and `vendor/qusme-nostr/UPSTREAM.json` records the commit and each file's git blob id. A test fails if any vendored file differs from its recorded blob id, so a local edit can't pass as upstream code. `pnpm vendor:sync [<ref>]` (needs `gh` with read access to lokkju/qusme) refreshes the files from a commit, `main` by default, and refuses if the parser has started importing a file that isn't vendored.

I vendored the parser instead of depending on `@qusme/nostr` by git URL for two reasons. lokkju/qusme is private and CI's token reads only this repository, so a git dependency would need a deploy key or token in CI just to install. And `@qusme/nostr` exports TypeScript source from a pnpm workspace, which Node won't type-strip inside `node_modules`.

## Creating the production publisher key

The operator does this once, on a trusted machine with this repository checked out. The commands assume lokkju/infra's operator-only `secrets/` SOPS files.

1. `pnpm keygen --out ~/qusme-registry.ncryptsec` asks for a passphrase twice (12 characters or more), generates the key, writes it encrypted with that passphrase (NIP-49, `log_n` 20) to the file with mode 600, writes the pubkey to `publisher/pubkey.json`, and prints the pubkey and npub. The bare key is never printed or written.
2. Put the passphrase in the password manager.
3. Store the ncryptsec in lokkju/infra: `sops edit /home/lokkju/projects/infra/secrets/qusme-registry-publisher.sops.yaml` with one line, `QUSME_REGISTRY_NCRYPTSEC: ncryptsec1...`. A copy in the password manager next to the passphrase is a reasonable second backup, since the ncryptsec is useless without the passphrase. Then `shred -u ~/qusme-registry.ncryptsec`.
4. Publish the relay list. Which relays is an open question in spec 17; the spec recommends `wss://nos.lol` and `wss://relay.ditto.pub` for storage:

   ```sh
   sops exec-env /home/lokkju/projects/infra/secrets/qusme-registry-publisher.sops.yaml \
     'pnpm -C /home/lokkju/projects/qusme-registry relay-list --relay wss://nos.lol --relay wss://relay.ditto.pub --publish --also wss://purplepag.es'
   ```

   It prompts for the passphrase on the terminal.
5. Sign and publish the definitions, then build the snapshot:

   ```sh
   sops exec-env /home/lokkju/projects/infra/secrets/qusme-registry-publisher.sops.yaml \
     'pnpm -C /home/lokkju/projects/qusme-registry publish-events --to-relay-list'
   pnpm snapshot
   ```

6. Commit `publisher/pubkey.json`, `publisher/relay-list.json` and `events/` in a PR, and pin the pubkey in lokkju/qusme.

## License

CC0 1.0 Universal; see `LICENSE`.
