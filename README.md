# qusme-registry

The site registry for [qus.me](https://github.com/lokkju/qusme): one JSON definition per site, telling the qus.me extension and service how to recognize a site, find the signed-in account, and fill a field such as a post composer. Definitions are data, never code. The registry publisher key signs each one as a Nostr `KIND_SITE_DEF` event (kind 31236, addressable, `d` = site id), and qus.me builds bundle a snapshot of those signed events. Devices refresh from relays and accept a definition only when its signature verifies against the publisher key pinned in their build and its version is newer than the one they hold. The specification is lokkju/qusme's `docs/spec.md`, sections 7.6 and 10.

## Layout

| Path | What it holds |
|---|---|
| `sites/<id>.json` | One definition per file; the file name is the site id. The sites so far are under [Sites](#sites) |
| `schema/site-definition.schema.json` | JSON Schema for a definition, for editors and as the first validation pass |
| `events/<id>.json` | The signed event for each site's published version, committed by the operator after signing |
| `publisher/pubkey.json` | The registry publisher's public key (hex), `null` until the operator creates the key |
| `publisher/relay-list.json` | The publisher's signed NIP-65 relay list (kind 10002), once published |
| `vendor/qusme-nostr/` | lokkju/qusme's site definition parser, copied byte for byte (see below) |
| `test/fixtures/sites/` | Definitions for tests and CI's dry runs, never published; `example.json` describes the local test page in `test/fixtures/example/` |
| `src/`, `scripts/`, `test/` | The tooling |

```sh
mise install && pnpm install
pnpm validate                  # every definition, against the base branch's versions
pnpm publish-events --dry-run  # sign everything with a throwaway key
pnpm snapshot --dry-run        # build a snapshot with a throwaway key
pnpm test

# the same against the fixtures, as CI does
pnpm validate --sites test/fixtures/sites
pnpm publish-events --dry-run --sites test/fixtures/sites
pnpm snapshot --dry-run --sites test/fixtures/sites
```

## Sites

The launch sites come from [lokkju/qusme#22](https://github.com/lokkju/qusme/issues/22). A definition counts as verified once the extension has inserted a draft with it on the live, logged-in site, and the PR records the date, the `lang` values checked and the strategy that worked. The schema has no field for this, so it lives here.

| Site | File | Version | Verified on a logged-in page |
|---|---|---|---|
| X | `sites/x.json` | 2026.11.2 | No. Built from X's shipped web bundles and message catalogs (`abs.twimg.com/x-web/x-web/assets/messages-logged-in-*.json`) and public userscripts, without an account; the operator checks it live |
| Bluesky | `sites/bsky.json` | 2026.11.1 | No. Built from bluesky-social/social-app's source (`main` at c5fe6e8, 2026-11-09) and its Lingui catalogs, without an account |
| Mastodon | `sites/mastodon.json` | 2026.11.1 | No. Built from mastodon/mastodon's source at v4.7.5 and `main` (5a207bc, 2026-11-09) and their locale files, without an account |
| LinkedIn | `sites/linkedin.json` | 2026.11.1 | No. LinkedIn's client isn't public; built from its help center and public automation code that records the composer's markup |

X currently ships two web clients, and the definition targets both. The older one has a Draft.js composer whose textbox is named "Post text" (English only in the definition, since its catalogs aren't public). The newer `x-web` client has a `<textarea>` named by its placeholder, "What's happening?", in the 42 languages its catalogs translate. Both name the sidebar account button "Account menu" and show `@handle` inside it, which is what `extract` reads; on narrow screens `x-web` shows only the avatar, so detection fails there and the extension lists every X account. The 280 limit is the free tier's; X Premium's longer posts are out of scope.

Bluesky's web composer is a TipTap (ProseMirror) editor: `role="textbox"` from TipTap, but no `aria-label`, and its placeholder ("What's up?", "Write your reply", "Add another post") is a `data-placeholder` on the empty paragraph, which no accessible name reads. So the field's locator lists those placeholders in every language the catalogs translate but matches nothing on today's bsky.app; insertion relies on the focused element (spec 10.2), and the composer focuses itself when it opens. The sidebar's account button is named "Switch accounts" and holds the display name followed by `@handle`; `extract` takes the handle at the end of the text. On narrow screens the button shows only the avatar, so detection fails there. The 300 limit is graphemes, `MAX_GRAPHEME_LENGTH` in the client.

Mastodon has no fixed hosts: `match` is empty and each destination names its instance in its override (spec 10.1). The composer is a `<textarea>`, named by its placeholder: "What's on your mind?" through 4.7 (an `aria-label` repeating the placeholder) and "What would you like to say?" in the redesigned composer on `main` and 5.0, both in every translated locale. The server counts 500 grapheme clusters, every URL as 23 and a remote mention as its local part (`StatusLengthValidator`); the registry has no counter for those rules, so the definition uses `graphemes`, which counts a URL longer than 23 characters against the post and a shorter one as less than Mastodon does. There is no `account`: destinations name accounts as `user@instance`, and the web client shows the signed-in account only as `@user`, which `extract` can't extend with the page's host. An instance with another limit overrides `constraints`.

LinkedIn's share box opens a Quill editor (`.ql-editor`, `role="textbox"`, `aria-label="Text editor for creating content"`), sometimes inside an open shadow root (`#interop-outlet`). Locators search only the light DOM, so in the shadow variant insertion relies on the focused element, which the extension does follow into open shadow roots. Only the English label is known. There is no `account`, since nothing on the page names the signed-in member without opening a menu, and no `intents`, since LinkedIn documents no text-prefill URL. Posts take 3,000 characters by LinkedIn's help center; how it counts them isn't documented, so the definition counts code points.

## Definition format

The fixture `test/fixtures/sites/example.json`, which describes `test/fixtures/example/index.html` served on localhost:

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
  "intents": { "compose": "{origin}/test/fixtures/example/?text={text}" },
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

`--sites <dir>` reads definitions from another directory instead of `sites/`; `publish-events` and `snapshot` accept it only with `--dry-run`, so fixtures never reach the publisher key.

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
pnpm publish-events --relay wss://relay.primal.net --relay wss://relay.ditto.pub
pnpm publish-events --all --to-relay-list   # republish every current event, signing what's new
pnpm snapshot                          # dist/snapshot.json from events/ and the relay list
```

`publish-events` validates first and signs nothing if anything fails. For each definition without an event at its current version it writes `events/<id>.json`, with a `created_at` later than the event it replaces, so relays keep the newer one. It writes the events it signed (or, with `--all`, every current event) to `dist/events.jsonl`, one per line, and publishes those to the relays given, reporting each relay's answer and exiting non-zero if any relay refused or couldn't be reached. Commit `events/` afterwards: it's how the next run and the snapshot know what is published.

`pnpm relay-list --relay <url>[#read|#write] ... [--publish] [--also <url>]` signs the publisher's NIP-65 relay list into `publisher/relay-list.json` and, with `--publish`, sends it to those relays and any `--also` relays (an indexer, so other clients can find the list). A relay without a marker is both read and write; devices fetch definitions from the write relays.

## Snapshot format

`pnpm snapshot` writes `dist/snapshot.json`, which lokkju/qusme's service and extension builds include (spec 10.3). It refuses to run unless every definition has a committed event at its current version and the relay list exists.

```json
{
  "format": "qusme-registry-snapshot/1",
  "publisher": "<publisher pubkey, 64 hex>",
  "relayList": { "kind": 10002, "tags": [["r", "wss://relay.primal.net"], ["r", "wss://relay.ditto.pub"]], "...": "a signed event" },
  "siteDefinitions": [
    { "kind": 31236, "tags": [["d", "x"], ["alt", "qus.me site definition: X 2026.11.1"]], "content": "<definition JSON>", "...": "a signed event" }
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
4. Publish the relay list. The publisher's relays are `wss://relay.primal.net` and `wss://relay.ditto.pub`, both read and write, and the list also goes to the indexer `wss://purplepag.es` (decided 2026-11-05; on 2026-11-09 relay.primal.net replaced nos.lol, which silently dropped the publisher's writes, see #11):

   ```sh
   sops exec-env /home/lokkju/projects/infra/secrets/qusme-registry-publisher.sops.yaml \
     'pnpm -C /home/lokkju/projects/qusme-registry relay-list --relay wss://relay.primal.net --relay wss://relay.ditto.pub --publish --also wss://purplepag.es'
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
