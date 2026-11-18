#!/usr/bin/env node
// Demo/verification: value a testnet wallet's Etherfuse CETES holding and run the collateral engine's
// USDC-advance quote against it — the off-chain (Stage A) half of RWA collateral on testnet.
//
//   node scripts/cetes-testnet-quote.js <G_WALLET> [score]
//
// Reads CETES on Stellar testnet (collateral-testnet.js) + prices it (etherfuse.js), then quotes
// (collateral-engine.js). No funds move. The on-chain pledge is the escrow harness
// (contracts/collateral-escrow/scripts/cetes-escrow-testnet.sh).
const { readWalletCollateral } = require("../collateral-testnet");
const { quote } = require("../collateral-engine");
const { getCollateralRegistry } = require("../collateral-registry");

(async () => {
  const wallet = process.argv[2];
  const scoreVal = Number(process.argv[3] || 70);
  if (!wallet || wallet[0] !== "G") {
    console.error("usage: node scripts/cetes-testnet-quote.js <G_WALLET> [score]");
    process.exit(1);
  }
  const registry = getCollateralRegistry("testnet");
  const portfolio = await readWalletCollateral(wallet, registry);
  const score = { wallet, score: scoreVal, tier: scoreVal >= 67 ? "A" : "B", path: "lending", components: [{ key: "tenure", points: 15, max: 15 }] };
  const q = quote({ portfolio, score, structure: "open_ended" }, undefined, registry);
  console.log(JSON.stringify({ portfolio, quote: q }, null, 2));
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
