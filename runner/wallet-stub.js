// Injected into every page before its scripts run: a Phantom-shaped wallet with a throwaway key and no funds.
// It connects and signs messages for real (the key lives in the runner, reached through window.__pvSign), and it
// records every transaction the site asks it to sign, then declines like a user pressing "Cancel". Nothing is ever sent.
export function walletStub({ pubkeyB58, pubkeyBytes }) {
  const B58 = pubkeyB58; const BYTES = new Uint8Array(pubkeyBytes);
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const pk = { toBase58: () => B58, toString: () => B58, toJSON: () => B58, toBytes: () => BYTES.slice(), toBuffer: () => BYTES.slice(), equals: (o) => !!o && String(o.toBase58 ? o.toBase58() : o) === B58, _bn: null };
  const listeners = {};
  const emit = (ev, ...a) => (listeners[ev] || []).forEach((f) => { try { f(...a); } catch {} });
  const ser = (tx) => { try { if (tx && tx.serialize) return b64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); } catch {} try { if (tx && tx.message && tx.message.serialize) return 'm:' + b64(tx.message.serialize()); } catch {} try { if (tx instanceof Uint8Array) return b64(tx); } catch {} return ''; };
  const declined = () => { const e = new Error('User rejected the request.'); e.code = 4001; return e; };
  const note = (kind, data) => { try { window.__pvNote && window.__pvNote(kind, data || ''); } catch {} };
  const provider = {
    isPhantom: true, isConnected: false, publicKey: null,
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    off(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); return provider; },
    removeListener(ev, f) { return provider.off(ev, f); }, removeAllListeners() { for (const k in listeners) delete listeners[k]; },
    async connect(opts) {
      if (opts && opts.onlyIfTrusted && !provider.isConnected) throw declined();
      note('connect'); provider.isConnected = true; provider.publicKey = pk; emit('connect', pk); return { publicKey: pk };
    },
    async disconnect() { provider.isConnected = false; provider.publicKey = null; emit('disconnect'); },
    async signMessage(msg) { note('signMessage', b64(msg instanceof Uint8Array ? msg : new TextEncoder().encode(String(msg))).slice(0, 400)); const sig = unb64(await window.__pvSign(b64(msg instanceof Uint8Array ? msg : new TextEncoder().encode(String(msg))))); return { signature: sig, publicKey: pk }; },
    async signIn() { note('signIn'); throw declined(); },
    async signTransaction(tx) { note('tx', ser(tx)); throw declined(); },
    async signAllTransactions(txs) { for (const t of txs || []) note('tx', ser(t)); throw declined(); },
    async signAndSendTransaction(tx) { note('tx', ser(tx)); throw declined(); },
    async request({ method, params } = {}) {
      if (method === 'connect') return provider.connect(params);
      if (method === 'disconnect') return provider.disconnect();
      if (method === 'signMessage') return provider.signMessage(params && params.message);
      note('tx', ''); throw declined();
    },
  };
  try { Object.defineProperty(window, 'solana', { value: provider, configurable: true }); } catch { window.solana = provider; }
  try { Object.defineProperty(window, 'phantom', { value: { solana: provider }, configurable: true }); } catch { window.phantom = { solana: provider }; }
  // Wallet Standard, so wallet-adapter lists it without a Phantom-specific adapter.
  const account = { address: B58, publicKey: BYTES.slice(), chains: ['solana:mainnet'], features: ['solana:signTransaction', 'solana:signAndSendTransaction', 'solana:signMessage'] };
  const stdListeners = [];
  const wallet = {
    version: '1.0.0', name: 'Phantom', chains: ['solana:mainnet'],
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjYWI5ZmYyIi8+PC9zdmc+',
    get accounts() { return provider.isConnected ? [account] : []; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { await provider.connect(); stdListeners.forEach((f) => f({ accounts: [account] })); return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { await provider.disconnect(); stdListeners.forEach((f) => f({ accounts: [] })); } },
      'standard:events': { version: '1.0.0', on: (_ev, f) => { stdListeners.push(f); return () => { const i = stdListeners.indexOf(f); if (i >= 0) stdListeners.splice(i, 1); }; } },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...ins) => Promise.all(ins.map(async (i) => { const r = await provider.signMessage(i.message); return { signedMessage: i.message, signature: r.signature }; })) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...ins) => { for (const i of ins) note('tx', b64(i.transaction)); throw declined(); } },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async (...ins) => { for (const i of ins) note('tx', b64(i.transaction)); throw declined(); } },
    },
  };
  const register = (api) => { try { api.register(wallet); } catch {} };
  try { window.dispatchEvent(new (class extends Event { constructor() { super('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false }); } get detail() { return register; } })()); } catch {}
  try { window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail)); } catch {}

  // A visible cursor for the recording.
  const mk = () => {
    if (document.getElementById('__pv_cur') || !document.documentElement) return;
    const c = document.createElement('div'); c.id = '__pv_cur';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(57,255,90,.35);border:2px solid #39ff5a;box-shadow:0 0 0 2px rgba(0,0,0,.55);z-index:2147483647;pointer-events:none;transform:translate(560px,315px);transition:transform .45s cubic-bezier(.2,.8,.2,1),width .15s,height .15s,margin .15s';
    document.documentElement.appendChild(c);
  };
  window.__pvCursor = (x, y, press) => { mk(); const c = document.getElementById('__pv_cur'); if (!c) return; c.style.transform = `translate(${x}px,${y}px)`; if (press) { c.style.width = '34px'; c.style.height = '34px'; c.style.margin = '-17px 0 0 -17px'; setTimeout(() => { c.style.width = '22px'; c.style.height = '22px'; c.style.margin = '-11px 0 0 -11px'; }, 220); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
}
