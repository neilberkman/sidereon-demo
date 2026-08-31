#!/usr/bin/env bash
# Scheduled element-set refresh for the site (the only thing that talks to the
# providers; builds and visitors never do).
#
# CelesTrak etiquette, from their GP FAQ: they refresh GP data every 2 hours,
# so a file fetched less than 2 hours ago is current and is not fetched again;
# an HTTP 403/404 will not change by repeating, so it stops all further
# CelesTrak queries for the run and is reported; the User-Agent identifies us
# and links to the repository.
#
# Primary source: CelesTrak group files. Fallback per group: the GP records for
# the NORAD IDs in the last good file, from Space-Track (18 SDS), with the
# CelesTrak name lines kept so PRN mapping and labels do not change and group
# membership still follows CelesTrak's curation.
#
# A group that cannot be refreshed keeps its previous file. tle-refresh.json
# carries: refreshedAt + sources (advance only when every group is current in
# this run, because they describe the oldest file served) and fetched (the last
# CelesTrak fetch time per group, the 2-hour guard's memory, always persisted).
#
# Environment:
#   DATA_DIR              default public/data
#   SPACETRACK_IDENTITY / SPACETRACK_PASSWORD   enable the fallback
#   CELESTRAK_BASE / SPACETRACK_BASE            overridable for tests
#   REFRESH_ALLOW_HTTP=1  allow plain http bases (tests only)
#   REFRESH_PAUSE_S       pause between CelesTrak groups (default 15)
#   REFRESH_RETRY_DELAY_S curl retry delay (default 20)
#   REFRESH_MIN_AGE_S     guard window (default 7200)
#   GITHUB_OUTPUT         when set, "failed=<groups>" is appended to it
set -euo pipefail

DATA=${DATA_DIR:-public/data}
STATE="$DATA/tle-refresh.json"
CELESTRAK=${CELESTRAK_BASE:-https://celestrak.org}
SPACETRACK=${SPACETRACK_BASE:-https://www.space-track.org}
UA="sidereon.dev element-set refresh (twice daily, 2-hour guard; https://github.com/neilberkman/sidereon-demo)"
TLE_GROUPS=(gps-ops galileo glo-ops beidou)
PAUSE=${REFRESH_PAUSE_S:-15}
RETRY_DELAY=${REFRESH_RETRY_DELAY_S:-20}
MIN_AGE=${REFRESH_MIN_AGE_S:-7200}
PROTO='=https'
[ "${REFRESH_ALLOW_HTTP:-0}" = "1" ] && PROTO='=http,https'

cookie=$(mktemp)
trap 'rm -f "$cookie"' EXIT
logged_in=0
celestrak_stop=0
declare -A source=()
declare -A fetched_now=()
current=()
failed=()

curl_base=(--proto "$PROTO" --tlsv1.2 --silent --show-error --connect-timeout 30 --max-time 120 -A "$UA")

record_count() { grep -cE '^1 [0-9]{5}' "$1" || true; }

# state_field <key> <group>: value from tle-refresh.json, empty when absent.
state_field() {
  [ -f "$STATE" ] || return 0
  python3 - "$STATE" "$1" "$2" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
    print((doc.get(sys.argv[2]) or {}).get(sys.argv[3], ""))
except Exception:
    print("")
PY
}

seconds_since_fetch() { # group -> seconds since the recorded CelesTrak fetch, or empty
  local stamp
  stamp=$(state_field fetched "$1")
  [ -n "$stamp" ] || return 0
  python3 - "$stamp" <<'PY'
import sys, datetime
try:
    t = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
except Exception:
    print("")
PY
}

fetch_celestrak() { # group out
  local code
  if [ "$celestrak_stop" = 1 ]; then
    echo "$1: not querying CelesTrak again this run after the earlier 403/404"; return 1
  fi
  code=$(curl "${curl_base[@]}" --retry 3 --retry-delay "$RETRY_DELAY" -w '%{http_code}' \
    "$CELESTRAK/NORAD/elements/gp.php?GROUP=$1&FORMAT=tle" -o "$2" 2>/dev/null) || code=${code:-000}
  case "$code" in
    200)
      [ "$(record_count "$2")" -ge 3 ] && return 0
      echo "$1: CelesTrak returned too few records"; return 1;;
    403|404)
      echo "$1: CelesTrak answered HTTP $code. Their GP FAQ: this will not change by repeating, so no further CelesTrak queries this run. Response: $(head -c 300 "$2" 2>/dev/null | tr '\n' ' ')"
      celestrak_stop=1; return 1;;
    *)
      echo "$1: CelesTrak fetch failed (HTTP ${code:-none})"; return 1;;
  esac
}

spacetrack_login() {
  [ "$logged_in" = 1 ] && return 0
  curl "${curl_base[@]}" --fail --retry 2 --retry-delay "$RETRY_DELAY" -c "$cookie" \
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
  if ! curl "${curl_base[@]}" --fail --retry 2 --retry-delay "$RETRY_DELAY" -b "$cookie" \
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
  age=$(seconds_since_fetch "$group")
  if [ -n "$age" ] && [ "$age" -lt "$MIN_AGE" ] && [ -f "$out" ]; then
    prev_source=$(state_field sources "$group")
    source[$group]=${prev_source:-celestrak}; current+=("$group")
    echo "$group: fetched from CelesTrak $((age / 60)) min ago, current (CelesTrak updates every 2 hours); not fetching"
    continue
  fi
  if fetch_celestrak "$group" "$tmp"; then
    mv "$tmp" "$out"; source[$group]=celestrak; current+=("$group")
    fetched_now[$group]=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "$group: refreshed from CelesTrak ($(record_count "$out") records)"
    sleep "$PAUSE"
  else
    rm -f "$tmp"
    echo "$group: trying the Space-Track fallback"
    if fetch_spacetrack "$group" "$tmp"; then
      mv "$tmp" "$out"; source[$group]=space-track; current+=("$group")
      echo "$group: refreshed from Space-Track ($(record_count "$out") records)"
    else
      rm -f "$tmp"; failed+=("$group")
      echo "$group: keeping previous file"
    fi
  fi
done

# Persist state: the 2-hour guard's memory always; refreshedAt/sources only
# when every group is current.
sources_in_order=()
fetched_in_order=()
for group in "${TLE_GROUPS[@]}"; do
  sources_in_order+=("${source[$group]:-}")
  fetched_in_order+=("${fetched_now[$group]:-}")
done
python3 - "$STATE" "$(( ${#failed[@]} == 0 ))" "${TLE_GROUPS[@]}" "${sources_in_order[@]}" "${fetched_in_order[@]}" <<'PY'
import json, sys, datetime
path, complete = sys.argv[1], sys.argv[2] == "1"
groups = sys.argv[3:7]
sources = sys.argv[7:11]
fetched = sys.argv[11:15]
try:
    doc = json.load(open(path))
except Exception:
    doc = {}
prev_fetched = doc.get("fetched") or {}
for g, f in zip(groups, fetched):
    if f:
        prev_fetched[g] = f
doc["fetched"] = prev_fetched
if complete:
    doc["refreshedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc["sources"] = dict(zip(groups, sources))
ordered = {k: doc[k] for k in ("refreshedAt", "sources", "fetched") if k in doc}
with open(path, "w", encoding="ascii", newline="\n") as fh:
    fh.write(json.dumps(ordered, separators=(",", ":")) + "\n")
print(("advanced" if complete else "kept") + " refreshedAt;", "state:", json.dumps(ordered))
PY

echo "current: ${current[*]:-none}"
echo "failed: ${failed[*]:-none}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "failed=${failed[*]:-}" >> "$GITHUB_OUTPUT"
fi
