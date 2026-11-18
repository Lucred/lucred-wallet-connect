#!/usr/bin/env python3
"""
check-rwa-issuance.py — new-issuance monitor for tokenized RWAs relevant to Stellar.

FREE sources only (no paid API). rwa.xyz's keyed API was dropped as too expensive;
this uses DefiLlama's free, keyless protocols API (api.llama.fi/protocols).

WHY, AND HOW IT DIFFERS FROM vault-coverage-check. That checker watches curated vault
*platforms* against the indexer registry. RWA *issuers* mint tokenized *assets*
(T-bills, MMFs, gold, equities, credit) that feed LCRD's collateral/pricing path and
the RWA scoring signal, not vault indexing. There's no on-chain factory for them.

Two free signals off one DefiLlama call:
  Bucket A — "RWA on Stellar": protocols whose chains include Stellar AND whose
             category is RWA-ish. High priority (already on Stellar).
  Bucket B — "RWA issuer catalog": every RWA-category protocol (DefiLlama leaves
             `chains` empty for most tokenized-treasury issuers — Spiko, Ondo,
             WisdomTree, Etherfuse, OpenEden, Backed …), so we watch the whole RWA
             catalog; a NEW name = a new tokenized-RWA issuer to check for Stellar.

Detection = a persisted seen-set (STATE_PATH). First run records today's set as the
baseline (reported, not alerted, exit 0); later runs flag anything new (exit 1), with
a best-effort hint of whether the name already appears in registry.ts.

Usage:
  python3 check-rwa-issuance.py                 # report new, update state
  python3 check-rwa-issuance.py --no-state-update
  python3 check-rwa-issuance.py --json
  python3 check-rwa-issuance.py --mock sample.json   # test with a local protocols dump

Env: LLAMA_URL (default https://api.llama.fi/protocols), REGISTRY_PATH, STATE_PATH,
     HTTP_TIMEOUT.
"""
import json, os, re, sys, time, urllib.request

LLAMA_URL = os.environ.get("LLAMA_URL", "https://api.llama.fi/protocols")
REGISTRY_PATH = os.environ.get(
    "REGISTRY_PATH",
    os.path.join(os.path.dirname(__file__), "..", "..", "backend", "indexer", "src", "registry.ts"),
)
STATE_PATH = os.environ.get("STATE_PATH", os.path.join(os.path.dirname(__file__), "state.json"))
TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "40"))

# Categories that count as RWA for the issuer-catalog bucket.
RWA_CATEGORIES = {"RWA", "Treasury Manager"}
# For the Stellar bucket, also allow a few adjacent categories when the protocol is
# explicitly chain-tagged Stellar (an RWA issuer may be filed under a yield category).
STELLAR_RWA_CATEGORIES = RWA_CATEGORIES | {"Onchain Capital Allocator"}


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "lcrd-rwa-issuance-monitor"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def fetch_protocols(mock=None):
    if mock is not None:
        with open(mock) as f:
            return json.load(f)
    return http_json(LLAMA_URL)


def classify(protocols):
    """Return (stellar_rwa, rwa_catalog) as lists of {key,name,category,chains}."""
    stellar, catalog = [], []
    for p in protocols:
        name = p.get("name") or "?"
        cat = p.get("category") or "?"
        chains = p.get("chains") or []
        on_stellar = "Stellar" in chains
        rec = {"name": name, "category": cat, "chains": chains, "on_stellar": on_stellar}
        if on_stellar and cat in STELLAR_RWA_CATEGORIES:
            rec = dict(rec, key="S|" + name)
            stellar.append(rec)
        if cat in RWA_CATEGORIES:
            catalog.append(dict(rec, key="C|" + name))
    return stellar, catalog


def load_registry_text():
    try:
        with open(REGISTRY_PATH) as f:
            return f.read().lower()
    except FileNotFoundError:
        return ""


def indexed_hint(name, registry_text):
    """Best-effort: does a distinctive token of the protocol name appear in registry.ts?"""
    if not registry_text:
        return None
    for tok in re.split(r"[^a-z0-9]+", name.lower()):
        if len(tok) >= 5 and tok not in ("stellar", "finance", "protocol", "token", "defi") and tok in registry_text:
            return True
    return False


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
    mock = sys.argv[sys.argv.index("--mock") + 1] if "--mock" in sys.argv else None

    protocols = fetch_protocols(mock)
    if not isinstance(protocols, list) or len(protocols) < 100:
        print(f"ERROR: DefiLlama returned {type(protocols).__name__} / too few rows — aborting "
              f"(won't false-baseline)", file=sys.stderr)
        return 2

    stellar, catalog = classify(protocols)
    registry_text = load_registry_text()
    seen = load_state()
    first_run = len(seen) == 0

    all_recs = {r["key"]: r for r in (stellar + catalog)}
    for r in all_recs.values():
        r["indexed"] = indexed_hint(r["name"], registry_text)
    current_keys = set(all_recs)
    new_keys = current_keys - seen
    new_stellar = sorted([all_recs[k] for k in new_keys if k.startswith("S|")], key=lambda r: r["name"])
    new_catalog = sorted([all_recs[k] for k in new_keys if k.startswith("C|")], key=lambda r: r["name"])

    # Persist state BEFORE printing, so truncated/broken-pipe output can never skip it.
    if not no_update and mock is None:
        save_state(seen | current_keys)

    if as_json:
        print(json.dumps({"stellar_rwa": len(stellar), "rwa_catalog": len(catalog),
                          "first_run": first_run,
                          "new_on_stellar": new_stellar, "new_in_catalog": new_catalog}, indent=2))
    else:
        tag = "baseline (first run — recording, not alerting)" if first_run else "NEW"
        print(f"RWA issuance monitor (DefiLlama, free) — {len(stellar)} RWA protocol(s) on "
              f"Stellar, {len(catalog)} in the RWA issuer catalog")
        def show(items, header):
            if items:
                print(f"  {len(items)} {tag} — {header}:")
                for r in items:
                    idx = {True: "name in registry", False: "NOT in registry", None: "?"}[r["indexed"]]
                    ch = ",".join(r["chains"]) or "no-chain-tag"
                    print(f"     {r['name'][:38]:<38} [{r['category']}]  {ch}  — {idx}")
        if not new_stellar and not new_catalog:
            print("  ✅ no new RWA protocols/issuers since last run")
        else:
            show(new_stellar, "RWA protocols now ON Stellar (high priority — index + collateral triage)")
            show(new_catalog, "RWA issuers in catalog (check whether they're on Stellar yet)")
            if not first_run:
                print("\n  Triage a Stellar one: (a) index for scoring — add its Stellar contract id "
                      "to registry.ts (resolve via its stellar.toml / stellar.expert), redeploy, "
                      "backfill; (b) assess for collateral — transferability gate + haircut (rwa-collateral).")

    return 1 if ((new_stellar or new_catalog) and not first_run) else 0


if __name__ == "__main__":
    sys.exit(main())
