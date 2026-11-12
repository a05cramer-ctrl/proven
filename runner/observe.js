// Runs in the page: what a visitor can see and press right now. Tags each control with data-pv so the runner can act on it.
export function observe(maxEls) {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 6 || r.height < 6) return false; const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false; return r.bottom > 0 && r.top < innerHeight * 3; };
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('[data-pv]').forEach((e) => e.removeAttribute('data-pv'));
  const seen = new Set(); const els = [];
  const cands = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=tab], [role=link], [role=menuitem], [onclick], summary, label[for]')];
  for (const el of document.querySelectorAll('div, span, li, img, svg')) { if (cands.length > 600) break; try { if (getComputedStyle(el).cursor === 'pointer' && !el.closest('button, a[href], [role=button]')) cands.push(el); } catch {} }
  // An open dialog (wallet picker, modal) goes first: it is what a person would deal with, and it sits last in the DOM.
  const inDialog = (el) => !!el.closest('[role=dialog], [aria-modal=true], dialog[open], .wallet-adapter-modal, [class*=modal i], [class*=Modal], [class*=dialog i], [class*=popover i], [class*=drawer i]');
  const rank = (el) => { const r = el.getBoundingClientRect(); return (inDialog(el) ? 0 : 2) + (r.top >= 0 && r.bottom <= innerHeight ? 0 : 1); };
  const ordered = cands.filter((el) => vis(el) && el.id !== '__pv_cur').map((el, k) => [rank(el), k, el]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
  for (const el of ordered) {
    if (els.length >= maxEls) break;
    if (seen.has(el)) continue;
    if ([...seen].some((s) => s.contains(el) && s !== el && s.tagName !== 'LABEL')) continue;
    seen.add(el);
    const tag = el.tagName.toLowerCase(); const r = el.getBoundingClientRect();
    const text = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 70);
    let href = ''; if (tag === 'a') { try { const u = new URL(el.href, location.href); href = u.host === location.host ? u.pathname + u.hash : u.host; } catch {} }
    const i = els.length; el.setAttribute('data-pv', String(i));
    els.push({ i, tag, type: el.getAttribute('type') || '', text, href, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', inView: r.top >= 0 && r.bottom <= innerHeight, dialog: inDialog(el) });
  }
  const text = clean(document.body ? document.body.innerText : '').slice(0, 2600);
  // A cheap fingerprint of the markup (without our own tags; the cursor lives outside <body>): catches a toggle that only changes a class or a style.
  const sig = document.body ? document.body.innerHTML.replace(/ data-pv="\d+"/g, '').length : 0;
  return { sig, url: location.href, title: document.title.slice(0, 120), text, textLen: (document.body ? document.body.innerText : '').length, els, scrollY: Math.round(scrollY), pageH: Math.round(document.documentElement.scrollHeight), viewH: innerHeight };
}
