/* The public site: today's passage, any past day, and each day's discussion. */
(function () {
  'use strict';

  var DV = window.DV;
  var sb = DV.sb;
  var esc = DV.esc;
  var view = document.getElementById('view');

  var POST_COLS = 'id,post_date,title,reference,translation,verse_text,reflection,prayer,video_url';
  var NAME_KEY = 'dv:name';
  var KEYS_KEY = 'dv:comment-keys';

  var isAdmin = false;
  var renderSeq = 0;
  var state = { route: null, post: null, today: DV.ukToday(), comments: new Map(), channel: null, seq: 0 };
  var pastRows = [];

  var ICONS = {
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4l4 4M5 13v6h14v-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5C10 5 7 4.6 4 5v13c3-.4 6 0 8 1.5 2-1.5 5-1.9 8-1.5V5c-3-.4-6 0-8 1.5zm0 0v13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  };

  function siteTitle() { return DV.settings().site_title || 'Daily Verse'; }

  // ---------------------------------------------------------------- routing

  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, '');
    if (/^past\b/.test(h)) return { name: 'past' };
    var m = h.match(/^day\/(\d{4}-\d{2}-\d{2})$/);
    if (m) return { name: 'day', date: m[1] };
    return { name: 'today' };
  }

  function setNav(r) {
    var today = DV.ukToday();
    var name = r.name === 'past' ? 'past'
      : r.name === 'today' || r.date === today ? 'today'
      : r.date < today ? 'past' : '';
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      var on = a.getAttribute('data-nav') === name;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function stopLive() {
    if (state.channel) {
      try { sb.removeChannel(state.channel); } catch (e) { /* ignore */ }
      state.channel = null;
    }
  }

  function render() {
    var seq = ++renderSeq;
    var r = parseRoute();
    state.route = r;
    state.post = null;
    setNav(r);
    stopLive();
    if (r.name === 'past') return renderPast(seq);
    return renderDay(seq, r.name === 'day' ? r.date : null);
  }

  // ---------------------------------------------------------------- a day

  async function renderDay(seq, date) {
    view.innerHTML = DV.spinner();
    var today = DV.ukToday();
    state.today = today;
    var q = sb.from('posts').select(POST_COLS);
    q = date ? q.eq('post_date', date) : q.lte('post_date', today).order('post_date', { ascending: false }).limit(1);
    var res = await q.maybeSingle();
    if (seq !== renderSeq) return;
    if (res.error) return showError(res.error);
    var post = res.data;
    if (!post) return date ? renderMissing(date, today) : renderNothingYet();

    var near = await Promise.all([
      sb.from('posts').select('post_date').lt('post_date', post.post_date).order('post_date', { ascending: false }).limit(1).maybeSingle(),
      sb.from('posts').select('post_date').gt('post_date', post.post_date).order('post_date', { ascending: true }).limit(1).maybeSingle(),
      fetchComments(post)
    ]);
    if (seq !== renderSeq) return;
    var prev = near[0].data ? near[0].data.post_date : null;
    var next = near[1].data ? near[1].data.post_date : null;

    state.post = post;
    state.comments = new Map();
    view.innerHTML = dayHtml(post, { today: today, prev: prev, next: next, latestFallback: !date && post.post_date !== today });
    document.title = post.reference + ' · ' + siteTitle();
    wireDay(post);
    showComments(seq, post, near[2]);
  }

  function dayNavHtml(date, prev, next) {
    var label = DV.dayLabel(date);
    var weekdayOnly = !/^(Today|Yesterday|Tomorrow)$/.test(label);
    var full = DV.fmtDate(date, weekdayOnly ? { day: 'numeric', month: 'long', year: 'numeric' } : undefined);
    function arrow(d, dir) {
      if (!d) return '<span class="day-arrow is-off" aria-hidden="true">' + ICONS[dir] + '</span>';
      return '<a class="day-arrow" href="#/day/' + d + '" aria-label="' + (dir === 'prev' ? 'Previous' : 'Next') + ' day: ' +
        esc(DV.fmtDate(d)) + '">' + ICONS[dir] + '</a>';
    }
    return '<nav class="day-nav" aria-label="Choose a day">' + arrow(prev, 'prev') +
      '<div class="day-when"><span class="day-label">' + esc(label) + '</span><span class="day-date">' + esc(full) + '</span></div>' +
      arrow(next, 'next') + '</nav>';
  }

  function dayHtml(p, o) {
    var isToday = p.post_date === o.today;
    var future = p.post_date > o.today;
    var video = DV.parseVideo(p.video_url);
    var shortDate = DV.fmtDate(p.post_date, { weekday: 'long', day: 'numeric', month: 'long' });
    var banner = '';
    if (o.latestFallback) {
      banner = '<p class="notice">Today’s passage isn’t up yet, so here’s the most recent one.</p>';
    } else if (future) {
      banner = '<p class="notice notice-admin"><strong>Scheduled.</strong> Everyone can see this from ' + esc(shortDate) +
        ' (midnight UK time). Until then, only you can.</p>';
    }
    var html = '<article class="day">' + dayNavHtml(p.post_date, o.prev, o.next) + banner +
      '<section class="verse-card" aria-label="Bible passage">' +
        (p.title ? '<h1 class="day-title">' + esc(p.title) + '</h1>' : '<h1 class="sr-only">' + esc(p.reference) + '</h1>') +
        '<blockquote class="verse">' + DV.verseHtml(p.verse_text) + '</blockquote>' +
        '<p class="ref">' + esc(p.reference) +
          (p.translation ? ' <span class="tr">' + esc(p.translation) + '</span>' : '') + '</p>' +
        '<div class="verse-actions">' +
          '<a class="btn btn-quiet" href="' + esc(DV.bibleGatewayUrl(p.reference, p.translation)) + '" target="_blank" rel="noopener">' +
            ICONS.book + 'Read the chapter</a>' +
          '<button class="btn btn-quiet" type="button" data-share>' + ICONS.share + 'Share</button>' +
        '</div>' +
      '</section>';
    if (video) html += '<section class="block" aria-label="Video">' + DV.videoHtml(video) + '</section>';
    if (p.reflection) html += '<section class="block"><h2 class="label">Reflection</h2><div class="prose">' + DV.richText(p.reflection) + '</div></section>';
    if (p.prayer) html += '<section class="block prayer"><h2 class="label">Prayer</h2><div class="prose">' + DV.richText(p.prayer) + '</div></section>';
    if (isAdmin) html += '<p class="admin-edit"><a class="btn btn-quiet" href="admin.html#edit/' + p.post_date + '">Edit this day</a></p>';
    html += '<section class="discussion" aria-labelledby="disc-h">' +
      '<div class="disc-head"><h2 id="disc-h">Discussion <span class="count" data-count></span></h2>' +
      '<p class="muted small">' + (isToday
        ? 'Today’s conversation about this passage. A fresh discussion opens with each new day.'
        : (future ? 'The discussion for ' + esc(shortDate) + '.' : 'The conversation from ' + esc(shortDate) + '.')) + '</p></div>' +
      '<ol class="comments" data-comments aria-live="polite"><li class="muted small">Loading the discussion…</li></ol>' +
      (future ? '<p class="muted small">Comments open when this day goes live.</p>' : commentFormHtml()) +
      '</section></article>';
    return html;
  }

  function commentFormHtml() {
    var name = DV.lsGet(NAME_KEY, '');
    return '<form class="comment-form" data-comment-form novalidate>' +
      '<div class="field"><label for="c-name">Your name</label>' +
        '<input id="c-name" name="author" maxlength="40" autocomplete="name" value="' + esc(name) + '" required></div>' +
      '<div class="field"><label for="c-body">Your thoughts</label>' +
        '<textarea id="c-body" name="message" rows="3" maxlength="1500" required placeholder="What stood out to you?"></textarea></div>' +
      '<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<div class="form-foot"><p class="form-msg" data-form-msg role="status">Your name is shown with your comment. Please be kind.</p>' +
        '<button class="btn btn-primary" type="submit">Post</button></div>' +
      '</form>';
  }

  function wireDay(post) {
    var shareBtn = view.querySelector('[data-share]');
    if (shareBtn) shareBtn.addEventListener('click', function () { share(post); });
    var form = view.querySelector('[data-comment-form]');
    if (form) form.addEventListener('submit', function (e) { submitComment(e, post); });
    var list = view.querySelector('[data-comments]');
    if (list) list.addEventListener('click', onCommentsClick);
  }

  // ---------------------------------------------------------------- discussion

  function fetchComments(post) {
    return sb.from('comments').select('id,name,body,by_admin,created_at')
      .eq('post_id', post.id).order('created_at', { ascending: true }).limit(1000);
  }

  async function loadComments(seq, post) {
    var res = await fetchComments(post);
    showComments(seq, post, res);
  }

  function showComments(seq, post, res) {
    if (seq !== renderSeq) return;
    var list = view.querySelector('[data-comments]');
    if (!list) return;
    if (res.error) {
      list.innerHTML = '<li class="empty-comments">Couldn’t load the discussion. <button type="button" class="link" data-retry>Try again</button></li>';
      list.querySelector('[data-retry]').addEventListener('click', function () { loadComments(seq, post); });
      return;
    }
    state.comments = new Map(res.data.map(function (c) { return [c.id, c]; }));
    drawComments();
    startLive(seq, post);
  }

  function drawComments() {
    var list = view.querySelector('[data-comments]');
    if (!list || !state.post) return;
    var arr = Array.from(state.comments.values()).sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
    var future = state.post.post_date > state.today;
    list.innerHTML = arr.length ? arr.map(commentHtml).join('')
      : '<li class="empty-comments">No comments yet.' + (future ? '' : ' Be the first to share a thought.') + '</li>';
    var count = view.querySelector('[data-count]');
    if (count) count.textContent = arr.length ? String(arr.length) : '';
  }

  function commentHtml(c) {
    var keys = DV.lsGet(KEYS_KEY, {});
    var mine = !!keys[c.id];
    var canDelete = mine || isAdmin;
    return '<li class="comment' + (c.by_admin ? ' by-admin' : '') + '" data-id="' + esc(c.id) + '">' +
      '<span class="avatar" style="--h:' + DV.hue(c.name) + '" aria-hidden="true">' + esc(DV.initial(c.name)) + '</span>' +
      '<div class="c-main">' +
        '<div class="c-head"><span class="c-name">' + esc(c.name) + '</span>' +
          (c.by_admin ? '<span class="badge">Author</span>' : '') +
          (mine ? '<span class="you">(you)</span>' : '') +
          '<time datetime="' + esc(c.created_at) + '" data-ts="' + esc(c.created_at) + '">' + esc(DV.timeAgo(c.created_at)) + '</time></div>' +
        '<p class="c-body">' + DV.commentText(c.body) + '</p>' +
        (canDelete ? '<button type="button" class="link c-del" data-del="' + esc(c.id) + '">Delete</button>' : '') +
      '</div></li>';
  }

  function startLive(seq, post) {
    stopLive();
    try {
      state.channel = sb.channel('comments-' + post.id)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments', filter: 'post_id=eq.' + post.id }, function (payload) {
          if (seq !== renderSeq || !payload.new) return;
          if (!state.comments.has(payload.new.id)) {
            state.comments.set(payload.new.id, payload.new);
            drawComments();
          }
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comments' }, function (payload) {
          if (seq !== renderSeq) return;
          var id = payload.old && payload.old.id;
          if (id && state.comments.delete(id)) drawComments();
        })
        .subscribe();
    } catch (e) { /* live updates are a bonus; the page still works without them */ }
  }

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = 'form-msg' + (kind ? ' ' + kind : '');
  }

  async function submitComment(e, post) {
    e.preventDefault();
    var form = e.currentTarget;
    var f = form.elements;
    var msg = form.querySelector('[data-form-msg]');
    var btn = form.querySelector('button[type=submit]');
    if (f.website.value) { form.reset(); return; } // a bot filled the hidden box
    var author = f.author.value.replace(/\s+/g, ' ').trim();
    var message = f.message.value.trim();
    if (!author) { setMsg(msg, 'Please add your name.', 'err'); f.author.focus(); return; }
    if (!message) { setMsg(msg, 'Please write something first.', 'err'); f.message.focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Posting…';
    var res = await sb.rpc('add_comment', { p_post_id: post.id, p_name: author, p_body: message });
    btn.disabled = false;
    btn.textContent = 'Post';
    if (res.error) { setMsg(msg, DV.friendly(res.error), 'err'); return; }
    var row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row) { setMsg(msg, 'Something went wrong. Please try again.', 'err'); return; }
    var keys = DV.lsGet(KEYS_KEY, {});
    keys[row.id] = row.delete_key;
    DV.lsSet(KEYS_KEY, keys);
    DV.lsSet(NAME_KEY, author);
    if (state.post && state.post.id === post.id) {
      state.comments.set(row.id, { id: row.id, name: author, body: message, by_admin: row.by_admin, created_at: row.created_at });
      drawComments();
    }
    f.message.value = '';
    setMsg(msg, 'Posted. Thanks for sharing!', 'ok');
  }

  async function onCommentsClick(e) {
    var btn = e.target.closest('[data-del]');
    if (!btn) return;
    var id = btn.getAttribute('data-del');
    if (!confirm('Delete this comment?')) return;
    btn.disabled = true;
    var keys = DV.lsGet(KEYS_KEY, {});
    var ok = false;
    if (keys[id]) {
      var r = await sb.rpc('delete_own_comment', { p_comment_id: id, p_key: keys[id] });
      ok = !r.error && r.data === true;
    }
    if (!ok && isAdmin) {
      var d = await sb.from('comments').delete({ count: 'exact' }).eq('id', id);
      ok = !d.error && d.count > 0;
    }
    if (ok) {
      delete keys[id];
      DV.lsSet(KEYS_KEY, keys);
      state.comments.delete(id);
      drawComments();
      DV.toast('Comment deleted');
    } else {
      btn.disabled = false;
      DV.toast('Couldn’t delete that comment.', 'err');
    }
  }

  async function share(p) {
    var url = location.origin + location.pathname + '#/day/' + p.post_date;
    var text = p.reference + (p.title ? ' — ' + p.title : '');
    if (navigator.share) {
      try {
        await navigator.share({ title: siteTitle(), text: text, url: url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      DV.toast('Link copied');
    } catch (err) {
      window.prompt('Copy this link:', url);
    }
  }

  // ---------------------------------------------------------------- empty / missing

  function emptyHtml(title, body) {
    return '<div class="empty"><div class="empty-mark" aria-hidden="true">' + ICONS.book + '</div><h1>' + title + '</h1><p class="muted">' + body + '</p></div>';
  }

  function renderNothingYet() {
    document.title = siteTitle();
    view.innerHTML = emptyHtml('The first passage is on its way', isAdmin
      ? 'Nothing is published yet. <a href="admin.html">Add the first day →</a>'
      : 'Nothing has been posted yet. Please check back soon.');
  }

  function renderMissing(date, today) {
    document.title = siteTitle();
    var when = DV.fmtDate(date);
    view.innerHTML = date > today
      ? emptyHtml('Not out yet', 'The passage for ' + esc(when) + ' appears on the day. <a href="#/">Go to today</a>')
      : emptyHtml('No passage that day', 'There’s nothing for ' + esc(when) + '. <a href="#/">Go to today</a> or <a href="#/past">see past days</a>.');
  }

  function showError(error) {
    view.innerHTML = emptyHtml('Couldn’t load this page', esc(DV.friendly(error)) + ' <button type="button" class="link" data-reload>Try again</button>');
    var b = view.querySelector('[data-reload]');
    if (b) b.addEventListener('click', render);
  }

  // ---------------------------------------------------------------- past days

  async function renderPast(seq) {
    document.title = 'Past days · ' + siteTitle();
    view.innerHTML = DV.spinner();
    var res = await sb.from('posts')
      .select('id,post_date,title,reference,verse_text,video_url,comments(count)')
      .lte('post_date', DV.ukToday())
      .order('post_date', { ascending: false })
      .limit(5000);
    if (seq !== renderSeq) return;
    if (res.error) return showError(res.error);
    pastRows = res.data.map(function (p) {
      var n = p.comments && p.comments[0] ? p.comments[0].count : 0;
      var snippet = DV.plainVerse(p.verse_text);
      return Object.assign({}, p, { n: n, snippet: snippet, hay: (p.reference + ' ' + (p.title || '') + ' ' + snippet).toLowerCase() });
    });
    var count = pastRows.length;
    view.innerHTML = '<section class="past">' +
      '<div class="past-head"><h1>Past days</h1>' +
        (count ? '<p class="muted">' + count + (count === 1 ? ' passage' : ' passages') + ' so far. Tap one to read it and see its discussion.</p>' : '') + '</div>' +
      (count > 5 ? '<div class="search"><input type="search" placeholder="Search by book, verse or word" aria-label="Search past days" data-search></div>' : '') +
      '<div data-past-list></div></section>';
    drawPast('');
    var s = view.querySelector('[data-search]');
    if (s) s.addEventListener('input', function () { drawPast(s.value); });
  }

  function drawPast(q) {
    var box = view.querySelector('[data-past-list]');
    if (!box) return;
    if (!pastRows.length) {
      box.innerHTML = emptyHtml('Nothing here yet', 'Past passages will appear here day by day.');
      return;
    }
    var term = q.trim().toLowerCase();
    var rows = term ? pastRows.filter(function (p) { return p.hay.indexOf(term) >= 0; }) : pastRows;
    if (!rows.length) {
      box.innerHTML = '<p class="muted no-match">No passages match “' + esc(q.trim()) + '”.</p>';
      return;
    }
    var groups = [];
    var byMonth = {};
    rows.forEach(function (p) {
      var k = p.post_date.slice(0, 7);
      if (!byMonth[k]) { byMonth[k] = []; groups.push(k); }
      byMonth[k].push(p);
    });
    var today = DV.ukToday();
    box.innerHTML = groups.map(function (k) {
      return '<h2 class="month">' + esc(DV.fmtDate(k + '-15', { month: 'long', year: 'numeric' })) + '</h2>' +
        '<ul class="post-list">' + byMonth[k].map(function (p) { return pastRowHtml(p, today); }).join('') + '</ul>';
    }).join('');
  }

  function pastRowHtml(p, today) {
    return '<li><a class="post-row" href="#/day/' + p.post_date + '">' +
      '<span class="pr-date"><span class="pr-num">' + Number(p.post_date.slice(8)) + '</span><span class="pr-wd">' +
        esc(p.post_date === today ? 'Today' : DV.fmtDate(p.post_date, { weekday: 'short' })) + '</span></span>' +
      '<span class="pr-main"><span class="pr-ref">' + esc(p.reference) +
        (p.title ? ' <span class="pr-title">· ' + esc(p.title) + '</span>' : '') + '</span>' +
        '<span class="pr-snippet">' + esc(p.snippet) + '</span></span>' +
      '<span class="pr-meta">' +
        (p.video_url ? '<span class="pr-icon" title="Has a video">' + ICONS.play + '<span class="sr-only">Has a video</span></span>' : '') +
        (p.n ? '<span class="pr-icon" title="' + p.n + (p.n === 1 ? ' comment' : ' comments') + '">' + ICONS.chat + p.n + '</span>' : '') +
      '</span></a></li>';
  }

  // ---------------------------------------------------------------- keeping things fresh

  function newDayWaiting() {
    return state.route && state.route.name === 'today' && DV.ukToday() !== state.today;
  }
  function typingAComment() {
    var t = view.querySelector('[data-comment-form] textarea');
    return t && t.value.trim().length > 0;
  }
  function refreshIfNewDay() {
    if (!newDayWaiting()) return;
    if (!typingAComment()) { render(); return; }
    if (!document.querySelector('[data-new-day]')) {
      var n = document.createElement('p');
      n.className = 'notice notice-admin';
      n.setAttribute('data-new-day', '');
      n.innerHTML = 'A new day has started. <button type="button" class="link">Open today’s passage</button>';
      n.querySelector('button').addEventListener('click', render);
      view.prepend(n);
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    refreshIfNewDay();
    // catch up on comments missed while the phone was asleep
    if (!newDayWaiting() && state.post && state.route && state.route.name !== 'past') loadComments(renderSeq, state.post);
  });
  setInterval(function () {
    view.querySelectorAll('time[data-ts]').forEach(function (t) { t.textContent = DV.timeAgo(t.getAttribute('data-ts')); });
    if (document.visibilityState === 'visible') refreshIfNewDay();
  }, 60000);

  window.addEventListener('hashchange', function () {
    render();
    window.scrollTo(0, 0);
  });

  // ---------------------------------------------------------------- start

  async function boot() {
    DV.loadSettings().then(function () {
      if (state.post) document.title = state.post.reference + ' · ' + siteTitle();
    });
    try { isAdmin = await DV.checkAdmin(); } catch (e) { isAdmin = false; }
    document.querySelectorAll('[data-admin-only]').forEach(function (el) { el.hidden = !isAdmin; });
    document.querySelectorAll('[data-visitor-only]').forEach(function (el) { el.hidden = isAdmin; });
    render();
  }
  boot();
})();
