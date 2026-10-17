/** No .env loading or remote connections. Requires the dedicated migrated DB. */
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5543'); assert.equal(url.pathname, '/kith_test');
const output = await mkdtemp(join(tmpdir(), 'kith-reliability-'));
const bridge = fork(join(root, 'scripts/test-support/local-sql-bridge.mjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
try {
  const port = await new Promise((resolve, reject) => {
    bridge.once('message', message => resolve(message.port));
    bridge.once('exit', code => reject(new Error(`Synthetic bridge exited: ${code}`)));
  });
  const env = { ...process.env, KITH_LOCAL_SQL_ENDPOINT: `http://127.0.0.1:${port}/sql` };
  assert.equal(spawnSync(process.execPath, [join(root, "scripts/test-support/migration-check.mjs")], { cwd: root, env, stdio: "inherit" }).status, 0, "Synthetic migration check");
  for (const script of ['filing-reliability-check', 'capture-job-check', 'capture-route-check', 'pipeline-check']) {
    const target = join(output, `${script}.mjs`);
    const args = [`scripts/${script}.ts`, '--bundle', '--platform=node', '--format=esm',
      '--alias:@neondatabase/serverless=./scripts/test-support/neon-local.mjs', `--outfile=${target}`, '--log-level=warning'];
    if (script === 'capture-route-check') args.push('--alias:@/lib/auth=./scripts/test-support/auth-local.ts',
      '--alias:@opennextjs/cloudflare=./scripts/test-support/cloudflare-local.ts',
      `--alias:next/server=${root}/node_modules/next/server.js`, `--external:${root}/node_modules/next/server.js`);
    assert.equal(spawnSync(join(root, 'node_modules/.bin/esbuild'), args, { cwd: root, env, stdio: 'inherit' }).status, 0, `Bundle ${script}`);
    assert.equal(spawnSync(process.execPath, [target], { cwd: root, env, stdio: 'inherit' }).status, 0, script);
  }
} finally {
  bridge.kill('SIGTERM');
  await new Promise(resolve => { if (bridge.exitCode !== null) resolve(); else bridge.once('exit', resolve); });
  await rm(output, { recursive: true, force: true });
}
