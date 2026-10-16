#!/bin/bash
set -u -C
umask 077
cd /home/ubuntu/Projects/pi-durable-bb-adapter
E=evidence/BB0/shared-required-fixture
R="$PWD/evidence/BB0/lead-private/.cache/shared-required-stage1"
N=/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node
TAG=${1:?unique log tag required}
MODE=${2:-units}
[[ "$TAG" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 64
mkdir -p "$R/env/xdg-state" "$R/env/xdg-runtime"
ARGS=(--test "$E/tests/declaration.test.mjs" "$E/tests/entries.test.mjs")
EXTRA=()
case "$MODE" in
  units) ;;
  baseline) EXTRA=(STAGE1_CONTROL=baseline); ARGS=(--test '--test-name-pattern=^valid declaration, socket metadata injected only' "$E/tests/entries.test.mjs");;
  pure-admission-always-deny|runner-eager-import|bridge-gate-removed|catalog-gate-removed|registry-gate-removed|diagnostics-gate-removed|runner-constructor-gate-removed)
    EXTRA=("STAGE1_MUTATION=$MODE"); ARGS=(--test '--test-name-pattern=^valid declaration, socket metadata injected only' "$E/tests/entries.test.mjs");;
  *) exit 64;;
esac
CMD=(env -i PATH=/usr/bin:/bin HOME="$R/env/home" PI_AGENT_DIR="$R/env/pi-agent" PI_CODING_AGENT_DIR="$R/env/pi-coding-agent" XDG_CONFIG_HOME="$R/env/xdg-config" XDG_CACHE_HOME="$R/env/xdg-cache" XDG_DATA_HOME="$R/env/xdg-data" XDG_STATE_HOME="$R/env/xdg-state" XDG_RUNTIME_DIR="$R/env/xdg-runtime" TMPDIR="$R/env/tmp" "${EXTRA[@]}" "$N" "${ARGS[@]}")
START=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
"${CMD[@]}" > "$E/logs/$TAG.log" 2>&1
RC=$?
{
  printf 'start=%s\nend=%s\nexit=%s\nmode=%s\ncommand=' "$START" "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$RC" "$MODE"
  printf '%q ' "${CMD[@]}"
  printf '\n'
} > "$E/logs/$TAG.receipt"
printf '%s mode=%s exit=%s\n' "$TAG" "$MODE" "$RC"
exit "$RC"
