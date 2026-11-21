"use strict";
// ---- Soroban Domains (name.xlm) resolution ----
// Resolves a Soroban Domains name (e.g. "earrietadev.xlm", or a subdomain like
// "payments.jhon.xlm") to its Stellar G-address, so a user can type a domain
// anywhere a wallet is accepted (/score, /portfolio, /df-credit, ...).
//
// This is a read-only Soroban RPC `simulateTransaction` against the Registry
// contract's `record` function - no signing, no fees, no account needed. The
// node-hash derivation mirrors @creit-tech/sorobandomains-sdk exactly: keccak-256
// folded over the reversed domain labels and the TLD. keccak-256 (not SHA3-256)
// is required - they are different padding schemes, so Node's built-in
// `sha3-256` would produce the wrong node. We use @noble/hashes, which ships as a
// direct dependency of @stellar/stellar-sdk.
//
// Mainnet contract from https://sorobandomains.org/docs/apps_and_contracts/ .
const { rpc, Contract, TransactionBuilder, Networks, Account, scValToNative, xdr } = require("@stellar/stellar-sdk");
const { keccak_256 } = require("@noble/hashes/sha3.js");

const REGISTRY_CONTRACT =
  process.env.SOROBAN_DOMAINS_REGISTRY || "CC75Z72OCE667WVPQOROIWDAGBOXFNJ4VQONQEURL74EYIDLWA4F7FEN";

// Public mainnet Soroban RPCs, tried in order; a configured one takes priority.
const RPC_URLS = (process.env.SOROBAN_RPC_URL ? [process.env.SOROBAN_RPC_URL] : []).concat([
  "https://mainnet.sorobanrpc.com",
  "https://soroban-rpc.mainnet.stellar.gateway.fm",
  "https://rpc.lightsail.network",
]);

// simulateTransaction needs a source account, but never submits, so any
// well-formed account id works - this one is a throwaway used only for simulation.
const SIM_ACCOUNT = "GDAT5HWTGIU4TSSZ4752OUC4SABDLTLZFRPZUJ3D6LKBNEPA7V2CIG54";

const STELLAR_G_RE = /^G[A-Z2-7]{55}$/;

// Soroban Domains labels are lowercase a-z (1..15 chars); TLD is "xlm".
// Matches a root domain or a subdomain: (label.)+xlm .
const SOROBAN_DOMAIN_RE = /^(?:[a-z]{1,15}\.)+xlm$/;

function isSorobanDomain(s) {
  return SOROBAN_DOMAIN_RE.test(String(s || "").trim().toLowerCase());
}

const enc = (s) => new TextEncoder().encode(s);
const h = (u8) => keccak_256(u8);
function cat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// node = keccak( keccak(tld) || keccak(firstLabel) ), then folded with each
// further label: node = keccak( keccak(node) || keccak(label) ).
// `chunks` are the labels in parent->child order (tld already removed).
function generateNode(chunks, tld) {
  const c = [...chunks];
  let node = h(cat(h(enc(tld)), h(enc(c.shift()))));
  while (c.length) node = h(cat(h(node), h(enc(c.shift()))));
  return node;
}

let _servers = null;
function servers() {
  if (!_servers) _servers = RPC_URLS.map((u) => new rpc.Server(u));
  return _servers;
}

// Resolve name.xlm -> G-address. Returns null for an invalid, unregistered, or
// address-less domain (so callers treat it like any other invalid wallet). A
// network error on one RPC falls through to the next; only when every RPC is
// unreachable does a transient failure surface as null.
async function resolveSorobanDomain(name) {
  const domain = String(name || "").trim().toLowerCase();
  if (!isSorobanDomain(domain)) return null;

  const parts = domain.split("."); // ["label", ..., "xlm"]
  const reversed = parts.reverse(); // ["xlm", "label", ...]
  const tld = reversed.shift(); // "xlm"
  const labels = reversed; // parent->child labels
  const node = generateNode(labels, tld);
  const isSub = labels.length > 1;

  const op = new Contract(REGISTRY_CONTRACT).call(
    "record",
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(isSub ? "SubDomain" : "Domain"),
      xdr.ScVal.scvBytes(Buffer.from(node)),
    ])
  );

  for (const server of servers()) {
    let sim;
    try {
      const tx = new TransactionBuilder(new Account(SIM_ACCOUNT, "0"), {
        networkPassphrase: Networks.PUBLIC,
        fee: "0",
      })
        .setTimeout(30)
        .addOperation(op)
        .build();
      sim = await server.simulateTransaction(tx);
    } catch {
      continue; // RPC unreachable: try the next one
    }
    // The RPC responded. A contract error here means the domain isn't
    // registered - a definitive "not found", so stop rather than retrying.
    if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
    try {
      // record() returns a 2-tuple [Domain, SubDomain]; one is null.
      const val = scValToNative(sim.result.retval);
      const rec = Array.isArray(val) ? val[1] || val[0] : val;
      const addr = rec && rec.address ? String(rec.address).toUpperCase() : null;
      return addr && STELLAR_G_RE.test(addr) ? addr : null;
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { resolveSorobanDomain, isSorobanDomain, SOROBAN_DOMAIN_RE, REGISTRY_CONTRACT };
