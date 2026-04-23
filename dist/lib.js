"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.markReady = markReady;
exports.waitForReady = waitForReady;
exports.getTenantCount = getTenantCount;
exports.computeTimeoutMs = computeTimeoutMs;
const pg_1 = require("pg");
const TABLE = '_app_deploy_markers';
const KEY = 'deploy_ready';
async function withClient(databaseUrl, fn) {
    const c = new pg_1.Client({ connectionString: databaseUrl });
    await c.connect();
    try {
        return await fn(c);
    }
    finally {
        await c.end();
    }
}
async function ensureTable(c) {
    await c.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
async function markReady(cfg) {
    await withClient(cfg.databaseUrl, async (c) => {
        await ensureTable(c);
        await c.query(`INSERT INTO ${TABLE} (key, version) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE
         SET version = EXCLUDED.version,
             updated_at = now()`, [KEY, cfg.version]);
    });
}
async function waitForReady(opts) {
    const pollMs = opts.pollMs ?? 2000;
    const start = Date.now();
    const deadline = start + opts.timeoutMs;
    await withClient(opts.databaseUrl, async (c) => {
        while (true) {
            let current = null;
            try {
                const r = await c.query(`SELECT version FROM ${TABLE} WHERE key = $1`, [KEY]);
                current = r.rows[0]?.version ?? null;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (!/does not exist/.test(msg))
                    throw e;
            }
            if (current === opts.version)
                return;
            opts.onPoll?.(current, opts.version, Date.now() - start);
            if (Date.now() >= deadline) {
                throw new Error(`deploy-gate timeout after ${opts.timeoutMs}ms ` +
                    `(have='${current ?? ''}' want='${opts.version}')`);
            }
            await new Promise((r) => setTimeout(r, pollMs));
        }
    });
}
async function getTenantCount(databaseUrl) {
    return withClient(databaseUrl, async (c) => {
        const r = await c.query(`
      SELECT count(*)::int AS n
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('public', 'information_schema')
        AND schema_name NOT LIKE 'pg_%'
    `);
        return r.rows[0]?.n ?? 0;
    });
}
function computeTimeoutMs(opts) {
    const perTenant = opts.perTenantMs ?? 180_000;
    const base = opts.baseMs ?? 120_000;
    const ceiling = opts.ceilingMs ?? 4 * 60 * 60 * 1000;
    return Math.min(ceiling, base + opts.tenantCount * perTenant);
}
//# sourceMappingURL=lib.js.map