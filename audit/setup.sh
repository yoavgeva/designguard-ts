#!/bin/sh
# Clones each audit app into its own Docker volume, dg-<app> at /work/app, and installs its dependencies with
# lifecycle scripts off, one container at a time. An app already cloned is left as it is. Run build.sh first.
#   audit/setup.sh [app...]   (default: all of them)
repo() {
  case $1 in
    calcom) echo calcom/cal.com ;;
    openstatus) echo openstatusHQ/openstatus ;;
    immich) echo immich-app/immich ;;
    vendure) echo vendure-ecommerce/vendure ;;
    *) return 1 ;;
  esac
}
install() {
  case $1 in
    calcom) echo 'YARN_ENABLE_SCRIPTS=0 YARN_ENABLE_IMMUTABLE_INSTALLS=0 CI=1 corepack yarn install' ;;
    vendure) echo 'CI=1 npm install --ignore-scripts --no-audit --no-fund && npx tsc -p packages/common/tsconfig.build.json' ;;
    *) echo 'CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --ignore-scripts --frozen-lockfile' ;;
  esac
}
for app in ${@:-calcom openstatus immich vendure}; do
  source=$(repo "$app") || { echo "unknown app $app"; continue; }
  docker volume create "dg-$app" >/dev/null
  docker run --rm --memory 4g --memory-swap 4g -v "dg-$app:/work" dg-tsaudit sh -c "
    [ -d /work/app ] || git clone -q --depth 1 https://github.com/$source /work/app
    cd /work/app && echo \"== $app \$(git rev-parse --short HEAD)\" && { $(install "$app"); } 2>&1 | tail -2"
done
