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
export GOFLAGS=-buildvcs=false  # an old-tree checkout has no objects of its own to stamp from
export GOCACHE="$cache/gocache" GOPATH="$cache/gopath"
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
case "${SHX_NO_BROWSER:-}" in
  1) ;;
  *)
    # A browser dir of its own per job: a cache shared by jobs on one node can be half-written by another job.
    export PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d)/pw"
    npx --no-install playwright install chromium >/dev/null ;;
esac
# The agent-side picture command lives in another repository. With SHX_DOTFILES_REPO (owner/name) and
# SHX_DOTFILES_REF set, its files are fetched for the job and exported as SHX_NOTE_IMAGE with the browser
# this job installed, so the journeys that need the command can run in the pod.
if [ -n "${SHX_DOTFILES_REPO:-}" ] && [ -n "${SHX_DOTFILES_REF:-}" ]; then
  tool="$(mktemp -d)"
  curl -fsSL "https://codeload.github.com/${SHX_DOTFILES_REPO}/tar.gz/${SHX_DOTFILES_REF}" |
    tar -xz -C "$tool" --wildcards '*/dot_local/share/shx/*' --strip-components=4
  printf '#!/bin/sh\nexec node "%s/shx.mjs" "$@"\n' "$tool" > "$tool/shx-note-image"
  chmod +x "$tool/shx-note-image"
  export SHX_NOTE_IMAGE="$tool/shx-note-image"
  SHX_CHROMIUM="$(node --input-type=module -e 'import {chromium} from "@playwright/test"; console.log(chromium.executablePath())')"
  export SHX_CHROMIUM
fi
exec "$@"
