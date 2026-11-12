#!/bin/sh
# Runs a command inside a kgate pod (see kgate.toml) with what the fork's heavy jobs need:
# the Go toolchain (the image has none), the npm dependencies (node_modules is not shipped),
# and a Playwright Chromium. Usage: run-and-wake -- kgate -- scripts/kgate-job.sh <command...>
set -eu
GO_VERSION="${GO_VERSION:-1.26.11}"
cache="${HOME:-/tmp}/shx-job"
mkdir -p "$cache"
if [ ! -x "$cache/go/bin/go" ]; then
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C "$cache" -xz
fi
export PATH="$cache/go/bin:$PATH" GOTOOLCHAIN=local
export GOCACHE="$cache/gocache" GOPATH="$cache/gopath"
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
case "${SHX_NO_BROWSER:-}" in
  1) ;;
  *) npx --no-install playwright install chromium >/dev/null ;;
esac
exec "$@"
