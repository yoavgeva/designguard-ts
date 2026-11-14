#!/bin/sh
# Puts each audit app in its own Docker volume, dg-<name> at /work/app, and installs its dependencies with lifecycle
# scripts off, then generates Prisma clients, one container at a time. An app already there is left as it is. Run
# build.sh first.
#   audit/setup.sh [app...]   an app is a short name below, a GitHub owner/repo, or a local directory (copied)
#   (default: the four short names)
apps=${*:-calcom openstatus immich vendure}
for app in $apps; do
  case $app in
    calcom) source=calcom/cal.com ;;
    openstatus) source=openstatusHQ/openstatus ;;
    immich) source=immich-app/immich ;;
    vendure) source=vendure-ecommerce/vendure ;;
    *) source=$app ;;
  esac
  name=$(basename "$source" | tr 'A-Z.' 'a-z-')
  [ "$app" = "$source" ] || name=$app
  if [ -d "$source" ]; then mount="-v $(cd "$source" && pwd):/source:ro"; fetch='cp -R /source /work/app && rm -rf /work/app/node_modules'
  else mount=; fetch="git clone -q --depth 1 https://github.com/$source /work/app"; fi
  docker volume create "dg-$name" >/dev/null
  # shellcheck disable=SC2086
  docker run --rm --memory 4g --memory-swap 4g -v "dg-$name:/work" $mount dg-tsaudit sh -c "
    [ -d /work/app ] || $fetch
    cd /work/app && echo \"== $name \$(git rev-parse --short HEAD 2>/dev/null || echo local)\"
    if [ -f yarn.lock ]; then YARN_ENABLE_SCRIPTS=0 YARN_ENABLE_IMMUTABLE_INSTALLS=0 CI=1 corepack yarn install
    elif [ -f pnpm-lock.yaml ]; then export CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
      corepack pnpm install --ignore-scripts --frozen-lockfile || corepack pnpm install --ignore-scripts --no-frozen-lockfile
    else CI=1 npm install --ignore-scripts --no-audit --no-fund; fi 2>&1 | tail -2
    [ -d packages/common ] && [ -f packages/common/tsconfig.build.json ] && npx tsc -p packages/common/tsconfig.build.json
    find . -name schema.prisma -not -path '*/node_modules/*' | while read -r schema; do
      npx --no-install prisma generate --schema \"\$schema\" 2>&1 | tail -1
    done"
done
