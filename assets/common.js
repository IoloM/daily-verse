/* Helpers shared by the public site (app.js) and the admin page (admin.js). */
(function () {
  'use strict';

  var cfg = window.DV_CONFIG;
  // Read this before the Supabase library tidies the address bar.
  var wasRecovery = /type=recovery/.test(location.hash + location.search);

  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
  });

  var TZ = cfg.timeZone || 'Europe/London';

  // ---------- small storage helpers (never throw) ----------
  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* private mode etc. */ }
  }

  // ---------- dates (all "days" are UK days, written YYYY-MM-DD) ----------
  function ukToday() {
    var parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .forEach(function (p) { parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function addDays(iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function fmtDate(iso, opts) {
    var o = Object.assign({ timeZone: 'UTC' }, opts || { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', o);
  }
  function dayLabel(iso) {
    var t = ukToday();
    if (iso === t) return 'Today';
    if (iso === addDays(t, -1)) return 'Yesterday';
    if (iso === addDays(t, 1)) return 'Tomorrow';
    return fmtDate(iso, { weekday: 'long' });
  }
  function timeAgo(ts) {
    var d = new Date(ts);
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 6 * 3600) {
      var h = Math.round(s / 3600);
      return h + (h === 1 ? ' hour ago' : ' hours ago');
    }
    var time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    var now = new Date();
    var y = new Date();
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'today at ' + time;
    if (d.toDateString() === y.toDateString()) return 'yesterday at ' + time;
    var o = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== now.getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString('en-GB', o) + ' at ' + time;
  }

  // ---------- text ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function emphasis(t) {
    return esc(t)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  }
  function inline(s) {
    var re = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(s))) {
      out += emphasis(s.slice(last, m.index)) +
        '<a href="' + esc(m[0]) + '" target="_blank" rel="noopener">' + esc(m[0]) + '</a>';
      last = m.index + m[0].length;
    }
    return out + emphasis(s.slice(last));
  }
  // For text the admin writes: paragraphs, line breaks, **bold**, *italic*, links.
  function richText(s) {
    return String(s || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)
      .filter(function (p) { return p.trim(); })
      .map(function (p) { return '<p>' + inline(p.trim()).replace(/\n/g, '<br>') + '</p>'; })
      .join('');
  }
  // For visitors' comments: plain text with line breaks only.
  function commentText(s) {
    return esc(String(s || '').trim()).replace(/\n/g, '<br>');
  }
  var SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  function toSup(n) {
    return String(n).split('').map(function (d) { return SUP[Number(d)] || d; }).join('');
  }
  // Verse text: superscript verse numbers become small styled numbers.
  function verseHtml(s) {
    return String(s || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map(function (p) {
      var h = esc(p.trim()).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, function (m) {
        return '<sup class="vn">' + m.split('').map(function (c) { return SUP.indexOf(c); }).join('') + '</sup>';
      });
      return '<p>' + h.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  function plainVerse(s) {
    return String(s || '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+\s?/g, '').replace(/\s+/g, ' ').trim();
  }
  function initial(name) {
    var ch = Array.from(String(name || '').trim())[0];
    return ch ? ch.toUpperCase() : '?';
  }
  function hue(name) {
    var h = 0;
    Array.from(String(name || '').toLowerCase()).forEach(function (ch) { h = (h * 31 + ch.codePointAt(0)) % 360; });
    return h;
  }

  // ---------- Bible links ----------
  var BG_VERSIONS = ['NIV', 'NIVUK', 'ESV', 'ESVUK', 'KJV', 'NKJV', 'NLT', 'NRSV', 'NRSVA', 'NRSVUE', 'MSG', 'AMP',
    'CSB', 'NASB', 'NASB1995', 'WEB', 'GNT', 'NCV', 'ERV', 'ICB', 'CEV', 'RSV', 'ASV', 'YLT', 'BBE', 'NET', 'TPT', 'NLV', 'NIRV', 'CEB', 'DLNT'];
  function bibleGatewayUrl(reference, translation) {
    var chapter = String(reference || '').replace(/\(.*?\)/g, '').split(/[;,]/)[0].replace(/:.*/, '').trim();
    return passageUrl(chapter, translation);
  }
  // NIV and ESV open in their UK (Anglicised) editions.
  function passageUrl(reference, translation) {
    var v = String(translation || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v === 'NIV') v = 'NIVUK';
    else if (v === 'ESV') v = 'ESVUK';
    else if (v === 'WEBBE') v = 'WEB';
    if (v !== 'NIVUK' && v !== 'ESVUK' && BG_VERSIONS.indexOf(v) < 0) v = 'NIVUK';
    return 'https://www.biblegateway.com/passage/?search=' + encodeURIComponent(String(reference || '').trim()) + '&version=' + v;
  }

  // "John 3:16-17" -> {chapter: 3, from: 16, to: 17}; "Psalm 23" -> {chapter: 23, from: 1, to: null} (whole chapter).
  // Anything spanning chapters or several parts gives null.
  function parseVerseRange(reference) {
    var r = String(reference || '').replace(/\(.*?\)/g, '').trim();
    if (/[;,]/.test(r) || (r.match(/:/g) || []).length > 1) return null;
    var m = r.match(/(\d+)\s*:\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*$/);
    if (m) {
      var from = Number(m[2]);
      var to = m[3] ? Number(m[3]) : from;
      return to >= from ? { chapter: Number(m[1]), from: from, to: to } : null;
    }
    var c = r.match(/\s(\d+)\s*$/);
    return c ? { chapter: Number(c[1]), from: 1, to: null } : null;
  }

  // Roughly how many verses a day quotes (used to keep an eye on the publishers' 500-verse allowance).
  function verseCount(reference, text) {
    var r = parseVerseRange(reference);
    if (r && r.to != null) return r.to - r.from + 1;
    var marks = String(text || '').match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g);
    return marks ? marks.length : 1;
  }

  // Tidies text copied from a Bible website: drops footnote letters like [a] and cross-reference
  // letters like (A), the footnotes/cross-references lists and title lines, and turns the verse
  // numbers that belong to the reference into small superscript numbers.
  function cleanPastedVerses(raw, reference) {
    var lines = String(raw || '').replace(/\r\n?/g, '\n').replace(/[   ]/g, ' ').split('\n');
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/^(footnotes|cross references|cross-references)\b/i.test(line)) break;
      if (/^read full chapter$/i.test(line)) continue;
      if (line.length < 100 && /(new international version|english standard version|\bNIVUK\b|\bESVUK\b|\(NIV\)|\(ESV\))/i.test(line) &&
          !/[.;!?]\s*\S/.test(line.replace(/\(.*?\)/g, ''))) continue;
      kept.push(line);
    }
    var t = kept.join('\n')
      .replace(/\[[a-z]{1,3}\]/g, '')
      .replace(/\(([A-Z]{1,3})\)/g, '')
      .split('\n')
      .map(function (l) { return l.replace(/[ \t]+/g, ' ').replace(/ ([,.;:!?’”])/g, '$1').trim(); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s*\((?:[1-3] )?[A-Za-z][^()]*\d+:\d+[^()]*\)\s*$/, '') // a trailing "(John 3:16 NIVUK)"
      .trim();
    var r = parseVerseRange(reference);
    if (!r || !t) return t;
    if (r.to === r.from) {
      // a single verse needs no number
      return t.replace(new RegExp('^(' + r.from + '|' + r.chapter + ')\\s+'), '');
    }
    var pos = 0;
    var n = r.from;
    var last = r.to == null ? 200 : r.to;
    if (r.from === 1) {
      // a passage that starts a chapter often shows the chapter number instead of "1"
      var lead = t.match(/^(\d+)\s/);
      if (lead && (Number(lead[1]) === r.chapter || Number(lead[1]) === 1)) {
        t = toSup(1) + t.slice(lead[1].length);
        pos = toSup(1).length;
        n = 2;
      }
    }
    for (; n <= last; n++) {
      var re = new RegExp('(^|[\\s“"‘(\\[—–-])' + n + '(?=\\s)', 'g');
      re.lastIndex = pos;
      var m = re.exec(t);
      if (!m) {
        if (r.to == null) break;
        continue;
      }
      var at = m.index + m[1].length;
      var sup = toSup(n);
      t = t.slice(0, at) + sup + t.slice(at + String(n).length);
      pos = at + sup.length;
    }
    return t;
  }

  // ---------- video ----------
  function ytStart(u) {
    var t = u.searchParams.get('t') || u.searchParams.get('start');
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    var m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
  }
  function parseVideo(url) {
    if (!url) return null;
    var u;
    try { u = new URL(String(url).trim()); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    var host = u.hostname.replace(/^(www|m)\./, '');
    var id = null;
    var vertical = false;
    if (host === 'youtu.be') {
      id = u.pathname.slice(1).split('/')[0];
    } else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        var m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]+)/);
        if (m) { id = m[2]; vertical = m[1] === 'shorts'; }
      }
    }
    if (id && /^[\w-]{6,20}$/.test(id)) {
      var start = ytStart(u);
      return { kind: 'youtube', vertical: vertical, src: 'https://www.youtube-nocookie.com/embed/' + id + '?rel=0' + (start ? '&start=' + start : '') };
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      var vm = u.pathname.match(/(\d{6,})/);
      if (vm) return { kind: 'vimeo', src: 'https://player.vimeo.com/video/' + vm[1] };
    }
    if (host === 'drive.google.com') {
      var dm = u.pathname.match(/\/file\/d\/([\w-]+)/);
      var did = dm ? dm[1] : u.searchParams.get('id');
      if (did) return { kind: 'drive', src: 'https://drive.google.com/file/d/' + did + '/preview' };
    }
    if (/\.(mp4|m4v|mov|webm)$/i.test(u.pathname) || u.pathname.indexOf('/storage/v1/object/public/videos/') >= 0) {
      return { kind: 'file', src: u.href };
    }
    return { kind: 'link', src: u.href };
  }
  function videoHtml(v) {
    if (!v) return '';
    if (v.kind === 'file') {
      return '<video class="video-file" controls playsinline preload="metadata" src="' + esc(v.src) + '"></video>';
    }
    if (v.kind === 'link') {
      return '<a class="btn" href="' + esc(v.src) + '" target="_blank" rel="noopener">Watch the video <span aria-hidden="true">↗</span></a>';
    }
    return '<div class="video-frame' + (v.vertical ? ' vertical' : '') + '"><iframe src="' + esc(v.src) +
      '" title="Video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
  }

  // ---------- little UI bits ----------
  function toast(msg, kind) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = 'toast'; }, 3200);
  }
  function friendly(error) {
    var m = (error && (error.message || error.error_description || error.msg)) || '';
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
      return "Couldn't connect. Check your internet and try again.";
    }
    if (m && m.length < 180 && !/violates|syntax|relation|function|permission|jwt|column|schema|duplicate key/i.test(m)) return m;
    return 'Something went wrong. Please try again.';
  }
  function spinner(text) {
    return '<div class="loading" role="status"><div class="spinner" aria-hidden="true"></div><span class="sr-only">' + esc(text || 'Loading') + '</span></div>';
  }

  // ---------- site settings (name + tagline) ----------
  var SETTINGS_KEY = 'dv:settings';
  var settings = lsGet(SETTINGS_KEY, null) || { site_title: 'Daily Verse', tagline: 'A Bible passage, a short reflection and a prayer for each day.' };
  function applySettings() {
    document.querySelectorAll('[data-site-title]').forEach(function (el) { el.textContent = settings.site_title; });
    document.querySelectorAll('[data-site-tagline]').forEach(function (el) { el.textContent = settings.tagline; });
  }
  function loadSettings() {
    applySettings();
    return sb.from('settings').select('site_title,tagline').eq('id', 1).maybeSingle().then(function (res) {
      if (res.data) {
        settings = res.data;
        lsSet(SETTINGS_KEY, settings);
        applySettings();
      }
      return settings;
    });
  }
  function setSettings(s) {
    settings = s;
    lsSet(SETTINGS_KEY, s);
    applySettings();
  }

  async function checkAdmin() {
    var res = await sb.auth.getSession();
    if (!res.data || !res.data.session) return false;
    var r = await sb.rpc('is_admin');
    return !r.error && r.data === true;
  }

  window.DV = {
    sb: sb,
    cfg: cfg,
    wasRecovery: wasRecovery,
    lsGet: lsGet,
    lsSet: lsSet,
    ukToday: ukToday,
    addDays: addDays,
    fmtDate: fmtDate,
    dayLabel: dayLabel,
    timeAgo: timeAgo,
    esc: esc,
    richText: richText,
    commentText: commentText,
    verseHtml: verseHtml,
    plainVerse: plainVerse,
    toSup: toSup,
    initial: initial,
    hue: hue,
    bibleGatewayUrl: bibleGatewayUrl,
    passageUrl: passageUrl,
    parseVerseRange: parseVerseRange,
    verseCount: verseCount,
    cleanPastedVerses: cleanPastedVerses,
    parseVideo: parseVideo,
    videoHtml: videoHtml,
    toast: toast,
    friendly: friendly,
    spinner: spinner,
    loadSettings: loadSettings,
    setSettings: setSettings,
    settings: function () { return settings; },
    checkAdmin: checkAdmin
  };
})();
