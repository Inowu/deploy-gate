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
with the image version. `api` waits for the marker for **its own** version
before starting the application. Markers are stored one row per version, so
rollbacks are safe — an `api` from a previous version finds its own row,
which a newer cron deploy never overwrites.

## Storage

Markers live in a single table (auto-created by `mark`):

```sql
CREATE TABLE _deploy_gate_markers (
  version    TEXT PRIMARY KEY,
  marked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`mark` does an `INSERT ... ON CONFLICT (version) DO UPDATE SET marked_at = now()`
— idempotent for the same version, append-only across versions. `wait` checks
for the existence of its own version's row and returns the moment it appears.

The table grows by one row per unique deployed version. There is no automatic
pruning; if you deploy thousands of distinct versions and care about the row
count, prune externally with a one-liner cron job.

## Install

```bash
pnpm add github:Inowu/deploy-gate#v0.2.0
# or pin a specific commit
pnpm add github:Inowu/deploy-gate#<sha>
```

## Upgrading from v0.1

v0.1 stored a single overwriting row in `_app_deploy_markers` keyed on a
constant `'deploy_ready'` string. That schema had a critical pitfall: a newer
deploy's mark would overwrite an older deploy's marker, and any `api`
container running the older version would then wait forever for its own
marker (which had been overwritten) and time out — the rollback case the
README claimed to handle. v0.2 fixes this with the per-version row layout
above.

To upgrade:

1. Bump the dependency in `package.json` (`github:Inowu/deploy-gate#v0.2.0`).
2. Roll cron and api together in a single deploy. Cron writes the v0.2
   marker into the new table; api on v0.2 reads from the new table.
3. The legacy `_app_deploy_markers` table is left in place untouched. Drop
   it manually after you've confirmed the upgrade is stable:
   `DROP TABLE _app_deploy_markers;`

Old api containers running v0.1 during the rollout still read from the old
table — that path is unaffected by the upgrade. Mixing v0.1 and v0.2 across
the cron/api split (e.g. cron upgraded, api still on v0.1) breaks because
they read/write different tables; always upgrade them together.

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
