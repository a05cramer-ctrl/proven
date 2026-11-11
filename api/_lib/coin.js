// Which coin, and which website does the coin itself list? The site always comes from the coin's own public
// listing (DexScreener, then pump.fun's metadata via Jupiter), never from the person asking for the test.
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { fetchJson, env, isPubkey, rpcUrl, HOLDER_TIER, JUP_TOKENS } from './util.js';

const SOCIAL = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.(me|org)|discord\.(gg|com)|pump\.fun|dexscreener\.com|tiktok\.com|instagram\.com|youtube\.com|youtu\.be|github\.com|linktr\.ee|tinyurl\.com|bit\.ly|gmgn\.ai|axiom\.trade|birdeye\.so|solscan\.io|medium\.com|reddit\.com)$/i;
/** A testable https site on its own domain, or null. */
export function cleanSite(u) {
  try {
    const url = new URL(String(u).trim());
    if (url.protocol !== 'https:') return null;
    const h = url.hostname.toLowerCase();
    if (!h.includes('.') || /^[\d.]+$/.test(h) || h.endsWith('.local') || h === 'localhost' || SOCIAL.test(h)) return null;
    url.hash = ''; url.username = ''; url.password = '';
    return url.toString();
  } catch { return null; }
}
export async function lookup(mint) {
  let name = ''; let symbol = ''; let icon = null; let site = null;
  try {
    const j = (await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, {}, 8000)).body;
    for (const p of Array.isArray(j) ? j : []) {
      if (p?.baseToken?.address !== mint) continue;
      name = name || p.baseToken.name || ''; symbol = symbol || p.baseToken.symbol || ''; icon = icon || p.info?.imageUrl || null;
      for (const w of p.info?.websites || []) { site = site || cleanSite(w.url); }
    }
  } catch { /* fall through to Jupiter */ }
  if (!site || !name) {
    try {
      const j = (await fetchJson(`${JUP_TOKENS}/search?query=${mint}`, {}, 8000)).body;
      const t = (Array.isArray(j) ? j : []).find((x) => x.id === mint);
      if (t) { name = name || t.name || ''; symbol = symbol || t.symbol || ''; icon = icon || t.icon || null; site = site || cleanSite(t.website || ''); }
    } catch { /* unknown coin */ }
  }
  return { name: name.slice(0, 60), symbol: symbol.slice(0, 20), icon, site, found: !!(name || symbol) };
}

/** "PROVEN retest <mint> <unix>" signed by a wallet holding 1,000,000 $PROVEN, at most 5 minutes old. */
export const retestMessage = (mint, ts) => `PROVEN retest ${mint} ${ts}`;
export async function holderOk({ wallet, signature, ts, mint }, now) {
  const pm = env('PROVEN_MINT');
  if (!isPubkey(pm) || !isPubkey(wallet) || !signature || !(Math.abs(now - Number(ts)) < 300)) return false;
  try { if (!nacl.sign.detached.verify(new TextEncoder().encode(retestMessage(mint, ts)), bs58.decode(signature), bs58.decode(wallet))) return false; } catch { return false; }
  try {
    const r = (await fetchJson(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [wallet, { mint: pm }, { encoding: 'jsonParsed' }] }) }, 8000)).body;
    const ui = (r?.result?.value || []).reduce((s, a) => s + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmountString || 0), 0);
    return ui >= HOLDER_TIER;
  } catch { return false; }
}

/** Start the public GitHub Actions run that does the test. → true when GitHub accepted it. */
export async function dispatch(id) {
  const token = env('GH_TOKEN'); const repo = env('GH_REPO');
  if (!token || !repo) return false;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/test.yml/dispatches`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'proven', 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: env('GH_REF', 'main'), inputs: { id: String(id) } }), signal: AbortSignal.timeout(8000) });
    return r.status === 204;
  } catch { return false; }
}
