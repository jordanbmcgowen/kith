// Synthetic PostgreSQL transport adapter, never part of an application bundle.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require(process.env.KITH_LOCAL_PG_MODULE ?? '/workspace/kith-local/node_modules/pg/lib/index.js');
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5543'); assert.equal(url.pathname, '/kith_test');
const pool = new pg.Pool({ connectionString: url.href });
const { rows } = await pool.query("select count(*)::int as n from users where email not like '%@example.invalid'");
assert.equal(rows[0].n, 0, 'Dedicated database must contain synthetic users only');
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/sql') { res.writeHead(404).end(); return; }
  const client = await pool.connect();
  let transaction = false;
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const query = async q => {
      const r = await client.query({ text: q.query, values: q.params, rowMode: 'array', types: { getTypeParser: () => v => v } });
      return { fields: r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows, rowCount: r.rowCount, command: r.command, rowAsArray: true };
    };
    let result;
    if (input.queries) {
      await client.query('BEGIN'); transaction = true;
      result = []; for (const q of input.queries) result.push(await query(q));
      await client.query('COMMIT'); transaction = false;
    } else result = await query(input);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (err) {
    if (transaction) await client.query('ROLLBACK');
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: err.message, code: err.code }));
  } finally { client.release(); }
});
server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }));
process.on('SIGTERM', () => server.close(() => pool.end().then(() => process.exit(0))));
