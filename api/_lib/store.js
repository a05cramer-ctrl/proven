// Postgres (Neon) store for tests. `driver` = anything with query(text, params) → rows (Neon, or PGlite in tests).
import { env, CACHE_HOURS, STALE_MINUTES } from './util.js';

/** Bumped when the robot's rules change: verdicts made under older rules leave the wall and the cache. */
export const RULES = 4;

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tests (id BIGSERIAL PRIMARY KEY, mint TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL DEFAULT '', icon TEXT, site TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', verdict TEXT, overruled BOOLEAN NOT NULL DEFAULT false, summary TEXT, findings JSONB, lines JSONB, steps JSONB, evidence JSONB, video TEXT, poster TEXT, run_url TEXT, model TEXT, holder BOOLEAN NOT NULL DEFAULT false, error TEXT, ms INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)`,
  `ALTER TABLE tests ADD COLUMN IF NOT EXISTS frames INT NOT NULL DEFAULT 0`,
  `ALTER TABLE tests ADD COLUMN IF NOT EXISTS rules INT NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS frames (test_id BIGINT NOT NULL, n INT NOT NULL, jpg TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (test_id, n))`,
  `CREATE INDEX IF NOT EXISTS tests_mint ON tests (mint, id DESC)`,
  `CREATE INDEX IF NOT EXISTS tests_done ON tests (status, id DESC)`,
];
const iso = (d) => (d == null ? null : new Date(d).toISOString());
const fix = (r) => (r ? { ...r, id: Number(r.id), created_at: iso(r.created_at), started_at: iso(r.started_at), finished_at: iso(r.finished_at) } : null);
const J = (v) => (v == null ? null : JSON.stringify(v));

export function pgStore(driver) {
  let ready = null;
  const q = async (text, params = []) => {
    if (!ready) ready = (async () => { for (const s of SCHEMA) await driver.query(s); })();
    await ready;
    const r = await driver.query(text, params);
    return Array.isArray(r) ? r : r.rows;
  };
  return {
    /** Tests that never reported back are closed as failed, so a coin is not stuck "running" forever. */
    async sweep() { await q(`UPDATE tests SET status = 'failed', error = 'the test did not report back', finished_at = now() WHERE status IN ('queued','running') AND created_at < now() - ($1 || ' minutes')::interval`, [String(STALE_MINUTES)]); },
    async add(t) { return fix((await q('INSERT INTO tests (mint, name, symbol, icon, site, holder, rules) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [t.mint, t.name || '', t.symbol || '', t.icon || null, t.site, !!t.holder, RULES]))[0]); },
    async get(id) { return fix((await q('SELECT * FROM tests WHERE id = $1', [id]))[0]); },
    /** The test that answers "was this coin tested today?": anything in flight, else the newest finished one inside the cache window. */
    async current(mint) { return fix((await q(`SELECT * FROM tests WHERE mint = $1 AND rules = $3 AND (status IN ('queued','running') OR (status = 'done' AND finished_at > now() - ($2 || ' hours')::interval)) ORDER BY id DESC LIMIT 1`, [mint, String(CACHE_HOURS), RULES]))[0]); },
    async latestDone(mint) { return fix((await q(`SELECT * FROM tests WHERE mint = $1 AND status = 'done' AND rules = $2 ORDER BY id DESC LIMIT 1`, [mint, RULES]))[0]); },
    async countToday() { return Number((await q(`SELECT count(*)::int AS n FROM tests WHERE created_at > date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' AND holder = false`))[0].n); },
    /** queued → running, once. */
    /** While a test runs: the steps so far and one more screen. The site reads these live. */
    async progress(id, steps, n, jpg) {
      if (jpg) await q('INSERT INTO frames (test_id, n, jpg) VALUES ($1,$2,$3) ON CONFLICT (test_id, n) DO UPDATE SET jpg = EXCLUDED.jpg', [id, n, jpg]);
      await q(`UPDATE tests SET steps = $2::jsonb, frames = GREATEST(frames, $3) WHERE id = $1 AND status = 'running'`, [id, J(steps), jpg ? n + 1 : 0]);
    },
    async frame(id, n) { return (await q('SELECT jpg FROM frames WHERE test_id = $1 AND n = $2', [id, n]))[0]?.jpg || null; },
    /** Screens are kept for 14 days; the verdict and the step log stay. */
    async prune() { await q(`DELETE FROM frames WHERE created_at < now() - interval '14 days'`); },
    async start(id, run_url) { return fix((await q(`UPDATE tests SET status = 'running', started_at = now(), run_url = COALESCE($2, run_url) WHERE id = $1 AND status = 'queued' RETURNING *`, [id, run_url || null]))[0]); },
    async finish(id, r) {
      return fix((await q(`UPDATE tests SET status = 'done', verdict = $2, overruled = $3, summary = $4, findings = $5::jsonb, lines = $6::jsonb, steps = $7::jsonb, evidence = $8::jsonb, video = $9, poster = $10, model = $11, ms = $12, run_url = COALESCE($13, run_url), finished_at = now() WHERE id = $1 AND status IN ('queued','running') RETURNING *`,
        [id, r.verdict, !!r.overruled, r.summary || '', J(r.findings || []), J(r.lines || []), J(r.steps || []), J(r.evidence || {}), r.video || null, r.poster || null, r.model || null, r.ms || null, r.run_url || null]))[0]);
    },
    async fail(id, error) { await q(`UPDATE tests SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status IN ('queued','running')`, [id, String(error).slice(0, 300)]); },
    async running() { return Number((await q(`SELECT count(*)::int AS n FROM tests WHERE status = 'running'`))[0].n); },
    async nextQueued() { return fix((await q(`SELECT * FROM tests WHERE status = 'queued' ORDER BY id LIMIT 1`))[0]); },
    async ahead(id) { return Number((await q(`SELECT count(*)::int AS n FROM tests WHERE status IN ('queued','running') AND id < $1`, [id]))[0].n); },
    async recent(limit = 24) { return (await q(`SELECT id, mint, name, symbol, icon, site, verdict, summary, frames, finished_at FROM tests WHERE status = 'done' AND rules = $2 ORDER BY id DESC LIMIT $1`, [limit, RULES])).map(fix); },
    async totals() {
      const r = (await q(`SELECT count(*) FILTER (WHERE status = 'done')::int AS tests, count(*) FILTER (WHERE verdict = 'WORKS')::int AS works, count(*) FILTER (WHERE verdict = 'NOTHING WORKS')::int AS nothing, count(*) FILTER (WHERE verdict = 'SITE DOWN')::int AS down, count(*) FILTER (WHERE status IN ('queued','running'))::int AS in_flight, count(DISTINCT mint) FILTER (WHERE status = 'done')::int AS coins FROM tests WHERE rules = $1`, [RULES]))[0];
      return { tests: Number(r.tests), works: Number(r.works), nothing: Number(r.nothing), down: Number(r.down), in_flight: Number(r.in_flight), coins: Number(r.coins) };
    },
  };
}
let _store = null; let _url = null; let _override = null;
export function store() {
  if (_override) return _override;
  const url = env('DATABASE_URL') || env('POSTGRES_URL') || env('DATABASE_URL_UNPOOLED');
  if (!url) return null;
  if (!_store || _url !== url) { let sql = null; _store = pgStore({ async query(t, p) { if (!sql) { const { neon } = await import('@neondatabase/serverless'); sql = neon(url); } return sql.query(t, p); } }); _url = url; }
  return _store;
}
export function setStore(s) { _override = s || null; }
