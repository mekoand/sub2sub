#!/bin/sh
# Download a complete release; no system Node.js, npm or OpenSSL is required.
set -eu
install_sub2sub() {
  target=${1:-codex}
  case "$target" in codex|claude) ;; *) echo 'Choose an installation target: codex or claude.' >&2; return 1 ;; esac
  [ "$#" -le 1 ] || { echo 'Usage: install.sh [codex|claude]' >&2; return 1; }
  [ "$(uname -s)" = Darwin ] || { echo 'This installer supports macOS. On Windows use install.ps1.' >&2; return 1; }
  case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo 'Unsupported Mac architecture.' >&2; return 1 ;; esac
  version=${SUB2SUB_VERSION:-0.8.1}
  case "$version" in ''|*[!0-9.]*) echo 'Invalid SUB2SUB_VERSION.' >&2; return 1 ;; esac
  base="https://github.com/mekoand/sub2sub/releases/download/v$version"
  asset="sub2sub-darwin-$arch.tar.gz"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT HUP INT TERM
  echo "Downloading sub2sub $version for macOS ($arch)..."
  curl --fail --location --retry 2 --connect-timeout 20 "$base/$asset" -o "$work/$asset"
  curl --fail --silent --show-error --location --retry 2 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
  (cd "$work" && awk -v name="$asset" '$2 == name { print }' SHA256SUMS > selected.sha256 && test -s selected.sha256 && shasum -a 256 -c selected.sha256)
  mkdir "$work/payload"
  tar -xzf "$work/$asset" -C "$work/payload"
  "$work/payload/runtime/bin/node" "$work/payload/plugins/sub2sub/scripts/install.mjs" "$work/payload" "${SUB2SUB_INSTALL_DIR:-$HOME/.local/share/sub2sub}" "$target"
}
install_sub2sub "$@"
