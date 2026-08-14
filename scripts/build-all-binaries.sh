#!/usr/bin/env bash
# Compile the viewer binary for every supported platform.
#
#   bash scripts/build-all-binaries.sh        → dist/orca-dag-<os>-<arch>[.exe]
#
# Bun cross-compiles from any host, so a single Linux CI runner produces the
# macOS and Windows binaries too — no build matrix needed. Each invocation of
# build-binary.mjs rebuilds web/dist and re-embeds it (a second or two), which
# keeps that script the single source of truth for how a binary is made.
set -euo pipefail

cd "$(dirname "$0")/.."

# Bun target → the artifact suffix users recognise from a release page.
targets=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-windows-x64:windows-x64"
)

for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  suffix="${entry##*:}"
  echo "── building orca-dag-${suffix} (${target})"
  TARGET="$target" OUT_NAME="orca-dag-${suffix}" node scripts/build-binary.mjs
done

# Each binary carries a whole Bun runtime (~100 MB), so ship them compressed —
# five raw files would be a ~500 MB release page. The archive holds a plain
# `orca-dag` (no per-target suffix) so `tar xf … && ./orca-dag` just works.
cd dist
for f in orca-dag-*; do
  case "$f" in
    *.tar.gz | *.zip | SHA256SUMS.txt) continue ;;
  esac
  if [[ "$f" == *windows* ]]; then
    cp "$f" orca-dag.exe && zip -q "${f%.exe}.zip" orca-dag.exe && rm orca-dag.exe
  else
    cp "$f" orca-dag && tar czf "$f.tar.gz" orca-dag && rm orca-dag
  fi
  rm "$f"
done

# Checksums let people verify a download; uploaded next to the archives.
# macOS ships `shasum` instead of coreutils' `sha256sum`, so this also runs
# locally, not just on the Linux CI runner.
if command -v sha256sum >/dev/null; then
  sha256sum orca-dag-* > SHA256SUMS.txt
else
  shasum -a 256 orca-dag-* > SHA256SUMS.txt
fi
echo
cat SHA256SUMS.txt
