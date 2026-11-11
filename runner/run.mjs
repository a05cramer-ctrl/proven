// The whole job, as run by the public GitHub Actions workflow: claim the test, drive the site, cut the recording,
// pin it to IPFS, report back. Secrets stay in this process; the page under test never sees them.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { runTest } from './agent.js';
import { openRouterModel } from './model.js';

const E = (k, d = '') => (process.env[k] || d).trim();
const API = E('PROVEN_API').replace(/\/+$/, ''); const SECRET = E('RUNNER_SECRET'); const ID = E('TEST_ID');
const MODEL = E('PROVEN_MODEL', 'anthropic/claude-haiku-4.5');
const auth = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const report = (body) => fetch(`${API}/api/runner`, { method: 'POST', headers: auth, body: JSON.stringify({ id: Number(ID), ...body }) }).then((r) => r.text());

async function pin(file, name, type) {
  const token = E('FILEBASE_IPFS_TOKEN');
  if (!token || !file || !existsSync(file)) return null;
  const fd = new FormData(); fd.append('file', new Blob([readFileSync(file)], { type }), name);
  const r = await fetch('https://rpc.filebase.io/api/v0/add?cid-version=1', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  if (!r.ok) { console.error('pin failed', r.status); return null; }
  const j = await r.json(); return j.Hash || j.cid || null;
}
/** webm → mp4 at 2x, capped at 40 s, so it plays everywhere and posts to X. */
function toMp4(webm, dir) {
  if (!webm || !existsSync(webm)) return null;
  const out = join(dir, 'test.mp4');
  try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf', 'setpts=0.5*PTS,fps=30,scale=1280:720', '-t', '40', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' }); return out; }
  catch (e) { console.error('ffmpeg failed', e.message); return null; }
}

async function main() {
  if (!API || !SECRET || !ID) throw new Error('PROVEN_API, RUNNER_SECRET and TEST_ID are required');
  if (!E('OPENROUTER_API_KEY')) throw new Error('OPENROUTER_API_KEY is required');
  const run = E('GITHUB_RUN_ID') ? `https://github.com/${E('GITHUB_REPOSITORY')}/actions/runs/${E('GITHUB_RUN_ID')}` : '';
  const jr = await fetch(`${API}/api/runner?id=${ID}${run ? `&run=${encodeURIComponent(run)}` : ''}`, { headers: auth });
  if (!jr.ok) throw new Error(`claim failed: ${jr.status} ${await jr.text()}`);
  const job = await jr.json();
  console.log(`test #${job.id}: ${job.name} ($${job.symbol}) → ${job.site}`);
  const dir = mkdtempSync(join(tmpdir(), 'proven-'));
  const browser = await chromium.launch();
  try {
    const r = await runTest(browser, { url: job.site, model: openRouterModel({ apiKey: E('OPENROUTER_API_KEY'), model: MODEL }), maxSteps: Number(E('PROVEN_STEPS', '12')), videoDir: dir, shotDir: dir, onStep: (s) => console.log(`  ${s.n}. ${s.action}${s.target ? ' ' + s.target : ''} — ${s.note || ''}${s.effect ? ' → ' + JSON.stringify(s.effect) : ''}`) });
    console.log(`verdict: ${r.verdict}${r.overruled ? ` (model said ${r.modelVerdict}; overruled: ${r.why})` : ''}`);
    r.lines.forEach((l) => console.log('  · ' + l));
    const mp4 = toMp4(r.video, dir);
    const [video, poster] = await Promise.all([pin(mp4, `proven-${job.id}.mp4`, 'video/mp4'), pin(r.poster, `proven-${job.id}.jpg`, 'image/jpeg')]);
    console.log(await report({ verdict: r.verdict, overruled: r.overruled, summary: r.overruled ? `Overruled by the evidence: ${r.why}.` : r.summary, findings: r.findings, lines: r.lines, steps: r.steps, evidence: r.evidence, video, poster, model: MODEL, ms: r.ms }));
  } finally { await browser.close(); }
}
main().catch(async (e) => { console.error(e); try { await report({ error: String(e.message || e).slice(0, 200) }); } catch {} process.exit(1); });
