#!/bin/bash
# Run all scenario tests
# Usage: ./test/scenarios/run-all.sh [--quick]

set -e
QUICK=${1:-""}
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$QUICK" = "--quick" ]; then
  DURATION=5
  AGENTS=3
  MEMBERS=5
  MESSAGES=10
  CYCLES=2
else
  DURATION=20
  AGENTS=5
  MEMBERS=20
  MESSAGES=50
  CYCLES=3
fi

pass=0
fail=0

run() {
  local name="$1"; shift
  echo "━━━ $name ━━━"
  if npx tsx "$@"; then
    echo "  → PASS"
    ((pass++)) || true
  else
    echo "  → FAIL"
    ((fail++)) || true
  fi
  echo
}

run "Many-to-Many" "$DIR/many-to-many.ts" --hubs 3 --agents $AGENTS --duration $DURATION
run "Group Broadcast" "$DIR/group-broadcast.ts" --members $MEMBERS --messages $MESSAGES
run "Reconnect Stress" "$DIR/reconnect-stress.ts" --agents $AGENTS --cycles $CYCLES
run "Mesh Stress" "$DIR/mesh-stress.ts" --hubs 3 --agents $AGENTS --duration $DURATION

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
