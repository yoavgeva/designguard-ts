#!/bin/sh
# Builds designguard, packs its packages and builds the audit image with them.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" && pnpm build >/dev/null
rm -rf audit/pkgs && mkdir audit/pkgs
for package in packages/core packages/eslint-plugin packages/adapters/*; do (cd "$package" && pnpm pack --pack-destination "$root/audit/pkgs" >/dev/null); done
docker build -q -t dg-tsaudit audit
