import { Client } from 'pg';

const TABLE = '_deploy_gate_markers';
// Legacy v0.1 table name. Older deployments wrote a single overwriting row to
// this table. v0.2 uses a per-version row in a NEW table — see migration note
// below in ensureTable().
const LEGACY_TABLE = '_app_deploy_markers';

export interface GateConfig {
  databaseUrl: string;
  version: string;
}

async function withClient<T>(
  databaseUrl: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Schema (v0.2):
 *
 *   _deploy_gate_markers (
 *     version TEXT PRIMARY KEY,
 *     marked_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *   )
 *
 * One row per deployed version. `mark` inserts (or refreshes `marked_at` if
 * the same version is re-marked). `wait` checks for the existence of the
 * caller's own version row — older deploys waiting for their own version
 * keep working forever, which is what makes rollbacks safe.
 *
 * Migration from v0.1 (`_app_deploy_markers`, single-row, overwriting):
 * we DO NOT touch the legacy table. A v0.1 → v0.2 upgrade leaves the old
 * table behind unread; the first `mark` after upgrade writes the new row
 * into the new table. Old api containers still running v0.1 read from the
 * old table during the rollout; new api containers on v0.2 read from the
 * new table. This means a project upgrading deploy-gate must roll cron and
 * api in lockstep (cron writes the v0.2 marker first; new api waits on it),
 * which Dokploy already does.
 */
async function ensureTable(c: Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      version TEXT PRIMARY KEY,
      marked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function markReady(cfg: GateConfig): Promise<void> {
  await withClient(cfg.databaseUrl, async (c) => {
    await ensureTable(c);
    await c.query(
      `INSERT INTO ${TABLE} (version) VALUES ($1)
       ON CONFLICT (version) DO UPDATE SET marked_at = now()`,
      [cfg.version],
    );
  });
}

export interface WaitOptions extends GateConfig {
  timeoutMs: number;
  pollMs?: number;
  onPoll?: (current: string | null, expected: string, elapsedMs: number) => void;
}

export async function waitForReady(opts: WaitOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 2000;
  const start = Date.now();
  const deadline = start + opts.timeoutMs;

  await withClient(opts.databaseUrl, async (c) => {
    while (true) {
      let found = false;
      let lastSeenVersion: string | null = null;

      try {
        const r = await c.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${TABLE} WHERE version = $1) AS exists`,
          [opts.version],
        );
        found = r.rows[0]?.exists === true;
      } catch (e) {
        // Table doesn't exist yet (cron has never run with v0.2). Keep polling.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/does not exist/.test(msg)) throw e;
      }

      if (found) return;

      // For onPoll diagnostics: surface the most recent marker so logs say
      // "have='X' want='Y'" — informative when the cron-cadefi pinning
      // (different image than api) drifts from what api expects.
      if (opts.onPoll) {
        try {
          const latest = await c.query<{ version: string }>(
            `SELECT version FROM ${TABLE} ORDER BY marked_at DESC LIMIT 1`,
          );
          lastSeenVersion = latest.rows[0]?.version ?? null;
        } catch {
          // ignore — informational only
        }
        opts.onPoll(lastSeenVersion, opts.version, Date.now() - start);
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `deploy-gate timeout after ${opts.timeoutMs}ms ` +
            `(latest_marker='${lastSeenVersion ?? ''}' want='${opts.version}'). ` +
            `If you see a NEWER marker than your own version, your service ` +
            `image is older than what cron last marked — make sure cron and ` +
            `api are pinned to the same IMAGE_TAG.`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  });
}

export async function getTenantCount(databaseUrl: string): Promise<number> {
  return withClient(databaseUrl, async (c) => {
    const r = await c.query<{ n: number }>(`
      SELECT count(*)::int AS n
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('public', 'information_schema')
        AND schema_name NOT LIKE 'pg_%'
    `);
    return r.rows[0]?.n ?? 0;
  });
}

export interface ComputeTimeoutOptions {
  tenantCount: number;
  perTenantMs?: number;
  baseMs?: number;
  ceilingMs?: number;
}

export function computeTimeoutMs(opts: ComputeTimeoutOptions): number {
  const perTenant = opts.perTenantMs ?? 180_000;
  const base = opts.baseMs ?? 120_000;
  const ceiling = opts.ceilingMs ?? 4 * 60 * 60 * 1000;
  return Math.min(ceiling, base + opts.tenantCount * perTenant);
}

export { LEGACY_TABLE, TABLE };
