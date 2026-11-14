#!/usr/bin/env bash
# Wrapper for the Boundless income loader (cron entrypoint). Passes args through.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 load-boundless-income.py "$@"
