# LCRD indexing coverage

What the LCRD score ingests, and the triaged watchlist of what it doesn't (yet). A living checklist —
update it when a watchlisted protocol goes mainnet-live, or when a new source is added.

**The binding rule:** we only index protocols that are **live on Stellar *mainnet*, currently active, and
emit parseable events with a user address.** Testnet/SCF-stage projects, dead deployments, and anything
whose borrow/repay happens off-Stellar are deferred until that changes. (Scoring reads mainnet data only.)

Three layers feed the score:
1. **DeFi protocols** → `backend/indexer/src/registry.ts` → `credit_bureau.credit_events` (activity, breadth, tenure, borrow→repay cycles)
2. **Income sources** → `credit_bureau.oss_bounty_events` (verified earned income)
3. **Priced tokens** → `PRICED_TOKENS` in `backend/credit-score-api/portfolio.js` + `credit_bureau.asset_prices` (holdings / collateral value)

---

## 1. DeFi protocols indexed (`registry.ts`)

| Protocol | Category | Contracts | Signal |
|---|---|---|---|
| **Blend** | lending_pool (+factory, +backstop) | 14 | borrow→repay (credit), supply (activity) |
| **Peridot** | lending_debt | 3 | borrow/repay |
| **XOXNO Lending** | lending_debt | 1 | borrow/repay (RWA-collateralised) |
| **Slender** | lending_pool | 1 | borrow/repay |
| **Alula** | lending_pool | 1 | borrow/repay (looping) |
| **K2 Lend** | lending_pool | 1 (router) | borrow→repay (credit, Aave-V3-style), supply (activity) — *added 2026-11-22* |
| **LCRD** (our pool) | lending_pool | 1 | our own borrow/repay — **TESTNET**, dormant until mainnet |
| **Phoenix DeFi Hub** | amm_liquidity | 13 | swaps / LP (activity) |
| **Soroswap** | amm_router + amm_factory | 2 | swaps (activity) |
| **Aquarius** | amm_liquidity | 1 | swaps / LP (activity) |
| **Sushi Stellar** | amm_factory | 1 | swaps (activity) |
| **Spectra Finance** | yield_derivatives | 7 | PT mint/redeem/yield-claim (activity) — *added 2026-11-15* |
| **Stellar DeFi Hub** | yield_savings | 3 | deposit/withdraw (activity + yield income) |
| **Gami / Upshift** | yield_savings | 2 | yield (activity + income) |
| **Vaquita** | yield_savings | 1 | deposit/withdraw → realized-yield income (fixed-yield savings) — *added 2026-11-22* |
| **Templar** | yield_savings | 1 | **collateral/deposit side only** — borrow lives on NEAR |
| **Normal** | wrapped_asset | 1 | wrapped-asset activity |
| **WisdomTree** | rwa_treasury | 9 | RWA holdings/activity |
| **Spiko** | rwa_treasury | 9 | RWA T-bill holdings/activity |
| **Etherfuse** | rwa_treasury | 4 | Stablebond holdings/activity |
| **Untangled** | rwa_credit | 4 | RWA private-credit activity |
| **Ondo (USDY)** | rwa_treasury | 1 | yield-bearing RWA |
| **Franklin Templeton (Benji)** | rwa_treasury | 1 | tokenised MMF |
| **Huma Finance** | rwa_trade_finance | 1 | PayFi activity |
| **Defa / InvoiceMate** | rwa_trade_finance | 1 | invoice finance activity |
| **Fundable** | mass_distribution | 1 | payroll/mass-distribution claims (income) |

DeFindex (yield vaults) is integrated via the yield-income scorer + `vault_assets`/portfolio valuation
(parser has a `defindex` branch), rather than as a scored registry protocol.

## 2. Income sources (`oss_bounty_events`)

| Source | Rail | incomeType / weight | Status |
|---|---|---|---|
| **GrantFox** | TrustlessWork escrow | oss_bounty · 0.7 | live |
| **Payroll operator** | TrustlessWork escrow | payroll · 1.0 | live |
| **Drips Wave** | classic USDC payments | oss_bounty (counts $1 increments) | live, daily cron |
| **HackMeridian** | classic USDC payments, memo-scoped | event_grant · ×0.35 | live, in payer registry |
| **Boundless** | own Soroban contract (BQ events) | oss_bounty (bounty) / event_grant (hackathon, grant) · crowdfunding excluded | live, weekly cron |

Excluded on purpose (not personal income): **KutanaPay** (cross-border trade), **Business-sale escrow**,
**Cheese Pay** (consumer wallet). Stubbed/pending a mainnet `roles.platform` account: Offer Hub, PayOnProof,
Pacto, Trustless OSS, ArcusX.

## 3. Priced tokens (`PRICED_TOKENS`)
XLM, USDC, EURC, USDT0, PYUSD, AQUA, BLND, CETES, USTRY, TESOURO, USDY.

RWA price gaps with contract ids in hand (need a live price feed, not static $1): Spiko USTBL/EUTBL/UKTBL,
Franklin BENJI, Etherfuse EUROB/KTB, Centrifuge JTRSY/JAAA, WisdomTree gold, SolvBTC, Archax AAULL1.

---

## 4. Watchlist — not indexed yet, by reason

**Testnet / SCF-stage (add when mainnet-live):**
- **Lendoor** ★★ — uncollateralised credit, borrow→repay→score (closest peer to LCRD). Testnet (vault `CCXUEBC3…`, loan-mgr `CB4QQU2J…`); README roadmap = mainnet pending.
- **Excellar** (futurenet), Vanna, Mystic, Laina, Lantern, Legasi, CoopStable, HedgePay, Trilobyte, Crebit
- Yield: Arka, Strata, Principal Protocol, Pods, Lusty, Cushion, Backyard, Meria, Prism
- RWA tokenisers: Spydra, SiBorg, Verseprop, Minah, Liqvid, Splyce, Rivool, ALTERNUN, EnerDAO, EquitX, Dobprotocol, Metafyed, Neovestor, TokenOps, Mojoflower, Gearup
- *stellar.org DeFi directory sweep (2026-11-22, 32 projects): no new mainnet-indexable adds.* Early/unverified to watch at mainnet activity: Wombat Exchange (stableswap AMM), Raum Network, Stride, Upwealth, Reyts. Infra/analytics/CeFi skipped: Autowhale, Hoops Finance, StellarBroker, StellarTerm, Balanced (ICON-side bridge balance, no Stellar contract).

**Income platforms, pre-mainnet (will auto-surface via `tw-platform-report`):** Trustless OSS, ArcusX, Brújula, Eascrow, Push, Nila (first mainnet disbursement targeted Dec 2026)

**Already captured upstream (ride Blend pools we index):** Yieldblox, YieldBack.Cash, For Yield
**Mainnet-live but not worth it:** FxDAO (vault `CCUN4RXU…` dormant since May 2026 + emits only `fn_call`/`fn_return`, no named borrow/repay events — re-confirmed 2026-11-22), OrbitCDP (its CDP *is* a Blend pool `CAE7QVOM…` we already index)
**Dead:** Lumen Later (dormant 9mo)
**B2B trade-credit / receivables (design-ready, folded into the score when live — see §6):** Airswift, Indentura, Trilobyte · *excluded as corporate financing:* Mercato, Stellar-VaultLink, ClickPesa Debt Fund
**Not indexable (nothing to score):** wallets (Lobstr, Varial/Freighter, xBull, Hana, Albedo, OneKey, Ledger, Trezor, Beans), anchors/payments (MoneyGram, Yellow Card, Flutterwave, Wave), DEX Lumenswap (low value / not mainnet-confirmed)
**Flash loans (not a credit signal):** XycLoans

---

## 5. How we keep this current

- **`ops/tw-platform-monitor/report.sh`** — weekly VM cron (`5 4 * * 1 DAYS=14`), records new mainnet TrustlessWork platforms to `credit_bureau.oss_unknown_platforms`.
- **StellarLight** (stellarlight.xyz) — best liveness monitor; it tracks per-project live/inactive status + on-chain footprint. Watch for a watchlisted protocol flipping to **Live**.
- **rgstry.xyz** (Stellar Registry) + the contract-level discovery scan (`token_transfers_raw_v2` USDC senders × `oss_bounty_events.receiver`) — catch own-contract protocols.

**To add a mainnet-live protocol:** resolve its contract(s) + event schema (app JS bundle `grep key:"C[A-Z2-7]{55}"`, their repo/docs, or `history_contract_events_v2`), confirm events are named + carry a user address, register in `registry.ts` (+ a `resolve<Protocol>Amount` handler in `xdrParser.ts` if the amount needs a per-protocol field), then redeploy the indexer on the VM (`bash ~/lcrd/deploy-gcp.sh indexer`, gated). Income platforms on TrustlessWork escrow need only a `TRUSTLESS_WORK_PLATFORMS` row in `escrowBounty.ts` once their `roles.platform` account is known.

---

## 6. Design-ready: trade-credit (B2B receivables) signal — Option A

Invoice / receivables-financing protocols (**Airswift, Indentura, Trilobyte**) are **pre-mainnet** (SCF-stage,
no on-chain footprint yet), so not indexed. When one goes live we **fold the SME's advance→settlement into
the existing borrow→repay / activity score** (Option A — no separate business-credit product yet). The SME
wallet is a business entity, so this quietly blends business credit into the personal score; acceptable as an
interim, revisit as its own dimension (ties to the Arc/EVM USDC product) if volume grows.

**Reference implementation — `Airswiftio/SCF`** (Rust/Soroban — the live product; the 2023 `NFTLoan` TS repo
was a prototype). Two contracts:
- **`scf_soroban`** (`TokenizedCertificate` = the receivable as an NFT): `mint(to,id)` (invoice tokenized to
  the supplier), `redeem(owner,id)` (invoice settled at maturity), `transfer`, `burn`, `split` (fractionalize).
- **`scf_pool`** (`OfferPool` = financiers): `create(from,amount,offer_id)` (financier funds an offer),
  `accept(to,offer_id)` (**SME takes the advance**), `expire`.

**Option A mapping into `computeDebtCycles`:**
| Lifecycle | Event | Maps to |
|---|---|---|
| Invoice tokenized | `scf_soroban.mint(to=SME, id)` | cycle context (supplier identity) |
| Advance drawn | `scf_pool.accept(to=SME, offer_id)` | **borrow** (amount from the matched `create` offer) |
| Invoice settled | `scf_soroban.redeem(owner, id)` | **repay** — on-time = completed cycle |
| Default/overdue | `burn` without `redeem`, or past due date | negative |

SME wallet = `mint.to` / `accept.to`.

**Build caveats:**
1. Correlate `offer_id` ↔ certificate `id` ↔ SME across the pool + certificate contracts (multi-event, like
   Boundless/Spectra); the amount is on `create`, not `accept`.
2. Timeliness needs the invoice **due date** (in the certificate's `order_info` storage, not in events) — read
   via RPC or capture at `accept`.

**Go-live trigger:** watch Airswift (furthest along) on StellarLight; when its `SCF` contracts show a mainnet
on-chain footprint, resolve the deployed ids, confirm events still match this reference, then register in
`registry.ts` + add a resolver (`resolveSpectraAmount`-style) + a `computeDebtCycles` branch for the SME cycle.
