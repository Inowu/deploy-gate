# @inowu/deploy-gate

Coordinates Docker Swarm rolling deploys when one replica (`cron`) must finish
schema work before other replicas (`api`) start handling traffic.

## The problem

In our standard project shape, an `api` service has 2 replicas and a `cron`
service has 1 replica, all built from the same image. The `cron` replica owns
schema migrations and tenant-schema sync. With Swarm rolling updates, all
services come up in parallel, so a fresh `api` container can bind its HTTP
port and start serving requests before `cron` finishes syncing — leading to
errors when app code expects schema state that hasn't been applied yet.

`docker compose`'s `depends_on: condition: service_healthy` does **not**
work in Swarm — the field is silently ignored by `docker stack deploy`.

## The solution

`cron` runs migrations, then writes a "ready" marker into Postgres tagged
with the image version. `api` waits for the marker to match its own version
before starting the application. The marker is per-deploy (keyed by image
tag), so rollbacks are safe — an `api` from a previous version waits for
its own marker, not a future one.

## Install

```bash
pnpm add github:Inowu/deploy-gate#v0.1.0
# or pin a specific commit
pnpm add github:Inowu/deploy-gate#<sha>
```

## Use from your entrypoint

```sh
#!/bin/sh
set -e

if [ "${ENABLE_CRONS:-true}" != "false" ]; then
  # cron role
  ./node_modules/.bin/prisma migrate deploy
  node src/scripts/sync-tenant-schemas.js
  npx deploy-gate mark
else
  # api role
  npx deploy-gate wait
fi

exec node dist/main.js
```

## Required environment

Both `mark` and `wait` need:

| Var | Notes |
|---|---|
| `IMAGE_TAG` (or `DEPLOY_GATE_VERSION`) | The version string used as the marker key. In Dokploy projects, add `IMAGE_TAG: ${IMAGE_TAG}` to your compose `environment:` block — the tag is interpolated into `image:` by default but is **not** propagated to the container env. |
| `DB_TENANT_URL` (or `DEPLOY_GATE_DATABASE_URL`, or `DATABASE_URL`) | Postgres connection string. |

`wait` also accepts:

| Var | Default | Notes |
|---|---|---|
| `DEPLOY_GATE_TIMEOUT_MS` | dynamic (see below) | Override the auto-computed timeout. |

### Dynamic timeout

If `DEPLOY_GATE_TIMEOUT_MS` is unset, `wait` queries the live tenant count
and computes:

```
timeout = 2 min base + (tenant_count × 3 min)
```

with a 4-hour ceiling. Tenant count = number of non-system Postgres
schemas (matches the convention used by our `sync-tenant-schemas` script).

## Compose changes (for adopting projects)

```yaml
x-app-environment: &app-environment
  IMAGE_TAG: ${IMAGE_TAG}              # required by deploy-gate

services:
  api:
    healthcheck:
      start_period: 10000s             # must exceed worst-case wait time
```

Set `start_period` generously: when `wait` is in progress, the api hasn't
bound its port yet, so the healthcheck fails. With `interval: 30s,
retries: 3`, Swarm kills the task at `start_period + 90s` if it's still
failing. Use a value larger than `2min + (max_tenant_count × 3min)`.
After the wait succeeds and the app binds its port, healthcheck passes
immediately and `start_period` no longer matters for that container.

## Programmatic API

```ts
import { markReady, waitForReady, getTenantCount, computeTimeoutMs }
  from '@inowu/deploy-gate';

// from your migrate script:
await markReady({
  databaseUrl: process.env.DB_TENANT_URL!,
  version: process.env.IMAGE_TAG!,
});

// from your bootstrap (before app.listen):
const tenantCount = await getTenantCount(process.env.DB_TENANT_URL!);
await waitForReady({
  databaseUrl: process.env.DB_TENANT_URL!,
  version: process.env.IMAGE_TAG!,
  timeoutMs: computeTimeoutMs({ tenantCount }),
  onPoll: (cur, exp, ms) => console.log(`waiting ${ms}ms: ${cur} → ${exp}`),
});
```

## What it does NOT solve

- **Destructive migrations during a rolling deploy.** `stop-first` parallelism
  means an old api replica can still be serving while cron is mid-migration.
  If the migration drops/renames columns the old code uses, that replica
  errors. The fix is the expand-contract pattern (split breaking changes
  across 2–3 deploys); deploy-gate doesn't help here.
- **Coordinating across stacks.** Single-stack only.

## Marker schema

Stored in `_app_deploy_markers`, created on first `mark` if missing:

```sql
CREATE TABLE _app_deploy_markers (
  key        TEXT PRIMARY KEY,        -- always 'deploy_ready' currently
  version    TEXT NOT NULL,           -- image tag from $IMAGE_TAG
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Underscore prefix keeps it out of `prisma db pull` and similar
introspection. If you use Prisma, the table will be flagged as drift on
`prisma migrate dev` — `prisma migrate diff --shadow-database-url` ignores
it as long as you don't add it to `schema.prisma`.
