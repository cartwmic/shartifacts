#!/bin/sh
# Runs the Go tests whose names match PATTERN (a go test -run regexp) and fails when none
# did: a filter that matches nothing makes `go test` exit 0, which would pass silently.
[ $# -eq 1 ] || { echo "usage: scripts/gocheck.sh PATTERN" >&2; exit 2; }
out=$(mktemp) || exit 1
trap 'rm -f "$out"' EXIT
go test -run "$1" -count=1 -v ./... >"$out" 2>&1
status=$?
cat "$out"
[ "$status" -eq 0 ] || exit "$status"
if ! grep -q -e '--- PASS' "$out"; then
	echo "gocheck: no test matched $1" >&2
	exit 1
fi
