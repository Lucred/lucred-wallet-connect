# RWA new-issuance monitor

Flags **newly issued / newly-on-Stellar tokenized RWAs** — tokenized T-bills, MMFs,
gold, equities, private credit — so a new issuer/asset doesn't go unnoticed.

**Free and keyless.** Uses DefiLlama's public `api.llama.fi/protocols` (no API key, no
cost). The paid rwa.xyz API was dropped as too expensive.

## Why it's separate from `vault-coverage-check`

That checker watches curated **vault platforms** against the indexer registry. RWA
**issuers** mint tokenized **assets** that feed LCRD's collateral/pricing path and the
RWA scoring signal, not vault indexing — and there's no on-chain factory to enumerate
them.

## What it watches (two buckets, one free call)

- **Bucket A — RWA on Stellar:** protocols whose `chains` include Stellar and whose
  category is RWA-ish (`RWA`, `Treasury Manager`, `Onchain Capital Allocator`). High
  priority — already on Stellar. (Today: Defa/InvoiceMate, Huma, Untangled, Upshift.)
- **Bucket B — RWA issuer catalog:** every `RWA`/`Treasury Manager`-category protocol.
  DefiLlama leaves `chains` empty for most tokenized-treasury issuers (Spiko, Ondo,
  WisdomTree, Etherfuse, OpenEden, Backed …), so chain-filtering alone misses them;
  watching the whole RWA catalog means a **new issuer name** is caught as an
  early-warning to check whether it has launched on Stellar.

## How it detects "new"

A persisted seen-set (`state.json`). The **first run records the current set as a
baseline** (reported, exit 0 — bucket B is ~200 names on that first run, one time
only). Every run after flags anything new (exit 1), with a best-effort hint of whether
the name already appears in `registry.ts`.

## Run

```bash
python3 check-rwa-issuance.py                 # report new, update state (exit 1 if new)
python3 check-rwa-issuance.py --no-state-update
python3 check-rwa-issuance.py --json
python3 check-rwa-issuance.py --mock protocols.json   # test with a saved DefiLlama dump
```

Env: `LLAMA_URL` (default `https://api.llama.fi/protocols`), `REGISTRY_PATH`,
`STATE_PATH`, `HTTP_TIMEOUT`.

## Cron (VM `lcrd-indexer`)

Weekly, Mondays 05:30 UTC (after the 05:00 vault check):

```
30 5 * * 1 /home/mac/lcrd/rwa-issuance-monitor/run-rwa-issuance-monitor.sh >> ~/lcrd-logs/rwa-issuance.log 2>&1
```

When the log shows a NEW **Stellar** RWA (bucket A): triage it — (a) index for scoring
(resolve its Stellar contract id via the issuer's stellar.toml / stellar.expert, add to
`registry.ts`, redeploy, backfill); (b) assess for collateral (transferability gate +
haircut; see the `rwa-collateral` notes). A new **catalog** entry (bucket B): glance to
see if it's on Stellar yet.

## Deeper check: issuer-asset scan (`check-issuer-assets.py`)

DefiLlama is protocol-level, so a *new product from an issuer already on Stellar*
(e.g. Etherfuse adds a bond) won't create a new DefiLlama protocol. This second check
(also free) scans Hubble's `history_assets` via the `bq` CLI for every classic asset
issued by a curated allowlist of **legit RWA issuer accounts**, and flags any asset
code not seen before (own state: `issuer-assets-state.json`).

- **Allowlist = issuer G-accounts, not asset codes** — a code like BENJI/CETES has
  dozens of impostor issuers. Seeded (SAC-verified against `registry.ts`): **Etherfuse**
  (`GCRYUGD5…`), **Franklin Templeton** (`GBHNGLLIE3KW…`).
- **Add an issuer** with `resolve-issuers.js`: pull candidates for the codes you want
  (`bq … history_assets WHERE asset_code IN (…)` → `cands.json`), run
  `node resolve-issuers.js cands.json`, and paste the verified issuer G-address into
  `KNOWN_RWA_ISSUERS`. Still to add when prioritized: WisdomTree (classic, 9 funds),
  Untangled. Native-Soroban issuers (Spiko) aren't in `history_assets` — those are
  indexed as contracts and caught on the contract path, not here.
- Run: `python3 check-issuer-assets.py` (exit 1 if new; `--json`, `--no-state-update`).

The wrapper (`run-rwa-issuance-monitor.sh`) runs BOTH checks under the one weekly cron
and exits non-zero if either finds something new.

### Known uncovered assets found at build time (2026-11-18)

The first issuer-asset scan surfaced classic assets from the seeded issuers that the
indexer registry does NOT yet include — candidates to triage (index + collateral):
Etherfuse **CETESZ, GILTS, KTB, MEX, MEXe**; Franklin **FOCGX, USDPEND**. (Issuance
alone doesn't prove active holdings — verify before indexing.)
