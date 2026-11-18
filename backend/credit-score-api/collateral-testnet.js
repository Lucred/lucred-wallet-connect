// Testnet collateral reader.
//
// portfolio.js reads a wallet's holdings on MAINNET (its RPC/Horizon URLs are mainnet, and its priced
// tokens are mainnet SACs), which is what scoring and the mainnet credit line use. The collateral
// engine, however, also runs on TESTNET for the Stage-B escrow flow, where the supported collateral is
// different (see collateral-registry.js). This module is the small, read-only testnet counterpart: it
// reads a wallet's balances of the registry's directly-held "asset" collateral (today: Etherfuse CETES)
// on Stellar testnet and shapes them exactly like portfolio.js `tokens`, so the engine can quote
// against a testnet wallet without touching the mainnet portfolio path.
//
// Scope: directly-held classic-asset collateral (kind "asset"/"token" with an issuer). Vault-share
// collateral on testnet is read by the on-chain escrow flow, not here. USD prices come from
// etherfuse.js (public lookup × live FX). Everything degrades to "unpriced/empty" on failure rather
// than throwing, mirroring portfolio.js.

const { getCollateralRegistry } = require("./collateral-registry");
const { stablebondUsdPrice } = require("./etherfuse");

const HORIZON_TESTNET = process.env.HORIZON_TESTNET_URL || "https://horizon-testnet.stellar.org";
const FETCH_TIMEOUT_MS = Number(process.env.ETHERFUSE_FETCH_TIMEOUT_MS) || 9000;
const round2 = (n) => Math.round(n * 100) / 100;

async function horizonAccount(wallet) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${HORIZON_TESTNET}/accounts/${encodeURIComponent(wallet)}`, { signal: ctrl.signal });
    if (r.status === 404) return { balances: [], exists: false };
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    return { balances: j.balances || [], exists: true };
  } catch (e) {
    console.error("collateral-testnet: Horizon read failed for " + wallet + ":", e.message);
    return { balances: [], exists: null };
  } finally {
    clearTimeout(t);
  }
}

// Read a wallet's supported directly-held collateral on testnet, shaped like portfolio.js output.
// Pricing uses the registry symbol's stablebond USD price. A classic wrapped-asset balance is the same
// number the SAC `balance()` returns, so these values line up with what the escrow actually custodies.
async function readWalletCollateral(wallet, registry = getCollateralRegistry()) {
  const assetEntries = Object.entries(registry || {}).filter(
    ([, r]) => r.enabled && (r.kind === "asset" || r.kind === "token") && r.issuer
  );
  const { balances, exists } = await horizonAccount(wallet);
  const tokens = [];
  for (const [contractId, reg] of assetEntries) {
    const bal = balances.find((b) => b.asset_code === reg.symbol && b.asset_issuer === reg.issuer);
    const amount = bal ? Number(bal.balance) : 0;
    if (!bal || !(amount > 0)) continue;
    let price = null;
    try { price = await stablebondUsdPrice(reg.symbol); } catch (e) { console.error("collateral-testnet: price " + reg.symbol + " failed:", e.message); }
    const usdPrice = price && price.usdPrice != null ? price.usdPrice : null;
    tokens.push({
      code: reg.symbol,
      contractId,
      issuer: reg.issuer,
      balance: bal.balance,
      usdPrice,
      usdValue: usdPrice != null ? round2(amount * usdPrice) : null,
      // auth_revocable issuers can deauthorize a specific trustline; is_authorized === false means the
      // holder currently can't move it, so it can't be pledged.
      transferable: bal.is_authorized !== false,
      priceSource: "verified", // classifies via POLICY.verifiedClassByTicker (CETES -> rwa)
      clawback: reg.clawback === true,
      priceMeta: price ? { nativePrice: price.nativePrice, currency: price.currency, fxToUsd: price.fxToUsd, source: price.source } : null,
    });
  }
  return { wallet, network: "testnet", accountExists: exists, totals: { debtUsd: 0 }, tokens, positions: [], asOf: new Date().toISOString() };
}

module.exports = { readWalletCollateral };
