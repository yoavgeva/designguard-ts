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
Both runs have typescript-eslint's typed promise rules on, as a project that lints with types has, so the difference
is designguard's alone.
