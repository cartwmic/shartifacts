#!/usr/bin/env bash
# Checks that the registry holds the image for this tree: both platforms under
# tree-<git tree hash>, the tag .github/workflows/image.yml pushes. It uses the credentials
# of the Docker user who is logged in. Run it from the repository with the commit checked out.
set -euo pipefail

url=$(git remote get-url origin)
# https://github.com/OWNER/REPO(.git) or git@github.com:OWNER/REPO(.git).
path=$(sed -E 's#^(https?://([^@/]+@)?|ssh://git@|git@)github\.com[:/]##; s#\.git$##' <<<"$url")
if [[ $path == "$url" || $path != */* ]]; then
  echo "check-image: cannot read a github.com OWNER/REPO from the origin remote: $url" >&2
  exit 1
fi
image="ghcr.io/${path,,}:tree-$(git rev-parse 'HEAD^{tree}')"

if ! manifest=$(docker buildx imagetools inspect "$image" 2>&1); then
  echo "check-image: $image is not in the registry (or cannot be read):" >&2
  echo "$manifest" >&2
  exit 1
fi

missing=()
for platform in linux/amd64 linux/arm64; do
  grep -q "Platform:[[:space:]]*$platform\$" <<<"$manifest" || missing+=("$platform")
done
if ((${#missing[@]})); then
  echo "check-image: $image has no manifest for: ${missing[*]}" >&2
  exit 1
fi

echo "$image"
sed -n 's/^Digest:[[:space:]]*//p' <<<"$manifest" | head -n 1
