// The runner's side (Authorization: Bearer RUNNER_SECRET).
// GET  /api/runner?id=   claim a queued test → { id, mint, site, name, symbol }
// POST /api/runner       { id, verdict, … } report the result, or { id, error }
import { route, send, readRaw, query, HttpError, env } from './_lib/util.js';
import { store } from './_lib/store.js';
import { cleanSite } from './_lib/coin.js';

const VERDICTS = ['WORKS', 'NOTHING WORKS', 'SITE DOWN'];
const cid = (s) => (typeof s === 'string' && /^[a-zA-Z0-9]{40,80}$/.test(s) ? s : null);

export default route(['GET', 'POST'], async (req, res) => {
  const secret = env('RUNNER_SECRET');
  if (!secret) throw new HttpError(503, 'not configured', { missing: ['RUNNER_SECRET'] });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) throw new HttpError(401, 'unauthorized');
  const db = store();
  if (!db) throw new HttpError(503, 'not configured', { missing: ['DATABASE_URL'] });
  if (req.method === 'GET') {
    const q = query(req);
    const t = await db.start(Number(q.id), typeof q.run === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(q.run) ? q.run : null);
    if (!t) throw new HttpError(409, 'not queued');
    if (!cleanSite(t.site)) { await db.fail(t.id, 'bad site'); throw new HttpError(409, 'bad site'); }
    return send(res, 200, { id: t.id, mint: t.mint, site: t.site, name: t.name, symbol: t.symbol });
  }
  let b; try { b = typeof req.body === 'object' && req.body ? req.body : JSON.parse((await readRaw(req, 512 * 1024)).toString('utf8')); } catch { throw new HttpError(400, 'bad json'); }
  const id = Number(b.id);
  if (b.error) { await db.fail(id, b.error); return send(res, 200, { ok: true }); }
  if (!VERDICTS.includes(b.verdict)) throw new HttpError(400, 'bad verdict');
  const t = await db.finish(id, {
    verdict: b.verdict, overruled: !!b.overruled, summary: String(b.summary || '').slice(0, 300),
    findings: (Array.isArray(b.findings) ? b.findings : []).slice(0, 4).map((x) => String(x).slice(0, 160)),
    lines: (Array.isArray(b.lines) ? b.lines : []).slice(0, 8).map((x) => String(x).slice(0, 200)),
    steps: (Array.isArray(b.steps) ? b.steps : []).slice(0, 20).map((s) => ({ n: Number(s.n) || 0, action: String(s.action || '').slice(0, 12), target: s.target ? String(s.target).slice(0, 90) : null, typed: s.typed ? String(s.typed).slice(0, 60) : undefined, note: String(s.note || '').slice(0, 200), dead: !!(s.action === 'click' && s.effect && !s.effect.domChanged && !s.effect.navigated && !s.effect.requests && !s.effect.popup && !s.effect.wallet), left: s.effect?.left || (s.effect?.popup ? 'another site' : null), wallet: !!s.effect?.wallet })),
    evidence: b.evidence && typeof b.evidence === 'object' ? b.evidence : {}, video: cid(b.video), poster: cid(b.poster), model: String(b.model || '').slice(0, 80), ms: Number(b.ms) || null,
  });
  if (!t) throw new HttpError(409, 'not open');
  send(res, 200, { ok: true });
});
