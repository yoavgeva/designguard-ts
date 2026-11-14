# The audit image: ESLint, typescript-eslint and TypeScript in /tools, with designguard's packed packages.
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends time git ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /tools
COPY pkgs/ /tools/pkgs/
RUN npm init -y >/dev/null && npm install --no-audit --no-fund eslint@10 typescript-eslint@8 typescript@5.9 /tools/pkgs/*.tgz
