# Boundless income loader

Indexes **Boundless** (boundlessfi.xyz) builder income into `credit_bureau.oss_bounty_events` so wallets
that earn Boundless hackathon prizes, bounties and grants become scoreable (the existing income scorer,
`backend/credit-score-api/oss-contribution.js`, sums `assetCode='USDC'` rows per receiver over 12 months —
no code change needed).

## Why this is different from the other income sources
- **Drips Wave** = classic USDC payments from a treasury (read from Horizon).
- **GrantFox** = TrustlessWork shared escrow (decoded by the in-stream indexer).
- **Boundless** = its **own Soroban contract** (`boundless-events`
  `CCFVEGOQJEM47LRAJU2LHEK4KTL5VYN7AOGZ2HH2GNHAMXTILNMMJGQZ`, mainnet). Payouts are **contract events**, so
  we read them from BigQuery `crypto-stellar.crypto_stellar.history_contract_events_v2` (DAY-partitioned,
  clustered by `contract_id` — the cheapest complete source for one contract's Soroban events).

## Events (confirmed against live mainnet data, 2026-11-14)
On-chain event names are **snake_case** (NOT the PascalCase in Boundless's Dune doc):
- `winner_paid` — Hackathon/Bounty prize collected (`claim_prize`). `amount`(i128 stroops), `event_id`(u64),
  `recipient`(address), `position`(u32).
- `milestone_claimed` — Grant/Crowdfunding milestone paid. `amount`, `event_id`, `recipient`, `milestone`(u32).
- The payout carries **neither token nor pillar** — both live on `event_created` (`id`, `pillar` as an enum
  `vec[0].symbol`, `token`). The loader joins `payout.event_id -> event_created`.

## Classification
Only **USDC** payouts are counted (token == Circle USDC SAC `CCW67TSZ…`), matching the scorer. By pillar:

| Pillar | incomeType | scorer weight | note |
|---|---|---|---|
| Bounty | `oss_bounty` | 1.0 (full) | work-for-pay, like GrantFox |
| Hackathon | `event_grant` | 0.35 | one-off prize (same rule as HackMeridian) |
| Grant | `event_grant` | 0.35 | one-off |
| Crowdfunding | — | — | **excluded**: recipient is the creator withdrawing raised capital, not earned income |

(The 0.35 multiplier for `event_grant` lives in `oss-contribution.js`.)

## Run
```bash
./load-boundless-income.sh          # load new income (full-history scan, idempotent)
./load-boundless-income.sh --full   # explicit backfill alias (same behaviour)
```
Idempotent (dedups against rows already in the table, and against the double-recording in the events
table). Needs `python3` + `bq` (gcloud auth). One BQ scan of this one contract's events (~$0.3 upper
bound, capped by `MAX_BYTES`).

## Cron (VM) — weekly is plenty (Boundless payouts are infrequent)
```
30 4 * * 1  cd ~/lcrd/boundless-income && ./load-boundless-income.sh >> ~/lcrd-logs/boundless-income.log 2>&1
```

## Backfill result (2026-11-14)
First load: **32 income rows** (winner_paid + milestone_claimed, deduped), all USDC, split across
`oss_bounty` (bounties) and `event_grant` (hackathons). Verified live: a $200 bounty counts in full
(score→income path), a $250 hackathon prize counts at $87.50 (×0.35).

## Future
- Incremental cost optimisation: filter payouts to recent `closed_at` partitions and persist the
  `event_id -> {pillar, token}` map, instead of scanning full history each run.
- `boundless-profile` (`CD3KH4OE…`) keeps a per-wallet earnings ledger; could be read directly as a
  cross-check or a lighter signal.
