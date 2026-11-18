#!/usr/bin/env node
// Helper to extend KNOWN_RWA_ISSUERS in check-issuer-assets.py.
//
// On Stellar an asset code (BENJI, CETES, USDY…) has many impostor issuers. This
// disambiguates: given candidate (asset_code, asset_issuer) pairs, it computes each
// one's Stellar Asset Contract (SAC) id and keeps only those whose SAC already
// appears in the indexer registry — i.e. the issuer we actually trust/index.
//
// Usage:
//   1) pull candidates for the codes you want to add (cheap, history_assets only):
//        bq query --use_legacy_sql=false --format=json --maximum_bytes_billed=21474836480 \
//          'SELECT asset_code, asset_issuer FROM `crypto-stellar.crypto_stellar.history_assets`
//           WHERE asset_code IN ("WTGXX","WTSYX",...) GROUP BY 1,2' > cands.json
//   2) node resolve-issuers.js cands.json [path/to/registry.ts]
//   -> prints the legit {code, issuer, sac}; add the issuer G-address to the dict.
//
// Needs @stellar/stellar-sdk — run from a place that can resolve it, or set SDK_PATH.
const fs = require("fs");
const path = require("path");

const SDK = process.env.SDK_PATH ||
  path.resolve(__dirname, "../../backend/indexer/node_modules/@stellar/stellar-sdk");
const { Asset, Networks } = require(SDK);

const candsFile = process.argv[2];
const regPath = process.argv[3] ||
  path.resolve(__dirname, "../../backend/indexer/src/registry.ts");
if (!candsFile) { console.error("usage: node resolve-issuers.js <candidates.json> [registry.ts]"); process.exit(1); }

const cands = JSON.parse(fs.readFileSync(candsFile, "utf8"));
const reg = fs.readFileSync(regPath, "utf8");
const legit = [];
for (const c of cands) {
  try {
    const sac = new Asset(c.asset_code, c.asset_issuer).contractId(Networks.PUBLIC);
    if (reg.includes(sac)) legit.push({ code: c.asset_code, issuer: c.asset_issuer, sac });
  } catch (e) { /* skip malformed */ }
}
console.log("legit (SAC in registry):", legit.length);
for (const l of legit) console.log(`  ${l.code}\t${l.issuer}\t${l.sac}`);
const issuers = [...new Set(legit.map((l) => l.issuer))];
console.log("\nunique legit issuers to add to KNOWN_RWA_ISSUERS:");
for (const i of issuers) console.log(`  "${i}": "<label>",`);
