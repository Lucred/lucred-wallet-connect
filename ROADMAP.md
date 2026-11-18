# LCRD Roadmap

Forward-looking work for the LCRD credit product — scoring, on-chain credit lines,
the indexer, and the developer surface that feeds them.

LCRD's core is **reputation-based credit**: an on-chain score built from a wallet's
Stellar footprint, turned into borrow-on-score and borrow-on-collateral credit lines.
This file is the single plan of record, consolidating the product, data, and
developer-surface work ahead. Items are marked **[done]**, **[in flight]**, or
**[planned]**; verify against current code before treating any line as live state.

## What already exists (build on, don't rebuild)

- **Multi-protocol indexer** — 21+ Stellar DeFi protocols into `credit_bureau.credit_events`
  (Blend, Aquarius, Soroswap, DeFindex, XOXNO, Ondo, Huma, Slender, Phoenix, Sushi, etc.);
  galexie → BigQuery, P30-ready (`@stellar/stellar-sdk` 17.4.0) on GCP VM `lcrd-indexer`.
- **Live position reads** — `backend/credit-score-api/portfolio.js` `getPortfolio(wallet)`:
  token + DeFi positions, USD valuation, transferability. LP/vault decomposition already
  implemented for Aquarius and DeFindex; Blend via `get_positions`.
- **Scoring + credit layer** — `/score`, `/credit-line`, on-chain Soroban credit-line pool
  (`contracts/credit-line/src/lib.rs`) with per-second interest, `quote()`-bounded
  tiers/limits/APR, graded starter line (gate score ≥ 50), secured lines, LTV/liquidation.
- **Borrow-on-collateral** — `src/collateral.ts` + `contracts/collateral-escrow/` on testnet.
- **`simulateTransaction` is healthy** on current pubnet incl. Soroswap (verified 2026-11-01).

---

## Credit-product depth

- [ ] **[planned] Granular credit-amount underwriting.** Size the line from *all* the
      datapoints that make up the wallet score (tenure, protocol breadth, volume, repayment
      cycles, income), not score alone. The contract already separates the underwriter-chosen
      `limit` (capped by on-chain `quote`) from the cap, so richer per-datapoint sizing can be
      computed off-chain in the score-api and passed as `limit` — or the on-chain cap formula
      itself takes more inputs.
- [ ] **[planned] Score-variable APR for collateral lines (mainnet).** Today `src/collateral.ts`
      prices flat by asset class (`APR_BY_CLASS`, stable 14% → curated 18.5%), ignoring score,
      and passes that `aprBps` straight into the on-chain open call. Secured lines are *already*
      score-variable (`secured_quote`). Fix: `collateralApr = base + classRiskPremium +
      0.35×scorePremium(score) − cycleDiscount`, floored — keep the score weight light
      (collateral is the protection). Phase 1: compute in `collateral.ts`. Phase 2 (durable):
      derive APR in the collateral contract from an attested score like `secured_quote` does —
      also removes the soft spot where the contract trusts a frontend-passed `aprBps`. Reconcile
      why collateral rates (14–18.5%) sit above secured-line rates (9–15%).
- [ ] **[planned] Tokenize the pool share → SEP-41 "LCRD LP token."** The pool share is an
      internal balance today (`shares_of`/`set_shares`) — not transferable, invisible to other
      platforms, usable only to back a secured line on LCRD's own pool. Make the pool contract
      SEP-41 (or a wrapper) so shares become transferable + composable + usable as collateral on
      other Stellar DeFi. Caveats: external platforms must whitelist + price it (expose a
      share-price read); and a share pledged for an LCRD secured line must be locked so it can't
      also be transferred (double-spend) — the contract already blocks withdrawing shares behind
      an open loan (err #18), so add a lock/escrow-on-pledge.
- [~] **[in flight] dfToken collateral credit — USDC against DeFindex positions.** A borrower
      pledges DeFindex vault shares (dfTokens) and draws 50–75% as USDC at the indicative secured
      APR. **Stage A (off-chain, demoable) done** — `collateral-engine.js`
      (`defindexCollateral`/`quote`), `dfCredit` policy (`df-credit-2026-10-draft1`), both
      `GET /df-credit/quote` and `POST /df-credit/accept` live on Cloud Run (verified 2026-11-01),
      and frontend UI (`src/dfCredit.ts`, `src/dfCreditView.ts`, `borrow.html`). **Remaining:**
      **Stage B** testnet end-to-end (Soroban escrow + engine attestation + treasury
      disbursement), then **Stage C** embeddable widget for fintechs. See the staged plan in
      session notes.
- [ ] **[planned] Privy embedded-wallet onboarding.** Email/social-login smart wallets (gasless)
      via Privy alongside Stellar Wallets Kit, so non-crypto-native users onboard and draw a line
      without seed phrases. Testnet first (onboard + draw), then live with DeFindex on mainnet.
- [~] **[in flight] Tokenized-RWA collateral.** Accept freely-transferable tokenized real-world
      assets — tokenized T-bills / money-market funds and tokenized gold — as collateral for a USDC
      line via the collateral engine's existing `rwa` class. Add a **transferability gate**: many
      tokenized RWAs are permissioned / whitelisted assets a pool cannot custody, so detect that
      (classic `auth_required`, or a native-token permission manager) and accept only freely
      transferable ones. Price each via the two-step `PRICED_TOKENS` + `asset_prices`, sub-tier the
      haircut by RWA type (T-bills tight, gold wider, trade-finance / private-credit excluded), and
      keep LTV conservative to absorb RWA redemption lag (no fire-sale liquidation; an
      auction-on-liquidation layer can come later). Etherfuse T-bills are already indexed and in the
      `rwa` class; Ondo USDY is the largest freely-transferable asset to add next. Holding RWAs
      should also lift the credit score independent of borrowing.
      **Testnet (done): Etherfuse CETES wired end-to-end.** Real CETES on Stellar testnet (Etherfuse
      sandbox, issuer home_domain `sand.etherfuse.com`, SAC `CC72F57Y…`, verified on-chain + via
      `stellar contract id asset`). The engine now accepts **directly-held** registry assets, not just
      vault shares (`tokenCollateral`/`engineCollateral` in `collateral-engine.js`); `collateral-registry.js`
      has the testnet CETES entry (`kind:"asset"`, `rwa` class, `clawback:true`, conservative 60%/85%
      bands); `etherfuse.js` prices it from the public `/lookup/stablebonds` (MXN) × live MXN→USD FX —
      no `asset_prices` row needed on testnet; `collateral-testnet.js` reads a testnet wallet's CETES
      and `scripts/cetes-testnet-quote.js` quotes it (verified live: 467.63 CETES → ~$28.79 → ~$10.80
      lendable at the clawback-adjusted 62% haircut). On-chain pledge harness:
      `contracts/collateral-escrow/scripts/cetes-escrow-testnet.sh` (allowlists the CETES SAC, then
      deposit→disburse→repay→close). **Remaining:** fund a borrower via the Etherfuse sandbox onramp
      (needs a sandbox API key) and run the on-chain pledge; a `/df-credit` testnet-quote endpoint +
      UI surface; then USTRY/TESOURO/USDY by the same pattern, and mainnet `asset_prices` wiring.
- [ ] **[exploratory] Tokenized-equity collateral (`rwa_equity`).** Extend RWA collateral to tokenized
      stocks, index/ETF, and fund shares so holders can borrow a USDC line against them. On-chain
      equity trading has reached Stellar — 21X (an EU-regulated DLT trading & settlement system) went
      live on Stellar in May 2026 with a native on-chain central-limit order book settling in
      stablecoins — which makes tokenized securities a plausible new collateral class. Treated as a
      **separate sub-class** of `rwa`, not folded into the T-bill tier, because equities carry
      single-name volatility, intraday price moves, and trading-hours / halt risk the debt RWAs don't:
      a **wider haircut (~40–50%+)**, a **preference for tokenized index/ETF products over single
      stocks**, an oracle with a **tight staleness cap** (venue mid or issuer price, since equity marks
      move intraday), and conservative LTV. Eligibility still runs through the existing transferability
      gate — only tokenized equities a pool can actually custody and liquidate qualify — and the
      applicable regulatory treatment of securities-backed credit is to be confirmed per market before
      build. Near-term, holding tokenized equities can lift the **credit score** independent of
      borrowing (same as holding tokenized T-bills), which needs none of the custody/liquidation work.

## Scoring & data expansion

- [ ] **[planned] Multi-chain scoring.** Expand scoring signal beyond Stellar. Scoring-signal
      chains (deep lending history): **Ethereum, Base, Solana** — index for the score.
      Lending/disbursement chains (clean USDC): **Arc, Base**. Scoring chain ≠ lending chain;
      one identity spans chains via a **multi-wallet profile**. Cost-sensitive: evaluate data
      providers (Dune / Allium / Goldsky / Covalent / Envio HyperSync / The Graph) vs self-index
      per chain. **Decision taken:** index **Arc** light now — not for scoring signal (no history
      yet) but operationally (LCRD already lends on Arc), as first-mover on Circle's chain, and to
      accumulate Arc credit history from genesis.
- [ ] **[planned] Off-chain underwriting + B2B payments data partnership.** The "coming soon"
      off-chain engine (`credit-data-analyser`: `services/pdf_reader` + `services/analysis`) adds a
      cash-flow sub-score alongside the on-chain score. A prospective data partner brings reconciled
      **B2B payment history** (who pays on time, how much, how often) — maps directly onto the
      off-chain engine. Next step: when off-chain underwriting is built, scope a pilot for how the
      partner's reconciled payment data feeds the cash-flow sub-score.
- [ ] **[design-ready] On-chain trade-credit (B2B receivables) signal.** Invoice-financing protocols
      (Airswift, Indentura, Trilobyte) are pre-mainnet; when one goes live we fold the SME's
      advance→settlement into the existing borrow→repay score (Option A, no separate business-credit
      product yet). Full design — the `Airswiftio/SCF` reference contracts/events, the
      `computeDebtCycles` mapping (`scf_pool.accept`=borrow, `scf_soroban.redeem`=repay, SME=`accept.to`),
      the correlation/due-date/entity-blend caveats, and the StellarLight go-live trigger — is written
      up in `backend/indexer/COVERAGE.md` §6.
- [ ] **[planned] Outcome instrumentation — loan performance by tier.** A loan-performance
      pipeline keyed by score tier (documented schema + dashboard queries), feeding repayment
      outcomes back into scoring.
- [~] **[in progress] Payment-based income sources + LCRD repayment feedback.**
      - DONE (2026-11-12): Drips Wave now counts `$1` incremental withdrawals — contributors who
        collect a whole grant as repeated `$1` payments were scoring `$0`. Loader generalized to a
        payer registry (`ops/drips-income/load-drips-income.py`).
      - DONE (2026-11-14): **HackMeridian** grants (`GC4MRJZW…`) added as `incomeType=event_grant`,
        memo-scoped to grant payments, counted at **0.35** in `oss-contribution.js` (one-off
        travel/event grants are a weaker creditworthiness signal than sustained income). "Cheese Pay"
        (`GBOGVS7Q…`) investigated and **excluded** — it's a consumer USDC wallet, not income.
      - READY, dormant until mainnet: **LCRD's own credit-line pool feeds repayment into the LCRD
        score.** Pool registered in `backend/indexer/src/registry.ts`; scorer `computeDebtCycles` has
        an `lcrd` branch so borrow→repay builds the repayment-speed / completed-loans signal.
        PENDING: an `lcrd` event resolver in `xdrParser.ts` (write against a real on-chain
        borrowed/repaid event — `payer` sits in the `repaid` data, borrower is `topic[1]`), and swap
        the testnet pool id for the mainnet id at launch. Scoring reads mainnet, so this is inert
        until the pool is on mainnet.
- [ ] **[planned] Sybil / cluster detection — common-funding-source signal.** The score floor is
      cheap to mint (one borrow→repay cycle takes a new wallet 0 → ~67, bottom of tier A) but
      deliberately inert: unsecured and score+collateral credit are gated on **tier A/B *and*
      tenure ≥ 11 pts ≈ 90 days** (`notEstablishedReason`, `credit-line.js`), which a fresh wallet
      can't fake, so a gamed 67 unlocks only self-collateralized secured credit (zero protocol
      loss). The residual vector is **patient Sybil** — many wallets, each aged 90 days with thin
      real activity, then drawing the small unsecured starter ($100 tier A) to default. Defense:
      flag wallet clusters sharing a common funding source / creation pattern. Cheap because events
      are already clustered by `userAddress` — add a creator/first-funder trace, a cluster score,
      and treat clustered wallets as one exposure for unsecured limits. Pairs with outcome
      instrumentation (clusters should show worse repayment) and the score-integrity note below.
- [ ] **[planned] Cross-chain collateral & USDC (exploratory).** Assets bridged via LayerZero as
      eligible collateral, Circle CCTP for native cross-chain USDC (deferred to mainnet), and NEAR
      Intents for intent-based execution. Promote if prioritized.

## Developer surface (cheap, serves the embeddable-underwriting goal)

These make the existing API adoptable by partners and cost days, not weeks.

- [ ] **[planned] OpenAPI spec** for the existing endpoints (`/score`, `/portfolio`,
      `/credit-line`, `/df-credit/*`, `/collateral/supported`, `/analytics`). Single source of
      truth for docs + client generation.
- [ ] **[planned] Generated client SDKs** (TypeScript, Go, Python) from the OpenAPI spec via
      openapi-generator; versioned with the spec. Publish to npm with a docs site and a first
      external demo.
- [ ] **[planned] Parity / snapshot fixtures** — ledger-pinned JSON snapshots for a few sample
      addresses, independently verifiable against the live endpoint. Trust artifact for scoring +
      portfolio outputs.
- [ ] **[planned] Response metadata** — expose `last_indexed_ledger` / data-staleness on
      portfolio/score responses so consumers can assess freshness programmatically.
- [ ] **[planned] MCP-compatible agent skills** over the API so wallets/neobanks/AI agents can
      call scoring and credit without building a bureau.

## Positions-API depth (only if productizing positions)

LCRD's moat is the **credit/reputation layer on top**, not raw positions — a public positions
API is a separate product. Pursue these only to offer one; otherwise a third-party positions
API is a candidate data source/partner.

- [ ] **[planned] Cross-protocol health factor** — per-wallet HF for third-party lending
      protocols (Blend, FxDAO), reusing positions we already read. (We compute LTV/liquidation for
      our own pool today.)
- [ ] **[planned] CDP / FxDAO adapter** — enumerate vaults, read collateral vs minted-stablecoin
      debt, compute collateral ratio. New adapter (FxDAO not currently indexed).
- [ ] **[planned] Soroswap LP decomposition per wallet** — the indexer already discovers pairs
      (~216); add constant-product LP-share → underlying decomposition in `portfolio.js`, matching
      the Aquarius/DeFindex pattern.

## Infrastructure & protocol

- [ ] **[planned] Protocol 30 "Bell" — residual items.** SDK bump to 17.4.0 is **done** across
      frontend + indexer (the required provisions; mainnet vote 2026-11-23). Left, all optional:
      skim RPC v30 / Horizon v30 release notes; W-addresses (SEP-23 muxed contract addresses,
      CAP-84) — switch user-facing params to `MuxedAddress` to accept both (needs rebuild+upgrade);
      migrate to `SOROBAN_CREDENTIALS_ADDRESS_V2` at convenience.
- [ ] **[planned] Home-page pool metrics fix.** Pool APY/liquidity/markets show "—" (empty testnet
      pool + a catch in `src/home.ts` that dashes markets on read failure) → harden the UI and seed
      the pool. (From partner feedback.)
- [x] **[done] Pre-connect "what builds your score" surface.** `score.html` explainer in place and
      now links to live cross-Stellar scores at `stellar.lcrd.fi/analytics.html`. (From partner
      feedback.)
- [ ] **[planned] SDK version tidy-up.** Align the score-api's stellar-sdk (17.2.1) with the
      indexer's (17.4.0).
- [ ] **[planned] Open-source the Soroban contracts (pool + escrow), Apache-2.0.** Public
      repo + README + reproducible build.
- [ ] **[planned] STRIDE threat model + on-chain monitoring.** Both docs in the public repo
      per Stellar templates; extend the live fraud monitor so alerts fire on a simulated attack.
- [ ] **[planned] Score-integrity / gaming-resistance note (public + FAQ).** A short write-up of
      *why the score resists gaming*, for partners, the SCF panel, and the docs site. Core argument:
      the score is a two-layer design — the cheap-to-mint 67 floor opens the ecosystem but underwrites
      nothing (only self-collateralized secured credit); the signals that gate real money and move a
      wallet into the 80s/90s can't be bought in a day — **tenure** (90-day calendar gate),
      **consistency** (distinct active days), **repeat cycles** (2+ for full trust; score capped at 82
      until the second loan), and **identity-bound income** (OSS/escrow payouts, the explicit
      "anti-self-funding signal" in `oss-contribution.js`). Same reasoning is why a testnet/live
      adoption metric must count **real external, non-team wallets** — a synthetic-wallet number is
      worthless for exactly the reason the score is hard to game. Dovetails with the STRIDE threat
      model and the Sybil/cluster item above.
- [ ] **[planned] End-to-end test suite + CI.** CI green + coverage report in the public repo.
- [ ] **[planned] Audited mainnet deployment (pool + escrow).** Third-party audit; contracts live
      on mainnet with addresses on Stellar Expert and the audit report linked.
- [ ] **[planned] Mainnet product live — real USDC, monitoring on.** Real mainnet loans with
      hashes + a 7-day log; SLOs: score-api p95 < 400ms under load, indexer < 15 min behind tip.

## Related repos / parallel tracks

- **`lcrd-arc-credit`** (separate repo, `lucredtech/lcrd-arc-credit`) — Lucred's Arc-chain (EVM L1,
  chain 5042, USDC-native gas) implementation of the credit product. Shares the credit concept and
  the LCRD score API with this repo but no on-chain code. Live on Arc mainnet; the Soroban replica
  (`contracts/credit-line/`) already lives here. Tracked as the next-phase product expansion.
