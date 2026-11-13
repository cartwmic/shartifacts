#!/bin/sh
# One named check of the fork, run on the cluster with kgate (never on a workstation).
#   KGATE_PROFILE=<path to kgate.toml> scripts/kgate-check.sh <name>
# Names: stroke, status, wake, draw, lost, fidelity, annot (against a local server in the pod) and
# live-base, live-annot (against the server at $SHX_LIVE_URL). The journeys that use the agent-side
# picture command need SHX_DOTFILES_REPO and SHX_DOTFILES_REF (see kgate-job.sh).
set -eu
profile="${KGATE_PROFILE:-kgate.toml}"
fetch="SHX_DOTFILES_REPO='${SHX_DOTFILES_REPO:-}' SHX_DOTFILES_REF='${SHX_DOTFILES_REF:-}'"
run() { exec kgate --profile "$profile" -- sh -c "$1"; }
case "${1:-}" in
  stroke) run "SHX_NO_BROWSER=1 scripts/kgate-job.sh scripts/gocheck.sh TestStroke" ;;
  wake) run "SHX_NO_BROWSER=1 scripts/kgate-job.sh scripts/gocheck.sh TestWakeCursor" ;;
  status) run "$fetch scripts/kgate-job.sh sh -c 'scripts/gocheck.sh TestCommentStatus && node scripts/journey.mjs --local lost'" ;;
  draw) run "scripts/kgate-job.sh node scripts/journey.mjs --local draw" ;;
  fidelity) run "$fetch scripts/kgate-job.sh node scripts/journey.mjs --local fidelity" ;;
  annot) run "$fetch scripts/kgate-job.sh node scripts/journey.mjs --local annot" ;;
  live-base) run "scripts/kgate-job.sh node scripts/journey.mjs --base '${SHX_LIVE_URL:?set SHX_LIVE_URL}' base" ;;
  live-annot) run "$fetch scripts/kgate-job.sh node scripts/journey.mjs --base '${SHX_LIVE_URL:?set SHX_LIVE_URL}' annot" ;;
  *) echo "usage: kgate-check.sh stroke|status|wake|draw|fidelity|annot|live-base|live-annot" >&2; exit 2 ;;
esac
