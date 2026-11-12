// GET /api/feed — the public wall: totals, the latest verdicts, and what is still missing before tests can run.
import { route, send, env, isPubkey, memo, HOLDER_TIER, CACHE_HOURS, DAILY_CAP_DEFAULT } from './_lib/util.js';
import { store } from './_lib/store.js';
import { MINT } from './_lib/coin.js';

const cache = memo(6000);
export default route(['GET'], async (_req, res) => {
  const missing = [];
  if (!store()) missing.push('DATABASE_URL');
  const cap = Number(env('PROVEN_DAILY_CAP', String(DAILY_CAP_DEFAULT)));
  const base = { open: missing.length === 0, missing, mint: isPubkey(env('PROVEN_MINT', MINT)) ? env('PROVEN_MINT', MINT) : null, repo: env('GH_REPO') || 'a05cramer-ctrl/proven', holder_tier: HOLDER_TIER, cache_hours: CACHE_HOURS, daily_cap: cap };
  const db = store();
  if (!db) return send(res, 200, { ...base, totals: { tests: 0, works: 0, nothing: 0, down: 0, in_flight: 0, coins: 0 }, today: 0, recent: [] });
  const d = await cache(async () => { await db.sweep(); const [totals, recent, today] = await Promise.all([db.totals(), db.recent(24), db.countToday()]); return { totals, recent, today }; });
  send(res, 200, { ...base, totals: d.totals, today: d.today, recent: d.recent });
});
