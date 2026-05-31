#!/usr/bin/env bash
#
# Regenerate the PyPI artifacts for gagent.
#
# This script rebuilds the TypeScript sources, bundles the CLI into a single
# self-contained JavaScript file with its sidecar assets, and produces the
# Python sdist + wheel that ship that bundle.
#
# Strategy: `pip install gagent` installs a thin Python launcher
# (python/gagent/__main__.py) plus the bundled JS (python/gagent/_bundle/).
# At runtime the launcher finds the user's Node.js (>=18) and execs the bundle.
#
# Usage:
#   bash scripts/build_pypi.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> [1/4] Installing npm deps (ignore native build scripts)"
npm install --ignore-scripts

echo "==> [2/4] Building TypeScript (-> dist/)"
npm run build

echo "==> [3/4] Bundling CLI with esbuild (-> python/gagent/_bundle/)"
mkdir -p python/gagent/_bundle
npx esbuild dist/cli.js \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=cjs \
  --outfile=python/gagent/_bundle/gagent.cli.js \
  --external:better-sqlite3

# tiktoken loads its WASM at runtime via fs.readFileSync(__dirname/...).
# Ship the WASM next to the bundle as package data so tokenization works.
cp node_modules/tiktoken/tiktoken_bg.wasm python/gagent/_bundle/tiktoken_bg.wasm

# Externals:
#   better-sqlite3 - native addon (needs a C++ toolchain); cannot be bundled.
#                    The CLI starts without it; persistence-backed commands
#                    degrade. It is loaded lazily via require().

# Output to dist-pypi/ to avoid colliding with the TypeScript dist/ output.
echo "==> [4/4] Building Python sdist + wheel (-> dist-pypi/)"
python -m build --outdir dist-pypi

echo "==> Validating artifacts"
python -m twine check dist-pypi/*

echo "Done. Artifacts in dist-pypi/."
