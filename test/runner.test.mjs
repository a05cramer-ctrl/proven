import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runTest, programsOf } from '../runner/agent.js';
import { parseAction, userMessage } from '../runner/model.js';
import { finalVerdict, evidenceOf, evidenceLines } from '../runner/verdict.js';
import { serveSites, scriptedModel } from './fixtures/sites.mjs';

let browser, sites;
test.before(async () => { browser = await chromium.launch(); sites = await serveSites(); });
test.after(async () => { await browser.close(); sites.close(); });

test('a working product: launch → connect → quote → swap reaches a real transaction → WORKS', async () => {
  const r = await runTest(browser, { url: sites.working, model: scriptedModel(), maxSteps: 10 });
  assert.equal(r.verdict, 'WORKS'); assert.equal(r.reachable, true);
  assert.equal(r.evidence.walletConnected, true); assert.equal(r.evidence.txBuilt, 1);
  assert.deepEqual(r.evidence.realPrograms, [sites.program]);
  assert.ok(r.evidence.apiCalls >= 1); assert.ok(r.evidence.effective >= 3);
  assert.ok(r.lines.some((l) => /1 real transaction built \(program 6EF8…wF6P\), declined/.test(l)));
  assert.ok(r.steps.some((s) => s.target === 'button "Swap"' && s.effect.wallet >= 1));
});
test('a landing page with dead buttons → NOTHING WORKS, dead clicks counted, buy links seen as leaving the site', async () => {
  const r = await runTest(browser, { url: sites.dead, model: scriptedModel(), maxSteps: 8 });
  assert.equal(r.verdict, 'NOTHING WORKS');
  assert.equal(r.evidence.dead, 3); assert.equal(r.evidence.effective, 0); assert.equal(r.evidence.txBuilt, 0); assert.equal(r.evidence.walletConnected, false);
  assert.ok(r.evidence.leftSite >= 1);
  assert.ok(r.lines.includes('no transaction was ever built'));
});
test('a model talked into WORKS by page text is overruled by the evidence', async () => {
  const r = await runTest(browser, { url: sites.dead, model: scriptedModel({ gullible: true }), maxSteps: 6 });
  assert.equal(r.modelVerdict, 'WORKS'); assert.equal(r.verdict, 'NOTHING WORKS'); assert.equal(r.overruled, true);
});
test('a site that does not load → SITE DOWN', async () => {
  const r = await runTest(browser, { url: sites.down, model: scriptedModel(), maxSteps: 3 });
  assert.equal(r.verdict, 'SITE DOWN'); assert.equal(r.reachable, false); assert.equal(r.steps.length, 0);
});
test('the step limit forces a verdict', async () => {
  const r = await runTest(browser, { url: sites.working, model: async () => JSON.stringify({ action: 'scroll' }), maxSteps: 3 });
  assert.equal(r.steps.at(-1).action, 'done'); assert.equal(r.verdict, 'NOTHING WORKS');
});
test('pure rules', () => {
  const ev = (o) => ({ clicks: 0, effective: 0, dead: 0, leftSite: 0, walletConnected: false, messagesSigned: 0, txBuilt: 0, programs: [], realPrograms: [], apiCalls: 0, apiHosts: [], failedRequests: 0, consoleErrors: 0, ...o });
  assert.equal(finalVerdict('WORKS', ev({ effective: 2 })).verdict, 'WORKS');
  assert.equal(finalVerdict('WORKS', ev({})).verdict, 'NOTHING WORKS');
  assert.equal(finalVerdict('NOTHING WORKS', ev({ realPrograms: ['x'], txBuilt: 1 })).verdict, 'WORKS');
  assert.equal(finalVerdict(null, ev({ effective: 5 })).verdict, 'NOTHING WORKS');
  assert.equal(finalVerdict(null, ev({ effective: 4, apiCalls: 9 })).verdict, 'WORKS');
  assert.equal(finalVerdict('WORKS', ev({ effective: 5 }), { reachable: false }).verdict, 'SITE DOWN');
  assert.equal(parseAction('sure! {"action":"click","target":3,"note":"x"} ok').target, 3);
  assert.equal(parseAction('{"action":"explode"}'), null); assert.equal(parseAction('nope'), null);
  assert.equal(parseAction('{"action":"done","verdict":"MAYBE"}').verdict, null);
  assert.deepEqual(programsOf('garbage'), []);
  assert.match(userMessage({ url: 'u', title: 't', text: 'x', els: [], scrollY: 0, pageH: 0, viewH: 0 }, '', 12, 12, []), /LAST STEP/);
  assert.equal(evidenceOf([{ action: 'click', effect: { domChanged: false, navigated: false, requests: 0, popup: null, wallet: 0 } }], {}).dead, 1);
  assert.ok(evidenceLines(ev({ clicks: 1, dead: 1 }))[0].startsWith('1 control tried'));
});
