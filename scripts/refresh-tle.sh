#!/usr/bin/env bash
# Daily element-set refresh for the site.
#
# Primary source: CelesTrak group files (one polite pass per run). CelesTrak
# rate-limits and blocks by address range, and shared CI egress ranges get
# caught in that, so each group has a fallback: the GP records for the NORAD
# IDs in the last good file, fetched from Space-Track (18 SDS). The name lines
# are kept from the last good CelesTrak file so PRN mapping and labels do not
# change; only lines 1 and 2 are replaced. Group membership therefore follows
# CelesTrak's curation and catches up when CelesTrak is reachable again.
#
# A group that cannot be refreshed from either source keeps its previous file.
# tle-refresh.json (refreshedAt + per-group source) only advances when every
# group refreshed in this run, because it describes the oldest file served.
#
# Environment:
#   DATA_DIR              default public/data
#   SPACETRACK_IDENTITY / SPACETRACK_PASSWORD   enable the fallback
#   CELESTRAK_BASE / SPACETRACK_BASE            overridable for tests
#   REFRESH_ALLOW_HTTP=1  allow plain http bases (tests only)
#   REFRESH_PAUSE_S       pause between CelesTrak groups (default 15)
#   REFRESH_RETRY_DELAY_S curl retry delay (default 20)
#   GITHUB_OUTPUT         when set, "failed=<groups>" is appended to it
set -euo pipefail

DATA=${DATA_DIR:-public/data}
CELESTRAK=${CELESTRAK_BASE:-https://celestrak.org}
SPACETRACK=${SPACETRACK_BASE:-https://www.space-track.org}
UA="sidereon.dev daily refresh (github action)"
TLE_GROUPS=(gps-ops galileo glo-ops beidou)
PAUSE=${REFRESH_PAUSE_S:-15}
RETRY_DELAY=${REFRESH_RETRY_DELAY_S:-20}
PROTO='=https'
[ "${REFRESH_ALLOW_HTTP:-0}" = "1" ] && PROTO='=http,https'

cookie=$(mktemp)
trap 'rm -f "$cookie"' EXIT
logged_in=0
declare -A source=()
refreshed=()
failed=()

curl_base=(--proto "$PROTO" --tlsv1.2 --fail --silent --show-error --connect-timeout 30 --max-time 120 -A "$UA")

record_count() { grep -cE '^1 [0-9]{5}' "$1" || true; }

fetch_celestrak() { # group out
  curl "${curl_base[@]}" --retry 3 --retry-delay "$RETRY_DELAY" \
    "$CELESTRAK/NORAD/elements/gp.php?GROUP=$1&FORMAT=tle" -o "$2" || return 1
  [ "$(record_count "$2")" -ge 3 ]
}

spacetrack_login() {
  [ "$logged_in" = 1 ] && return 0
  curl "${curl_base[@]}" --retry 2 --retry-delay "$RETRY_DELAY" -c "$cookie" \
    --data-urlencode "identity=$SPACETRACK_IDENTITY" \
    --data-urlencode "password=$SPACETRACK_PASSWORD" \
    "$SPACETRACK/ajaxauth/login" -o /dev/null || return 1
  logged_in=1
}

fetch_spacetrack() { # group out  (uses the last good file for IDs and names)
  local group=$1 out=$2 last="$DATA/$1.tle" ids raw
  if [ -z "${SPACETRACK_IDENTITY:-}" ] || [ -z "${SPACETRACK_PASSWORD:-}" ]; then
    echo "$group: no Space-Track credentials, fallback unavailable"; return 1
  fi
  [ -f "$last" ] || { echo "$group: no last good file for the fallback"; return 1; }
  ids=$(grep -E '^1 [0-9]{5}' "$last" | cut -c3-7 | paste -sd, -)
  [ -n "$ids" ] || { echo "$group: last good file has no records"; return 1; }
  spacetrack_login || { echo "$group: Space-Track login failed"; return 1; }
  raw=$(mktemp)
  if ! curl "${curl_base[@]}" --retry 2 --retry-delay "$RETRY_DELAY" -b "$cookie" \
      "$SPACETRACK/basicspacedata/query/class/gp/NORAD_CAT_ID/$ids/orderby/NORAD_CAT_ID/format/tle" -o "$raw"; then
    rm -f "$raw"; echo "$group: Space-Track query failed"; return 1
  fi
  python3 - "$last" "$raw" "$out" <<'PY' || { rm -f "$raw"; return 1; }
import sys
last, raw, out = sys.argv[1:4]
names = {}   # norad id -> name line from the last good CelesTrak file
order = []
prev = None
for line in open(last, encoding="ascii", errors="replace").read().splitlines():
    if line.startswith("1 ") and prev is not None:
        nid = line[2:7]
        names[nid] = prev
        order.append(nid)
    prev = line if not line.startswith(("1 ", "2 ")) else prev
fresh = {}
lines = [l.rstrip("\r") for l in open(raw, encoding="ascii", errors="replace").read().splitlines()]
for i, line in enumerate(lines):
    if line.startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
        fresh[line[2:7]] = (line, lines[i + 1])
kept = [nid for nid in order if nid in fresh]
if len(order) == 0 or len(kept) < 3 or len(kept) * 5 < len(order) * 4:
    sys.exit(f"fallback coverage too low: {len(kept)} of {len(order)} records")
with open(out, "w", encoding="ascii", newline="\n") as fh:
    for nid in kept:
        l1, l2 = fresh[nid]
        fh.write(f"{names[nid]}\n{l1}\n{l2}\n")
missing = len(order) - len(kept)
print(f"fallback merged {len(kept)} records" + (f", {missing} not returned by Space-Track" if missing else ""))
PY
  rm -f "$raw"
}

for group in "${TLE_GROUPS[@]}"; do
  out="$DATA/$group.tle"
  tmp="$out.new"
  if fetch_celestrak "$group" "$tmp"; then
    mv "$tmp" "$out"; source[$group]=celestrak; refreshed+=("$group")
    echo "$group: refreshed from CelesTrak ($(record_count "$out") records)"
  else
    rm -f "$tmp"
    echo "$group: CelesTrak fetch failed, trying the Space-Track fallback"
    if fetch_spacetrack "$group" "$tmp"; then
      mv "$tmp" "$out"; source[$group]=space-track; refreshed+=("$group")
      echo "$group: refreshed from Space-Track ($(record_count "$out") records)"
    else
      rm -f "$tmp"; failed+=("$group")
      echo "$group: keeping previous file"
    fi
  fi
  sleep "$PAUSE"
done

if [ "${#failed[@]}" -eq 0 ]; then
  sources_in_order=()
  for group in "${TLE_GROUPS[@]}"; do sources_in_order+=("${source[$group]}"); done
  python3 - "$DATA/tle-refresh.json" "${TLE_GROUPS[@]}" "${sources_in_order[@]}" <<'PY'
import json, sys, datetime
path = sys.argv[1]
groups = sys.argv[2:6]
sources = sys.argv[6:10]
doc = {
    "refreshedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "sources": dict(zip(groups, sources)),
}
with open(path, "w", encoding="ascii", newline="\n") as fh:
    fh.write(json.dumps(doc, separators=(",", ":")) + "\n")
print("wrote", path, doc)
PY
fi

echo "refreshed: ${refreshed[*]:-none}"
echo "failed: ${failed[*]:-none}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "failed=${failed[*]:-}" >> "$GITHUB_OUTPUT"
fi
