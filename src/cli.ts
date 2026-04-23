#!/usr/bin/env node
import {
  computeTimeoutMs,
  getTenantCount,
  markReady,
  waitForReady,
} from './lib.js';

function bail(msg: string, code = 1): never {
  console.error(`[deploy-gate] ${msg}`);
  process.exit(code);
}

const databaseUrl =
  process.env.DEPLOY_GATE_DATABASE_URL ||
  process.env.DB_TENANT_URL ||
  process.env.DATABASE_URL;

const version = process.env.IMAGE_TAG || process.env.DEPLOY_GATE_VERSION;

const cmd = process.argv[2];

if (!cmd || !['mark', 'wait'].includes(cmd)) {
  bail('usage: deploy-gate (mark|wait)', 2);
}
if (!databaseUrl) {
  bail(
    'missing DATABASE_URL (set DEPLOY_GATE_DATABASE_URL, DB_TENANT_URL, or DATABASE_URL)',
  );
}
if (!version) {
  bail('missing version (set IMAGE_TAG or DEPLOY_GATE_VERSION)');
}

(async () => {
  if (cmd === 'mark') {
    await markReady({ databaseUrl, version });
    console.log(`[deploy-gate] marked ready version=${version}`);
    return;
  }

  // cmd === 'wait'
  let timeoutMs = parseInt(process.env.DEPLOY_GATE_TIMEOUT_MS || '0', 10);
  if (!timeoutMs) {
    const n = await getTenantCount(databaseUrl);
    timeoutMs = computeTimeoutMs({ tenantCount: n });
    console.log(
      `[deploy-gate] dynamic timeout: ${n} tenants × 3min + 2min base = ` +
        `${(timeoutMs / 60_000).toFixed(1)}min`,
    );
  } else {
    console.log(`[deploy-gate] timeout from env: ${(timeoutMs / 60_000).toFixed(1)}min`);
  }

  await waitForReady({
    databaseUrl,
    version,
    timeoutMs,
    onPoll: (cur, exp, elapsed) =>
      console.log(
        `[deploy-gate] waiting ${(elapsed / 1000).toFixed(0)}s ` +
          `(timeout ${(timeoutMs / 1000).toFixed(0)}s): ` +
          `have='${cur ?? ''}' want='${exp}'`,
      ),
  });
  console.log(`[deploy-gate] ready version=${version}`);
})().catch((err: Error) => bail(err.message));
