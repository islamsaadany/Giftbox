/* Shared bits for the guest and admin pages: escaping, money, API calls, toast, bottom sheet */
window.WB = (function () {
  const gift = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18M12 8v13"/><path d="M12 8c-2-3-6-3-6-1s3 1 6 1c3 0 6 1 6-1s-4-2-6 1z"/></svg>';
  // The app icon, on a white ground so it shows on the pink banner
  const logo = '<svg viewBox="0 0 160 160" aria-hidden="true"><rect width="160" height="160" rx="36" fill="#FFFFFF"/><path d="M80 22l6 16 16 6-16 6-6 16-6-16-16-6 16-6z" fill="#C93A64"/><path d="M116 30l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#F06A92"/><rect x="44" y="88" width="72" height="44" rx="8" fill="#C93A64"/><rect x="38" y="72" width="84" height="20" rx="6" fill="#A82C52"/><rect x="74" y="72" width="12" height="60" fill="#FFFFFF"/></svg>';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => (n || n === 0 ? Number(n).toLocaleString('en-EG') + ' EGP' : '');
  const $ = id => document.getElementById(id);

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (_) {
      const e = new Error('offline'); e.code = 'offline'; e.data = {}; throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'error'); e.status = res.status; e.code = data.error || 'error'; e.data = data; throw e; }
    return data;
  }
  const problem = e => e.code === 'offline' ? 'No connection. Check your internet and try again.'
    : e.code === 'too_many_attempts' ? 'Too many tries. Please wait a little and try again.'
    : 'Something went wrong. Please try again.';

  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }

  /* The page behind a sheet doesn't scroll */
  let lockY = null;
  function lock() { if (lockY !== null) return; lockY = scrollY; document.body.style.top = (-lockY) + 'px'; document.body.classList.add('locked'); }
  function unlock() { if (lockY === null) return; document.body.classList.remove('locked'); document.body.style.top = ''; scrollTo(0, lockY); lockY = null; }

  function open(html, after) {
    lock();
    const layer = $('layer');
    layer.innerHTML = `<div class="overlay" id="ov"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
    const ov = $('ov');
    ov.onclick = e => { if (e.target === ov) close(); };
    layer.querySelectorAll('[data-close]').forEach(b => (b.onclick = close));
    const sh = layer.querySelector('.sheet');
    sh.querySelectorAll('input:not([type=file])').forEach(i => i.setAttribute('enterkeyhint', 'done'));
    // Enter only closes the keyboard; saving happens with the button
    sh.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.blur(); } });
    // Dragging the form down closes the keyboard so you can see what you filled in
    let ty = null;
    sh.addEventListener('touchstart', e => { ty = e.touches[0].clientY; }, { passive: true });
    sh.addEventListener('touchmove', e => {
      if (ty !== null && e.touches[0].clientY - ty > 24) { const a = document.activeElement; if (a && a.tagName === 'INPUT') a.blur(); ty = null; }
    }, { passive: true });
    after && after(sh);
  }
  function close() { $('layer').innerHTML = ''; unlock(); }
  addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function confirmBox(title, text, label, fn) {
    open(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="cf">${esc(label)}</button></div>`,
      () => { $('cf').onclick = () => { close(); fn(); }; });
  }

  /* Run an async save from a form's submit button, guarding against double taps */
  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  return { gift, logo, esc, money, $, api, problem, toast, open, close, confirmBox, busy };
})();
