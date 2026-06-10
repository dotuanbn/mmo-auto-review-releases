#!/usr/bin/env bash
# health-check.sh — Quick health check for MMO Auto Review dependencies
#
# Usage: bash health-check.sh
# Output: NDJSON lines with status of each dependency

set -euo pipefail

check() {
  local name="$1"
  local cmd="$2"

  if command -v "$cmd" &>/dev/null; then
    local version
    version=$("$cmd" --version 2>/dev/null | head -1 || echo "unknown")
    echo "{\"name\":\"${name}\",\"status\":\"ok\",\"version\":\"${version}\"}"
  else
    echo "{\"name\":\"${name}\",\"status\":\"missing\",\"version\":null}"
  fi
}

echo "--- MMO Auto Review Health Check ---"
check "node" "node"
check "npm" "npm"
check "python" "python"
check "git" "git"
check "bash" "bash"
echo "{\"name\":\"timestamp\",\"value\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
echo "--- Done ---"
