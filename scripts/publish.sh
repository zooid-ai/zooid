#!/usr/bin/env bash
set -euo pipefail

# Ensure we're running from the repo root
cd "$(dirname "$0")/.."

# Publish Zooid packages to npm
# Usage: ./scripts/publish.sh [patch|minor|major] [--dry-run]
#
# Publishes in dependency order:
#   @zooid/types → @zooid/ui → @zooid/sdk → @zooid/web → @zooid/server → zooid (CLI)
# Handles workspace:* → real version replacement via pnpm publish

BUMP="${1:-patch}"
DRY_RUN=""

if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "🏃 Dry run — no packages will be published."
  echo ""
fi

# Packages to publish, in dependency order
PACKAGES=("types" "ui" "sdk" "web" "server" "cli")
PACKAGE_DIRS=("packages/types" "packages/ui" "packages/sdk" "packages/web" "packages/server" "packages/cli")

# --- Preflight checks ---

echo "📋 Preflight checks..."

# Must be on main
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "✗ Must be on main branch (currently on $BRANCH)"
  exit 1
fi

# Must be clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working directory is not clean. Commit or stash changes first."
  exit 1
fi

# Must be up to date with remote
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "✗ Local main is not up to date with origin. Pull first."
  exit 1
fi

# Must be logged into npm
if ! npm whoami &>/dev/null; then
  echo "✗ Not logged into npm. Run: npm login"
  exit 1
fi

echo "✓ On main, clean, up to date, npm authenticated"
echo ""

# --- Format check ---

echo "🎨 Checking formatting..."
pnpm format:check
echo "✓ Formatting OK"
echo ""

# --- Run tests ---

echo "🧪 Running tests..."
pnpm --filter=@zooid/types --filter=@zooid/sdk --filter=@zooid/server --filter=zooid test
echo "✓ Tests passed"
echo ""

# --- Build ---

echo "🔨 Building packages..."
pnpm --filter=@zooid/sdk build
pnpm --filter=@zooid/web build
pnpm --filter=zooid build
echo "✓ Build complete"
echo ""

# --- Bump versions ---

# Read current version from types (source of truth)
CURRENT=$(node -p "require('./packages/types/package.json').version")
echo "📦 Current version: $CURRENT"

# Calculate next version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  *)
    echo "✗ Invalid bump type: $BUMP (use patch, minor, or major)"
    exit 1
    ;;
esac
NEXT="$MAJOR.$MINOR.$PATCH"
echo "📦 Next version: $NEXT ($BUMP)"
echo ""

# Update version in all publishable packages
for dir in "${PACKAGE_DIRS[@]}"; do
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$dir/package.json', 'utf-8'));
    pkg.version = '$NEXT';
    fs.writeFileSync('$dir/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  $dir → $NEXT"
done
echo ""

# --- Publish ---

echo "🚀 Publishing..."
echo ""

for i in "${!PACKAGES[@]}"; do
  dir="${PACKAGE_DIRS[$i]}"
  name=$(node -p "require('./$dir/package.json').name")

  echo "  Publishing $name@$NEXT..."

  # pnpm publish handles workspace:* → real version replacement automatically
  (cd "$dir" && pnpm publish --access public --no-git-checks $DRY_RUN)

  echo "  ✓ $name@$NEXT published"
  echo ""
done

# --- Git tag + push ---

if [[ -z "$DRY_RUN" ]]; then
  echo "🏷️  Tagging v$NEXT..."
  git add packages/types/package.json packages/ui/package.json packages/sdk/package.json packages/web/package.json packages/server/package.json packages/cli/package.json
  git commit -m "release: v$NEXT"
  git tag "v$NEXT"
  git push origin main --tags
  echo "✓ Tagged and pushed v$NEXT"
else
  echo "🏷️  Would tag v$NEXT (skipped in dry run)"
  # Revert version bumps in dry run
  git checkout -- packages/types/package.json packages/ui/package.json packages/sdk/package.json packages/web/package.json packages/server/package.json packages/cli/package.json
  echo "  Reverted version bumps"
fi

echo ""
echo "🪸 Done!"
