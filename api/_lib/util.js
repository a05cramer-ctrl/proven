// Shared helpers + the PROVEN constants. Everything under api/_lib/ is a module, not a route.
// Degrades by design: every public GET answers with zeros and a `missing` list when env is absent.
// Secrets only ever come from env().

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const HOLDER_TIER = 1_000_000; // whole $PROVEN → re-test any coin any time, outside the daily cap
export const CACHE_HOURS = 24; // one test per coin per day for everyone else
export const DAILY_CAP_DEFAULT = 100; // tests a day across the whole site (each costs model time)
export const STALE_MINUTES = 12; // a test that has not reported back by then counts as failed
export const RENT_MIN_LAMPORTS = 890_880n;
/** Rent of one associated token account (165 bytes). The sender pays it when the receiver has no ATA yet. */
export const ATA_RENT_LAMPORTS = 2_039_280n;
/** Allowance for base fee + priority fee of one TELEX tx (1 signature, ≤ 60k CU at 100k µL). */
export const NETWORK_FEE_LAMPORTS = 15_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const JUP_SWAP = 'https://lite-api.jup.ag/swap/v1';
export const JUP_TOKENS = 'https://lite-api.jup.ag/tokens/v2';
export const JUP_PRICE = 'https://lite-api.jup.ag/price/v3';
export const PUBLIC_RPC = { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : String(v).trim();
}

export function network() { return env('SOLANA_NETWORK', 'mainnet') === 'devnet' ? 'devnet' : 'mainnet'; }
export function hasHelius() { return !!env('HELIUS_API_KEY'); }

/** Helius when a key is set, else the public cluster RPC. RPC_URL overrides both. */
export function rpcUrl() {
  if (env('RPC_URL')) return env('RPC_URL');
  if (hasHelius()) return `https://${network()}.helius-rpc.com/?api-key=${encodeURIComponent(env('HELIUS_API_KEY'))}`;
  return PUBLIC_RPC[network()];
}
export function rpcKind() { return env('RPC_URL') ? 'custom' : hasHelius() ? 'helius' : 'public'; }

export function solscanTx(sig) { return `https://solscan.io/tx/${sig}${network() === 'devnet' ? '?cluster=devnet' : ''}`; }
export function solscanAccount(pk) { return `https://solscan.io/account/${pk}${network() === 'devnet' ? '?cluster=devnet' : ''}`; }

/** fetch with a hard timeout. */
export async function fetchT(input, init = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, init = {}, ms = 15000) {
  const r = await fetchT(url, init, ms);
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  return { ok: r.ok, status: r.status, headers: r.headers, body };
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telex-Dev');
}

export function send(res, status, obj, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function sendXml(res, status, xml) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(xml);
}

/** Wrap a handler: CORS, OPTIONS, method guard, uniform error JSON. */
export function route(methods, fn) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (!methods.includes(req.method)) return send(res, 405, { error: 'method not allowed' });
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error('[api]', req.url, e);
      return send(res, 500, { error: 'internal error' });
    }
  };
}

export function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const u = new URL(req.url, 'http://x');
  return Object.fromEntries(u.searchParams.entries());
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isPubkey(s) { return typeof s === 'string' && B58.test(s); }
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,120}$/;
export function isSignature(s) { return typeof s === 'string' && SIG.test(s); }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowS = () => Math.floor(Date.now() / 1000);
export const startOfTodayUtc = () => Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
export const lamportsToSol = (l, d = 4) => Math.round((Number(BigInt(l)) / LAMPORTS_PER_SOL) * 10 ** d) / 10 ** d;

/**
 * Tiny in-process TTL cache (per warm function instance). On a failed refresh the previous value is
 * served for up to `staleMs` more, so one bad upstream call never blanks the site.
 */
export function memo(ttlMs, staleMs = 5 * 60_000) {
  let hit = null; let inflight = null;
  const get = async (fn) => {
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
    if (!inflight) inflight = fn().then((v) => { hit = { t: Date.now(), v }; return v; }).finally(() => { inflight = null; });
    try { return await inflight; } catch (e) { if (hit && Date.now() - hit.t < ttlMs + staleMs) return hit.v; throw e; }
  };
  get.reset = () => { hit = null; };
  return get;
}

/** Authorise a cron route: Vercel sends `Authorization: Bearer <CRON_SECRET>`. */
export function requireCron(req, { allowOpen = false } = {}) {
  if (!env('CRON_SECRET')) {
    if (allowOpen) return;
    throw new HttpError(503, 'not configured', { missing: ['CRON_SECRET'], note: 'set CRON_SECRET on Vercel; the cron sends it as "Authorization: Bearer <CRON_SECRET>"' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${env('CRON_SECRET')}`) throw new HttpError(401, 'unauthorized');
}

/** Raw request body as a string (Vercel may already have parsed it into req.body). */
export async function readRaw(req, limit = 64 * 1024) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return req.body; // already parsed by the platform
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) reject(new HttpError(413, 'body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Parse a JSON body. */
export async function readJson(req) {
  const raw = await readRaw(req);
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { throw new HttpError(400, 'invalid JSON body'); }
}

/**
 * Parse a Twilio webhook body: application/x-www-form-urlencoded (what Twilio sends) or JSON (dev mode).
 * Returns a plain { key: value } object with decoded values.
 */
export async function readForm(req) {
  const raw = await readRaw(req);
  if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v ?? '')]));
  if (!raw) return {};
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json') || /^\s*\{/.test(raw)) {
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x ?? '')])) : {}; } catch { throw new HttpError(400, 'invalid JSON body'); }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

/** Decimal string ("0.5", "0,5", ".5", "1000") → base units (BigInt) at `decimals`; extra fraction digits are truncated. null when not a number. */
export function toUnits(amount, decimals) {
  const s = String(amount ?? '').trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [intPart = '', fracPart = ''] = s.split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt((intPart || '0') + frac); } catch { return null; }
}

/** Base units → human string, trailing zeros trimmed, at most `maxFrac` decimals shown. */
export function fmtUnits(raw, decimals, maxFrac = 6) {
  const n = BigInt(raw);
  const neg = n < 0n; const a = neg ? -n : n;
  const s = a.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals) || '0';
  let frac = decimals ? s.slice(s.length - decimals) : '';
  frac = frac.slice(0, Math.max(0, maxFrac)).replace(/0+$/, '');
  const intG = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + intG + (frac ? `.${frac}` : '');
}
export const fmtSol = (lamports, maxFrac = 6) => fmtUnits(lamports, 9, maxFrac);
