#!/usr/bin/env bash
set -euo pipefail

# Coverage report across all packages
# Usage: ./scripts/coverage.sh [--open]
#
# Providers:
#   - CLI + SDK: @vitest/coverage-v8 (Node runtime)
#   - Server:    @vitest/coverage-istanbul (workerd runtime)
#
# Integration tests (tests/) are excluded from coverage because Istanbul
# has a known multi-file merging bug in workerd that reports 0%.
# See: https://github.com/cloudflare/workers-sdk/issues/5825
# Server unit tests already cover the same source code.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Coverage: packages/sdk (v8) ==="
cd "$ROOT/packages/sdk"
pnpm vitest run --coverage

echo ""
echo "=== Coverage: packages/cli (v8) ==="
cd "$ROOT/packages/cli"
pnpm vitest run --coverage

echo ""
echo "=== Coverage: packages/server (istanbul) ==="
cd "$ROOT/packages/server"
pnpm vitest run --coverage

echo ""
echo "=== Coverage reports ==="
echo "  packages/sdk/coverage/"
echo "  packages/cli/coverage/"
echo "  packages/server/coverage/"

if [[ "${1:-}" == "--open" ]]; then
  open "$ROOT/packages/sdk/coverage/index.html" 2>/dev/null || true
  open "$ROOT/packages/cli/coverage/index.html" 2>/dev/null || true
  open "$ROOT/packages/server/coverage/index.html" 2>/dev/null || true
fi
