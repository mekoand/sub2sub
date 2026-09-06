#!/bin/sh
set -eu
sub2sub_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -n "${SUB2SUB_NODE:-}" ]; then
  if ! "$SUB2SUB_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    echo 'SUB2SUB_NODE must point to a working Node.js 22+ executable.' >&2
    exit 1
  fi
  sub2sub_node=$SUB2SUB_NODE
else
  sub2sub_node=''
  for sub2sub_candidate in "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(command -v node || true)"; do
    if [ -n "$sub2sub_candidate" ] && [ -x "$sub2sub_candidate" ] && "$sub2sub_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
      sub2sub_node=$sub2sub_candidate
      break
    fi
  done
  if [ -z "$sub2sub_node" ]; then
    echo 'sub2sub requires Node.js 22+. Install Node.js or set SUB2SUB_NODE to its executable path.' >&2
    exit 1
  fi
fi
if [ "${1:-}" = '--check' ]; then
  exec "$sub2sub_node" "$sub2sub_root/scripts/setup-check.mjs"
fi
exec "$sub2sub_node" "$sub2sub_root/bin/mcp.mjs"
