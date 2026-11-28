#!/usr/bin/env bash
#
# Weekly ecosystem score-distribution refresh.
#
# Runs the offline batch scorer (batch-score.js), which streams every credit event,
# scores each wallet with the EXACT production scorer, and writes
#   credit_bureau.credit_score_histogram  +  credit_bureau.credit_score_tiers
# in BigQuery — the data behind the /analytics "score distribution" card.
#
# WHY THIS EXISTS: batch-score.js is a standalone script with no scheduler. Left
# un-cronned it silently froze the distribution card for 44 days (last run
# 2026-10-14). This runner + a weekly crontab entry keep it fresh.
#
# REQUIREMENTS on the host (a BigQuery-credentialed box, e.g. stellar-indexer1):
#   - node >= 20.19 (or >= 22) reachable — batch-score.js pulls in @stellar/stellar-sdk,
#     whose transitive uint8array-extras is ESM-only, so an older node dies with
#     ERR_REQUIRE_ESM. If the host's default `node` is too old (common when an OS
#     package ships node 20.17 in /usr/local/bin ahead of an nvm build), point this
#     runner at a good binary with NODE_BIN, e.g.:
#        NODE_BIN=/home/svc/.nvm/versions/node/v22.23.1/bin/node
#     in the crontab line (or export it before running). Defaults to `node` on PATH.
#   - this folder's deps installed:  (cd here && npm ci)
#   - BigQuery Application Default Credentials, i.e. one of:
#       * `gcloud auth application-default login` has been run, OR
#       * GOOGLE_APPLICATION_CREDENTIALS points at a service-account key with
#         BigQuery Data Editor + Job User on the credit_bureau dataset.
#     (The node @google-cloud/bigquery SDK needs ADC — the `bq` CLI's own auth
#      is NOT enough.)
#
# INSTALL (on the scorer host):
#   chmod +x run-batch-score.sh
#   crontab -e   # then add the line below (adjust the absolute path + log dir):
#
#   7 4 * * 0  /ABS/PATH/TO/backend/credit-score-api/run-batch-score.sh >> /var/log/lcrd/batch-score.log 2>&1
#
#   → Sundays 04:07 UTC. The :07 offset keeps it clear of the loader cron's
#     :00/:10 slots on stellar-indexer1 so the two full-scan jobs don't collide.
#     Bump to daily ("7 4 * * *") if you want the distribution fresher.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Make common node install locations reachable from cron's minimal PATH. Append (not
# prepend) so an operator's own PATH — e.g. an nvm shim that resolves to a new-enough
# node — still wins over a stale /usr/local/bin/node.
export PATH="${PATH:-}:/usr/local/bin:/usr/bin:/bin"

# Resolve the node binary: NODE_BIN wins, else `node` on PATH.
NODE_BIN="${NODE_BIN:-node}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Fail fast with a clear message if node is missing or too old for require(ESM).
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "----- $(ts) batch-score ABORT: node not found (NODE_BIN='$NODE_BIN'). Set NODE_BIN to a node >= 20.19/22. -----"
  exit 127
fi
NODE_VER="$("$NODE_BIN" -v 2>/dev/null)"           # e.g. v22.23.1
NODE_MAJOR="$(printf '%s' "$NODE_VER" | sed -E 's/^v([0-9]+)\..*/\1/')"
NODE_MINOR="$(printf '%s' "$NODE_VER" | sed -E 's/^v[0-9]+\.([0-9]+)\..*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt 20 ] || { [ "${NODE_MAJOR:-0}" -eq 20 ] && [ "${NODE_MINOR:-0}" -lt 19 ]; } || [ "${NODE_MAJOR:-0}" -eq 21 ]; then
  echo "----- $(ts) batch-score ABORT: node $NODE_VER too old for require(ESM). Need >= 20.19 or >= 22; set NODE_BIN. -----"
  exit 1
fi

echo "----- $(ts) batch-score starting (cwd=$SCRIPT_DIR, node=$NODE_VER) -----"
if "$NODE_BIN" batch-score.js; then
  echo "----- $(ts) batch-score OK -----"
else
  code=$?
  echo "----- $(ts) batch-score FAILED (exit ${code}) -----"
  exit "${code}"
fi
