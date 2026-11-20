(function () {
  const { gift, logo, esc, money, $, api, problem, open, close, busy } = WB;
  const slug = location.pathname.split('/')[2] || '';
  const app = $('app'), slim = $('slim');
  let list = null, sort = 'default';

  const priceLine = it => it.price === null ? '' : it.each ? `${money(it.price)} <span class="each">each</span>` : money(it.price);
  const pic = it => `<div class="pic">${it.photo ? `<img src="${esc(it.photo)}" alt="" loading="lazy">` : gift}${it.left > 1 ? `<span class="qty">${it.left} still needed</span>` : ''}</div>`;
  // Always takes a line, so Reserve buttons line up across a row whether or not an item has a shop link
  const shop = it => it.link ? `<a class="shoplink" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">View in shop</a>` : '<span class="shoplink none" aria-hidden="true">&nbsp;</span>';
  const mark = `<div class="mark">${logo}Wishbox</div>`;

  function message(html) {
    showSlim(false);
    slim.innerHTML = '';
    app.innerHTML = `<section class="banner">${mark}</section>${html}`;
  }

  async function load() {
    try { list = await api('GET', '/api/l/' + encodeURIComponent(slug)); }
    catch (e) {
      list = null;
      message(e.status === 404
        ? `<div class="empty"><h3>This list isn't available</h3>The link may be old. Ask for a new one.</div>`
        : `<div class="empty"><h3>Couldn't load the list</h3>${esc(problem(e))}<div style="margin-top:12px"><button class="btn" id="retry">Try again</button></div></div>`);
      const r = $('retry'); if (r) r.onclick = load;
      return;
    }
    document.title = list.name;
    render();
  }

  function sorted() {
    const av = list.items.slice();
    // Items without a price go last
    if (sort !== 'default') av.sort((a, b) => {
      const x = a.price, y = b.price;
      if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1;
      return sort === 'low' ? x - y : y - x;
    });
    return av;
  }

  function cards() {
    const grid = $('grid');
    grid.innerHTML = sorted().map(it => `<article class="card">${pic(it)}<div class="card-body">
      <h3>${esc(it.name)}</h3>
      <div class="price">${priceLine(it)}</div>
      <div class="row"><button class="btn primary" data-pick="${it.id}">Reserve</button>${shop(it)}</div>
    </div></article>`).join('');
    grid.querySelectorAll('[data-pick]').forEach(b => (b.onclick = () => pickForm(list.items.find(i => String(i.id) === b.dataset.pick))));
  }

  function render() {
    const n = list.items.length;
    // The big banner scrolls away; this slim one takes its place at the top
    slim.innerHTML = `<div class="slim-in">${logo}<div class="t"><small>Wishbox</small><b>${esc(list.name)}</b></div>${n ? `<span class="n">${n} ${n === 1 ? 'gift' : 'gifts'} left</span>` : ''}</div>`;
    let h = `<section class="banner" id="banner">${mark}<div><h1>${esc(list.name)}</h1>${list.note ? `<p>${esc(list.note)}</p>` : ''}</div></section>`;
    if (!n) {
      h += list.total
        ? `<div class="empty"><h3>Every gift has been reserved</h3>Thank you all. Nothing left to pick right now.</div>`
        : `<div class="empty"><h3>Nothing here yet</h3>Gifts will show up here soon.</div>`;
    } else {
      h += `<div class="sortwrap"><div class="segsort" role="group" aria-label="Sort by price">${[['default', 'Default'], ['low', 'Lowest price'], ['high', 'Highest price']]
        .map(([k, t]) => `<button data-sort="${k}" aria-pressed="${sort === k}">${t}</button>`).join('')}</div></div>
      <div class="grid" id="grid"></div>`;
    }
    app.innerHTML = h;
    if (n) {
      cards();
      // Sorting only redraws the cards, so the page doesn't jump while the sort buttons are pinned
      app.querySelectorAll('[data-sort]').forEach(b => (b.onclick = () => {
        sort = b.dataset.sort;
        app.querySelectorAll('[data-sort]').forEach(x => x.setAttribute('aria-pressed', x === b));
        const grid = $('grid'), bar = app.querySelector('.sortwrap');
        // Hold the page height while the cards are redrawn, so the scroll position isn't lost
        grid.style.minHeight = grid.offsetHeight + 'px';
        cards();
        grid.style.minHeight = '';
        // If the buttons are pinned, bring the first gifts of the new order up under them
        const under = slim.offsetHeight + bar.offsetHeight;
        const gridTop = grid.getBoundingClientRect().top;
        if (gridTop < under) scrollTo(0, scrollY + gridTop - under);
      }));
    }
    watch();
  }

  function showSlim(on) { slim.classList.toggle('on', on); slim.setAttribute('aria-hidden', String(!on)); }

  /* Swap to the slim banner at the moment the big one has scrolled up behind where the slim one sits.
     Measured on every scroll frame: an IntersectionObserver margin is ignored when the page is shown inside
     another site's frame, which left a gap between the banner and the pinned sort buttons. */
  let slimH = 0, queued = false;
  function check() {
    queued = false;
    const banner = $('banner');
    showSlim(!!banner && banner.getBoundingClientRect().bottom <= slimH + 0.5);
  }
  function watch() {
    slimH = slim.offsetHeight;
    document.documentElement.style.setProperty('--slim-h', slimH + 'px');
    check();
  }
  const onMove = () => { if (!queued) { queued = true; requestAnimationFrame(check); } };
  addEventListener('scroll', onMove, { passive: true });
  addEventListener('resize', () => { if (list) watch(); });

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
