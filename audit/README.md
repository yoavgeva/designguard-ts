# Audit

Runs designguard on open-source apps in Docker, to read its findings and measure what it costs. Each app lives in its
own volume, `dg-<app>`, and every container runs alone with a memory cap.

```sh
audit/build.sh                                  # build, pack and bake designguard into the dg-tsaudit image
audit/setup.sh                                  # clone and install Cal.com, openstatus, Immich and Vendure
audit/memory.sh calcom apps/web/app 12g web     # lint one directory without and with designguard
audit/whole.sh                                  # lint each app whole, findings in audit/out/whole-<app>.json
```

`memory.sh` prints, for each run, the files linted, findings, seconds, the heap's peak and what stays after a full GC.
It takes several directories in one quoted argument; an app too big for one 12 GB run lints in parts, each its own
process. `FORKS="typeorm=@n8n/typeorm"` points an adapter at a fork published under another name.

Some monorepos import their own packages from what those packages build, as Twenty's `twenty-shared` and n8n's
`@n8n/db` are: build those in the app's volume before linting, or their calls go unresolved.
Both runs have typescript-eslint's typed promise rules on, as a project that lints with types has, so the difference
is designguard's alone.
