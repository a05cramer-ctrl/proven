// POST /api/test { mint }                       ask for a test (one per coin per 24 h; returns the current one if there is one)
// POST /api/test { mint, wallet, signature, ts } a holder of 1,000,000 $PROVEN re-tests now, outside the cap
// GET  /api/test?id=  |  ?mint=                 the test and its result
import { route, send, readJson, query, HttpError, isPubkey, env, nowS, DAILY_CAP_DEFAULT } from './_lib/util.js';
import { store } from './_lib/store.js';
import { lookup, holderOk, dispatch } from './_lib/coin.js';

export const view = (t) => (t ? { id: t.id, mint: t.mint, name: t.name, symbol: t.symbol, icon: t.icon, site: t.site, status: t.status, verdict: t.verdict, overruled: t.overruled, summary: t.summary, findings: t.findings || [], lines: t.lines || [], steps: t.steps || [], video: t.video, poster: t.poster, run_url: t.run_url, model: t.model, error: t.status === 'failed' ? t.error : null, ms: t.ms, created_at: t.created_at, finished_at: t.finished_at } : null);

export default route(['GET', 'POST'], async (req, res) => {
  const db = store();
  if (!db) throw new HttpError(503, 'not configured', { missing: ['DATABASE_URL'] });
  await db.sweep();
  if (req.method === 'GET') {
    const q = query(req);
    const t = q.id ? await db.get(Number(q.id)) : isPubkey(q.mint) ? (await db.current(q.mint)) || (await db.latestDone(q.mint)) : null;
    if (!t) throw new HttpError(404, 'no test for that yet');
    return send(res, 200, { test: view(t) });
  }
  const b = await readJson(req);
  const mint = String(b.mint || '').trim();
  if (!isPubkey(mint)) throw new HttpError(400, "Paste the coin's contract address.");
  const holder = b.signature ? await holderOk({ wallet: b.wallet, signature: b.signature, ts: b.ts, mint }, nowS()) : false;
  if (b.signature && !holder) throw new HttpError(403, 'That wallet does not hold 1,000,000 $PROVEN.');
  const cur = await db.current(mint);
  if (cur && (cur.status !== 'done' || !holder)) return send(res, 200, { test: view(cur), cached: true });
  const coin = await lookup(mint);
  if (!coin.found) throw new HttpError(404, "Can't find that coin.");
  if (!coin.site) throw new HttpError(422, `${coin.symbol ? '$' + coin.symbol : 'This coin'} lists no website of its own, so there is no product to test.`, { coin: { name: coin.name, symbol: coin.symbol, icon: coin.icon } });
  const cap = Number(env('PROVEN_DAILY_CAP', String(DAILY_CAP_DEFAULT)));
  if (!holder && await db.countToday() >= cap) throw new HttpError(429, `Today's ${cap} free tests are used. Holders of 1,000,000 $PROVEN can still test.`);
  const t = await db.add({ mint, ...coin, holder });
  const started = await dispatch(t.id);
  send(res, 200, { test: view(t), started });
});
