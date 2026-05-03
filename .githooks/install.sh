#!/usr/bin/env bash
# One-shot installer: point this clone's git hooks at `.githooks/`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit 2>/dev/null || true
echo "Installed: core.hooksPath = .githooks"
