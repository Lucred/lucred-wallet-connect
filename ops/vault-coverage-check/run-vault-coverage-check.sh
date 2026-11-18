#!/usr/bin/env bash
# Cron wrapper for check-vault-coverage.py. Reads the LIVE registry on the VM.
# Exit 1 (something uncovered / a fetch failed) is surfaced in the log so it is
# easy to alert on; it does not touch the chain or BigQuery.
set -uo pipefail
cd "$(dirname "$0")"
export REGISTRY_PATH="${REGISTRY_PATH:-$HOME/lcrd/indexer/src/registry.ts}"
echo "=== vault-coverage-check $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
python3 check-vault-coverage.py
rc=$?
echo "=== exit $rc ==="
exit $rc
