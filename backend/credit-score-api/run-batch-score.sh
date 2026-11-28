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
#   - node >= 20 on PATH
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

# Make common node install locations reachable from cron's minimal PATH.
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "----- $(ts) batch-score starting (cwd=$SCRIPT_DIR) -----"
if node batch-score.js; then
  echo "----- $(ts) batch-score OK -----"
else
  code=$?
  echo "----- $(ts) batch-score FAILED (exit ${code}) -----"
  exit "${code}"
fi
