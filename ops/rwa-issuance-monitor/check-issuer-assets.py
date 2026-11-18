#!/usr/bin/env python3
"""
check-issuer-assets.py — deeper, on-chain half of the RWA monitor.

The DefiLlama check (check-rwa-issuance.py) is protocol-level, so a NEW product from
an issuer ALREADY on Stellar (e.g. Etherfuse adds another bond) won't create a new
DefiLlama protocol and would slip through. This catches that: it scans Hubble's
`history_assets` for every classic asset issued by a curated allowlist of LEGIT RWA
issuer accounts, and flags any asset code we haven't seen before.

FREE: uses the `bq` CLI against the public `crypto-stellar` dataset (same pattern as
the drips/boundless loaders), cost-capped. Writes only its own state file.

WHY AN ALLOWLIST (not asset codes): on Stellar an asset code like BENJI or CETES has
dozens of impostor issuers. The allowlist holds the verified issuer G-accounts only.
Each one here was confirmed by computing its asset's SAC and matching it against the
indexer registry (see resolve-issuers.js). Add more with that helper.

Coverage: classic assets only. Native-Soroban RWA tokens (e.g. Spiko) are not in
`history_assets` — those are already indexed as contracts and would be caught by the
vault/contract path, not here.

Usage:
  python3 check-issuer-assets.py                 # report new codes, update state (exit 1 if new)
  python3 check-issuer-assets.py --no-state-update
  python3 check-issuer-assets.py --json
Env: PROJECT (default lucred-715bc), STATE_PATH, MAX_BYTES_BILLED.
"""
import json, os, subprocess, sys, time

PROJECT = os.environ.get("PROJECT", "lucred-715bc")
STATE_PATH = os.environ.get("STATE_PATH",
                            os.path.join(os.path.dirname(__file__), "issuer-assets-state.json"))
MAX_BYTES = os.environ.get("MAX_BYTES_BILLED", "21474836480")  # 20 GiB cap

# Curated LEGIT RWA issuer accounts (classic-asset issuers). Each verified by
# SAC-matching against registry.ts. Extend via resolve-issuers.js.
KNOWN_RWA_ISSUERS = {
    "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC": "Etherfuse",          # CETES/USTRY/TESOURO/EUROB
    "GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5": "Franklin Templeton",  # BENJI
    # TODO (resolve + add): WisdomTree (classic, 9 funds), Untangled RWA, Ondo (USDY
    # on Stellar appears non-classic). Native-Soroban issuers (Spiko) are out of scope.
}


def bq_query(sql):
    cmd = ["bq", "query", "--project_id", PROJECT, "--use_legacy_sql=false",
           "--format=json", "--max_rows=10000", "--maximum_bytes_billed=" + MAX_BYTES, sql]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("bq query failed: " + (out.stderr or out.stdout)[:400])
    return json.loads(out.stdout or "[]")


def fetch_issuer_assets():
    issuers = ",".join('"%s"' % g for g in KNOWN_RWA_ISSUERS)
    sql = ("SELECT asset_code, asset_issuer, asset_type "
           "FROM `crypto-stellar.crypto_stellar.history_assets` "
           "WHERE asset_issuer IN (%s) GROUP BY 1,2,3" % issuers)
    return bq_query(sql)


def load_state():
    try:
        with open(STATE_PATH) as f:
            return set(json.load(f).get("seen", []))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_state(seen):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"seen": sorted(seen),
                   "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f, indent=2)
    os.replace(tmp, STATE_PATH)


def main():
    as_json = "--json" in sys.argv
    no_update = "--no-state-update" in sys.argv
    if not KNOWN_RWA_ISSUERS:
        print("no issuers configured", file=sys.stderr)
        return 2

    rows = fetch_issuer_assets()
    assets = [{"code": r["asset_code"], "issuer": r["asset_issuer"],
               "issuer_label": KNOWN_RWA_ISSUERS.get(r["asset_issuer"], "?"),
               "key": r["asset_issuer"] + "|" + r["asset_code"]} for r in rows]
    seen = load_state()
    first_run = len(seen) == 0
    current = {a["key"] for a in assets}
    new = sorted([a for a in assets if a["key"] not in seen], key=lambda a: (a["issuer_label"], a["code"]))

    if not no_update:
        save_state(seen | current)  # persist before printing

    if as_json:
        print(json.dumps({"issuers": len(KNOWN_RWA_ISSUERS), "assets": len(assets),
                          "first_run": first_run, "new": new}, indent=2))
    else:
        tag = "baseline (first run — recording, not alerting)" if first_run else "NEW asset(s)"
        print(f"RWA issuer-asset scan — {len(assets)} classic asset(s) across "
              f"{len(KNOWN_RWA_ISSUERS)} known issuer(s)")
        if new:
            print(f"  {len(new)} {tag}:")
            for a in new:
                print(f"     {a['code']:<12} {a['issuer_label']:<20} {a['issuer']}")
            if not first_run:
                print("\n  Each new code from a known issuer = a new RWA product. Triage: compute its "
                      "SAC (new Asset(code,issuer).contractId(PUBLIC)), add to registry.ts, redeploy, "
                      "backfill; assess for collateral (rwa-collateral).")
        else:
            print("  ✅ no new assets from known RWA issuers since last run")

    return 1 if (new and not first_run) else 0


if __name__ == "__main__":
    sys.exit(main())
