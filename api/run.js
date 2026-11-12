// POST /api/run { id } — one test, start to finish, inside this function: a real Chromium, the model at the wheel,
// every step and every screen written to the database as it happens. Only /api/test can call it (x-proven-key).
import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';
import { route, send, readJson, HttpError, env } from './_lib/util.js';
import { store } from './_lib/store.js';
import { runKey, cleanSite } from './_lib/coin.js';
import { runTest, publicStep } from '../runner/agent.js';
import { chatModel } from '../runner/model.js';

/** Which model drives: the project's Vercel AI Gateway (no key to set up), or OpenRouter when a key is present. */
export function pickModel(req) {
  if (env('OPENROUTER_API_KEY')) return { name: env('PROVEN_MODEL', 'google/gemini-2.5-flash'), fn: chatModel({ apiKey: env('OPENROUTER_API_KEY'), model: env('PROVEN_MODEL', 'google/gemini-2.5-flash'), base: 'https://openrouter.ai/api/v1' }) };
  const token = env('AI_GATEWAY_API_KEY') || req.headers['x-vercel-oidc-token'] || env('VERCEL_OIDC_TOKEN');
  if (!token) return null;
  const name = env('PROVEN_MODEL', 'google/gemini-2.5-flash');
  return { name, fn: chatModel({ apiKey: token, model: name, base: 'https://ai-gateway.vercel.sh/v1' }) };
}

// Two tests can land on the same warm instance. Chromium is unpacked to /tmp once, and launches go one at a time,
// so a second test never starts a binary that is still being written.
let line = Promise.resolve();
async function launchOnce() {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { return await playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true }); }
    catch (e) { lastErr = e; if (!/ETXTBSY|EAGAIN|ENOENT/.test(String(e?.message))) throw e; await new Promise((r) => setTimeout(r, 1200 * (i + 1))); }
  }
  throw lastErr;
}
function launch() { const p = line.then(launchOnce, launchOnce); line = p.catch(() => {}); return p; }

export default route(['POST'], async (req, res) => {
  if ((req.headers['x-proven-key'] || '') !== runKey()) throw new HttpError(401, 'unauthorized');
  const db = store();
  if (!db) throw new HttpError(503, 'not configured');
  const { id } = await readJson(req);
  const t = await db.start(Number(id));
  if (!t) throw new HttpError(409, 'not queued');
  if (!cleanSite(t.site)) { await db.fail(t.id, 'bad site'); throw new HttpError(409, 'bad site'); }
  const model = pickModel(req);
  if (!model) { await db.fail(t.id, 'no model available'); throw new HttpError(503, 'no model available'); }
  let browser = null;
  try {
    browser = await launch();
    let n = 0;
    const r = await runTest(browser, {
      url: t.site, model: model.fn, maxSteps: Number(env('PROVEN_STEPS', '10')), budgetMs: 170_000, frames: true,
      onStep: async (_step, jpg, steps) => { try { await db.progress(t.id, steps.map(publicStep), n, jpg); if (jpg) n++; } catch (e) { console.error('[progress]', e?.message); } },
    });
    await db.finish(t.id, { verdict: r.verdict, overruled: r.overruled, summary: r.overruled ? `Overruled by the evidence: ${r.why}.` : r.summary, findings: r.findings, lines: r.lines, steps: r.steps, evidence: r.evidence, model: model.name, ms: r.ms });
    db.prune().catch(() => {});
    send(res, 200, { ok: true, verdict: r.verdict });
  } catch (e) {
    console.error('[run]', e);
    await db.fail(t.id, String(e?.message || e));
    send(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200) });
  } finally { if (browser) await browser.close().catch(() => {}); }
});
