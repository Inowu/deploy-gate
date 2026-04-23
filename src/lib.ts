import { Client } from 'pg';

const TABLE = '_app_deploy_markers';
const KEY = 'deploy_ready';

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

async function ensureTable(c: Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function markReady(cfg: GateConfig): Promise<void> {
  await withClient(cfg.databaseUrl, async (c) => {
    await ensureTable(c);
    await c.query(
      `INSERT INTO ${TABLE} (key, version) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE
         SET version = EXCLUDED.version,
             updated_at = now()`,
      [KEY, cfg.version],
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
      let current: string | null = null;
      try {
        const r = await c.query<{ version: string }>(
          `SELECT version FROM ${TABLE} WHERE key = $1`,
          [KEY],
        );
        current = r.rows[0]?.version ?? null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/does not exist/.test(msg)) throw e;
      }

      if (current === opts.version) return;

      opts.onPoll?.(current, opts.version, Date.now() - start);

      if (Date.now() >= deadline) {
        throw new Error(
          `deploy-gate timeout after ${opts.timeoutMs}ms ` +
            `(have='${current ?? ''}' want='${opts.version}')`,
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
