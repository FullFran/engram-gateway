#!/bin/sh
# Download one Engram release binary for linux and verify it against the
# release's checksums.txt.
#
# Usage: scripts/fetch-engram.sh <version> <dest-dir>
#   version   e.g. 3.7.0 (no leading v); defaults to the pin in engram.version
#   dest-dir  where the `engram` binary is installed; defaults to ./.engram-bin
set -eu

version=${1:-$(tr -d '[:space:]' < "$(dirname "$0")/../engram.version")}
dest=${2:-.engram-bin}
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="engram_${version}_linux_${arch}.tar.gz"
base="https://github.com/Gentleman-Programming/engram/releases/download/v${version}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/$asset" "$base/$asset"
curl -fsSL -o "$work/checksums.txt" "$base/checksums.txt"
(cd "$work" && grep " ${asset}\$" checksums.txt | sha256sum -c -)
tar xzf "$work/$asset" -C "$work" engram
mkdir -p "$dest"
install -m 0755 "$work/engram" "$dest/engram"
"$dest/engram" version
