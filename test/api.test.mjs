// The API against a real Postgres (PGlite), DexScreener stubbed at fetch, and a real test run writing its progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { chromium } from 'playwright';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { pgStore, setStore } from '../api/_lib/store.js';
import { cleanSite, retestMessage, runKey } from '../api/_lib/coin.js';
import { runTest, publicStep } from '../runner/agent.js';
import { serveSites, scriptedModel } from './fixtures/sites.mjs';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; const NOSITE = 'So11111111111111111111111111111111111111112'; const PM = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.PROVEN_DAILY_CAP = '2'; process.env.PROVEN_MINT = PM; process.env.RPC_URL = 'https://rpc.test'; process.env.DATABASE_URL = 'postgres://test';
const pg = new PGlite(); const db = pgStore({ query: (t, p) => pg.query(t, p) }); setStore(db);
const world = { runs: [], holderUi: 0 };
const realFetch = globalThis.fetch;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  if (url === 'https://proven.test/api/run') { world.runs.push({ id: JSON.parse(init.body).id, key: init.headers['x-proven-key'] }); return J({ ok: true }); }
  if (url.includes('api.dexscreener.com')) { const m = url.split('/').pop(); return J(m === MINT ? [{ baseToken: { address: MINT, name: 'Swapr', symbol: 'SWAPR' }, info: { imageUrl: 'https://img.test/a.png', websites: [{ url: 'https://x.com/swapr' }, { url: 'https://swapr.example/' }] } }] : m === NOSITE ? [{ baseToken: { address: NOSITE, name: 'Nosite', symbol: 'NO' }, info: { websites: [{ url: 'https://t.me/x' }] } }] : []); }
  if (url.includes('lite-api.jup.ag')) return J([]);
  if (url.startsWith('https://rpc.test')) return J({ result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: String(world.holderUi) } } } } } }] } });
  throw new Error('unstubbed ' + url);
};
async function call(mod, { method = 'GET', url = '/', body = null, headers = {} } = {}) {
  const handler = (await import(`../api/${mod}.js`)).default;
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await handler({ method, url, headers: { host: 'proven.test', ...headers }, body }, res);
  let json = null; try { json = JSON.parse(res.body); } catch { /* binary */ }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

test('cleanSite: only a coin\'s own https site', () => {
  assert.equal(cleanSite('https://swapr.example/app#x'), 'https://swapr.example/app');
  for (const u of ['http://swapr.example', 'https://x.com/a', 'https://t.me/a', 'https://pump.fun/coin/x', 'https://127.0.0.1/', 'https://localhost/', 'javascript:alert(1)', 'nope']) assert.equal(cleanSite(u), null, u);
});
test('ask for a test → queued and the run is kicked off with the server key; asking again returns the same test', async () => {
  assert.equal((await call('test', { method: 'POST', body: { mint: 'x' } })).status, 400);
  assert.equal((await call('test', { method: 'POST', body: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' } })).status, 404);
  const no = await call('test', { method: 'POST', body: { mint: NOSITE } });
  assert.equal(no.status, 422); assert.match(no.json.error, /\$NO lists no website/);
  const a = await call('test', { method: 'POST', body: { mint: MINT } });
  assert.equal(a.status, 200); assert.equal(a.json.test.status, 'queued'); assert.equal(a.json.test.site, 'https://swapr.example/');
  assert.deepEqual(world.runs, [{ id: 1, key: runKey() }]);
  const b = await call('test', { method: 'POST', body: { mint: MINT } });
  assert.equal(b.json.cached, true); assert.equal(b.json.test.id, 1); assert.equal(world.runs.length, 1);
});
test('/api/run refuses anyone without the server key', async () => {
  assert.equal((await call('run', { method: 'POST', body: { id: 1 } })).status, 401);
  assert.equal((await call('run', { method: 'POST', body: { id: 1 }, headers: { 'x-proven-key': 'nope' } })).status, 401);
});
test('a real run writes steps and screens as it goes; the public result has the verdict, the steps and the frames', async () => {
  const t = await db.start(1); assert.equal(t.status, 'running'); assert.equal(await db.start(1), null);
  const sites = await serveSites(); const browser = await chromium.launch();
  let n = 0; let seenLive = null;
  const r = await runTest(browser, { url: sites.working, model: scriptedModel(), maxSteps: 10, frames: true, onStep: async (_s, jpg, steps) => { await db.progress(1, steps.map(publicStep), n, jpg); if (jpg) n++; if (n === 3) seenLive = (await call('test', { url: '/api/test?id=1' })).json.test; } });
  await browser.close(); sites.close();
  assert.equal(seenLive.status, 'running'); assert.equal(seenLive.frames, 3); assert.equal(seenLive.steps.length, 2);
  await db.finish(1, { verdict: r.verdict, summary: r.summary, findings: r.findings, lines: r.lines, steps: r.steps, evidence: r.evidence, model: 'm', ms: r.ms });
  assert.equal(await db.finish(1, { verdict: 'NOTHING WORKS' }), null, 'a result cannot be rewritten');
  const done = (await call('test', { url: '/api/test?mint=' + MINT })).json.test;
  assert.equal(done.status, 'done'); assert.equal(done.verdict, 'WORKS'); assert.ok(done.frames >= 5);
  assert.ok(done.steps.some((s) => s.target === 'button "Swap"' && s.wallet)); assert.ok(done.lines.length >= 4);
  const f = await call('frame', { url: '/api/frame?id=1&n=0' });
  assert.equal(f.status, 200); assert.equal(f.headers['content-type'], 'image/jpeg'); assert.equal(f.raw[0], 0xff); assert.equal(f.raw[1], 0xd8);
  assert.equal((await call('frame', { url: '/api/frame?id=1&n=99' })).status, 404);
});
test('a tested coin is served from cache for 24 h; a holder signature forces a fresh test', async () => {
  const c = await call('test', { method: 'POST', body: { mint: MINT } });
  assert.equal(c.json.cached, true); assert.equal(c.json.test.verdict, 'WORKS');
  const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey); const ts = Math.floor(Date.now() / 1000);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(retestMessage(MINT, ts)), kp.secretKey));
  world.holderUi = 999_999;
  assert.equal((await call('test', { method: 'POST', body: { mint: MINT, wallet, signature, ts } })).status, 403);
  world.holderUi = 1_000_000;
  assert.equal((await call('test', { method: 'POST', body: { mint: MINT, wallet, signature: bs58.encode(new Uint8Array(64)), ts } })).status, 403);
  const h = await call('test', { method: 'POST', body: { mint: MINT, wallet, signature, ts } });
  assert.equal(h.status, 200); assert.equal(h.json.test.id, 2); assert.equal(h.json.test.status, 'queued');
});
test('the daily cap stops free tests; a failed run closes a test; the feed adds up', async () => {
  await pg.query(`INSERT INTO tests (mint, site, status, rules) VALUES ('a','https://a.example/','done', 4)`);
  const capped = await call('test', { method: 'POST', body: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' } });
  assert.ok([404, 429].includes(capped.status));
  await db.start(2); await db.fail(2, 'boom');
  assert.equal((await call('test', { url: '/api/test?id=2' })).json.test.status, 'failed');
  const f = await call('feed');
  assert.equal(f.json.open, true); assert.deepEqual(f.json.missing, []); assert.equal(f.json.totals.works, 1); assert.equal(f.json.daily_cap, 2);
});
test('a test that never reports back is closed', async () => {
  await pg.query(`INSERT INTO tests (mint, site, status, created_at) VALUES ('z','https://z.example/','running', now() - interval '20 minutes')`);
  await db.sweep();
  assert.equal((await pg.query(`SELECT status FROM tests WHERE mint='z'`)).rows[0].status, 'failed');
});
