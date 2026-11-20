(function () {
  const { THEMES, setTheme, gift, logo, esc, money, $, api, problem, toast, open, close, confirmBox, busy } = WB;
  const app = $('app');
  let lists = [], listId = null, filter = 'all';
  try { listId = Number(sessionStorage.getItem('wb.list')) || null; } catch (_) {}

  const resN = it => it.reservations.reduce((s, r) => s + r.count, 0);
  const leftOf = it => Math.max(0, it.qty - resN(it));
  const priceLine = it => it.price === null ? '' : it.qty > 1 ? `${money(it.price)} <span class="each">each</span>` : money(it.price);
  const cur = () => lists.find(l => l.id === listId);
  // Whether everything is allowed on this list (delete it, choose collaborators): its owner, or an admin working in a user's lists
  const full = l => l.mine || !!viewing;
  // The list's collaborators by name, without the signed-in user
  const others = l => l.collaborators.map(c => c.name).filter(n => viewing || n !== me);
  // The server names the public address, so links copied from a preview deployment still work for guests
  let publicUrl = '';
  const guestLink = l => (publicUrl || location.origin) + '/l/' + l.slug;
  const pick = id => { listId = id; try { sessionStorage.setItem('wb.list', id); } catch (_) {} };
  let me = '', theme = 'pink', isAdmin = false, view = 'lists', users = [];
  let viewing = null; // admin working in another user's lists: { id, name }
  const top = signedIn => `<header class="top"><div class="brand">${logo}Wishbox</div>${signedIn ? `<div class="share">${isAdmin ? `<button class="link-btn" id="nav">${view === 'users' ? 'My lists' : viewing ? 'Back to users' : 'Users'}</button>` : ''}<button class="link-btn" id="theme">Colour</button><button class="link-btn" id="logout">${me ? esc(me) + ' · ' : ''}Sign out</button></div>` : ''}</header>`;

  /* Any admin call can find the session expired: go back to the login screen */
  async function call(method, url, body) {
    try { return await api(method, url, body); }
    catch (e) { if (e.status === 401 && e.code === 'not_signed_in') { close(); login(); } throw e; }
  }

  async function start() {
    try {
      const r = await api('GET', '/api/admin/me');
      if (!r.admin) return login();
      me = r.name; isAdmin = r.isAdmin; theme = setTheme(r.theme); publicUrl = r.publicUrl || '';
      await refresh();
    } catch (e) { app.innerHTML = top(false) + `<div class="empty"><h3>Couldn't load</h3>${esc(problem(e))}</div>`; }
  }

  function login() {
    lists = []; users = []; view = 'lists'; viewing = null; isAdmin = false; pick(null);
    app.innerHTML = top(false) + `<div class="center"><form class="panel" id="lg" novalidate>
      <div><div class="eyebrow">Your gift lists</div><h1>Sign in</h1></div>
      <div class="field"><label for="un">Username</label><input id="un" autocomplete="username" autocapitalize="words" maxlength="30"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" maxlength="200"></div>
      <div class="err" id="lge" role="alert"></div>
      <button class="btn primary" id="lgo">Sign in</button></form></div>`;
    $('lg').onsubmit = e => {
      e.preventDefault();
      busy($('lgo'), async () => {
        try {
          const r = await api('POST', '/api/admin/login', { name: $('un').value, password: $('pw').value });
          me = r.name; isAdmin = r.isAdmin; theme = setTheme(r.theme); publicUrl = r.publicUrl || ''; filter = 'all';
          await refresh();
        } catch (x) { const el = $('lge'); if (el) el.textContent = x.code === 'wrong_login' ? 'That username or password isn’t right.' : problem(x); }
      });
    };
    $('un').focus();
  }

  async function refresh() {
    if (view === 'users') { users = (await call('GET', '/api/admin/users')).users; return renderUsers(); }
    lists = (await call('GET', viewing ? `/api/admin/users/${viewing.id}/lists` : '/api/admin/lists')).lists;
    if (!cur()) pick(lists[0]?.id || null);
    render();
  }

  function statusPill(it) {
    const r = resN(it), lf = leftOf(it);
    if (!r) return '<span class="pill ok">Available</span>';
    if (!lf) return `<span class="pill taken">${it.qty > 1 ? 'Fully reserved' : 'Reserved'}</span>`;
    return `<span class="pill taken">${r} of ${it.qty} reserved</span>`;
  }
  const pic = it => `<div class="pic">${it.photo ? `<img src="${esc(it.photo)}" alt="" loading="lazy">` : gift}${it.qty > 1 ? `<span class="qty">${it.qty} total</span>` : ''}</div>`;

  function render() {
    const l = cur();
    let h = top(true) + `<nav class="lists" aria-label="Your lists">${lists.map(x => `<button class="chip" data-list="${x.id}" aria-current="${x.id === listId}">${esc(x.name)}</button>`).join('')}${viewing ? '' : '<button class="chip" id="new-list">+ New list</button>'}</nav>`;
    if (viewing) h = top(true) + `<p class="viewing">Viewing <b>${esc(viewing.name)}</b>’s lists. Changes you make here change their lists.</p>` + h.slice(top(true).length);
    if (!l) h += viewing ? `<div class="empty"><h3>No lists yet</h3>${esc(viewing.name)} hasn't created a list.</div>` : `<div class="empty"><h3>No lists yet</h3>Create your first list, then add the gifts you'd like.</div>`;
    else {
      const taken = l.items.filter(i => leftOf(i) === 0).length, avail = l.items.length - taken;
      const shown = l.items.filter(i => filter === 'all' || (filter === 'taken' ? resN(i) > 0 : leftOf(i) > 0))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })); // A–Z, like the guest page
      h += `<section class="panel">
        <div class="panel-head"><div><div class="eyebrow">Gift list${l.mine ? '' : ' · shared by ' + esc(l.owner)}</div><h2>${esc(l.name)}</h2>${others(l).length ? `<p class="hint">${l.mine || viewing ? 'Shared with' : 'Also shared with'} ${esc(others(l).join(', '))}</p>` : ''}</div>
          <div class="share"><button class="btn ghost" id="edit-list">Rename</button><button class="btn primary" id="add-item">+ Add item</button></div></div>
        <div class="stats"><span><b>${l.items.length}</b>items</span><span><b>${avail}</b>available</span><span><b>${taken}</b>reserved</span></div>
        <div class="share"><button class="btn" id="copy-link">Copy guest link</button><a class="btn ghost" href="/l/${esc(l.slug)}" target="_blank" rel="noopener">Preview as guest</a>${full(l) ? '<button class="btn ghost" id="collab">Collaborators</button>' : '<button class="btn ghost" id="leave">Leave list</button>'}</div>
        <div class="filters" role="group" aria-label="Filter">${['all', 'available', 'taken'].map(f => `<button class="chip" data-filter="${f}" aria-current="${filter === f}">${f === 'all' ? 'All' : f === 'available' ? 'Available' : 'Reserved'}</button>`).join('')}</div>
      </section>`;
      if (!l.items.length) h += `<div class="empty"><h3>This list is empty</h3>Tap “Add item” to add the first gift: a name, price, shop link and photo.</div>`;
      else if (!shown.length) h += `<div class="empty">Nothing here for this filter.</div>`;
      else h += `<div class="grid">${shown.map(it => `<article class="card">${pic(it)}<div class="card-body">
        <div class="meta">${statusPill(it)}</div>
        <h3>${esc(it.name)}</h3>
        <div class="price">${priceLine(it)}</div>
        ${it.reservations.length ? `<div class="who-list">${it.reservations.map(r => `<div class="who"><div><strong>${esc(r.name)}${it.qty > 1 ? ` · ×${r.count}` : ''}</strong><span class="num">${esc(r.mobile)}</span><span>${new Date(r.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div><button class="rel" data-release="${it.id}|${r.id}">Release</button></div>`).join('')}</div>` : ''}
        <div class="row"><button class="btn primary" data-edit="${it.id}">Edit</button>${it.link ? `<a class="shoplink" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">View in shop</a>` : '<span class="shoplink none" aria-hidden="true">&nbsp;</span>'}</div>
      </div></article>`).join('')}</div>`;
    }
    app.innerHTML = h;
    bind();
  }

  function bind() {
    const on = (id, f) => { const e = $(id); if (e) e.onclick = f; };
    const item = id => cur().items.find(i => String(i.id) === id);
    on('logout', async () => { try { await api('POST', '/api/admin/logout', {}); } catch (_) {} login(); });
    on('theme', themePicker);
    on('nav', () => { view = view === 'users' ? 'lists' : 'users'; viewing = null; lists = []; pick(null); refresh().catch(e => toast(problem(e))); });
    on('new-list', () => listForm());
    on('edit-list', () => listForm(cur()));
    on('collab', () => collabForm());
    on('leave', () => { const l = cur(); confirmBox('Leave “' + l.name + '”?', 'You won’t see or edit this list any more. ' + l.owner + ' can add you again.', 'Leave list',
      () => act(() => call('DELETE', `/api/admin/lists/${l.id}/collaborators/${l.collaborators.find(c => c.name === me).id}`), 'You left the list')); });
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

  /* Tapping a colour shows it straight away and saves it for this user and their guest pages */
  function themePicker() {
    open(`<h2>Colour</h2><p>Your pages and the lists your guests open use this colour.</p>
      <div class="swatches">${THEMES.map(([k, label]) => `<button type="button" class="swatch" data-theme="${k}" aria-pressed="${k === theme}"><i></i>${label}</button>`).join('')}</div>
      <div class="actions"><button class="btn primary" data-close>Done</button></div>`, sh => {
      sh.querySelectorAll('.swatch').forEach(b => (b.onclick = async () => {
        const before = theme;
        theme = setTheme(b.dataset.theme);
        sh.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        try { await call('PATCH', '/api/admin/me', { theme }); }
        catch (e) {
          theme = setTheme(before);
          sh.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.theme === theme)));
          if (e.status !== 401) toast(problem(e));
        }
      }));
    });
  }

  /* ---------- users (admins only) ---------- */
  function renderUsers() {
    app.innerHTML = top(true) + `<section class="panel">
      <div class="panel-head"><div><div class="eyebrow">Admin</div><h2>Users</h2></div><button class="btn primary" id="add-user">+ Add user</button></div>
      <p class="hint">Create a username and password for each person, then send them both. Each person sees only their own lists and the ones shared with them; you can open and edit anyone’s with “Lists”.</p>
      <div class="user-list">${users.map(u => `<div class="user"><div><strong>${esc(u.name)}</strong>${u.admin ? ' <span class="pill ok">Admin</span>' : ''}<span>${u.lists} ${u.lists === 1 ? 'list' : 'lists'}</span></div><div class="share"><button class="btn" data-lists="${u.id}">Lists</button><button class="btn" data-user="${u.id}">Manage</button></div></div>`).join('')}</div>
    </section>`;
    bind();
    $('add-user').onclick = () => userForm();
    app.querySelectorAll('[data-user]').forEach(b => (b.onclick = () => userForm(users.find(u => String(u.id) === b.dataset.user))));
    app.querySelectorAll('[data-lists]').forEach(b => (b.onclick = () => {
      const u = users.find(x => String(x.id) === b.dataset.lists);
      viewing = { id: u.id, name: u.name }; view = 'lists'; lists = []; pick(null); filter = 'all';
      refresh().catch(e => toast(problem(e)));
    }));
  }

  const userProblem = x => x.code === 'name_taken' ? 'That username is taken. Try another one.'
    : x.code === 'bad_name' ? 'Usernames are 2 to 30 letters or numbers (spaces, dots and dashes are fine).'
    : x.code === 'bad_password' ? 'The password needs at least 8 characters.'
    : x.code === 'is_admin' ? 'Admins can’t be deleted here.'
    : problem(x);

  /* u given: set a new password or delete. Otherwise: create a user. The password is shown so it can be passed on. */
  function userForm(u) {
    open(`<h2>${u ? esc(u.name) : 'Add user'}</h2>
    <form id="uf" novalidate>
      ${u ? '' : '<div class="field"><label for="uname">Username</label><input id="uname" maxlength="30" autocomplete="off" autocapitalize="words"></div>'}
      <div class="field"><label for="upw">${u ? 'New password' : 'Password'}</label><input id="upw" maxlength="200" autocomplete="off" autocapitalize="none" spellcheck="false">
        <span class="hint">At least 8 characters. ${u ? 'They’ll be signed out and need the new one.' : 'Note it down: it isn’t shown again.'}</span></div>
      <div class="err" id="ue" role="alert"></div>
      <div class="actions">${u && !u.admin ? '<button type="button" class="btn danger left" id="udel">Delete user</button>' : ''}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ugo">${u ? 'Set password' : 'Create user'}</button></div>
    </form>`, () => {
      $('uf').onsubmit = e => {
        e.preventDefault();
        const name = u ? '' : $('uname').value.trim(), password = $('upw').value, err = $('ue');
        if (!u && name.length < 2) { err.textContent = 'Give the user a username of at least 2 characters.'; return; }
        if (password.length < 8) { err.textContent = 'The password needs at least 8 characters.'; return; }
        busy($('ugo'), async () => {
          try {
            if (u) await call('PATCH', '/api/admin/users/' + u.id, { password });
            else await call('POST', '/api/admin/users', { name, password });
            close(); await refresh(); toast(u ? 'Password changed' : 'User created');
          } catch (x) { if ($('ue')) $('ue').textContent = userProblem(x); }
        });
      };
      const d = $('udel');
      if (d) d.onclick = () => confirmBox('Delete ' + u.name + '?', u.lists ? 'Their ' + (u.lists === 1 ? 'list' : u.lists + ' lists') + ', items and all reservations will be removed. Guests with the links will no longer see them.' : 'They will no longer be able to sign in.',
        'Delete user', () => act(() => call('DELETE', '/api/admin/users/' + u.id), 'User deleted'));
    });
  }

  /* Run a change, then reload the lists and say what happened */
  async function act(fn, msg) {
    try { await fn(); await refresh(); toast(msg); }
    catch (e) { if (e.status !== 401) { toast(e.code === 'is_admin' ? userProblem(e) : problem(e)); refresh().catch(() => {}); } }
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
      <div class="actions">${l && full(l) ? '<button type="button" class="btn danger left" id="ldel">Delete list</button>' : ''}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" id="lgo">${l ? 'Save' : 'Create list'}</button></div>
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

  /* The owner chooses who else can edit the current list, by username */
  function collabForm() {
    const l = cur();
    open(`<h2>Collaborators</h2><p>People you add can see “${esc(l.name)}”, its reservations, and add or edit its gifts. Only ${viewing ? 'the owner or an admin' : 'you'} can delete the list.</p>
      ${l.collaborators.length ? `<div class="user-list">${l.collaborators.map(c => `<div class="user"><div><strong>${esc(c.name)}</strong></div><button type="button" class="btn" data-remove="${c.id}">Remove</button></div>`).join('')}</div>` : ''}
      <form id="cf2" novalidate>
        <div class="field"><label for="cn">Add by username</label><input id="cn" maxlength="30" autocomplete="off" autocapitalize="words"></div>
        <div class="err" id="ce" role="alert"></div>
        <div class="actions"><button type="button" class="btn ghost" data-close>Done</button><button class="btn primary" id="cgo">Add</button></div>
      </form>`, sh => {
      // After a change, show the sheet again with the new list of people
      const again = async msg => { await refresh(); toast(msg); if (cur()?.id === l.id) collabForm(); else close(); };
      $('cf2').onsubmit = e => {
        e.preventDefault();
        const name = $('cn').value.trim();
        if (!name) { $('ce').textContent = 'Type the person’s username.'; return; }
        busy($('cgo'), async () => {
          try { const r = await call('POST', `/api/admin/lists/${l.id}/collaborators`, { name }); await again(r.name + ' can now edit this list'); }
          catch (x) {
            if ($('ce')) $('ce').textContent = x.code === 'no_such_user' ? 'There’s no user with that username.'
              : x.code === 'is_owner' ? 'That’s the owner: it’s already their list.' : problem(x);
          }
        });
      };
      sh.querySelectorAll('[data-remove]').forEach(b => (b.onclick = () => busy(b, async () => {
        try { await call('DELETE', `/api/admin/lists/${l.id}/collaborators/${b.dataset.remove}`); await again('Removed'); }
        catch (x) { if (x.status !== 401 && $('ce')) $('ce').textContent = problem(x); }
      })));
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
        <div class="side"><input id="iph" type="file" accept="image/*"><button type="button" class="btn ghost" id="pph">Paste picture</button><button type="button" class="btn ghost" id="rmph" ${it?.photo ? '' : 'hidden'}>Remove picture</button></div></div>
        <span class="hint">Copy a picture or screenshot and paste it here (Ctrl+V / ⌘V), or choose a file.</span></div>
      <div class="err" id="ie" role="alert"></div>
      <div class="actions">${it ? '<button type="button" class="btn danger left" id="idel">Delete</button>' : ''}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" id="igo">${it ? 'Save' : 'Add to list'}</button></div>
    </form>`, () => {
      const th = $('th'), rm = $('rmph'), err = $('ie');
      const use = async f => {
        try { photo = await shrink(f); th.innerHTML = thumb(photo); rm.hidden = false; err.textContent = ''; }
        catch (_) { err.textContent = 'That picture couldn’t be read. Try a JPG or PNG.'; }
      };
      $('iph').onchange = e => { const f = e.target.files[0]; if (f) use(f); };
      // Paste anywhere while the form is open; text pastes into fields are left alone
      const form = $('if');
      const onPaste = e => {
        if (!form.isConnected) { document.removeEventListener('paste', onPaste); return; }
        const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
        if (!f) return;
        e.preventDefault(); $('iph').value = ''; use(f);
      };
      document.addEventListener('paste', onPaste);
      // Button for phones and for people who don't use the keyboard shortcut
      $('pph').onclick = async () => {
        try {
          for (const ci of await navigator.clipboard.read()) {
            const t = ci.types.find(x => x.startsWith('image/'));
            if (t) { $('iph').value = ''; return use(await ci.getType(t)); }
          }
          err.textContent = 'There is no picture in the clipboard. Copy one first.';
        } catch (_) { err.textContent = 'The clipboard couldn’t be read. Press Ctrl+V (⌘V on Mac) instead.'; }
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
