// One test: open the site, let the model drive for a bounded number of steps, measure what every action really did.
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { VersionedTransaction, Transaction, VersionedMessage } from '@solana/web3.js';
import { walletStub } from './wallet-stub.js';
import { observe } from './observe.js';
import { SYSTEM, userMessage, parseAction } from './model.js';
import { evidenceOf, finalVerdict, evidenceLines } from './verdict.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATIC = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|woff2?|ttf|otf|mp4|webm|mp3|wasm|map)(\?|$)/i;
const ANALYTICS = /(google-analytics|googletagmanager|doubleclick|facebook|hotjar|segment|sentry|clarity|plausible|vercel-insights|vercel-scripts|cloudflareinsights|intercom|crisp|fonts\.g)/i;

export function programsOf(b64) {
  try {
    if (!b64) return [];
    if (b64.startsWith('m:')) { const m = VersionedMessage.deserialize(Buffer.from(b64.slice(2), 'base64')); return m.compiledInstructions.map((ix) => m.staticAccountKeys[ix.programIdIndex]?.toBase58()).filter(Boolean); }
    const buf = Buffer.from(b64, 'base64');
    try { const t = VersionedTransaction.deserialize(buf); return t.message.compiledInstructions.map((ix) => t.message.staticAccountKeys[ix.programIdIndex]?.toBase58()).filter(Boolean); }
    catch { return Transaction.from(buf).instructions.map((ix) => ix.programId.toBase58()); }
  } catch { return []; }
}

/**
 * @param browser  a Playwright Browser
 * @param opts     { url, model(fn), maxSteps, budgetMs, videoDir, onStep }
 * → { verdict, overruled, why, summary, findings, evidence, lines, steps, reachable, finalUrl, video, shots }
 */
export async function runTest(browser, { url, model, maxSteps = 12, budgetMs = 150_000, videoDir = null, shotDir = null, onStep = () => {} }) {
  const kp = nacl.sign.keyPair();
  const pub58 = bs58.encode(kp.publicKey);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: videoDir ? { dir: videoDir, size: { width: 1280, height: 720 } } : undefined, acceptDownloads: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
  const signals = { connected: false, signedMessages: 0, txs: [], apiCalls: 0, apiHosts: [], failed: 0, consoleErrors: 0, popups: [] };
  let counters = { requests: 0, wallet: 0, popup: null };
  await context.exposeBinding('__pvSign', (_src, b64) => Buffer.from(nacl.sign.detached(Buffer.from(b64, 'base64'), kp.secretKey)).toString('base64'));
  await context.exposeBinding('__pvNote', (_src, kind, data) => {
    counters.wallet++;
    if (kind === 'connect') signals.connected = true;
    else if (kind === 'signMessage') signals.signedMessages++;
    else if (kind === 'tx') signals.txs.push({ programs: programsOf(data) });
  });
  await context.addInitScript(walletStub, { pubkeyB58: pub58, pubkeyBytes: [...kp.publicKey] });
  const page = await context.newPage();
  const siteHost = (() => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } })();
  context.on('page', async (p) => { if (p === page) return; try { await p.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {}); const u = p.url(); signals.popups.push(u); counters.popup = u; await p.close(); } catch {} });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('console', (m) => { if (m.type() === 'error') signals.consoleErrors++; });
  page.on('pageerror', () => { signals.consoleErrors++; });
  const isData = (req) => ['xhr', 'fetch', 'websocket'].includes(req.resourceType()) && !STATIC.test(req.url()) && !ANALYTICS.test(req.url());
  page.on('request', (req) => { if (!isData(req)) return; counters.requests++; signals.apiCalls++; try { const h = new URL(req.url()).host; if (!signals.apiHosts.includes(h) && signals.apiHosts.length < 12) signals.apiHosts.push(h); } catch {} });
  page.on('requestfailed', (req) => { if (isData(req)) signals.failed++; });
  page.on('response', (res) => { if (res.status() >= 400 && isData(res.request())) signals.failed++; });

  const steps = []; const history = []; const shots = [];
  const started = Date.now();
  let reachable = true; let modelOut = { verdict: null, summary: '', findings: [] };
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!resp || resp.status() >= 400) reachable = false;
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(1200);
  } catch { reachable = false; }

  const snap = async () => { try { return await page.evaluate(observe, 70); } catch { await sleep(800); try { return await page.evaluate(observe, 70); } catch { return { url: page.url(), title: '', text: '', textLen: 0, els: [], scrollY: 0, pageH: 0, viewH: 720 }; } } };
  let last = '';
  if (reachable) {
    let obs = await snap();
    if (obs.textLen < 20 && obs.els.length === 0) { await sleep(2500); obs = await snap(); }
    for (let n = 1; n <= maxSteps; n++) {
      const lastStep = n === maxSteps || Date.now() - started > budgetMs;
      let jpeg = null; try { jpeg = (await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' })).toString('base64'); } catch {}
      let act = null;
      try { act = parseAction(await model({ system: SYSTEM, user: userMessage(obs, last, lastStep ? maxSteps : n, maxSteps, history), jpegB64: jpeg, obs, signals, steps })); } catch (e) { last = `model error: ${String(e.message).slice(0, 80)}`; }
      if (!act) { if (lastStep) break; act = { action: 'wait', note: 'no valid action', target: null, text: '' }; }
      if (lastStep && act.action !== 'done') act = { ...act, action: 'done' };
      const step = { n, action: act.action, note: act.note, target: null, effect: null };
      if (act.action === 'done') { modelOut = { verdict: act.verdict, summary: act.summary, findings: act.findings }; steps.push(step); onStep(step); break; }
      counters = { requests: 0, wallet: 0, popup: null };
      const before = { url: page.url(), len: obs.textLen, text: obs.text };
      try {
        if (act.action === 'click' || act.action === 'type') {
          const el = obs.els.find((e) => e.i === act.target);
          if (!el) throw new Error(`no control ${act.target}`);
          step.target = `${el.tag} "${el.text}"`;
          const loc = page.locator(`[data-pv="${el.i}"]`).first();
          await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
          const box = await loc.boundingBox().catch(() => null);
          if (box) { await page.evaluate(([x, y]) => window.__pvCursor && window.__pvCursor(x, y, false), [box.x + box.width / 2, box.y + box.height / 2]).catch(() => {}); await sleep(520); await page.evaluate(([x, y]) => window.__pvCursor && window.__pvCursor(x, y, true), [box.x + box.width / 2, box.y + box.height / 2]).catch(() => {}); }
          if (act.action === 'click') await loc.click({ timeout: 4000 }).catch(async () => { await loc.click({ timeout: 2000, force: true }); });
          else { await loc.fill(act.text || 'test', { timeout: 4000 }).catch(async () => { await loc.click({ timeout: 2000 }); await page.keyboard.type(act.text || 'test', { delay: 20 }); }); step.typed = act.text || 'test'; }
        } else if (act.action === 'scroll') { await page.mouse.wheel(0, 620); }
        else if (act.action === 'back') { await page.goBack({ timeout: 8000 }).catch(() => {}); }
        else { await sleep(1500); }
      } catch (e) { step.error = String(e.message).split('\n')[0].slice(0, 120); }
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await sleep(1400);
      obs = await snap();
      const navigated = obs.url.split('#')[0] !== before.url.split('#')[0];
      const domChanged = navigated || Math.abs(obs.textLen - before.len) > 12 || obs.text !== before.text;
      step.effect = { navigated, domChanged: act.action === 'scroll' ? false : domChanged, requests: counters.requests, wallet: counters.wallet, popup: counters.popup };
      const leftHost = (() => { try { return new URL(obs.url).host.replace(/^www\./, ''); } catch { return siteHost; } })();
      if (navigated && leftHost !== siteHost && !leftHost.endsWith('.' + siteHost)) { step.effect.left = leftHost; step.effect.popup = step.effect.popup || obs.url; step.effect.navigated = false; step.effect.domChanged = false; await page.goBack({ timeout: 8000 }).catch(() => {}); await sleep(900); obs = await snap(); }
      last = step.error ? `failed: ${step.error}` : [step.effect.left ? `left the site to ${step.effect.left} (went back)` : navigated ? `navigated to ${obs.url}` : '', step.effect.popup && !step.effect.left ? `opened another site in a new tab: ${String(step.effect.popup).slice(0, 80)} (closed)` : '', step.effect.domChanged && !navigated ? 'the page content changed' : '', step.effect.wallet ? `the wallet was called (${signals.connected ? 'connected' : ''}${signals.signedMessages ? ', message signed' : ''}${signals.txs.length ? `, ${signals.txs.length} transaction request(s) recorded and declined` : ''})` : '', step.effect.requests ? `${step.effect.requests} data request(s)` : ''].filter(Boolean).join('; ') || (act.action === 'scroll' ? 'scrolled' : 'NOTHING happened: no page change, no request, no wallet call');
      history.push(`${n}. ${act.action}${step.target ? ' ' + step.target : ''}${step.typed ? ` = "${step.typed}"` : ''} → ${last}`);
      if (shotDir && shots.length < 6 && (step.effect.domChanged || step.effect.wallet)) { const f = `${shotDir}/step-${n}.jpg`; try { await page.screenshot({ path: f, type: 'jpeg', quality: 70 }); shots.push(f); } catch {} }
      steps.push(step); onStep(step);
    }
  }
  const finalUrl = page.url();
  let poster = null; if (shotDir) { poster = `${shotDir}/final.jpg`; await page.screenshot({ path: poster, type: 'jpeg', quality: 80 }).catch(() => { poster = null; }); }
  await sleep(600);
  const video = page.video();
  await context.close();
  const evidence = evidenceOf(steps, signals);
  const fv = finalVerdict(modelOut.verdict, evidence, { reachable });
  return {
    ...fv, modelVerdict: modelOut.verdict, summary: reachable ? modelOut.summary : 'The site did not load.', findings: modelOut.findings,
    evidence, lines: reachable ? evidenceLines(evidence) : ['the site did not answer'], steps: steps.map((s) => ({ n: s.n, action: s.action, target: s.target, typed: s.typed, note: s.note, effect: s.effect, error: s.error })),
    reachable, finalUrl, wallet: pub58, video: video ? await video.path().catch(() => null) : null, poster, shots, ms: Date.now() - started,
  };
}
