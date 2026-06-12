# Geo Curator Copilot

[![CI](https://github.com/Suckhept/geo-curator-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Suckhept/geo-curator-copilot/actions/workflows/ci.yml)

Duplicate detection & QA engine for the [Geo](https://www.geobrowser.io) knowledge graph (GRC-20).

## Receipts

- **618 duplicate entities** and **103 duplicate relation groups** found across Geo flagship spaces (Crypto, Crypto datasets).
- A merge proposal built by this engine was submitted through on-chain governance from a regular member account: [Dedup pilot v2: merge 56 duplicate entities](https://www.geobrowser.io/space/5908c73ad336472ccbd983491d2d17e4/governance?proposalId=c8acd570ca364c7d81e2c1aede02d154) — open for editor vote as of 2026-06-12; [live status](https://geocheck.space).
- Live demo: **<https://geocheck.space>** — paste any Geo space id, get a duplicate report in the browser.

## How it works

Entity pairs are scored by independent signals (thresholds: duplicate ≥ 0.9 auto-merge band, likely ≥ 0.6 human review):

- **Case/punctuation-insensitive name matching** — exact match after casefold + punctuation strip; below that, fuzzy token-sort/token-set + Jaccard with domain stop-words (audit, report, by, …).
- **Identity vs profile URL tiers** — a shared canonical URL on an identity property (Report URL) is decisive evidence (1.0); profile URLs (Website / X / LinkedIn) only support a match.
- **Hub-URL guard** — a URL shared by many entities (a protocol's audits folder, a project homepage) identifies a group, not an entity; corpus document frequency strips its identity power.
- **Relation-conflict veto** — when the same relation type points at disjoint targets on both sides (same link, different auditor), the pair is capped into the review band instead of auto-merging.
- **Schema-entity guard** — entities used as types or property definitions by others are never auto-merged ("Date" vs "Date" is by design); they are demoted to review with an explicit signal.
- **Version veto** — disjoint version markers (v3.0 vs v3.1) cap the score; only an identity-tier URL match overrides it.

On top of pair matching, an **intra-entity lint** finds duplicate relations `(typeId, toEntityId)` and duplicate values inside a single entity and emits `deleteRelation` fix ops.

Confirmed clusters become a fix plan (re-point inbound relations to the canonical entity, then delete duplicates), serialized as a GRC-20 binary edit, uploaded to IPFS, and submitted as a governance proposal via an ERC-4337 Safe — editors vote, the merge applies.

## Packages

| package | what it is |
|---|---|
| `@geo-copilot/core` | matching engine: signals, scoring, clustering, schema guard, intra-entity lint, fix plans — zero deps |
| `@geo-copilot/client` | GraphQL transport, full-space snapshots, CSV draft loading, GRC-20 publishing (IPFS + Safe / ERC-4337) |
| `@geo-copilot/cli` | `geo-copilot`: `snapshot` \| `scan` \| `lint` \| `fix` |
| `@geo-copilot/mcp-server` | 5 MCP tools for AI curators; the only mutating tool requires `GEO_PRIVATE_KEY` **and** `confirm: true` |
| `@geo-copilot/web` | geocheck.space: live space scans, precomputed nightly reports, proposal status |

## Quickstart

```bash
pnpm install && pnpm build && pnpm test

# 1. snapshot a space (paginates to the last page; pasted GraphQL responses also accepted)
node packages/cli/dist/main.js snapshot --space <spaceId> --out space.snapshot.json

# 2. scan for duplicates -> geo-copilot-out/report.{json,md}
#    exit code: 0 clean, 2 duplicates found (CI-friendly), 1 error
node packages/cli/dist/main.js scan --space <spaceId> --snapshot space.snapshot.json

# 3. turn the plan into a GRC-20 edit; always dry-run first
GEO_PRIVATE_KEY=0x... GEO_SAFE_ADDRESS=0x... \
node packages/cli/dist/main.js fix --plan pilot-edit.json --tier a \
  --space <spaceId> --network TESTNET_V2 \
  --exclude exclude-ids.json --publish --dry-run
```

`fix` also accepts `--report geo-copilot-out/report.json` directly; `--exclude` takes a JSON file with entity ids that must never be deleted (governance entities). The private key is read from the environment only and is never written or logged.

## License

[MIT](LICENSE)
