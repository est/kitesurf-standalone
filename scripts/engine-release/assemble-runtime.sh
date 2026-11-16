#!/bin/sh
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

# Assembles one platform's release tarball from a built checkout, and smoke tests it.
#
#   scripts/engine-release/assemble-runtime.sh <out-dir> <platform>
#
# The engine dist is architecture-independent, so the expensive Bazel build happens once and each
# platform only swaps in a prebuilt workerd binary. The layout it produces:
#
#   bin/kitesurf              zero-dependency POSIX sh launcher
#   runtime/workerd           the platform runtime
#   runtime/config.capnp      generated here; embeds the modules at build time
#   runtime/dist/             engine bundle, wasm modules and the assets tree
#   LICENSE, NOTICE, licenses/ attribution
#
# Environment: WORKERD_VERSION (default 1.20260911.1, must match pnpm-lock.yaml), WORKERD_BASE_URL
# and WORKERD_ASSET to fetch workerd from elsewhere, SKIP_BUILD=1 to reuse an existing dist,
# SKIP_SMOKE=1 when the target cannot run here, plus TARBALL_DIR and NOTICES_FILE.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
WORKERD_VERSION=${WORKERD_VERSION:-1.20260911.1}
OUT=${1:?"usage: assemble-runtime.sh <out-dir> <platform>"}
PLATFORM=${2:?"usage: assemble-runtime.sh <out-dir> <platform>"}
DIST="$OUT/runtime/dist"

case "$PLATFORM" in
  darwin-arm64 | darwin-64 | linux-64 | linux-arm64) ;;
  *)
    echo "unknown platform $PLATFORM (want darwin-arm64, darwin-64, linux-64 or linux-arm64)" >&2
    exit 2
    ;;
esac

mkdir -p "$OUT/runtime" "$OUT/bin" "$ROOT/.tmp/workerd-$PLATFORM"

if [ "${SKIP_BUILD:-0}" = 1 ]; then
  echo "==> reusing $DIST (SKIP_BUILD=1)"
elif [ -f "$DIST/index.js" ]; then
  echo "==> reusing existing dist at $DIST"
else
  echo "==> building the Wasm core and the loaded-worker bundles with Bazel"
  (cd "$ROOT" && bazel run //packages/engine:dev_build)
  echo "==> bundling the engine dist (wrangler deploy --dry-run)"
  node "$ROOT/scripts/wpt-engine.mjs" prepare --dist "$DIST"
  # The sourcemap is 5 MB of the tarball and no one debugs a shipped engine with it.
  find "$DIST" -maxdepth 1 -name "*.map" -delete
fi
[ -f "$DIST/index.js" ] || { echo "no index.js in $DIST" >&2; exit 1; }

WORKERD_BASE_URL=${WORKERD_BASE_URL:-https://github.com/cloudflare/workerd/releases/download/v$WORKERD_VERSION}
WORKERD_ASSET=${WORKERD_ASSET:-workerd-$PLATFORM.gz}
WORKERD_BIN="$ROOT/.tmp/workerd-$PLATFORM/workerd"

if [ -x "$WORKERD_BIN" ]; then
  echo "==> reusing $WORKERD_BIN"
else
  echo "==> fetching workerd $WORKERD_VERSION ($WORKERD_ASSET) for $PLATFORM"
  curl -fsSL -o "$WORKERD_BIN.archive" "$WORKERD_BASE_URL/$WORKERD_ASSET"
  case "$WORKERD_ASSET" in
    *.gz) gzip -dc "$WORKERD_BIN.archive" > "$WORKERD_BIN" ;;
    *.tgz)
      rm -rf "$WORKERD_BIN.dir"
      mkdir -p "$WORKERD_BIN.dir"
      tar -xzf "$WORKERD_BIN.archive" -C "$WORKERD_BIN.dir"
      cp "$WORKERD_BIN.dir/package/bin/workerd" "$WORKERD_BIN"
      rm -rf "$WORKERD_BIN.dir"
      ;;
    *)
      echo "cannot unpack $WORKERD_ASSET" >&2
      exit 1
      ;;
  esac
  chmod +x "$WORKERD_BIN"
  rm -f "$WORKERD_BIN.archive"
fi
cp "$WORKERD_BIN" "$OUT/runtime/workerd"
chmod +x "$OUT/runtime/workerd"

# A cross-packed tarball must still hold the runtime for its own platform, so check the machine
# field of the binary rather than trusting which URL it came from. od is in both GNU and BSD
# userlands; the ELF machine field sits at byte 18 and Mach-O's cputype at byte 4.
verify_runtime() {
  header=$(od -An -tx1 -N24 "$1" | tr -d ' \n')
  magic=$(printf '%s' "$header" | cut -c1-8)
  macho_cpu=$(printf '%s' "$header" | cut -c9-16)
  elf_machine=$(printf '%s' "$header" | cut -c37-40)
  case "$2" in
    darwin-arm64) want_magic=cffaedfe; want_cpu=0c000001; got=$macho_cpu ;;
    darwin-64) want_magic=cffaedfe; want_cpu=07000001; got=$macho_cpu ;;
    linux-64) want_magic=7f454c46; want_cpu=3e00; got=$elf_machine ;;
    linux-arm64) want_magic=7f454c46; want_cpu=b700; got=$elf_machine ;;
    *) echo "no runtime check for $2" >&2; exit 2 ;;
  esac
  if [ "$magic" != "$want_magic" ] || [ "$got" != "$want_cpu" ]; then
    echo "runtime for $2 has an unexpected header $magic/$got (want $want_magic/$want_cpu)" >&2
    exit 1
  fi
  echo "    runtime $2 header $magic/$got"
}
verify_runtime "$OUT/runtime/workerd" "$PLATFORM"

echo "==> staging the asset tree the engine reads through FONT_ASSETS"
# `wrangler` serves these from the assets binding in a deploy; standalone they sit next to the
# runtime. The engine needs them: without the UA fonts, text lays out with zero height.
rm -rf "$OUT/runtime/assets"
mkdir -p "$OUT/runtime/assets"
cp -R "$ROOT/packages/engine/public/." "$OUT/runtime/assets/"
find "$OUT/runtime/assets" -name ".DS_Store" -delete

echo "==> generating runtime/config.capnp"
# The disk service path is relative, resolved against the working directory the launcher sets.
node "$HERE/launcher.mjs" --dist "$DIST" --runtime "$OUT/runtime" \
  --disk-path runtime/assets --print-config > "$OUT/runtime/config.capnp"

echo "==> launcher and attribution"
cp "$HERE/kitesurf-launch.sh" "$OUT/bin/kitesurf"
chmod +x "$OUT/bin/kitesurf"
cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$OUT/"
if [ -d "$ROOT/licenses" ]; then
  cp -R "$ROOT/licenses" "$OUT/licenses"
fi
if [ -f "$ROOT/.tmp/workerd-$WORKERD_VERSION/LICENSE" ]; then
  cp "$ROOT/.tmp/workerd-$WORKERD_VERSION/LICENSE" "$OUT/runtime/WORKERD-LICENSE"
fi
if [ -n "${NOTICES_FILE:-}" ] && [ -f "${NOTICES_FILE}" ]; then
  cp "$NOTICES_FILE" "$OUT/THIRD_PARTY_NOTICES.md"
elif [ -f "$OUT/THIRD_PARTY_NOTICES.md" ]; then
  echo "    keeping $OUT/THIRD_PARTY_NOTICES.md"
else
  echo "    no THIRD_PARTY_NOTICES.md (pass NOTICES_FILE to include one)"
fi

if [ "${SKIP_SMOKE:-0}" = 1 ]; then
  echo "==> smoke test skipped (SKIP_SMOKE=1; run it on the target platform instead)"
else
  smoke_port=${SMOKE_PORT:-46789}
  echo "==> smoke test (start on :$smoke_port, check /health and a built-in font, stop)"
  KITESURF_PORT=$smoke_port "$OUT/bin/kitesurf" > "$OUT/.smoke.log" 2>&1 &
  smoke_pid=$!
  health=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$smoke_port/health" > /dev/null 2>&1; then
      health=1
      break
    fi
    sleep 1
  done
  # /health alone passes when FONT_ASSETS points at nothing, which silently breaks text layout.
  font=0
  font_bytes=""
  if [ "$health" = 1 ]; then
    font_bytes=$(curl -fsS --max-time 5 "http://127.0.0.1:$smoke_port/rbi/fonts/NotoSans.ttf" 2>/dev/null | wc -c | tr -d ' ')
    [ "${font_bytes:-0}" -gt 100000 ] && font=1
  fi
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  if [ "$health" != 1 ] || [ "$font" != 1 ]; then
    echo "smoke test failed on :$smoke_port — launcher output follows" >&2
    cat "$OUT/.smoke.log" >&2
    exit 1
  fi
  rm -f "$OUT/.smoke.log"
  echo "    /health ok, NotoSans.ttf $font_bytes bytes"
fi

echo "==> tarball"
TARBALL_DIR=${TARBALL_DIR:-$ROOT/.tmp}
mkdir -p "$TARBALL_DIR"
NAME="kitesurf-engine-$PLATFORM"
tar -czf "$TARBALL_DIR/$NAME.tar.gz" -C "$OUT" .
# GNU tar hosts have sha256sum; macOS has shasum.
if command -v sha256sum > /dev/null 2>&1; then
  (cd "$TARBALL_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
else
  (cd "$TARBALL_DIR" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
fi
ls -l "$TARBALL_DIR/$NAME.tar.gz" "$TARBALL_DIR/$NAME.tar.gz.sha256"
du -sh "$OUT"
