#!/bin/bash
# The game's F8 bug reports, from the R2 bucket "gtad" (bugs/<date>/<time>-<player>-<id>/report.json and shot.jpg).
#   tools/gtad-bugs.sh          download the 20 newest reports into ~/Downloads/gtad-bugs/ and list them
#   tools/gtad-bugs.sh 50       the 50 newest
#   tools/gtad-bugs.sh rm <id>  delete one report (id as listed, e.g. 2026-11-26/053012-leo-a1b2c3)
#   tools/gtad-bugs.sh logs                 list the 20 newest game log sessions (player-session, chunks, last upload)
#   tools/gtad-bugs.sh logs <player-session>  join that session's chunks, in order, into ~/Downloads/gtad-bugs/logs/<it>.log, and say where they came from
#   tools/gtad-bugs.sh logs rm <player-session>  delete that session's chunks
# Keys come from ~/.config/gtad/r2.env (GTAD_R2_ACCESS_KEY_ID, GTAD_R2_SECRET_ACCESS_KEY) and are never printed. Needs the aws CLI.
set -euo pipefail
ENV="$HOME/.config/gtad/r2.env"; [ -r "$ENV" ] || { echo "missing $ENV" >&2; exit 1; }
set -a; . "$ENV"; set +a
export AWS_ACCESS_KEY_ID="$GTAD_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$GTAD_R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto AWS_PAGER=""
EP="https://${GTAD_R2_ACCOUNT_ID:-f72e4ca67688711bd49d9a35abcd721e}.r2.cloudflarestorage.com"; BUCKET="${GTAD_R2_BUCKET:-gtad}"
OUT="$HOME/Downloads/gtad-bugs"; s3() { aws s3 --endpoint-url "$EP" "$@"; }

if [ "${1:-}" = "rm" ]; then
  id="${2:?which report? give its id}"; case "$id" in */*-*) ;; *) echo "not a report id: $id" >&2; exit 1;; esac
  cid=$( { s3 cp --quiet "s3://$BUCKET/bugs/$id/report.json" - 2>/dev/null || true; } | /usr/bin/python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id") or "")
except Exception: print("")')
  s3 rm --recursive "s3://$BUCKET/bugs/$id/" >/dev/null && rm -rf "$OUT/$id"
  [ -n "$cid" ] && s3 rm "s3://$BUCKET/bugs/_ids/$cid" >/dev/null 2>&1 || true
  echo "deleted $id"; exit 0
fi

if [ "${1:-}" = "logs" ]; then
  all=$( { s3 ls --recursive "s3://$BUCKET/logs/" || true; } | awk '{print $1" "$2" "$4}')
  if [ "${2:-}" = "rm" ]; then
    sess="${3:?which session?}"; keys=$(echo "$all" | awk '{print $3}' | { grep "/$sess/" || true; })
    [ -n "$keys" ] || { echo "no session $sess"; exit 1; }
    for k in $keys; do s3 rm "s3://$BUCKET/$k" >/dev/null; done; echo "deleted $(echo "$keys" | wc -l | tr -d ' ') chunks of $sess"; exit 0
  fi
  if [ -z "${2:-}" ]; then
    [ -n "$all" ] || { echo "no game logs yet"; exit 0; }
    echo "$all" | /usr/bin/python3 -c '
import sys, collections
s = collections.OrderedDict()
for line in sys.stdin:
    d, t, k = line.split(None, 2); k = k.strip(); sess = k.split("/")[2]
    c, last = s.get(sess, (0, "")); s[sess] = (c + 1, max(last, d + " " + t))
for sess, (c, last) in sorted(s.items(), key=lambda x: x[1][1], reverse=True)[:20]: print("%-48s %4d chunks  last %s" % (sess, c, last))'
    exit 0
  fi
  sess="$2"; keys=$(echo "$all" | awk '{print $3}' | { grep "/$sess/" || true; })
  [ -n "$keys" ] || { echo "no session $sess"; exit 1; }
  mkdir -p "$OUT/logs"; tmp=$(mktemp -d "${TMPDIR:-/tmp}/gtad-logs.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
  for k in $keys; do s3 cp --quiet "s3://$BUCKET/$k" "$tmp/$(echo "$k" | tr / _)"; done
  # chunks in order: by date folder, then chunk number (a session may cross midnight UTC)
  ls "$tmp" | sort -t_ -k2,2 -k4,4n | while read f; do gunzip -c "$tmp/$f"; done > "$OUT/logs/$sess.log"
  first=$(echo "$keys" | head -n 1); geo=$(aws s3api head-object --endpoint-url "$EP" --bucket "$BUCKET" --key "$first" --query Metadata --output json 2>/dev/null | /usr/bin/python3 -c 'import json,sys
try: m = json.load(sys.stdin) or {}
except Exception: m = {}
p = ", ".join(x for x in (m.get("city"), m.get("region"), m.get("country")) if x)
print((p + (" (" + m["timezone"] + ")" if m.get("timezone") else "")) if p or m.get("timezone") else "")' || true)
  echo "$OUT/logs/$sess.log ($(echo "$keys" | wc -l | tr -d ' ') chunks, $(wc -l < "$OUT/logs/$sess.log" | tr -d ' ') lines)${geo:+, sent from $geo}"; exit 0
fi

N="${1:-20}"; mkdir -p "$OUT"
ids=$( { s3 ls --recursive "s3://$BUCKET/bugs/" || true; } | awk '{print $4}' | { grep '/report.json$' || true; } | sed 's#^bugs/##; s#/report.json$##' | sort -r | head -n "$N")
[ -n "$ids" ] || { echo "no bug reports yet"; exit 0; }
for id in $ids; do
  [ -f "$OUT/$id/report.json" ] || s3 cp --recursive --quiet "s3://$BUCKET/bugs/$id/" "$OUT/$id/"
  /usr/bin/python3 - "$OUT/$id/report.json" "$id" <<'PY'
import json, sys
try: r = json.load(open(sys.argv[1]))
except Exception: r = {}
words = next((str(r[k]) for k in ("text", "message", "description", "what") if r.get(k)), "")
print("%-40s %-8s %-8s %s" % (sys.argv[2], str(r.get("version", ""))[:8], str(r.get("platform", ""))[:8], words.replace("\n", " ")[:70]))
PY
done
echo "in $OUT"
