#!/bin/bash
# The game's F8 bug reports, from the R2 bucket "gtad" (bugs/<date>/<time>-<player>-<id>/report.json and shot.jpg).
#   tools/gtad-bugs.sh          download the 20 newest reports into ~/Downloads/gtad-bugs/ and list them
#   tools/gtad-bugs.sh 50       the 50 newest
#   tools/gtad-bugs.sh rm <id>  delete one report (id as listed, e.g. 2026-11-26/053012-leo-a1b2c3)
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
