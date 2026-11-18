#!/usr/bin/env python3
"""
check-vault-coverage.py — catch NEW vaults on major Stellar platforms that are
not yet in the indexer's PROTOCOL_REGISTRY.

WHY THIS EXISTS. `backend/indexer/src/poolDiscovery.ts` auto-discovers vaults for
platforms that expose an on-chain factory (Soroswap, Sushi, Aquarius, DeFindex,
Blend, Phoenix). Platforms that are *curated* and have no factory — Upshift /
Sentora / Gami (August Digital) — have no discovery hook, so a new vault there is
invisible until someone notices. That is exactly how the Sentora USDC vault
(~$53.7M, the largest Stellar yield vault) went unindexed. This checker closes
that blind spot: it pulls each such platform's authoritative vault list and diffs
it against the registry, flagging anything uncovered.

It is READ-ONLY: it fetches public APIs and reads registry.ts. It writes nothing
on-chain and nothing to BigQuery. Run it on a cron; review the log (non-zero exit
when something new is found makes it easy to alert on).

Usage:
  python3 check-vault-coverage.py                 # human report, exit 1 if gaps
  python3 check-vault-coverage.py --json          # machine-readable
  REGISTRY_PATH=/path/to/registry.ts python3 check-vault-coverage.py

Add a platform: append an entry to PLATFORMS with a fetch_* function that returns
a list of {address, name, tvl} for its live Stellar vaults.
"""
import json, os, re, sys, urllib.request

REGISTRY_PATH = os.environ.get(
    "REGISTRY_PATH",
    os.path.join(os.path.dirname(__file__), "..", "..", "backend", "indexer", "src", "registry.ts"),
)
TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "30"))
STELLAR_C_ID = re.compile(r"C[A-Z2-7]{55}")  # Soroban contract id (strkey)


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "lcrd-vault-coverage-check"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def http_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": "lcrd-vault-coverage-check"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8")


# ---- platform adapters -----------------------------------------------------
# Each returns [{address, name, tvl}] for the platform's LIVE Stellar vaults.

def fetch_august_digital():
    """Upshift / Sentora / Gami — the August Digital API, chain -3 = Stellar.
    This is the feed DefiLlama's `upshift` adapter also reads."""
    url = ("https://api.augustdigital.io/api/v1/tokenized_vault"
           "?status=active&load_subaccounts=false&load_snapshots=false")
    out = []
    for v in http_json(url):
        if v.get("chain") != -3:            # -3 = Stellar
            continue
        if v.get("status") != "active":
            continue
        addr = v.get("address")
        if not addr or not STELLAR_C_ID.fullmatch(addr):
            continue
        out.append({
            "address": addr,
            "name": v.get("vault_name") or v.get("name") or "?",
            "tvl": v.get("latest_reported_tvl") or 0,
        })
    return out


def fetch_stellar_defi_hub():
    """Stellar DeFi Hub — no factory, no API. The authoritative vault list is the
    hardcoded `vaults` + `shareVaults` arrays in its DefiLlama adapter, which
    DefiLlama contributors update when a vault is added. We diff against that file."""
    url = ("https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/"
           "main/projects/stellarDefiHub/index.js")
    src = http_text(url)
    out, seen = [], set()
    # match:  'C...55...',   // optional name
    for m in re.finditer(r"'(C[A-Z2-7]{55})'\s*,?\s*(?://\s*(.*))?", src):
        addr = m.group(1)
        if addr in seen:
            continue
        seen.add(addr)
        out.append({"address": addr, "name": (m.group(2) or "?").strip(), "tvl": 0})
    return out


PLATFORMS = [
    {"key": "august_digital", "label": "Upshift / Sentora / Gami", "fetch": fetch_august_digital},
    {"key": "stellar_defi_hub", "label": "Stellar DeFi Hub", "fetch": fetch_stellar_defi_hub},
    # Add more no-factory platforms here as fetch_* adapters.
]


def load_registry_ids(path):
    with open(path, "r") as f:
        return set(STELLAR_C_ID.findall(f.read()))


def main():
    as_json = "--json" in sys.argv
    try:
        registry_ids = load_registry_ids(REGISTRY_PATH)
    except FileNotFoundError:
        print(f"ERROR: registry not found at {REGISTRY_PATH} (set REGISTRY_PATH)", file=sys.stderr)
        return 2
    if len(registry_ids) < 20:
        print(f"ERROR: only {len(registry_ids)} ids parsed from {REGISTRY_PATH} — refusing "
              f"to report (looks wrong, would false-flag everything)", file=sys.stderr)
        return 2

    results, errors = [], []
    for p in PLATFORMS:
        try:
            vaults = p["fetch"]()
        except Exception as e:  # a platform being down must not hide the others
            errors.append({"platform": p["key"], "error": str(e)})
            continue
        for v in vaults:
            v["platform"] = p["label"]
            v["covered"] = v["address"] in registry_ids
            results.append(v)

    missing = [v for v in results if not v["covered"]]
    missing.sort(key=lambda v: -(v.get("tvl") or 0))

    if as_json:
        print(json.dumps({"checked": len(results), "missing": missing, "errors": errors}, indent=2))
    else:
        print(f"Vault coverage check — {len(results)} live vault(s) across "
              f"{len(PLATFORMS)} platform(s), registry has {len(registry_ids)} contract ids")
        for e in errors:
            print(f"  ⚠️  {e['platform']}: fetch failed — {e['error']}")
        if not missing:
            print("  ✅ all live vaults are covered")
        else:
            print(f"  ❌ {len(missing)} UNCOVERED vault(s):")
            for v in missing:
                tvl = v.get("tvl") or 0
                print(f"     {v['address']}  {v['name']}  (${tvl:,.0f})  [{v['platform']}]")
            print("\n  To cover: add each id to backend/indexer/src/registry.ts, then "
                  "scp + `bash ~/lcrd/deploy-gcp.sh indexer`, and backfill history "
                  "(ops/vault-coverage-check and the v2 backfill method).")

    # non-zero exit when there is something new, so cron/alerting can trigger
    return 1 if (missing or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
