# Vault coverage check

Catches **new vaults on major Stellar platforms that are not yet in the indexer's
`PROTOCOL_REGISTRY`** — the blind spot that let the Sentora USDC vault (~$53.7M,
the largest Stellar yield vault) go unindexed.

## Why it's needed

`backend/indexer/src/poolDiscovery.ts` auto-discovers vaults for platforms with an
**on-chain factory** (Soroswap, Sushi, Aquarius, DeFindex, Blend, Phoenix). Platforms
that are **curated with no factory** have no discovery hook, so a new vault there is
invisible until a human notices. This checker pulls each such platform's authoritative
vault list and diffs it against `registry.ts`.

Platforms covered:
- **Upshift / Sentora / Gami** — the August Digital API (`chain -3`), the feed DefiLlama also reads.
- **Stellar DeFi Hub** — no factory/API; its authoritative list is the hardcoded `vaults`/`shareVaults` arrays in its DefiLlama adapter, which we fetch and diff.

Not covered here: tokenized-**RWA issuers** (Ondo, Etherfuse, Spiko, WisdomTree, …).
They mint tokenized *assets*, not vaults, and feed the collateral/pricing path rather
than vault indexing — a different check (e.g. an rwa.xyz-based issuance monitor), not
this one.

Read-only: fetches public APIs + reads `registry.ts`. No chain or BigQuery writes.

## Run

```bash
python3 check-vault-coverage.py          # human report; exit 1 if any gap/fetch error
python3 check-vault-coverage.py --json    # machine-readable
```

`REGISTRY_PATH` overrides the registry location (default: the repo's
`backend/indexer/src/registry.ts`; on the VM, `~/lcrd/indexer/src/registry.ts`).

## Cron (VM `lcrd-indexer`)

Weekly, Mondays 05:00 UTC, alongside the other `ops/` monitors:

```
0 5 * * 1 cd ~/lcrd/vault-coverage-check && ./run-vault-coverage-check.sh >> ~/lcrd-logs/vault-coverage.log 2>&1
```

When the log shows an UNCOVERED vault: add its id to `registry.ts`, redeploy the
indexer (`scp` + `bash ~/lcrd/deploy-gcp.sh indexer`), then backfill its history
(Hubble → `parseContractEventGroup` → `bq load`; see the v2 backfill method).

## Adding a platform

Append an entry to `PLATFORMS` in `check-vault-coverage.py` with a `fetch_*`
function returning `[{address, name, tvl}]` for that platform's live Stellar
vaults. The August Digital (API) and Stellar DeFi Hub (DefiLlama-adapter parse)
adapters are the two references for the two source shapes.
