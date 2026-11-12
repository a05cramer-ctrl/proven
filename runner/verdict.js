// Pure rules around the model's call. The model proposes a verdict; the evidence the runner measured can overrule it.
// WORKS needs proof that something actually happened; NOTHING WORKS cannot stand next to a real transaction.
const SYSTEM_PROGRAMS = new Set(['11111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EhKvWbXwRBhGe', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
export const VERDICTS = ['WORKS', 'NOTHING WORKS', 'SITE DOWN'];

export function evidenceOf(steps, signals) {
  const clicks = steps.filter((s) => s.action === 'click' || s.action === 'type');
  const effective = clicks.filter((s) => s.effect && (s.effect.domChanged || s.effect.navigated || s.effect.requests > 0));
  const dead = clicks.filter((s) => s.action === 'click' && !s.error && s.effect && !s.effect.domChanged && !s.effect.navigated && !s.effect.requests && !s.effect.popup && !s.effect.wallet);
  const outOnly = clicks.filter((s) => s.effect && s.effect.popup && !s.effect.domChanged);
  const programs = [...new Set((signals.txs || []).flatMap((t) => t.programs || []))];
  const realPrograms = programs.filter((p) => !SYSTEM_PROGRAMS.has(p));
  return {
    clicks: clicks.length, effective: effective.length, dead: dead.length, leftSite: outOnly.length,
    walletConnected: !!signals.connected, messagesSigned: signals.signedMessages || 0,
    txBuilt: (signals.txs || []).length, programs, realPrograms,
    apiCalls: signals.apiCalls || 0, apiHosts: signals.apiHosts || [], failedRequests: signals.failed || 0, consoleErrors: signals.consoleErrors || 0,
  };
}

/** → { verdict, overruled?, why? } */
export function finalVerdict(modelVerdict, ev, { reachable = true } = {}) {
  if (!reachable) return { verdict: 'SITE DOWN' };
  // No call from the model at all: the measurements decide. Three or more controls that answered, with live data behind them, is a product.
  if (!modelVerdict) return { verdict: ev.realPrograms.length > 0 || (ev.effective >= 3 && ev.apiCalls >= 3) ? 'WORKS' : 'NOTHING WORKS', overruled: false, byEvidence: true };
  let v = VERDICTS.includes(modelVerdict) && modelVerdict !== 'SITE DOWN' ? modelVerdict : 'NOTHING WORKS';
  if (v === 'NOTHING WORKS' && ev.realPrograms.length > 0) return { verdict: 'WORKS', overruled: true, why: 'the site built a real transaction for an on-chain program' };
  if (v === 'NOTHING WORKS' && ev.effective >= 3 && ev.effective >= ev.dead * 2 && (ev.apiCalls >= 5 || ev.walletConnected || ev.messagesSigned > 0)) return { verdict: 'WORKS', overruled: true, why: ev.walletConnected ? 'the controls answered and the wallet connected' : 'the controls answered and live data loaded behind them' };
  if (v === 'WORKS' && ev.effective === 0 && ev.txBuilt === 0 && ev.messagesSigned === 0) return { verdict: 'NOTHING WORKS', overruled: true, why: 'no click did anything measurable' };
  return { verdict: v };
}

/** Short evidence lines for the result card, in plain words. */
export function evidenceLines(ev) {
  const out = [];
  out.push(`${ev.clicks} control${ev.clicks === 1 ? '' : 's'} tried · ${ev.effective} did something · ${ev.dead} dead`);
  if (ev.leftSite) out.push(`${ev.leftSite} button${ev.leftSite === 1 ? '' : 's'} only opened another site`);
  out.push(ev.walletConnected ? 'wallet connect: asked for and accepted' : 'wallet connect: never asked for');
  if (ev.messagesSigned) out.push(`${ev.messagesSigned} message${ev.messagesSigned === 1 ? '' : 's'} signed`);
  out.push(ev.txBuilt ? `${ev.txBuilt} real transaction${ev.txBuilt === 1 ? '' : 's'} built${ev.realPrograms.length ? ` (program ${ev.realPrograms[0].slice(0, 4)}…${ev.realPrograms[0].slice(-4)})` : ''}, declined by the test wallet` : 'no transaction was ever built');
  out.push(`${ev.apiCalls} live data call${ev.apiCalls === 1 ? '' : 's'}${ev.failedRequests ? ` · ${ev.failedRequests} failed` : ''}${ev.consoleErrors ? ` · ${ev.consoleErrors} page error${ev.consoleErrors === 1 ? '' : 's'}` : ''}`);
  return out;
}
