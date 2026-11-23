#!/usr/bin/env bash
# Snapshots `apt list --upgradable` into a JSON file the (unprivileged) app container
# can read. Read-only: never runs `apt-get update` or `apt upgrade` — the system's own
# apt-daily.timer / update-notifier-download.timer already keep the apt cache fresh.
# One-way flow: host -> updates.json -> app. The app never triggers this script.
set -euo pipefail

# apt and apt-check translate their output: under a French (or any non-English) system
# locale, `apt list` prints "[pouvant être mis à jour depuis : …]" and the regex below
# matches nothing, so the list came out empty. Parse the C locale output only.
export LC_ALL=C

OUT="${UPDATES_OUT:-/var/lib/spark-control-center/updates.json}"
OUT_DIR="$(dirname "$OUT")"
TMP="$OUT_DIR/.$(basename "$OUT").tmp.$$"

mkdir -p "$OUT_DIR"
trap 'rm -f "$TMP"' EXIT

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# name/origin version arch [upgradable from: current]
line_re='^([^/[:space:]]+)/([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]+\[upgradable from: ([^]]+)\]$'

# Machine-readable counts "total;security" (on stderr), the same numbers update-notifier
# shows, without its translated sentences. Left out if apt-check is missing.
counts=""
if [ -x /usr/lib/update-notifier/apt-check ]; then
  raw="$(/usr/lib/update-notifier/apt-check 2>&1 >/dev/null || true)"
  if [[ "$raw" =~ ^([0-9]+)\;([0-9]+)$ ]]; then
    counts="$(printf '"total":%s,"security":%s,' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")"
  fi
fi

{
  printf '{"generatedAt":"%s",%s"packages":[' "$generated_at" "$counts"
  first=1
  while IFS= read -r line; do
    [[ "$line" == "Listing"* || -z "$line" ]] && continue
    [[ "$line" =~ $line_re ]] || continue
    name="${BASH_REMATCH[1]}"
    origin="${BASH_REMATCH[2]}"
    candidate="${BASH_REMATCH[3]}"
    arch="${BASH_REMATCH[4]}"
    current="${BASH_REMATCH[5]}"
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"name":"%s","candidate":"%s","current":"%s","origin":"%s","arch":"%s"}' \
      "$name" "$candidate" "$current" "$origin" "$arch"
  done < <(apt list --upgradable 2>/dev/null)
  printf ']}'
} > "$TMP"

chmod 0644 "$TMP"
mv -f "$TMP" "$OUT"
