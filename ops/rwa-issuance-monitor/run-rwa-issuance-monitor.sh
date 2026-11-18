#!/usr/bin/env bash
# Cron wrapper: runs BOTH free RWA checks and exits non-zero if either finds something new.
#   1) check-rwa-issuance.py   — DefiLlama catalog (new RWA protocols / issuers), keyless
#   2) check-issuer-assets.py  — Hubble history_assets scan of known RWA issuer accounts
#                                (new product from an issuer already on Stellar), via bq CLI
# Read-only except each check's own state file.
set -uo pipefail
cd "$(dirname "$0")"
export REGISTRY_PATH="${REGISTRY_PATH:-$HOME/lcrd/indexer/src/registry.ts}"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "=== rwa-issuance-monitor $(ts) ==="
STATE_PATH="${STATE_PATH:-$HOME/lcrd/rwa-issuance-monitor/state.json}" python3 check-rwa-issuance.py
rc1=$?

echo "--- issuer-asset scan $(ts) ---"
STATE_PATH="$HOME/lcrd/rwa-issuance-monitor/issuer-assets-state.json" python3 check-issuer-assets.py
rc2=$?

rc=0; [ "$rc1" -ne 0 ] && rc=1; [ "$rc2" -ne 0 ] && rc=1
echo "=== exit $rc (defillama=$rc1 issuer-assets=$rc2) ==="
exit $rc
