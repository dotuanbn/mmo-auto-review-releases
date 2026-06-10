#!/usr/bin/env bash
# export-metrics.sh — Export AI metrics from the past N days as CSV
#
# Usage: bash export-metrics.sh [days=7]
# Requires: sqlite3
#
# Output: CSV rows of ai_metrics table

set -euo pipefail

DAYS="${1:-7}"

# Find the SQLite database
DB_PATH="${APPDATA:-$HOME}/MMO Auto Review/database.sqlite"

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: Database not found at $DB_PATH" >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "ERROR: sqlite3 is not installed" >&2
  exit 1
fi

CUTOFF=$(date -u -d "-${DAYS} days" +%s 2>/dev/null || date -u -v-${DAYS}d +%s 2>/dev/null)

echo "task,model_id,operation,duration_ms,success,memory_mb,created_at"

sqlite3 -csv "$DB_PATH" \
  "SELECT task, model_id, operation, duration_ms, success, memory_mb, datetime(created_at/1000, 'unixepoch') as created_at
   FROM ai_metrics
   WHERE created_at > ${CUTOFF}000
   ORDER BY created_at DESC;"
