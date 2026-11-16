#!/bin/sh
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

# Starts the released engine. No Node, no wrangler and no Cloudflare account: it execs the
# bundled workerd against the config the release pipeline generated at build time.
#
#   ./bin/kitesurf                 # 127.0.0.1:8787
#   KITESURF_PORT=9000 ./bin/kitesurf
#   ./bin/kitesurf --verbose       # extra arguments go to workerd
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PORT=${KITESURF_PORT:-8787}
cd "$DIR"

echo "kitesurf engine"
echo "  cdp      ws://127.0.0.1:$PORT/devtools/browser"
echo "  discover http://127.0.0.1:$PORT/json/version"
echo "  stop     ctrl-c"

# --experimental is what workerd requires for the workerLoader binding the engine spawns pages on.
# The socket address is overridden here so the config does not have to be rewritten per port.
exec ./runtime/workerd serve --experimental \
  --socket-addr "http=127.0.0.1:$PORT" \
  ./runtime/config.capnp "$@"
