(function () {
  const { gift, esc, money, $, api, problem, toast, open, close, confirmBox, busy } = WB;
  const app = $('app');
  let lists = [], listId = null, filter = 'all';
  try { listId = Number(sessionStorage.getItem('wb.list')) || null; } catch (_) {}

  const resN = it => it.reservations.reduce((s, r) => s + r.count, 0);
  const leftOf = it => Math.max(0, it.qty - resN(it));
  const priceLine = it => it.price === null ? '' : it.qty > 1 ? `${money(it.price)} <span class="each">each</span>` : money(it.price);
  const cur = () => lists.find(l => l.id === listId);
  const guestLink = l => location.origin + '/l/' + l.slug;
  const pick = id => { listId = id; try { sessionStorage.setItem('wb.list', id); } catch (_) {} };
  let me = '';
  const top = signedIn => `<header class="top"><div class="brand">${gift}Wishbox</div>${signedIn ? `<button class="link-btn" id="logout">${me ? esc(me) + ' · ' : ''}Sign out</button>` : ''}</header>`;

  /* Any admin call can find the session expired: go back to the login screen */
  async function call(method, url, body) {
    try { return await api(method, url, body); }
    catch (e) { if (e.status === 401 && e.code === 'not_signed_in') { close(); login(); } throw e; }
  }

  async function start() {
    try {
      const r = await api('GET', '/api/admin/me');
      if (!r.admin) return login();
      me = r.name;
      await refresh();
    } catch (e) { app.innerHTML = top(false) + `<div class="empty"><h3>Couldn't load</h3>${esc(problem(e))}</div>`; }
  }

  function login() {
    app.innerHTML = top(false) + `<div class="center"><form class="panel" id="lg" novalidate>
      <div><div class="eyebrow">Admin</div><h1>Sign in</h1></div>
      <div class="field"><label for="un">Name</label><input id="un" autocomplete="username" autocapitalize="words" maxlength="60"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"></div>
      <div class="err" id="lge" role="alert"></div>
      <button class="btn primary" id="lgo">Sign in</button></form></div>`;
    $('lg').onsubmit = e => {
      e.preventDefault();
      busy($('lgo'), async () => {
        try { me = (await api('POST', '/api/admin/login', { name: $('un').value, password: $('pw').value })).name; await refresh(); }
        catch (x) { const el = $('lge'); if (el) el.textContent = x.code === 'wrong_login' ? 'That name or password isn’t right.' : problem(x); }
      });
    };
    $('un').focus();
  }

  async function refresh() {
    lists = (await call('GET', '/api/admin/lists')).lists;
    if (!cur()) pick(lists[0]?.id || null);
    render();
  }

  function statusPill(it) {
    const r = resN(it), lf = leftOf(it);
    if (!r) return '<span class="pill ok">Available</span>';
    if (!lf) return `<span class="pill taken">${it.qty > 1 ? 'Fully reserved' : 'Reserved'}</span>`;
    return `<span class="pill taken">${r} of ${it.qty} reserved</span>`;
  }
  const pic = it => `<div class="pic">${it.photo ? `<img src="${esc(it.photo)}" alt="" loading="lazy">` : gift}${it.qty > 1 ? `<span class="qty">× ${it.qty}<small>total</small></span>` : ''}</div>`;

  function render() {
    const l = cur();
    let h = top(true) + `<nav class="lists" aria-label="Your lists">${lists.map(x => `<button class="chip" data-list="${x.id}" aria-current="${x.id === listId}">${esc(x.name)}</button>`).join('')}<button class="chip" id="new-list">+ New list</button></nav>`;
    if (!l) h += `<div class="empty"><h3>No lists yet</h3>Create your first list, then add the gifts you'd like.</div>`;
    else {
      const taken = l.items.filter(i => leftOf(i) === 0).length, avail = l.items.length - taken;
      const shown = l.items.filter(i => filter === 'all' || (filter === 'taken' ? resN(i) > 0 : leftOf(i) > 0));
      h += `<section class="panel">
        <div class="panel-head"><div><div class="eyebrow">Gift list</div><h2>${esc(l.name)}</h2></div>
          <div class="share"><button class="btn ghost" id="edit-list">Rename</button><button class="btn primary" id="add-item">+ Add item</button></div></div>
        <div class="stats"><span><b>${l.items.length}</b>items</span><span><b>${avail}</b>available</span><span><b>${taken}</b>reserved</span></div>
        <div class="share"><button class="btn" id="copy-link">Copy guest link</button><a class="btn ghost" href="/l/${esc(l.slug)}" target="_blank" rel="noopener">Preview as guest</a></div>
        <div class="filters" role="group" aria-label="Filter">${['all', 'available', 'taken'].map(f => `<button class="chip" data-filter="${f}" aria-current="${filter === f}">${f === 'all' ? 'All' : f === 'available' ? 'Available' : 'Reserved'}</button>`).join('')}</div>
      </section>`;
      if (!l.items.length) h += `<div class="empty"><h3>This list is empty</h3>Tap “Add item” to add the first gift: a name, price, shop link and photo.</div>`;
      else if (!shown.length) h += `<div class="empty">Nothing here for this filter.</div>`;
      else h += `<div class="grid">${shown.map(it => `<article class="card">${pic(it)}<div class="card-body">
        <div class="meta">${statusPill(it)}</div>
        <h3>${esc(it.name)}</h3>
        <div class="meta"><span class="price">${priceLine(it)}</span></div>
        ${it.reservations.length ? `<div class="who-list">${it.reservations.map(r => `<div class="who"><div><strong>${esc(r.name)}${it.qty > 1 ? ` · ×${r.count}` : ''}</strong><span class="num">${esc(r.mobile)}</span><span>${new Date(r.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div><button class="rel" data-release="${it.id}|${r.id}">Release</button></div>`).join('')}</div>` : ''}
        <div class="row">${it.link ? `<a class="btn" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">Shop</a>` : ''}<button class="btn" data-edit="${it.id}">Edit</button></div>
      </div></article>`).join('')}</div>`;
    }
    app.innerHTML = h;
    bind();
  }

  function bind() {
    const on = (id, f) => { const e = $(id); if (e) e.onclick = f; };
    const item = id => cur().items.find(i => String(i.id) === id);
    on('logout', async () => { try { await api('POST', '/api/admin/logout', {}); } catch (_) {} login(); });
    on('new-list', () => listForm());
    on('edit-list', () => listForm(cur()));
    on('add-item', () => itemForm());
    on('copy-link', () => {
      const t = guestLink(cur());
      try { navigator.clipboard.writeText(t).then(() => toast('Link copied'), () => showLink(t)); } catch (_) { showLink(t); }
    });
    app.querySelectorAll('[data-list]').forEach(b => (b.onclick = () => { pick(Number(b.dataset.list)); filter = 'all'; render(); }));
    app.querySelectorAll('[data-filter]').forEach(b => (b.onclick = () => { filter = b.dataset.filter; render(); }));
    app.querySelectorAll('[data-edit]').forEach(b => (b.onclick = () => itemForm(item(b.dataset.edit))));
    app.querySelectorAll('[data-release]').forEach(b => (b.onclick = () => {
      const [iid, rid] = b.dataset.release.split('|'); const it = item(iid); const r = it.reservations.find(x => String(x.id) === rid);
      confirmBox('Release ' + r.name + '’s reservation?',
        it.qty > 1 ? (r.count + ' ' + (r.count > 1 ? 'pieces go' : 'piece goes') + ' back on the guest list. Other reservations stay as they are.') : 'The gift goes back on the guest list.',
        'Release', () => act(() => call('DELETE', '/api/admin/reservations/' + r.id), 'Released'));
    }));
  }

  /* Run a change, then reload the lists and say what happened */
  async function act(fn, msg) {
    try { await fn(); await refresh(); toast(msg); }
    catch (e) { if (e.status !== 401) { toast(problem(e)); refresh().catch(() => {}); } }
  }

  function showLink(t) {
    open(`<h2>Guest link</h2><p>Your phone blocked automatic copying. Press and hold the link to copy it.</p><code class="linkbox">${esc(t)}</code><div class="actions"><button class="btn primary" data-close>Done</button></div>`);
  }

  function listForm(l) {
    open(`<h2>${l ? 'Rename list' : 'New list'}</h2>
    <form id="lf" novalidate>
      <div class="field"><label for="ln">List name</label><input id="ln" maxlength="60" placeholder="e.g. Birthday 2027" value="${esc(l?.name || '')}"></div>
      <div class="field"><label for="lnote">Message to guests <i>(optional)</i></label><input id="lnote" maxlength="160" value="${esc(l?.note || '')}"></div>
      <div class="err" id="le" role="alert"></div>
      <div class="actions">${l ? '<button type="button" class="btn danger left" id="ldel">Delete list</button>' : ''}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" id="lgo">${l ? 'Save' : 'Create list'}</button></div>
    </form>`, () => {
      $('lf').onsubmit = e => {
        e.preventDefault();
        const name = $('ln').value.trim(), note = $('lnote').value.trim(), err = $('le');
        if (!name) { err.textContent = 'Give the list a name.'; return; }
        busy($('lgo'), async () => {
          try {
            if (l) await call('PATCH', '/api/admin/lists/' + l.id, { name, note });
            else { const r = await call('POST', '/api/admin/lists', { name, note }); pick(r.id); filter = 'all'; }
            close(); await refresh(); toast(l ? 'List saved' : 'List created');
          } catch (x) { if ($('le')) $('le').textContent = problem(x); }
        });
      };
      const d = $('ldel');
      if (d) d.onclick = () => confirmBox('Delete “' + l.name + '”?', 'The list, its items and all reservations will be removed. Guests with the link will no longer see it.', 'Delete list',
        () => act(() => call('DELETE', '/api/admin/lists/' + l.id), 'List deleted'));
    });
  }

  /* Resize to at most 640px JPEG before upload */
  function shrink(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => {
        const im = new Image();
        im.onload = () => {
          const m = 640, s = Math.min(1, m / Math.max(im.width, im.height));
          const c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
          const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', .78));
        };
        im.onerror = rej; im.src = fr.result;
      };
      fr.onerror = rej; fr.readAsDataURL(file);
    });
  }

  function itemForm(it) {
    // undefined = keep the current picture, null = remove it, data URL = new upload
    let photo;
    const thumb = src => src ? `<img src="${esc(src)}" alt="">` : gift;
    open(`<h2>${it ? 'Edit item' : 'Add item'}</h2>
    <form id="if" novalidate>
      <div class="field"><label for="in">Item name</label><input id="in" maxlength="80" placeholder="e.g. Baby car seat" value="${esc(it?.name || '')}"></div>
      <div class="two"><div class="field"><label for="ip">Price per piece (EGP)</label><input id="ip" type="number" inputmode="decimal" min="0" step="any" value="${it?.price ?? ''}"></div>
      <div class="field"><label for="iq">Quantity</label><input id="iq" type="number" inputmode="numeric" min="1" max="999" value="${it?.qty || 1}"></div></div>
      <div class="field"><label for="il">Shop link</label><input id="il" type="url" inputmode="url" placeholder="https://" maxlength="2000" value="${esc(it?.link || '')}"></div>
      <div class="field"><label for="iph">Picture</label><div class="photo-pick"><div class="thumb" id="th">${thumb(it?.photo)}</div>
        <div class="side"><input id="iph" type="file" accept="image/*"><button type="button" class="btn ghost" id="rmph" ${it?.photo ? '' : 'hidden'}>Remove picture</button></div></div>
        <span class="hint">Take a screenshot from the shop page and upload it here.</span></div>
      <div class="err" id="ie" role="alert"></div>
      <div class="actions">${it ? '<button type="button" class="btn danger left" id="idel">Delete</button>' : ''}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" id="igo">${it ? 'Save' : 'Add to list'}</button></div>
    </form>`, () => {
      const th = $('th'), rm = $('rmph'), err = $('ie');
      $('iph').onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try { photo = await shrink(f); th.innerHTML = thumb(photo); rm.hidden = false; err.textContent = ''; }
        catch (_) { err.textContent = 'That picture couldn’t be read. Try a JPG or PNG.'; }
      };
      rm.onclick = () => { photo = null; th.innerHTML = gift; rm.hidden = true; $('iph').value = ''; };
      $('if').onsubmit = e => {
        e.preventDefault();
        const name = $('in').value.trim(), price = $('ip').value.trim(), qty = parseInt($('iq').value, 10) || 1, link = $('il').value.trim();
        if (!name) { err.textContent = 'Add a name for the item.'; return; }
        if (price !== '' && !(Number(price) >= 0)) { err.textContent = 'The price should be a number.'; return; }
        if (qty < 1 || qty > 999) { err.textContent = 'Quantity should be between 1 and 999.'; return; }
        if (link && !/^https?:\/\/\S+\.\S+/.test(link)) { err.textContent = 'The shop link should start with https://'; return; }
        if (it && qty < resN(it)) { err.textContent = resN(it) + ' pieces are already reserved, so the quantity can’t be lower than that.'; return; }
        const data = { name, price: price === '' ? null : Number(price), qty, link };
        if (photo !== undefined) data.photo = photo;
        busy($('igo'), async () => {
          try {
            if (it) await call('PATCH', '/api/admin/items/' + it.id, data);
            else await call('POST', `/api/admin/lists/${listId}/items`, data);
            close(); await refresh(); toast(it ? 'Item saved' : 'Item added');
          } catch (x) {
            if (!$('ie')) return;
            $('ie').textContent = x.code === 'qty_below_reserved' ? x.data.reserved + ' pieces are already reserved, so the quantity can’t be lower than that.'
              : x.code === 'photo_too_big' || x.code === 'bad_photo' ? 'That picture couldn’t be saved. Try another one.'
              : x.code === 'photo_store_failed' ? 'The picture storage refused the upload: ' + (x.data.detail || 'unknown reason')
              : x.code === 'bad_link' ? 'The shop link should start with https://'
              : problem(x);
          }
        });
      };
      const d = $('idel');
      if (d) d.onclick = () => confirmBox('Delete “' + it.name + '”?',
        it.reservations.length ? 'This gift has reservations from ' + it.reservations.map(r => r.name).join(', ') + '. Deleting removes them too.' : 'It will be removed from the list.',
        'Delete', () => act(() => call('DELETE', '/api/admin/items/' + it.id), 'Item deleted'));
    });
  }

  start();
})();
