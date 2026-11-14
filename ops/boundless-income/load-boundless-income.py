#!/usr/bin/env python3
"""Load Boundless builder income into credit_bureau.oss_bounty_events.

Boundless (boundlessfi.xyz) is a Stellar hackathons / bounties / grants / crowdfunding platform. Unlike
Drips (classic USDC payments) or GrantFox (TrustlessWork escrow), Boundless runs its OWN Soroban contract
(`boundless-events`), so builder payouts are CONTRACT EVENTS, not classic payments or TW escrows. We read
them from BigQuery `crypto-stellar.crypto_stellar.history_contract_events_v2` (the only cheap, complete
source for one contract's Soroban events — it is DAY-partitioned and clustered by contract_id), decode
them, and append USDC income to the same oss_bounty_events table the other sources use — so the existing
income scorer (oss-contribution.js) picks them up with no code change.

Income events (confirmed against live mainnet data 2026-11-14 — names are snake_case on chain, NOT the
PascalCase in Boundless's Dune doc):
  • `winner_paid`      — a Hackathon/Bounty winner collected a prize (claim_prize). data: amount(i128
                         stroops), event_id(u64), recipient(address), position(u32), milestone(void).
  • `milestone_claimed`— a Grant/Crowdfunding milestone paid. data: amount, event_id, recipient,
                         milestone(u32).
The payout event carries NEITHER the token NOR the pillar; both live on `event_created` (per event_id:
id(u64), pillar(enum vec[0].symbol), token(address)). So we join payout.event_id -> event_created.

Classification (mirrors the HackMeridian decision — one-off event/grant money is a weaker signal than
sustained work-for-pay):
  • Bounty      -> incomeType 'oss_bounty'  (weight 0.7, counted in full by the scorer)
  • Hackathon   -> incomeType 'event_grant' (scorer counts at 0.35)
  • Grant       -> incomeType 'event_grant' (0.35)
  • Crowdfunding-> EXCLUDED (the recipient is the project creator withdrawing raised capital, not earned
                   income — same reasoning that excluded Cheese Pay).
Only USDC payouts are counted (token == Circle USDC SAC; USD 1:1), matching the scorer's USDC-only sum.

Idempotent: reads Boundless rows already in the table and skips loaded payouts, so backfill and re-runs
are safe. One BQ query scans this one contract's events (~$0.3 upper bound); run weekly (Boundless payouts
are infrequent) or daily.

  ./load-boundless-income.py            # load new income (full-history scan, idempotent)
  ./load-boundless-income.py --full     # same; explicit backfill alias
"""
import json, os, subprocess, sys, tempfile

CONTRACT   = "CCFVEGOQJEM47LRAJU2LHEK4KTL5VYN7AOGZ2HH2GNHAMXTILNMMJGQZ"   # boundless-events (mainnet)
USDC_SAC   = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"   # Circle USDC SAC (the event `token`)
PROJECT    = os.environ.get("PROJECT", "lucred-715bc")
EVENTS_DS  = os.environ.get("EVENTS_DS", "crypto-stellar.crypto_stellar.history_contract_events_v2")
TABLE      = "credit_bureau.oss_bounty_events"
PLATFORM_NAME = "Boundless"
SINCE      = os.environ.get("SINCE", "2026-01-01")   # partition lower bound (Boundless mainnet era)
MAX_BYTES  = os.environ.get("MAX_BYTES", "60000000000")  # ~$0.38 guardrail

# pillar -> (incomeType, weight, include)
PILLAR_POLICY = {
    "Bounty":       ("oss_bounty",  0.7, True),
    "Hackathon":    ("event_grant", 0.35, True),
    "Grant":        ("event_grant", 0.35, True),
    "Crowdfunding": (None,          0.0, False),   # creator withdrawing raised capital — not earned income
}

STELLAR_ADDRESS_RE = None  # not needed; addresses come straight from decoded events


def bq(sql, max_bytes=None):
    cmd = ["bq", "query", "--project_id", PROJECT, "--use_legacy_sql=false", "--format=json",
           "--max_rows=1000000"]
    if max_bytes:
        cmd.append("--maximum_bytes_billed=" + str(max_bytes))
    out = subprocess.run(cmd + [sql], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("bq query failed: " + out.stderr[:400])
    txt = out.stdout.strip()
    return json.loads(txt) if txt else []


def known_keys():
    """Boundless payouts already loaded (dedup scope = this platform)."""
    rows = bq("SELECT transactionHash, receiver, amount, milestoneIndex FROM `%s` WHERE platformName='%s'"
              % (TABLE, PLATFORM_NAME))
    keys = set()
    for r in rows:
        keys.add((r["transactionHash"], r["receiver"], round(float(r["amount"]), 7), int(r["milestoneIndex"])))
    return keys


def field(dmap, name):
    """Pull one field's typed value out of a decoded ScVal map (list of {key:{symbol},val:{type:value}})."""
    for e in dmap.get("map", []):
        if e.get("key", {}).get("symbol") == name:
            return e.get("val")
    return None


def as_addr(v):   return v.get("address") if isinstance(v, dict) else None
def as_i128(v):   return int(v["i128"]) if isinstance(v, dict) and "i128" in v else None
def as_u64(v):    return v["u64"] if isinstance(v, dict) and "u64" in v else None
def as_u32(v):    return v["u32"] if isinstance(v, dict) and "u32" in v else None
def as_pillar(v):
    # enum encoded as {"vec":[{"symbol":"Hackathon"}]}, or sometimes {"symbol":"Hackathon"}
    if isinstance(v, dict):
        if "vec" in v and v["vec"]:
            return v["vec"][0].get("symbol")
        if "symbol" in v:
            return v["symbol"]
    return None


def main():
    seen = known_keys()
    print("boundless-income: %d payouts already loaded" % len(seen))

    sql = (
        "SELECT JSON_VALUE(topics_decoded,'$[0].symbol') AS ev, "
        "       TO_JSON_STRING(data_decoded) AS data, "
        "       transaction_hash AS tx, "
        "       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', closed_at) AS t "
        "FROM `" + EVENTS_DS + "` "
        "WHERE contract_id = '" + CONTRACT + "' AND successful "
        "  AND closed_at >= '" + SINCE + "' "
        "  AND JSON_VALUE(topics_decoded,'$[0].symbol') IN ('event_created','winner_paid','milestone_claimed')"
    )
    rows = bq(sql, max_bytes=MAX_BYTES)
    print("boundless-income: scanned %d event rows" % len(rows))

    # 1) build event_id -> {pillar, token} from event_created
    meta = {}
    payouts = []
    for r in rows:
        try:
            d = json.loads(r["data"])
        except Exception:
            continue
        ev = r["ev"]
        if ev == "event_created":
            eid = as_u64(field(d, "id"))
            if eid is None:
                continue
            meta[eid] = {"pillar": as_pillar(field(d, "pillar")), "token": as_addr(field(d, "token"))}
        elif ev in ("winner_paid", "milestone_claimed"):
            eid = as_u64(field(d, "event_id"))
            recipient = as_addr(field(d, "recipient"))
            amt = as_i128(field(d, "amount"))
            if eid is None or not recipient or amt is None:
                continue
            idx = as_u32(field(d, "milestone")) if ev == "milestone_claimed" else as_u32(field(d, "position"))
            payouts.append({"ev": ev, "event_id": eid, "receiver": recipient, "amountRaw": amt,
                            "idx": int(idx or 0), "tx": r["tx"], "t": r["t"]})

    # 2) dedup (the events table records each event twice), classify, keep USDC + includable pillars
    new_rows, dedup = [], set()
    skipped_pillar = skipped_token = skipped_nometa = 0
    for p in payouts:
        amount = p["amountRaw"] / 1e7
        natural = (p["tx"], p["receiver"], round(amount, 7), p["idx"])
        if natural in dedup:
            continue
        dedup.add(natural)
        if natural in seen:
            continue
        m = meta.get(p["event_id"])
        if not m:
            skipped_nometa += 1; continue
        if m["token"] != USDC_SAC:
            skipped_token += 1; continue
        incomeType, weight, include = PILLAR_POLICY.get(m["pillar"], (None, 0.0, False))
        if not include:
            skipped_pillar += 1; continue
        new_rows.append({
            "escrowContract": CONTRACT,
            "milestoneIndex": p["idx"],
            "receiver": p["receiver"],
            "platform": CONTRACT,
            "platformName": PLATFORM_NAME,
            "incomeType": incomeType,
            "weight": weight,
            "amount": amount,
            "platformFeeBps": 0,
            "assetCode": "USDC",
            "assetContractId": USDC_SAC,
            "title": "Boundless " + (m["pillar"] or ""),
            "transactionHash": p["tx"],
            "blockCloseTime": p["t"],
        })

    print("boundless-income: %d new income rows (skipped: %d non-USDC, %d excluded-pillar, %d no event_created)"
          % (len(new_rows), skipped_token, skipped_pillar, skipped_nometa))
    if not new_rows:
        print("boundless-income: nothing new to load."); return

    with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as f:
        for row in new_rows:
            f.write(json.dumps(row) + "\n")
        path = f.name
    load = subprocess.run(["bq", "load", "--project_id", PROJECT,
                           "--source_format=NEWLINE_DELIMITED_JSON", TABLE, path],
                          capture_output=True, text=True)
    os.unlink(path)
    if load.returncode != 0:
        sys.exit("bq load failed: " + load.stderr[:500])
    print("boundless-income: loaded %d rows into %s" % (len(new_rows), TABLE))


if __name__ == "__main__":
    main()
