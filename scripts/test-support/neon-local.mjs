// Test transport only. No production WebSocket traffic or model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { neonConfig } from '../../node_modules/@neondatabase/serverless/index.mjs';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '5543');
assert.equal(url.pathname, '/kith_test');
const require = createRequire(import.meta.url);
const pg = require(process.env.KITH_LOCAL_PG_MODULE ?? '/workspace/kith-local/node_modules/pg/lib/index.js');
neonConfig.fetchEndpoint = () => 'http://127.0.0.1:5544/sql';
export * from '../../node_modules/@neondatabase/serverless/index.mjs';
export const Pool = pg.Pool;
