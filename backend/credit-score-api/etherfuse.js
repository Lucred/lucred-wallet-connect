// Etherfuse stablebond pricing for TESTNET collateral.
//
// Etherfuse issues tokenized short-term government bills on Stellar (CETES = Mexican CETES,
// USTRY = US Treasuries, TESOURO = Brazil Tesouro). On MAINNET these are priced the usual way —
// PRICED_TOKENS maps their SAC contract id to a ticker and the price comes from
// credit_bureau.asset_prices (see portfolio.js). This module is the SELF-CONTAINED TESTNET price
// source so the collateral engine can value a sandbox CETES holding without any BigQuery row:
//
//   1. Read Etherfuse's PUBLIC lookup endpoint (no API key) for the per-token price. CETES is
//      denominated in MXN (bondCurrency), so the raw price is pesos per token, NOT USD.
//   2. Convert to USD with a live FX rate (configurable + a static fallback so a down FX API never
//      zeroes collateral). CETES ≈ 1.15 MXN ≈ $0.06, so the FX leg is not optional.
//
// Everything is cached in-memory on a long TTL (prices move slowly) and every network read has a
// fallback, so this can never throw into the engine — a miss returns null and the caller treats the
// asset as unpriced (excluded from lendable value), exactly like any other unpriced token.
//
// Mainnet vs sandbox is a URL swap (ETHERFUSE_LOOKUP_URL); the sandbox host serves Stellar-testnet
// identifiers, which is what the testnet collateral registry points at.

const LOOKUP_URL = process.env.ETHERFUSE_LOOKUP_URL || "https://api.sand.etherfuse.com/lookup/stablebonds";
const FX_BASE_URL = process.env.ETHERFUSE_FX_URL || "https://open.er-api.com/v6/latest/"; // + <CCY>
const CACHE_TTL_MS = Number(process.env.ETHERFUSE_CACHE_TTL_MS) || 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.ETHERFUSE_FETCH_TIMEOUT_MS) || 9000;

// Static USD-per-unit fallbacks, only used when the live FX API is unreachable. Override via env.
// Deliberately conservative/round; the live rate wins whenever it is available.
const FX_FALLBACK = {
  MXN: Number(process.env.ETHERFUSE_MXN_USD_RATE) || 0.054,
  BRL: Number(process.env.ETHERFUSE_BRL_USD_RATE) || 0.185,
  USD: 1,
};

let _bonds = { at: 0, data: null };
const _fx = {}; // ccy -> { at, rate }

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Raw stablebond catalog (all symbols/chains), cached. Returns [] on failure so callers degrade.
async function fetchStablebonds() {
  if (_bonds.data && Date.now() - _bonds.at < CACHE_TTL_MS) return _bonds.data;
  try {
    const j = await fetchJson(LOOKUP_URL);
    const list = Array.isArray(j && j.stablebonds) ? j.stablebonds : [];
    _bonds = { at: Date.now(), data: list };
    return list;
  } catch (e) {
    console.error("etherfuse: stablebond lookup failed:", e.message);
    return _bonds.data || [];
  }
}

// USD per 1 unit of `ccy`, from the live FX API, cached per currency; static fallback on failure.
async function fxToUsd(ccy) {
  const code = String(ccy || "").toUpperCase();
  if (code === "USD") return 1;
  const c = _fx[code];
  if (c && Date.now() - c.at < CACHE_TTL_MS) return c.rate;
  try {
    const j = await fetchJson(FX_BASE_URL + encodeURIComponent(code));
    const rate = j && j.rates && Number(j.rates.USD);
    if (!rate || !isFinite(rate) || rate <= 0) throw new Error("no USD rate in response");
    _fx[code] = { at: Date.now(), rate };
    return rate;
  } catch (e) {
    const fb = FX_FALLBACK[code];
    console.error("etherfuse: FX " + code + "->USD failed (" + e.message + "), using fallback " + (fb ?? "none"));
    return fb || null;
  }
}

// Pick the Stellar leg of a stablebond entry. Etherfuse lists the issuer as "CODE-GISSUER..." in
// tokenIdentifier (dash-separated), which we normalise to the CODE:ISSUER the rest of Stellar uses.
function stellarLeg(bond) {
  const leg = (bond.blockchains || []).find((b) => b.blockchain === "stellar");
  if (!leg || !leg.tokenIdentifier) return null;
  const [code, issuer] = String(leg.tokenIdentifier).split("-");
  return { code: code || bond.symbol, issuer: issuer || null, decimals: Number(leg.decimals) || 7 };
}

// Pure: native price * (USD per native unit). Exposed for unit tests.
function toUsd(nativePrice, fxRate) {
  const n = Number(nativePrice), f = Number(fxRate);
  if (!isFinite(n) || n <= 0 || !isFinite(f) || f <= 0) return null;
  return n * f;
}

// Resolve one stablebond by symbol (case-insensitive) to a priced, Stellar-scoped record, or null.
// { symbol, code, issuer, decimals, nativePrice, currency, fxToUsd, usdPrice, source, asOf }
async function stablebondUsdPrice(symbol) {
  const want = String(symbol || "").toUpperCase();
  const bonds = await fetchStablebonds();
  // Prefer an exact symbol match that actually has a Stellar leg (several "Cetes-N" test bonds are
  // Solana-only); fall back to a name match.
  const candidates = bonds.filter((b) => String(b.symbol || "").toUpperCase() === want);
  let bond = candidates.find((b) => stellarLeg(b)) || null;
  if (!bond) bond = bonds.find((b) => String(b.name || "").toUpperCase() === want && stellarLeg(b)) || null;
  if (!bond) return null;
  const leg = stellarLeg(bond);
  if (!leg) return null;
  const nativePrice = Number(bond.tokenPriceDecimal);
  const currency = String(bond.bondCurrency || "USD").toUpperCase();
  const fx = await fxToUsd(currency);
  const usdPrice = toUsd(nativePrice, fx);
  return {
    symbol: bond.symbol,
    code: leg.code,
    issuer: leg.issuer,
    decimals: leg.decimals,
    nativePrice,
    currency,
    fxToUsd: fx,
    usdPrice,
    source: "etherfuse_lookup",
    asOf: new Date().toISOString(),
  };
}

// Convenience for the one asset wired on testnet today.
async function cetesUsdPrice() {
  return stablebondUsdPrice("CETES");
}

module.exports = { stablebondUsdPrice, cetesUsdPrice, fxToUsd, toUsd, stellarLeg, fetchStablebonds };
