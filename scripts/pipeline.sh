#!/bin/sh
# Full pipeline: passive survey -> experiment (dry-run unless DRY_RUN=false + confirmation) -> nothing else.
# Analysis runs in the separate `analyze` service after this one completes.
set -e
echo "== solana-tx-ordering pipeline  DRY_RUN=${DRY_RUN:-true}  MAX_SPEND_SOL=${MAX_SPEND_SOL:-0.05}"
node --test test/unit.test.js
if [ "${SKIP_PASSIVE:-false}" != "true" ]; then node dist/main.js passive; fi
node dist/main.js experiment
