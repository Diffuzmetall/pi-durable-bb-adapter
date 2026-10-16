#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/ubuntu/Projects/pi-durable-bb-adapter
SCRATCH="$ROOT/.pi/fixtures/core-sol/native-port"
WORK="$ROOT/.pi/fixtures/core-sol/sqlite-build"
NODE_ROOT=/home/ubuntu/.nvm/versions/node/v24.19.0
EVIDENCE="$ROOT/evidence/BB1/core-port-sol/project-root-frozen"
NONCE=core-sqlite-project-root-frozen-20261016-d
: "${MEASUREMENT_LEASE_EXPIRES_AT:?actual exclusive Agent Mail receipt expiry required}"
: "${SOURCE_LEASE_EXPIRES_AT:?actual source/scratch/evidence lease receipt expiry required}"
NOW=$(date +%s)
MEASUREMENT_END=$(date -d "$MEASUREMENT_LEASE_EXPIRES_AT" +%s)
SOURCE_END=$(date -d "$SOURCE_LEASE_EXPIRES_AT" +%s)
if (( MEASUREMENT_END - NOW < 210 || SOURCE_END - NOW < 210 )); then
  echo 'Insufficient remaining lease TTL; nonce not consumed'
  exit 1
fi
( set -o noclobber; printf '%s\n' "$NONCE" > "$EVIDENCE/$NONCE.used" )
printf 'measurement_remaining=%s source_remaining=%s\n' "$((MEASUREMENT_END-NOW))" "$((SOURCE_END-NOW))" > "$EVIDENCE/lease-remaining.txt"
export SCRATCH WORK NODE_ROOT
set +e
setsid timeout --signal=TERM --kill-after=5s 175s bash -c '
set -euo pipefail
export PATH="$NODE_ROOT/bin:$PATH" HOME="$WORK/home" XDG_CACHE_HOME="$WORK/cache" npm_config_cache="$WORK/cache" TMPDIR="$WORK/tmp"
cd "$WORK/sqlite"
"$NODE_ROOT/bin/node" /usr/share/nodejs/node-gyp/bin/node-gyp.js rebuild --release --nodedir="$NODE_ROOT" --jobs=2
for target in "$SCRATCH/packages/db/node_modules/better-sqlite3" "$SCRATCH/apps/server/node_modules/better-sqlite3"; do
 test -L "$target"
 ln -sfn "$WORK/sqlite" "$target"
done
cd "$SCRATCH"
"$NODE_ROOT/bin/node" node_modules/vitest/vitest.mjs run --config focused-sol.vitest.config.ts --reporter=verbose
' > "$EVIDENCE/build-and-test.log" 2>&1 &
PID=$!
wait "$PID"
RESULT=$?
set -e
printf '%s\n' "$RESULT" > "$EVIDENCE/exit-code.txt"
exit "$RESULT"
