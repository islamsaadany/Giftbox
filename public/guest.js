(function () {
  const { gift, esc, money, $, api, problem, open, close, busy } = WB;
  const slug = location.pathname.split('/')[2] || '';
  const app = $('app');
  let list = null, sort = 'default';

  const priceLine = it => it.price === null ? '' : it.each ? `${money(it.price)} <span class="each">each</span>` : money(it.price);
  const pic = it => `<div class="pic">${it.photo ? `<img src="${esc(it.photo)}" alt="" loading="lazy">` : gift}${it.left > 1 ? `<span class="qty">× ${it.left}<small>needed</small></span>` : ''}</div>`;
  const shop = it => it.link ? `<a class="btn" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">Shop</a>` : '';

  async function load() {
    try { list = await api('GET', '/api/l/' + encodeURIComponent(slug)); }
    catch (e) {
      list = null;
      app.innerHTML = e.status === 404
        ? `<div class="empty"><h3>This list isn't available</h3>The link may be old. Ask for a new one.</div>`
        : `<div class="empty"><h3>Couldn't load the list</h3>${esc(problem(e))}<div style="margin-top:12px"><button class="btn" id="retry">Try again</button></div></div>`;
      const r = $('retry'); if (r) r.onclick = load;
      return;
    }
    document.title = list.name;
    render();
  }

  function render() {
    const av = list.items.slice();
    // Items without a price go last
    if (sort !== 'default') av.sort((a, b) => {
      const x = a.price, y = b.price;
      if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1;
      return sort === 'low' ? x - y : y - x;
    });
    let h = `<section class="hero"><h1>${esc(list.name)}</h1>${list.note ? `<p>${esc(list.note)}</p>` : ''}</section>`;
    if (!av.length) {
      h += list.total
        ? `<div class="empty"><h3>Every gift has been reserved</h3>Thank you all. Nothing left to pick right now.</div>`
        : `<div class="empty"><h3>Nothing here yet</h3>Gifts will show up here soon.</div>`;
    } else {
      h += `<div class="sortbar" role="group" aria-label="Sort by price">${[['default', 'Default'], ['low', 'Lowest price'], ['high', 'Highest price']]
        .map(([k, t]) => `<button class="chip sm" data-sort="${k}" aria-current="${sort === k}">${t}</button>`).join('')}</div>
      <div class="grid">${av.map(it => `<article class="card">${pic(it)}<div class="card-body">
        <h3>${esc(it.name)}</h3>
        <div class="meta"><span class="price">${priceLine(it)}</span></div>
        <div class="row">${shop(it)}<button class="btn primary" data-pick="${it.id}">Reserve</button></div>
      </div></article>`).join('')}</div>`;
    }
    app.innerHTML = h;
    app.querySelectorAll('[data-sort]').forEach(b => (b.onclick = () => { sort = b.dataset.sort; render(); }));
    app.querySelectorAll('[data-pick]').forEach(b => (b.onclick = () => pickForm(list.items.find(i => String(i.id) === b.dataset.pick))));
  }

  function pickForm(it) {
    const lf = it.left, u = it.price; let c = 1;
    const sumHtml = () => u === null ? '' : `<span>${c} × ${money(u)}</span><b>${money(u * c)}</b>`;
    open(`<div class="eyebrow">Reserve this gift</div><h2>${esc(it.name)}</h2>
    ${lf > 1 ? `<div class="step-row"><div><div class="lbl">How many will you get?</div><div class="hint">${lf} still needed</div></div><div class="stepper"><button type="button" id="dec" aria-label="One less" disabled>−</button><output id="cnt" aria-live="polite">1</output><button type="button" id="inc" aria-label="One more">+</button></div></div><div class="sum" id="sum">${sumHtml()}</div>` : ''}
    <form id="pf" novalidate>
      <div class="field"><label for="pn">Your name</label><input id="pn" autocomplete="name" maxlength="60"></div>
      <div class="field"><label for="pm">Mobile number</label><input id="pm" type="tel" inputmode="tel" autocomplete="tel" placeholder="01xxxxxxxxx" maxlength="18"></div>
      <div class="err" id="pe" role="alert"></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pgo">Reserve it</button></div>
    </form>`, () => {
      const inc = $('inc'), dec = $('dec');
      const upd = () => { $('cnt').textContent = c; dec.disabled = c <= 1; inc.disabled = c >= lf; const s = $('sum'); if (s) s.innerHTML = sumHtml(); };
      if (inc) { inc.onclick = () => { if (c < lf) { c++; upd(); } }; dec.onclick = () => { if (c > 1) { c--; upd(); } }; }
      $('pf').onsubmit = e => {
        e.preventDefault();
        const n = $('pn').value.trim(), m = $('pm').value.trim(), err = $('pe');
        if (!n) { err.textContent = 'Please add your name.'; return; }
        if (!/^\+?[0-9 ]{8,17}$/.test(m)) { err.textContent = 'Please enter a valid mobile number, e.g. 01012345678.'; return; }
        err.textContent = '';
        busy($('pgo'), async () => {
          try {
            await api('POST', `/api/l/${encodeURIComponent(slug)}/items/${it.id}/reserve`, { name: n, mobile: m, count: c });
          } catch (x) {
            if (x.code === 'not_enough') {
              err.textContent = x.data.left ? 'Only ' + x.data.left + ' left now. Please lower the number.' : 'Someone just reserved the last one. Please pick another gift.';
              if (!x.data.left) load();
            } else if (x.code === 'not_found') { err.textContent = 'This gift is no longer on the list.'; load(); }
            else err.textContent = problem(x);
            return;
          }
          close();
          await load();
          open(`<div class="done">${gift}<h2>Thank you, ${esc(n.split(' ')[0])}!</h2><p>${c > 1 ? `${c} pieces of “${esc(it.name)}” are reserved for you.` : `“${esc(it.name)}” is reserved for you.`}</p>${it.link ? `<a class="btn" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">Open the shop link</a>` : ''}<button class="btn primary" data-close>Done</button></div>`);
        });
      };
    });
  }

  load();
})();
