// Collateral engine for dfToken-backed USDC credit.
//
// Stage A (this file, off-chain, demoable): value a wallet's DeFindex vault positions (the dfTokens
// it could pledge), compute an advance (50-75% of position value) and an APR, and return a terms
// object the user can review and accept. NO funds move and nothing is locked on-chain here.
//
// This is a SPECIALIZATION of the general collateral engine (see ~/.claude/plans/resilient-skipping-curry.md),
// narrowed to one collateral type (DeFindex share tokens) and one disbursed asset (USDC). It reuses the
// exact collateral math from credit-line.js (buildCollateral: per-class haircut + lpFactor) and the exact
// indicative APR (priceApr, model "secured") so the numbers line up with /credit-line's secured line.
//
// `attest`/`health` are stubs here; they become real in Stage B (the Soroban escrow + engine attestations),
// so the engine's surface matches the parent plan.
const { buildCollateral, priceApr, POLICY } = require("./credit-line");

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const DISCLAIMER =
  "Indicative terms only. No funds move in this demo — nothing is locked and nothing is disbursed. " +
  "Not an offer of credit, not a credit decision and not financial advice. Figures use today's balances and prices and can change.";

// Filter a portfolio to its DeFindex vault positions and value just those as collateral, reusing
// buildCollateral so the haircut/lpFactor logic is identical to the main credit line. Returns an
// overall total plus a per-vault breakdown (each vault's share token is the collateral token).
// `registry` is the supported-collateral registry (see collateral-registry.js), keyed by share-token
// contract id, injected by the caller so this stays pure/testable. Default {} keeps the pre-registry
// behaviour (eligibility by priced-underlying). Production injects getCollateralRegistry() for the
// active network.
function defindexCollateral(portfolio, policy = POLICY, registry = {}) {
  const positions = (((portfolio && portfolio.positions) || []).filter(
    (p) => p.protocol === "defindex" && p.type !== "debt" && p.transferable === true
  ));

  // Eligibility: prefer the curated supported-collateral registry (enabled share-tokens); else the
  // policy's eligibleVaults; else — pre-registry fallback — any priced, transferable position. So an
  // empty mainnet registry still works until the list is filled in.
  // Only vault-type registry entries gate the vault allowlist — directly-held asset entries
  // (kind "asset"/"token") are handled by tokenCollateral and must not filter out vault positions.
  const regIds = Object.keys(registry || {}).filter(
    (id) => registry[id].enabled && registry[id].kind !== "asset" && registry[id].kind !== "token"
  );
  const policyAllow = (policy.dfCredit && policy.dfCredit.eligibleVaults) || [];
  const allow = regIds.length ? regIds : policyAllow;
  const eligible = allow.length ? positions.filter((p) => allow.includes(p.pool)) : positions;

  const overall = buildCollateral({ tokens: [], positions: eligible }, policy);
  const vaults = eligible
    .map((p) => {
      const one = buildCollateral({ tokens: [], positions: [p] }, policy);
      const reg = (registry && registry[p.pool]) || null;
      return {
        shareToken: p.pool,
        label: reg && reg.label ? reg.label : null,
        symbol: reg && reg.symbol ? reg.symbol : null,
        kind: reg && reg.kind ? reg.kind : "vault",
        underlying: (p.assets || [])
          .filter((a) => a.usdValue !== null && a.usdValue !== undefined)
          .map((a) => ({ contractId: a.contractId || null, code: a.code || null, amount: a.amount, usdValue: round2(a.usdValue), priceSource: a.priceSource || null })),
        marketUsd: one.marketUsd,
        lendableUsd: one.lendableUsd,
        haircutPct: round2(one.averageHaircut * 100),
        advanceRate: reg && reg.advanceBps ? reg.advanceBps / 10000 : null,
        liquidationLtv: reg && reg.liquidationLtvBps ? reg.liquidationLtvBps / 10000 : null
      };
    })
    .filter((v) => v.marketUsd > 0);

  return { vaults, marketUsd: overall.marketUsd, lendableUsd: overall.lendableUsd, averageHaircut: overall.averageHaircut };
}

// Value a wallet's DIRECTLY-HELD registry-whitelisted tokens as collateral (as opposed to vault
// share tokens above) — e.g. an Etherfuse RWA bond like CETES held straight in the wallet. Keyed by
// the token's own contract id; only entries with kind "asset"/"token" are considered here so a vault
// share-token never double-counts. Reuses buildCollateral so the per-class haircut (rwa 0.25) and the
// clawback factor (0.50 for clawback-enabled issuers like Etherfuse) are identical to /credit-line.
function tokenCollateral(portfolio, policy = POLICY, registry = {}) {
  const tokens = (((portfolio && portfolio.tokens) || []).filter(
    (t) => t.transferable === true && t.usdValue !== null && t.usdValue !== undefined
  ));
  const regIds = Object.keys(registry || {}).filter(
    (id) => registry[id].enabled && (registry[id].kind === "asset" || registry[id].kind === "token")
  );
  const eligible = regIds.length ? tokens.filter((t) => regIds.includes(t.contractId)) : [];

  const overall = buildCollateral({ tokens: eligible, positions: [] }, policy);
  const assets = eligible
    .map((t) => {
      const one = buildCollateral({ tokens: [t], positions: [] }, policy);
      const reg = (registry && registry[t.contractId]) || null;
      return {
        token: t.contractId,
        label: reg && reg.label ? reg.label : null,
        symbol: reg && reg.symbol ? reg.symbol : (t.code || null),
        kind: reg && reg.kind ? reg.kind : "asset",
        code: t.code || null,
        amount: t.balance,
        usdPrice: t.usdPrice != null ? t.usdPrice : null,
        clawback: t.clawback === true,
        marketUsd: one.marketUsd,
        lendableUsd: one.lendableUsd,
        haircutPct: round2(one.averageHaircut * 100),
        priceSource: t.priceSource || null,
        advanceRate: reg && reg.advanceBps ? reg.advanceBps / 10000 : null,
        liquidationLtv: reg && reg.liquidationLtvBps ? reg.liquidationLtvBps / 10000 : null,
      };
    })
    .filter((a) => a.marketUsd > 0);

  return { assets, marketUsd: overall.marketUsd, lendableUsd: overall.lendableUsd, averageHaircut: overall.averageHaircut };
}

// Combined engine collateral: DeFindex vault positions + directly-held whitelisted tokens, merged
// into one view the quote prices off. Totals recompute the blended haircut across both.
function engineCollateral(portfolio, policy = POLICY, registry = {}) {
  const v = defindexCollateral(portfolio, policy, registry);
  const a = tokenCollateral(portfolio, policy, registry);
  const marketUsd = round2(v.marketUsd + a.marketUsd);
  const lendableUsd = round2(v.lendableUsd + a.lendableUsd);
  return {
    vaults: v.vaults,
    assets: a.assets,
    marketUsd,
    lendableUsd,
    averageHaircut: marketUsd > 0 ? round2(1 - lendableUsd / marketUsd) : 0,
  };
}

// Compute the full quote/terms for a dfToken-backed USDC advance. Pure given the inputs + policy.
// structure: "open_ended" (default) | "fixed_term"; termDays only used for fixed_term.
function quote({ portfolio, score, structure, termDays }, policy = POLICY, registry = {}) {
  const cfg = policy.dfCredit;
  const wallet = (score && score.wallet) || (portfolio && portfolio.wallet) || null;
  const s = score && typeof score.score === "number" ? score.score : 0;
  const collateral = engineCollateral(portfolio, policy, registry);

  if ((!collateral.vaults.length && !collateral.assets.length) || collateral.lendableUsd <= 0) {
    return {
      version: cfg.version,
      policyVersion: policy.version,
      wallet,
      asOf: new Date().toISOString(),
      eligible: false,
      reason: !(portfolio && (portfolio.positions || portfolio.tokens))
        ? "Holdings couldn't be read, so collateral can't be valued."
        : "No priced, transferable DeFindex vault position or supported collateral asset found for this wallet.",
      demo: true,
      disclaimer: DISCLAIMER
    };
  }

  // Structure + term.
  const structures = cfg.structures;
  const struct = structures.includes(structure) ? structure : "open_ended";
  let td = null;
  if (struct === "fixed_term") td = cfg.termDaysOptions.includes(Number(termDays)) ? Number(termDays) : cfg.termDaysOptions[0];

  // Advance: per-vault when the registry sets an advance rate for that share-token (so each supported
  // vault/LP is sized on its own risk), else the flat policy default across the bundle. Each vault is
  // hard-capped at its own risk-adjusted lendable value (the haircut/lpFactor is a safety ceiling).
  const defaultRate = clamp(cfg.advance.defaultRate, cfg.advance.minRate, cfg.advance.maxRate);
  // Size each collateral item (vault share-token OR directly-held asset) on its own risk when the
  // registry gives it an advance rate; each is hard-capped at its own risk-adjusted lendable value.
  const items = [...collateral.vaults, ...collateral.assets];
  const hasPerItem = items.some((it) => it.advanceRate != null);
  const principalUsd = hasPerItem
    ? round2(items.reduce((sum, it) => {
        const r = clamp(it.advanceRate != null ? it.advanceRate : defaultRate, cfg.advance.minRate, cfg.advance.maxRate);
        return sum + Math.min(it.marketUsd * r, it.lendableUsd);
      }, 0))
    : round2(Math.min(collateral.marketUsd * defaultRate, collateral.lendableUsd));
  // Reported advance rate: the blended effective rate when per-item, else the flat default (unchanged).
  const rate = hasPerItem
    ? (collateral.marketUsd > 0 ? round4(principalUsd / collateral.marketUsd) : defaultRate)
    : defaultRate;

  // APR = the existing indicative SECURED credit-line rate, plus an optional per-structure/term
  // adjustment (policy.dfCredit.termAdjust, empty = no-op until the team supplies real rate logic).
  const pricing = priceApr("secured", s, collateral, policy);
  const adj = struct === "open_ended" ? (cfg.termAdjust.open_ended || 0) : (cfg.termAdjust[td] || 0);
  const aprRaw = pricing.apr + adj;
  const apr = round4(clamp(aprRaw, policy.apr.min, policy.apr.max));

  // Simple-interest growth preview (the open-ended risk the user should see before accepting).
  const debtAfter = (days) => round2(principalUsd * (1 + apr * (days / 365)));

  return {
    version: cfg.version,
    policyVersion: policy.version,
    wallet,
    asOf: new Date().toISOString(),
    eligible: true,
    collateral,
    advance: {
      rate,
      minRate: cfg.advance.minRate,
      maxRate: cfg.advance.maxRate,
      principalUsd,
      principalAsset: { code: "USDC", contractId: null }, // resolved to a real contract id in Stage B
      principalAmount: principalUsd.toFixed(7)            // USDC is USD-pegged, 7dp
    },
    terms: {
      structure: struct,
      termDays: td,
      apr,
      aprPct: round2(apr * 100),
      aprBreakdown: {
        basePct: pricing.breakdown.basePct,
        scoreRiskPct: pricing.breakdown.scoreRiskPct,
        securityDiscountPct: pricing.breakdown.securityDiscountPct,
        volatileCollateralPct: pricing.breakdown.volatileCollateralPct,
        structurePct: round2(adj * 100),
        capped: aprRaw !== apr
      },
      interestAccrual: "simple_per_second",
      maturityDate: td ? new Date(Date.now() + td * 86400000).toISOString() : null
    },
    disbursement: { asset: "USDC", source: "company_treasury", amount: principalUsd.toFixed(7) },
    ltv: {
      originationLtv: collateral.marketUsd > 0 ? round4(principalUsd / collateral.marketUsd) : 0,
      marginCallLtv: cfg.liquidation.marginCallLtv,
      liquidationLtv: cfg.liquidation.liquidationLtv,
      cureWindowSec: cfg.liquidation.cureWindowSec
    },
    projectedDebt: { d30: debtAfter(30), d90: debtAfter(90), d365: debtAfter(365) },
    demo: true,
    disclaimer: DISCLAIMER
  };
}

// Stage B surface (not enabled in the demo).
function attest() {
  throw new Error("Engine attestations are enabled in the on-chain stage (Stage B), not in this demo.");
}
function health() {
  throw new Error("On-chain health tracking is enabled in the on-chain stage (Stage B), not in this demo.");
}

module.exports = { defindexCollateral, tokenCollateral, engineCollateral, quote, attest, health };
