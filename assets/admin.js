/* The admin page: sign in, schedule days, edit passages, moderate comments, settings. */
(function () {
  'use strict';

  var DV = window.DV;
  var sb = DV.sb;
  var esc = DV.esc;
  var cfg = DV.cfg;
  var root = document.getElementById('admin');

  var POST_COLS = 'id,post_date,title,reference,translation,verse_text,reflection,prayer,video_url,updated_at';
  var STORAGE_PREFIX = cfg.supabaseUrl + '/storage/v1/object/public/videos/';
  var MAX_UPLOAD = 50 * 1024 * 1024;
  var TRANSLATIONS = ['NIV', 'ESV'];
  var LAST_TR_KEY = 'dv:translation';
  var OPEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M10 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var recovery = DV.wasRecovery;
  var inDashboard = false;
  var dirty = false;
  var pendingUpload = null; // a video uploaded in the editor but not saved yet
  var lastHash = location.hash;
  var panel = null;
  var seq = 0;

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'form-msg' + (kind ? ' ' + kind : '');
  }
  function siteUrl() {
    return location.origin + location.pathname.replace(/admin\.html$/, '');
  }

  // ================================================================ signing in

  function authShell(inner) {
    inDashboard = false;
    root.innerHTML = '<div class="auth-wrap">' +
      '<a class="brand auth-brand" href="./"><img class="brand-mark" src="assets/icon.svg" alt="" width="40" height="40">' +
      '<span class="brand-title" data-site-title>' + esc(DV.settings().site_title) + '</span></a>' +
      '<div class="card auth-card">' + inner + '</div>' +
      '<p class="center small"><a href="./">← Back to the site</a></p></div>';
  }

  var authMode = null;
  async function showAuth(mode) {
    if (mode && mode === authMode && !inDashboard && root.querySelector('[data-auth="' + mode + '"]')) return;
    if (!mode) {
      root.innerHTML = DV.spinner();
      var r = await sb.rpc('has_admin');
      mode = !r.error && r.data === false ? 'setup' : 'signin';
    }
    if (mode === 'setup') {
      authShell('<h1>Create your admin account</h1>' +
        '<p class="muted">A one-time step. This account is the only one that can add passages — once it exists, nobody else can make one.</p>' +
        '<form class="stack" data-auth="setup" novalidate>' +
          '<div class="field"><label for="s-email">Your email</label><input id="s-email" type="email" name="email" autocomplete="username" required></div>' +
          '<div class="field"><label for="s-pass">Choose a password</label><input id="s-pass" type="password" name="password" autocomplete="new-password" minlength="8" required>' +
            '<small class="hint">At least 8 characters.</small></div>' +
          '<div class="field"><label for="s-pass2">Type it again</label><input id="s-pass2" type="password" name="password2" autocomplete="new-password" minlength="8" required></div>' +
          '<p class="form-msg" data-msg role="status"></p>' +
          '<button class="btn btn-primary btn-block" type="submit">Create account</button>' +
        '</form>');
    } else if (mode === 'forgot') {
      authShell('<h1>Reset your password</h1>' +
        '<p class="muted">Type your email and you’ll get a link to choose a new password.</p>' +
        '<form class="stack" data-auth="forgot" novalidate>' +
          '<div class="field"><label for="f-email">Email</label><input id="f-email" type="email" name="email" autocomplete="username" required></div>' +
          '<p class="form-msg" data-msg role="status"></p>' +
          '<button class="btn btn-primary btn-block" type="submit">Send reset link</button>' +
        '</form>' +
        '<p class="center small"><button type="button" class="link" data-go="signin">Back to sign in</button></p>');
    } else if (mode === 'recover') {
      authShell('<h1>Choose a new password</h1>' +
        '<form class="stack" data-auth="recover" novalidate>' +
          '<div class="field"><label for="r-pass">New password</label><input id="r-pass" type="password" name="password" autocomplete="new-password" minlength="8" required></div>' +
          '<div class="field"><label for="r-pass2">Type it again</label><input id="r-pass2" type="password" name="password2" autocomplete="new-password" minlength="8" required></div>' +
          '<p class="form-msg" data-msg role="status"></p>' +
          '<button class="btn btn-primary btn-block" type="submit">Save new password</button>' +
        '</form>');
    } else {
      authShell('<h1>Admin sign in</h1>' +
        '<form class="stack" data-auth="signin" novalidate>' +
          '<div class="field"><label for="a-email">Email</label><input id="a-email" type="email" name="email" autocomplete="username" required></div>' +
          '<div class="field"><label for="a-pass">Password</label><input id="a-pass" type="password" name="password" autocomplete="current-password" required></div>' +
          '<p class="form-msg" data-msg role="status"></p>' +
          '<button class="btn btn-primary btn-block" type="submit">Sign in</button>' +
        '</form>' +
        '<p class="center small"><button type="button" class="link" data-go="forgot">Forgot your password?</button></p>');
    }
    authMode = mode;
    var go = root.querySelector('[data-go]');
    if (go) go.addEventListener('click', function () { showAuth(go.getAttribute('data-go')); });
    var form = root.querySelector('[data-auth]');
    form.addEventListener('submit', onAuthSubmit);
    var first = form.querySelector('input');
    if (first) first.focus();
  }

  function authError(err) {
    var m = (err && err.message) || '';
    if (/invalid login credentials/i.test(m)) return 'That email and password don’t match.';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox).';
    if (/database error saving new user|sign-?ups? (are )?(closed|not allowed|disabled)|signups? not allowed|already registered|already been registered/i.test(m)) return 'CLOSED';
    if (/password should be|weak password|at least \d+ characters/i.test(m)) return 'Please choose a longer password (at least 8 characters).';
    if (/should be different/i.test(m)) return 'That’s your current password. Choose a new one.';
    if (/rate limit|too many|security purposes/i.test(m)) return 'Too many tries. Please wait a few minutes and try again.';
    if (/invalid.*email|email.*invalid|unable to validate email/i.test(m)) return 'That email address doesn’t look right.';
    return DV.friendly(err);
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var mode = form.getAttribute('data-auth');
    var f = form.elements;
    var msg = form.querySelector('[data-msg]');
    var btn = form.querySelector('button[type=submit]');
    var email = f.email ? f.email.value.trim() : '';
    var password = f.password ? f.password.value : '';

    if (f.email && !/^\S+@\S+\.\S+$/.test(email)) { setMsg(msg, 'Please type your email address.', 'err'); f.email.focus(); return; }
    if ((mode === 'setup' || mode === 'recover') && password.length < 8) { setMsg(msg, 'Please choose a password of at least 8 characters.', 'err'); f.password.focus(); return; }
    if ((mode === 'setup' || mode === 'recover') && password !== f.password2.value) { setMsg(msg, 'The two passwords don’t match.', 'err'); f.password2.focus(); return; }
    if (mode === 'signin' && !password) { setMsg(msg, 'Please type your password.', 'err'); f.password.focus(); return; }

    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    setMsg(msg, '');
    var res;
    try {
      if (mode === 'signin') res = await sb.auth.signInWithPassword({ email: email, password: password });
      else if (mode === 'setup') res = await sb.auth.signUp({ email: email, password: password });
      else if (mode === 'forgot') res = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      else res = await sb.auth.updateUser({ password: password });
    } catch (err) {
      res = { error: err };
    }
    btn.disabled = false;
    btn.textContent = label;

    if (res.error) {
      var m = authError(res.error);
      if (m === 'CLOSED') {
        await showAuth('signin');
        setMsg(root.querySelector('[data-msg]'), 'An admin account already exists, so please sign in.', 'err');
        return;
      }
      setMsg(msg, m, 'err');
      return;
    }
    if (mode === 'forgot') {
      setMsg(msg, 'If that’s the admin email, a reset link is on its way. Check your spam folder too.', 'ok');
      return;
    }
    if (mode === 'setup' && !(res.data && res.data.session)) {
      setMsg(msg, 'Nearly there: check your email for a link to confirm your account, then come back and sign in.', 'ok');
      return;
    }
    if (mode === 'recover') {
      recovery = false;
      DV.toast('New password saved');
    }
    enter();
  }

  async function enter() {
    root.innerHTML = DV.spinner();
    var s = await sb.auth.getSession();
    if (!s.data.session) return showAuth();
    var r = await sb.rpc('is_admin');
    if (r.error) {
      authShell('<h1>Couldn’t check your account</h1><p class="muted">' + esc(DV.friendly(r.error)) + '</p>' +
        '<div class="row"><button class="btn btn-primary" type="button" data-retry>Try again</button><button class="btn" type="button" data-signout>Sign out</button></div>');
      root.querySelector('[data-retry]').addEventListener('click', enter);
      root.querySelector('[data-signout]').addEventListener('click', signOut);
      return;
    }
    if (r.data !== true) {
      authShell('<h1>Not the admin account</h1><p class="muted">You’re signed in as ' + esc(s.data.session.user.email || 'someone') +
        ', but this account can’t edit the site.</p><button class="btn" type="button" data-signout>Sign out</button>');
      root.querySelector('[data-signout]').addEventListener('click', signOut);
      return;
    }
    showDashboard();
  }

  async function signOut() {
    if (dirty && !confirm('You have unsaved changes. Sign out anyway?')) return;
    leaveEditor();
    inDashboard = false;
    await sb.auth.signOut();
    showAuth('signin');
  }

  // ================================================================ dashboard frame

  var TABS = [['schedule', 'Schedule'], ['days', 'All days'], ['comments', 'Comments'], ['settings', 'Settings']];

  function showDashboard() {
    inDashboard = true;
    root.innerHTML =
      '<header class="admin-head"><div class="wrap wide admin-head-in">' +
        '<a class="brand" href="./" target="_blank" rel="noopener"><img class="brand-mark" src="assets/icon.svg" alt="" width="36" height="36">' +
          '<span class="brand-text"><span class="eyebrow">Admin</span><span class="brand-title" data-site-title>' + esc(DV.settings().site_title) + '</span></span></a>' +
        '<div class="admin-head-actions"><a class="btn btn-quiet" href="./" target="_blank" rel="noopener">View site</a>' +
          '<button class="btn btn-quiet" type="button" data-signout>Sign out</button></div>' +
      '</div>' +
      '<nav class="wrap wide admin-tabs" aria-label="Admin sections">' +
        TABS.map(function (t) { return '<a href="#' + t[0] + '" data-tab="' + t[0] + '">' + t[1] + '</a>'; }).join('') +
      '</nav></header>' +
      '<main class="wrap wide admin-main" id="panel" tabindex="-1"></main>';
    panel = document.getElementById('panel');
    root.querySelector('[data-signout]').addEventListener('click', signOut);
    lastHash = location.hash;
    showPanel();
  }

  function parseRoute() {
    var h = location.hash.replace(/^#/, '');
    if (/access_token|type=|error/.test(h)) h = '';
    var m = h.match(/^edit\/(\d{4}-\d{2}-\d{2})$/);
    if (m) return { name: 'edit', date: m[1] };
    if (h === 'new') return { name: 'new' };
    for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === h) return { name: h };
    return { name: 'schedule' };
  }

  function showPanel() {
    var my = ++seq;
    var r = parseRoute();
    root.querySelectorAll('[data-tab]').forEach(function (a) {
      if (a.getAttribute('data-tab') === r.name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    if (r.name === 'edit' || r.name === 'new') return showEditor(my, r.date || null);
    if (r.name === 'days') return showDays(my);
    if (r.name === 'comments') return showComments(my);
    if (r.name === 'settings') return showSettings();
    return showSchedule(my);
  }

  function leaveEditor() {
    dirty = false;
    if (pendingUpload) {
      removeUpload(pendingUpload);
      pendingUpload = null;
    }
  }

  window.addEventListener('hashchange', function () {
    if (!inDashboard) return;
    if (dirty && !confirm('You have unsaved changes. Leave without saving?')) {
      history.replaceState(null, '', lastHash || '#schedule');
      return;
    }
    leaveEditor();
    lastHash = location.hash;
    showPanel();
  });
  window.addEventListener('beforeunload', function (e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function panelError(error) {
    panel.innerHTML = '<div class="empty"><h1>Couldn’t load this</h1><p class="muted">' + esc(DV.friendly(error)) +
      ' <button type="button" class="link" data-reload>Try again</button></p></div>';
    panel.querySelector('[data-reload]').addEventListener('click', showPanel);
  }

  function statusChip(date, today) {
    if (date > today) return '<span class="chip chip-scheduled">Scheduled</span>';
    if (date === today) return '<span class="chip chip-live">Live today</span>';
    return '<span class="chip">Published</span>';
  }

  function adminRowHtml(p, today) {
    var n = p.comments && p.comments[0] ? p.comments[0].count : 0;
    return '<li><a class="post-row" href="#edit/' + p.post_date + '">' +
      '<span class="pr-date"><span class="pr-num">' + Number(p.post_date.slice(8)) + '</span><span class="pr-wd">' +
        esc(DV.fmtDate(p.post_date, { month: 'short' })) + '</span></span>' +
      '<span class="pr-main"><span class="pr-ref">' + esc(p.reference) +
        (p.title ? ' <span class="pr-title">· ' + esc(p.title) + '</span>' : '') + '</span>' +
        '<span class="pr-snippet">' + esc(DV.fmtDate(p.post_date)) + '</span></span>' +
      '<span class="pr-meta">' + (n ? '<span class="pr-count" title="Comments">' + n + ' comment' + (n === 1 ? '' : 's') + '</span>' : '') +
        statusChip(p.post_date, today) + '</span></a></li>';
  }

  // ================================================================ schedule

  async function showSchedule(my) {
    panel.innerHTML = DV.spinner();
    var today = DV.ukToday();
    var res = await sb.from('posts').select('id,post_date,title,reference,video_url').gte('post_date', today).order('post_date').limit(1000);
    if (my !== seq) return;
    if (res.error) return panelError(res.error);
    var by = {};
    res.data.forEach(function (p) { by[p.post_date] = p; });
    var days = [];
    for (var i = 0; i < 14; i++) days.push(DV.addDays(today, i));
    var ready = 0;
    while (ready < days.length && by[days[ready]]) ready++;
    var summary;
    if (ready === 0) summary = '<strong>Today is still empty.</strong> Click it below to add today’s passage.';
    else if (ready === 1) summary = 'Today is done. <strong>Tomorrow is still empty.</strong>';
    else if (ready >= days.length) summary = 'You’re all set for the next two weeks.';
    else summary = 'You’re ready up to ' + esc(DV.fmtDate(days[ready - 1], { weekday: 'long', day: 'numeric', month: 'long' })) + '.';
    var later = res.data.filter(function (p) { return p.post_date > days[days.length - 1]; });
    var firstGap = ready < days.length ? days[ready] : DV.addDays(today, days.length);

    panel.innerHTML =
      '<div class="panel-head"><div><h1>Schedule</h1><p class="lede">' + summary + '</p></div>' +
        '<form class="row jump" data-jump><label class="sr-only" for="jump">Open any date</label>' +
          '<input id="jump" type="date" value="' + firstGap + '" required><button class="btn" type="submit">Open date</button></form></div>' +
      '<p class="hint">Each day appears on the site by itself at midnight (UK time). Click a day to add or change its passage.</p>' +
      '<div class="tiles">' + days.map(function (d) { return tileHtml(d, by[d], today); }).join('') + '</div>' +
      (later.length ? '<h2 class="subhead">Further ahead</h2><ul class="post-list">' +
        later.map(function (p) { return adminRowHtml(p, today); }).join('') + '</ul>' : '');
    panel.querySelector('[data-jump]').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = e.currentTarget.querySelector('input').value;
      if (v) location.hash = '#edit/' + v;
    });
  }

  function tileHtml(d, p, today) {
    var isToday = d === today;
    var wd = isToday ? 'Today' : d === DV.addDays(today, 1) ? 'Tomorrow' : DV.fmtDate(d, { weekday: 'short' });
    return '<a class="tile' + (p ? ' filled' : ' empty') + (isToday ? ' is-today' : '') + '" href="#edit/' + d + '">' +
      '<span class="t-when"><span class="t-wd">' + esc(wd) + '</span><span class="t-date">' + esc(DV.fmtDate(d, { day: 'numeric', month: 'short' })) + '</span></span>' +
      (p
        ? '<span class="t-ref">' + esc(p.reference) + '</span><span class="t-state' + (isToday ? ' live' : '') + '">' +
            (isToday ? 'Live now' : 'Scheduled') + (p.video_url ? ' · video' : '') + '</span>'
        : '<span class="t-add">+ Add passage</span>') +
      '</a>';
  }

  // ================================================================ all days

  async function showDays(my) {
    panel.innerHTML = DV.spinner();
    var res = await sb.from('posts').select('id,post_date,title,reference,video_url,comments(count)')
      .order('post_date', { ascending: false }).limit(5000);
    if (my !== seq) return;
    if (res.error) return panelError(res.error);
    var today = DV.ukToday();
    var rows = res.data;
    panel.innerHTML =
      '<div class="panel-head"><div><h1>All days</h1><p class="lede">' +
        (rows.length ? rows.length + (rows.length === 1 ? ' day' : ' days') + ' so far, newest first.' : 'Nothing yet.') + '</p></div>' +
        '<a class="btn btn-primary" href="#new">+ Add a day</a></div>' +
      (rows.length > 5 ? '<div class="search"><input type="search" placeholder="Search by reference or title" aria-label="Search days" data-search></div>' : '') +
      '<div data-list></div>';
    var box = panel.querySelector('[data-list]');
    function draw(q) {
      var term = (q || '').trim().toLowerCase();
      var list = term ? rows.filter(function (p) { return (p.reference + ' ' + (p.title || '') + ' ' + p.post_date).toLowerCase().indexOf(term) >= 0; }) : rows;
      if (!rows.length) { box.innerHTML = '<div class="empty"><p class="muted">No days yet. <a href="#new">Add the first one →</a></p></div>'; return; }
      if (!list.length) { box.innerHTML = '<p class="muted">Nothing matches “' + esc(q.trim()) + '”.</p>'; return; }
      box.innerHTML = '<ul class="post-list">' + list.map(function (p) { return adminRowHtml(p, today); }).join('') + '</ul>';
    }
    draw('');
    var s = panel.querySelector('[data-search]');
    if (s) s.addEventListener('input', function () { draw(s.value); });
  }

  // ================================================================ comments

  async function showComments(my) {
    panel.innerHTML = DV.spinner();
    var res = await sb.from('comments').select('id,name,body,by_admin,created_at,posts(post_date,reference)')
      .order('created_at', { ascending: false }).limit(200);
    if (my !== seq) return;
    if (res.error) return panelError(res.error);
    var rows = res.data;
    panel.innerHTML =
      '<div class="panel-head"><div><h1>Comments</h1><p class="lede">The latest comments from every day, newest first. ' +
        'You can also delete comments straight from the site while you’re signed in.</p></div></div>' +
      (rows.length ? '<ul class="mod-list">' + rows.map(function (c) {
        var p = c.posts || {};
        return '<li class="mod-item" data-id="' + esc(c.id) + '">' +
          '<span class="avatar" style="--h:' + DV.hue(c.name) + '" aria-hidden="true">' + esc(DV.initial(c.name)) + '</span>' +
          '<div class="c-main"><div class="c-head"><span class="c-name">' + esc(c.name) + '</span>' +
            (c.by_admin ? '<span class="badge">Author</span>' : '') +
            '<time datetime="' + esc(c.created_at) + '">' + esc(DV.timeAgo(c.created_at)) + '</time></div>' +
            '<p class="c-body">' + DV.commentText(c.body) + '</p>' +
            '<p class="small muted">on <a href="./#/day/' + esc(p.post_date) + '" target="_blank" rel="noopener">' + esc(p.reference || 'a day') +
              (p.post_date ? ' · ' + esc(DV.fmtDate(p.post_date, { day: 'numeric', month: 'short' })) : '') + '</a></p></div>' +
          '<button type="button" class="btn btn-danger btn-small" data-del="' + esc(c.id) + '">Delete</button></li>';
      }).join('') + '</ul>' : '<div class="empty"><p class="muted">No comments yet.</p></div>');
    var list = panel.querySelector('.mod-list');
    if (list) list.addEventListener('click', onModClick);
  }

  async function onModClick(e) {
    var btn = e.target.closest('[data-del]');
    if (!btn) return;
    if (!confirm('Delete this comment? This can’t be undone.')) return;
    btn.disabled = true;
    var id = btn.getAttribute('data-del');
    var res = await sb.from('comments').delete({ count: 'exact' }).eq('id', id);
    if (res.error || !res.count) {
      btn.disabled = false;
      DV.toast('Couldn’t delete that comment.', 'err');
      return;
    }
    var li = btn.closest('li');
    if (li) li.remove();
    DV.toast('Comment deleted');
  }

  // ================================================================ settings

  function showSettings() {
    var s = DV.settings();
    panel.innerHTML =
      '<div class="panel-head"><div><h1>Settings</h1></div></div>' +
      '<div class="settings-grid">' +
        '<div class="card stack"><h2>Your site’s address</h2>' +
          '<p class="muted small">Share this link. Anyone can read the passages and join the discussion — no account needed.</p>' +
          '<div class="copy-row"><input readonly value="' + esc(siteUrl()) + '" aria-label="Site address" data-url>' +
          '<button class="btn" type="button" data-copy>Copy</button></div></div>' +
        '<div class="card stack"><h2>Bible text</h2>' +
          '<p class="small" data-counts>Counting the verses you’ve used…</p>' +
          '<p class="muted small">Biblica (NIV) and Crossway (ESV) each let you quote up to 500 verses on the site without asking, ' +
            'as long as their copyright notice is shown. It’s added at the bottom of every page for you. If you get close to 500 for either one, send them a permission request: ' +
            '<a href="https://www.biblica.com/permissions/" target="_blank" rel="noopener">NIV</a> · ' +
            '<a href="https://www.crossway.org/permissions/" target="_blank" rel="noopener">ESV</a>.</p></div>' +
        '<form class="card stack" data-settings novalidate><h2>Name and description</h2>' +
          '<div class="field"><label for="st-title">Site name</label><input id="st-title" name="site_title" maxlength="60" required value="' + esc(s.site_title) + '"></div>' +
          '<div class="field"><label for="st-tag">Short description</label><input id="st-tag" name="tagline" maxlength="200" value="' + esc(s.tagline) + '"></div>' +
          '<p class="form-msg" data-msg role="status"></p><div><button class="btn btn-primary" type="submit">Save</button></div></form>' +
        '<form class="card stack" data-password novalidate><h2>Change your password</h2>' +
          '<div class="field"><label for="np1">New password</label><input id="np1" type="password" name="p1" minlength="8" autocomplete="new-password" required></div>' +
          '<div class="field"><label for="np2">Type it again</label><input id="np2" type="password" name="p2" minlength="8" autocomplete="new-password" required></div>' +
          '<p class="form-msg" data-msg role="status"></p><div><button class="btn" type="submit">Change password</button></div></form>' +
      '</div>';

    sb.from('posts').select('reference,translation,verse_text').limit(5000).then(function (res) {
      var el = panel.querySelector('[data-counts]');
      if (!el) return;
      if (res.error) { el.textContent = 'Couldn’t count the verses just now.'; return; }
      var totals = {};
      res.data.forEach(function (p) {
        var t = p.translation || 'other';
        totals[t] = (totals[t] || 0) + DV.verseCount(p.reference, p.verse_text);
      });
      el.innerHTML = 'Quoted so far: ' + TRANSLATIONS.map(function (t) {
        var n = totals[t] || 0;
        return '<strong>' + t + '</strong> about ' + n + ' verse' + (n === 1 ? '' : 's') + (n >= 450 ? ' (nearly at 500)' : '');
      }).join(' · ') + '.';
    });

    panel.querySelector('[data-copy]').addEventListener('click', async function () {
      var input = panel.querySelector('[data-url]');
      try { await navigator.clipboard.writeText(input.value); DV.toast('Link copied'); }
      catch (err) { input.select(); document.execCommand('copy'); DV.toast('Link copied'); }
    });

    panel.querySelector('[data-settings]').addEventListener('submit', async function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      var msg = form.querySelector('[data-msg]');
      var title = form.elements.site_title.value.replace(/\s+/g, ' ').trim();
      var tagline = form.elements.tagline.value.replace(/\s+/g, ' ').trim();
      if (!title) { setMsg(msg, 'The site needs a name.', 'err'); return; }
      var res = await sb.from('settings').update({ site_title: title, tagline: tagline }).eq('id', 1).select('site_title,tagline').single();
      if (res.error) { setMsg(msg, DV.friendly(res.error), 'err'); return; }
      DV.setSettings(res.data);
      setMsg(msg, 'Saved.', 'ok');
    });

    panel.querySelector('[data-password]').addEventListener('submit', async function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      var msg = form.querySelector('[data-msg]');
      var p1 = form.elements.p1.value;
      if (p1.length < 8) { setMsg(msg, 'Please use at least 8 characters.', 'err'); return; }
      if (p1 !== form.elements.p2.value) { setMsg(msg, 'The two passwords don’t match.', 'err'); return; }
      var res = await sb.auth.updateUser({ password: p1 });
      if (res.error) { setMsg(msg, authError(res.error) === 'CLOSED' ? DV.friendly(res.error) : authError(res.error), 'err'); return; }
      form.reset();
      setMsg(msg, 'Password changed.', 'ok');
    });
  }

  // ================================================================ editor

  async function showEditor(my, date) {
    panel.innerHTML = DV.spinner();
    var today = DV.ukToday();
    if (!date) {
      var r0 = await sb.from('posts').select('post_date').gte('post_date', today).order('post_date').limit(1000);
      if (my !== seq) return;
      var taken = {};
      (r0.data || []).forEach(function (p) { taken[p.post_date] = true; });
      date = today;
      while (taken[date]) date = DV.addDays(date, 1);
      history.replaceState(null, '', '#edit/' + date);
      lastHash = location.hash;
    }
    var res = await sb.from('posts').select(POST_COLS).eq('post_date', date).maybeSingle();
    if (my !== seq) return;
    if (res.error) return panelError(res.error);
    panel.innerHTML = editorHtml(res.data, date);
    wireEditor(res.data, date);
  }

  function translationOptions(current) {
    var list = TRANSLATIONS.slice();
    if (current && list.indexOf(current) < 0) list.push(current); // keep an older day's translation selectable
    return list.map(function (t) {
      return '<label class="seg-option"><input type="radio" name="translation" value="' + esc(t) + '"' +
        (t === current ? ' checked' : '') + '><span>' + esc(t) + '</span></label>';
    }).join('');
  }

  function editorHtml(p, date) {
    p = p || {};
    var tr = p.id ? (p.translation || '') : DV.lsGet(LAST_TR_KEY, 'NIV');
    if (!p.id && TRANSLATIONS.indexOf(tr) < 0) tr = 'NIV';
    return '<div class="editor">' +
      '<div class="panel-head"><div><a class="small back" href="#schedule">← Schedule</a>' +
        '<h1 data-editor-title>' + (p.id ? 'Edit passage' : 'Add a passage') + '</h1><p class="lede" data-status></p></div></div>' +
      '<form class="stack" data-editor novalidate>' +
        '<div class="grid-2">' +
          '<div class="field"><label for="e-date">Date</label><input id="e-date" type="date" name="post_date" value="' + esc(p.post_date || date) + '" required></div>' +
          '<div class="field"><label for="e-title">Title <span class="opt">optional</span></label>' +
            '<input id="e-title" name="title" maxlength="120" value="' + esc(p.title || '') + '" placeholder="e.g. Peace in the storm"></div>' +
        '</div>' +
        '<fieldset class="fieldset"><legend>Bible passage</legend>' +
          '<div class="grid-ref">' +
            '<div class="field"><label for="e-ref">Reference</label>' +
              '<input id="e-ref" name="reference" maxlength="120" required value="' + esc(p.reference || '') + '" placeholder="e.g. John 3:16-17" autocomplete="off"></div>' +
            '<div class="field"><span class="field-label" id="e-tr-label">Translation</span>' +
              '<div class="seg" role="radiogroup" aria-labelledby="e-tr-label">' + translationOptions(tr) + '</div></div>' +
          '</div>' +
          '<div class="open-row"><a class="btn" data-open-bg target="_blank" rel="noopener">' + OPEN_ICON + '<span data-open-label>Open the passage</span></a></div>' +
          '<p class="hint">This opens the passage on Bible Gateway. Copy the verses there, then paste them into the box below. ' +
            'Footnote letters are removed and the verse numbers made small for you.</p>' +
          '<p class="form-msg" data-fetch-msg role="status"></p>' +
          '<div class="field"><label for="e-text">Verse text</label>' +
            '<textarea id="e-text" name="verse_text" rows="6" required placeholder="Paste the verses here">' + esc(p.verse_text || '') + '</textarea></div>' +
        '</fieldset>' +
        '<div class="field"><label for="e-reflection">Reflection <span class="opt">a few thoughts on the passage</span></label>' +
          '<textarea id="e-reflection" name="reflection" rows="8">' + esc(p.reflection || '') + '</textarea>' +
          '<p class="hint">Leave an empty line between paragraphs. Put **double stars** round words for bold.</p></div>' +
        '<div class="field"><label for="e-prayer">Prayer</label>' +
          '<textarea id="e-prayer" name="prayer" rows="5">' + esc(p.prayer || '') + '</textarea></div>' +
        '<fieldset class="fieldset"><legend>Video <span class="opt">optional</span></legend>' +
          '<div class="field"><label for="e-video">Video link</label>' +
            '<input id="e-video" name="video_url" type="url" inputmode="url" value="' + esc(p.video_url || '') + '" placeholder="Paste a YouTube link"></div>' +
          '<div class="upload-row"><span class="muted small">or</span>' +
            '<label class="btn" data-upload-label><input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.m4v,.webm" data-file class="sr-only">Upload a video file</label>' +
            '<button type="button" class="link" data-clear-video hidden>Remove the video</button></div>' +
          '<div class="progress" data-progress hidden><div class="progress-track"><div class="progress-bar" data-bar></div></div><span class="small muted" data-ptext></span></div>' +
          '<p class="form-msg" data-video-msg role="status"></p>' +
          '<p class="hint">Easiest for everyone: upload the video to YouTube as “Unlisted” and paste the link — it plays on every phone. ' +
            'Files uploaded here can be up to 50 MB (roughly a minute of phone video).</p>' +
          '<div class="video-preview" data-video-preview></div>' +
        '</fieldset>' +
        '<div class="editor-actions">' +
          '<button type="submit" class="btn btn-primary">Save</button>' +
          '<a class="btn btn-quiet" data-preview target="_blank" rel="noopener" hidden>Preview</a>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn btn-danger" data-delete hidden>Delete day</button>' +
        '</div>' +
        '<p class="form-msg" data-msg role="status"></p>' +
      '</form></div>';
  }

  function wireEditor(post, date) {
    var form = panel.querySelector('[data-editor]');
    var f = form.elements;
    var msg = form.querySelector('[data-msg]');
    var fetchMsg = form.querySelector('[data-fetch-msg]');
    var videoMsg = form.querySelector('[data-video-msg]');
    var status = panel.querySelector('[data-status]');
    var preview = panel.querySelector('[data-preview]');
    var delBtn = panel.querySelector('[data-delete]');
    var videoBox = panel.querySelector('[data-video-preview]');
    var clearBtn = panel.querySelector('[data-clear-video]');
    var openBtn = panel.querySelector('[data-open-bg]');
    var openLabel = panel.querySelector('[data-open-label]');
    var fileInput = panel.querySelector('[data-file]');
    var uploadLabel = panel.querySelector('[data-upload-label]');
    var progress = panel.querySelector('[data-progress]');
    var bar = panel.querySelector('[data-bar]');
    var ptext = panel.querySelector('[data-ptext]');
    var lastVideo = null;

    function updateStatus() {
      var today = DV.ukToday();
      var d = f.post_date.value;
      var when = d ? DV.fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' }) : '';
      var text;
      if (!d) text = 'Pick a date for this passage.';
      else if (post && d === post.post_date) {
        text = d > today ? 'Scheduled — appears on the site on ' + when + ' at midnight (UK time).'
          : d === today ? 'Live on the site now.' : 'Published on ' + when + '.';
      } else {
        text = d > today ? 'Not saved yet. Once saved, it appears on ' + when + ' at midnight (UK time).'
          : d === today ? 'Not saved yet. Once saved, it goes live straight away.'
          : 'Not saved yet. This date is in the past, so it will go straight into Past days.';
      }
      status.textContent = text;
      preview.hidden = !post;
      if (post) preview.href = './#/day/' + post.post_date;
      delBtn.hidden = !post;
    }

    function updateVideo() {
      var url = f.video_url.value.trim();
      clearBtn.hidden = !url;
      if (url === lastVideo) return;
      lastVideo = url;
      if (!url) { videoBox.innerHTML = ''; return; }
      var v = DV.parseVideo(url);
      if (!v) { videoBox.innerHTML = '<p class="form-msg err">That doesn’t look like a web link. It should start with https://</p>'; return; }
      videoBox.innerHTML = (v.kind === 'link'
        ? '<p class="hint">This link can’t play inside the page, so visitors will get a button that opens it.</p>' : '') + DV.videoHtml(v);
    }

    function updateOpen() {
      var ref = f.reference.value.replace(/\s+/g, ' ').trim();
      var tr = f.translation.value || 'NIV';
      openBtn.href = DV.passageUrl(ref, tr);
      openLabel.textContent = ref ? 'Open ' + ref + ' (' + tr + ')' : 'Open the passage (' + tr + ')';
    }

    var videoTimer = null;
    form.addEventListener('input', function (e) {
      var n = e.target.name;
      if (e.target.type === 'file') return;
      dirty = true;
      if (n === 'post_date') updateStatus();
      if (n === 'reference') updateOpen();
      if (n === 'translation') {
        if (TRANSLATIONS.indexOf(f.translation.value) >= 0) DV.lsSet(LAST_TR_KEY, f.translation.value);
        updateOpen();
      }
      if (n === 'video_url') {
        clearTimeout(videoTimer);
        videoTimer = setTimeout(updateVideo, 450);
      }
    });

    preview.addEventListener('click', function (e) {
      if (dirty) {
        e.preventDefault();
        DV.toast('Save first, then preview');
      }
    });

    openBtn.addEventListener('click', function (e) {
      if (!f.reference.value.trim()) {
        e.preventDefault();
        setMsg(fetchMsg, 'Type the reference first, e.g. John 3:16-17.', 'err');
        f.reference.focus();
        return;
      }
      setMsg(fetchMsg, '');
    });

    // Pasted verses get tidied: footnote letters out, verse numbers made small.
    f.verse_text.addEventListener('paste', function (e) {
      var cd = e.clipboardData || window.clipboardData;
      var raw = cd && cd.getData('text');
      if (!raw) return;
      var cleaned = DV.cleanPastedVerses(raw, f.reference.value);
      if (!cleaned || cleaned === raw.trim()) return; // nothing to tidy: let the paste happen normally
      e.preventDefault();
      var el = f.verse_text;
      var start = el.selectionStart;
      var end = el.selectionEnd;
      el.value = el.value.slice(0, start) + cleaned + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + cleaned.length;
      dirty = true;
      setMsg(fetchMsg, 'Pasted and tidied up. Check it looks right.', 'ok');
    });

    fileInput.addEventListener('change', async function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_UPLOAD) {
        setMsg(videoMsg, 'That video is ' + Math.round(file.size / 1048576) + ' MB, but the limit is 50 MB. Upload it to YouTube as “Unlisted” and paste the link instead.', 'err');
        return;
      }
      setMsg(videoMsg, '');
      progress.hidden = false;
      bar.style.width = '0%';
      ptext.textContent = 'Uploading…';
      uploadLabel.classList.add('is-busy');
      try {
        var url = await uploadVideo(file, f.post_date.value || date, function (p) {
          var pct = Math.round(p * 100);
          bar.style.width = pct + '%';
          ptext.textContent = 'Uploading… ' + pct + '%';
        });
        if (pendingUpload) removeUpload(pendingUpload);
        pendingUpload = url;
        f.video_url.value = url;
        dirty = true;
        updateVideo();
        setMsg(videoMsg, 'Video uploaded. Remember to press Save.', 'ok');
      } catch (err) {
        setMsg(videoMsg, err.message || 'The upload didn’t work. Please try again.', 'err');
      } finally {
        progress.hidden = true;
        uploadLabel.classList.remove('is-busy');
      }
    });

    clearBtn.addEventListener('click', function () {
      f.video_url.value = '';
      dirty = true;
      updateVideo();
      setMsg(videoMsg, 'Video removed. Press Save to keep this change.', 'ok');
    });

    delBtn.addEventListener('click', async function () {
      if (!post) return;
      if (!confirm('Delete the passage for ' + DV.fmtDate(post.post_date) + '?\n\nIts discussion will be deleted too. This can’t be undone.')) return;
      delBtn.disabled = true;
      var res = await sb.from('posts').delete().eq('id', post.id);
      delBtn.disabled = false;
      if (res.error) { setMsg(msg, DV.friendly(res.error), 'err'); return; }
      if (post.video_url) removeUpload(post.video_url);
      dirty = false;
      DV.toast('Day deleted');
      location.hash = '#schedule';
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var row = {
        post_date: f.post_date.value,
        title: f.title.value.trim() || null,
        reference: f.reference.value.replace(/\s+/g, ' ').trim(),
        translation: f.translation.value || null,
        verse_text: f.verse_text.value.trim(),
        reflection: f.reflection.value.trim() || null,
        prayer: f.prayer.value.trim() || null,
        video_url: f.video_url.value.trim() || null
      };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.post_date)) { setMsg(msg, 'Pick a date for this passage.', 'err'); f.post_date.focus(); return; }
      if (!row.reference) { setMsg(msg, 'Add the Bible reference, e.g. John 3:16.', 'err'); f.reference.focus(); return; }
      if (!row.translation) { setMsg(msg, 'Choose NIV or ESV.', 'err'); return; }
      if (!row.verse_text) { setMsg(msg, 'Add the verse text: open the passage, copy the verses and paste them in.', 'err'); f.verse_text.focus(); return; }
      if (row.video_url && !DV.parseVideo(row.video_url)) { setMsg(msg, 'The video link should start with https://', 'err'); f.video_url.focus(); return; }

      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      var res = post
        ? await sb.from('posts').update(row).eq('id', post.id).select(POST_COLS).single()
        : await sb.from('posts').insert(row).select(POST_COLS).single();
      btn.disabled = false;
      btn.textContent = 'Save';
      if (res.error) {
        if (res.error.code === '23505') {
          setMsg(msg, 'There’s already a passage on ' + DV.fmtDate(row.post_date) + '. Pick another date, or open that day from the Schedule to change it.', 'err');
        } else {
          setMsg(msg, DV.friendly(res.error), 'err');
        }
        return;
      }
      var oldVideo = post && post.video_url;
      post = res.data;
      if (pendingUpload && pendingUpload !== post.video_url) removeUpload(pendingUpload);
      pendingUpload = null;
      if (oldVideo && oldVideo !== post.video_url) removeUpload(oldVideo);
      dirty = false;
      if (location.hash !== '#edit/' + post.post_date) {
        history.replaceState(null, '', '#edit/' + post.post_date);
        lastHash = location.hash;
      }
      panel.querySelector('[data-editor-title]').textContent = 'Edit passage';
      updateStatus();
      var today = DV.ukToday();
      setMsg(msg, post.post_date > today ? 'Saved and scheduled.' : 'Saved. It’s on the site now.', 'ok');
      DV.toast(post.post_date > today ? 'Saved and scheduled' : 'Saved — it’s live');
    });

    updateStatus();
    updateVideo();
    updateOpen();
    if (!post) f.reference.focus();
  }

  function uploadVideo(file, date, onProgress) {
    return sb.auth.getSession().then(function (s) {
      var session = s.data && s.data.session;
      if (!session) throw new Error('Please sign in again, then try the upload.');
      var m = file.name.match(/\.([a-z0-9]{2,5})$/i);
      var ext = (m ? m[1] : 'mp4').toLowerCase();
      var type = file.type || ({ mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' }[ext] || 'video/mp4');
      var path = date + '-' + Math.random().toString(36).slice(2, 10) + '.' + ext;
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', cfg.supabaseUrl + '/storage/v1/object/videos/' + path);
        xhr.setRequestHeader('authorization', 'Bearer ' + session.access_token);
        xhr.setRequestHeader('apikey', cfg.supabaseKey);
        xhr.setRequestHeader('content-type', type);
        xhr.setRequestHeader('cache-control', 'max-age=31536000');
        xhr.setRequestHeader('x-upsert', 'false');
        xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) return resolve(STORAGE_PREFIX + path);
          var text = '';
          try { var j = JSON.parse(xhr.responseText); text = j.message || j.error || ''; } catch (err) { /* ignore */ }
          if (xhr.status === 413 || /maximum allowed size|too large|exceeded/i.test(text)) return reject(new Error('That video is too big (the limit is 50 MB).'));
          if (/mime|type/i.test(text)) return reject(new Error('That file type isn’t supported. Please use an MP4, MOV or WebM video.'));
          reject(new Error('The upload didn’t work' + (text ? ' (' + text + ')' : '') + '. Please try again.'));
        };
        xhr.onerror = function () { reject(new Error('The upload didn’t work. Check your internet connection and try again.')); };
        xhr.send(file);
      });
    });
  }

  async function removeUpload(url) {
    if (!url || url.indexOf(STORAGE_PREFIX) !== 0) return;
    var path = decodeURIComponent(url.slice(STORAGE_PREFIX.length).split('?')[0]);
    try {
      var used = await sb.from('posts').select('id', { count: 'exact', head: true }).eq('video_url', url);
      if (used.error || used.count > 0) return;
      await sb.storage.from('videos').remove([path]);
    } catch (e) { /* tidying up is optional */ }
  }

  // ================================================================ start

  sb.auth.onAuthStateChange(function (event) {
    if (event === 'PASSWORD_RECOVERY') {
      recovery = true;
      setTimeout(function () { showAuth('recover'); }, 0);
    } else if (event === 'SIGNED_OUT' && inDashboard) {
      inDashboard = false;
      setTimeout(function () { showAuth('signin'); }, 0);
    }
  });

  async function boot() {
    DV.loadSettings();
    root.innerHTML = DV.spinner();
    var s = await sb.auth.getSession();
    if (s.data.session && recovery) return showAuth('recover');
    if (s.data.session) return enter();
    return showAuth();
  }
  boot();
})();
