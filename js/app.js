(function () {
  'use strict';
  var CFG = window.SITE_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = 'gdcb-token', USER_KEY = 'gdcb-user';
  var state = { token: null, user: null, cache: {}, busy: false };

  // ---------------------------------------------------------------- helpers
  function el(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'on') Object.keys(props.on).forEach(function (ev) { e.addEventListener(ev, props.on[ev]); });
      else if (props[k] === true) e.setAttribute(k, '');
      else if (props[k] !== false && props[k] != null) e.setAttribute(k, props[k]);
    });
    add(e, [].slice.call(arguments, 2));
    return e;
  }
  function add(e, list) {
    list.forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) add(e, c);
      else e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function store(get, k, v) {
    try { if (get) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* private mode */ }
    return null;
  }

  // ---------------------------------------------------------------- API
  function api(action, payload, opts) {
    opts = opts || {};
    if (!CFG.API_URL) return Promise.reject(mkErr('NOT_CONFIGURED', 'This site is not connected yet. The owner must put the Apps Script URL in js/config.js.'));
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeout || 30000);
    return fetch(CFG.API_URL, {
      method: 'POST', redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, token: state.token || '', payload: payload || {} }),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) { return r.text(); }).then(function (txt) {
      clearTimeout(timer);
      var j;
      try { j = JSON.parse(txt); } catch (e) { throw mkErr('BAD_RESPONSE', 'The server sent an unexpected reply. Please try again.'); }
      if (!j.ok) {
        var er = mkErr(j.error && j.error.code, j.error && j.error.message);
        if (action !== 'auth.login' && (er.code === 'UNAUTHORIZED' || (er.code === 'FORBIDDEN' && state.token))) { signedOut(er.message); }
        throw er;
      }
      return j.data;
    }, function (e) {
      clearTimeout(timer);
      if (e && e.isApp) throw e;
      throw mkErr('NETWORK', 'Could not reach the server. Check your internet connection and try again.');
    });
  }
  function mkErr(code, message) { var e = new Error(message || 'Something went wrong'); e.code = code; e.isApp = true; return e; }
  function cached(key, action, payload, opts) {
    if (state.cache[key]) return Promise.resolve(state.cache[key]);
    return api(action, payload, opts).then(function (d) { state.cache[key] = d; return d; });
  }

  // ---------------------------------------------------------------- session
  function showLogin(msg, ok) {
    $('app').hidden = true; $('login').hidden = false;
    var m = $('lmsg');
    if (msg) { m.textContent = msg; m.hidden = false; m.className = 'msg' + (ok ? ' okmsg' : ''); } else { m.hidden = true; }
    $('lp').value = '';
    $('lgo').disabled = false; $('lgo').textContent = 'Sign in';
    (($('lu').value ? $('lp') : $('lu'))).focus();
  }
  function signedOut(msg) {
    state.token = null; state.user = null; state.cache = {};
    store(false, TOKEN_KEY, null); store(false, USER_KEY, null);
    clear($('main'));
    showLogin(msg || '');
  }
  function enterApp() {
    $('login').hidden = true; $('app').hidden = false;
    $('navadmin').hidden = state.user.role !== 'Admin';
    $('lic').textContent = 'Signed in as ' + state.user.name + ' (' + state.user.username + '). This login is personal, please do not share it.' + (state.user.expires_on ? ' Access valid until ' + state.user.expires_on + '.' : '');
    route();
  }

  $('lform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var u = $('lu').value.trim(), p = $('lp').value;
    if (!u || !p) { showLogin('Please type your username and password.'); return; }
    $('lgo').disabled = true; $('lgo').textContent = 'Signing in...';
    api('auth.login', { username: u, password: p }).then(function (d) {
      state.token = d.token; state.user = d.user; state.cache = {};
      store(false, TOKEN_KEY, d.token); store(false, USER_KEY, JSON.stringify(d.user));
      $('lp').value = '';
      if (!location.hash || location.hash === '#/admin' && d.user.role !== 'Admin') location.hash = '#/';
      enterApp();
    }, function (e) { showLogin(e.message); });
  });
  $('lshow').addEventListener('click', function () {
    var p = $('lp'), on = p.type === 'password';
    p.type = on ? 'text' : 'password'; this.textContent = on ? 'Hide' : 'Show'; this.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $('logout').addEventListener('click', function () {
    var t = state.token;
    if (t) api('auth.logout').catch(function () {});
    signedOut('You have been signed out.');
    $('lmsg').className = 'msg okmsg';
  });

  // ---------------------------------------------------------------- progress (this browser only)
  function pkey() { return 'gdcb-progress-v2-' + (state.user ? state.user.username : ''); }
  function loadProg() { try { return JSON.parse(localStorage.getItem(pkey())) || {}; } catch (e) { return {}; } }
  function saveProg(o) { try { localStorage.setItem(pkey(), JSON.stringify(o)); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- views
  function loading(main) { clear(main); main.appendChild(el('p', { class: 'muted', role: 'status', text: 'Loading...' })); }
  function failure(main, e, retry) {
    clear(main);
    if (!state.token) return;                      // signed out meanwhile: show nothing
    main.appendChild(el('div', { class: 'notice', role: 'alert' }, el('p', { text: e.message }),
      retry ? el('button', { class: 'btn', type: 'button', on: { click: retry } }, 'Try again') : null));
  }

  function viewHome(main) {
    loading(main);
    cached('index', 'content.index').then(function (ix) {
      clear(main);
      var done = loadProg(), count = 0;
      var cards = [];
      var pbar = el('span'), ptext = el('p', { id: 'ptext' });
      var q = el('input', { id: 'q', type: 'search', placeholder: 'Search topics, e.g. RAM, router, backup', autocomplete: 'off' });
      var none = el('p', { class: 'muted', hidden: true, text: 'No topic matches your search.' });
      var hero = el('section', { class: 'hero' },
        el('p', { class: 'eyebrow', text: ix.brand }), el('h1', { text: ix.title }), el('p', { text: ix.sub + '.' }),
        el('div', { class: 'progress', 'aria-live': 'polite' }, el('div', { class: 'bar' }, pbar), ptext),
        el('label', { class: 'search' }, el('span', { class: 'sr', text: 'Search topics' }), q),
        el('p', { class: 'quick' },
          el('a', { class: 'btn', href: '#/t/1', text: 'Start with topic 1' }), ' ',
          el('a', { class: 'btn alt', href: '#/quiz', text: 'Quick quiz' }), ' ',
          el('a', { class: 'btn alt', href: '#/print', text: 'Print all notes' })));
      main.appendChild(hero);
      var sections = [];
      [1, 2, 3, 4].forEach(function (p) {
        var ts = ix.topics.filter(function (t) { return t.part === p; });
        var ol = el('ol', { class: 'cards', start: String(ts[0].n) });
        ts.forEach(function (t) {
          var isDone = !!done[t.n]; if (isDone) count++;
          var li = el('li', { class: 'card' + (isDone ? ' done' : ''), 'data-hay': t.hay },
            el('a', { href: '#/t/' + t.n },
              el('span', { class: 'num', text: String(t.n) }),
              el('span', { class: 'ct' }, el('b', { text: t.title }), el('small', { text: t.summary })),
              el('span', { class: 'tick', 'aria-hidden': 'true' })));
          cards.push(li); ol.appendChild(li);
        });
        var sec = el('section', { class: 'part' },
          el('h2', null, el('span', { text: ix.parts[p][0] }), ' ' + ix.parts[p][1] + ' ', el('small', { text: ts.length + ' topics' })), ol);
        sections.push(sec); main.appendChild(sec);
      });
      main.appendChild(none);
      pbar.style.width = Math.round(count / cards.length * 100) + '%';
      ptext.textContent = count + ' of ' + cards.length + ' topics done';
      q.addEventListener('input', function () {
        var v = q.value.trim().toLowerCase(), shown = 0;
        cards.forEach(function (c) { var m = !v || c.getAttribute('data-hay').indexOf(v) > -1; c.hidden = !m; if (m) shown++; });
        sections.forEach(function (s) { s.hidden = !s.querySelector('.card:not([hidden])'); });
        none.hidden = shown > 0;
      });
    }, function (e) { failure(main, e, function () { viewHome(main); }); });
  }

  function svgUri(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

  function viewTopic(main, n) {
    loading(main);
    cached('t' + n, 'content.topic', { n: n }).then(function (t) {
      clear(main);
      main.innerHTML = t.html;                      // trusted: generated by the owner's build script, served only after login
      var img = $('dimg'); if (img) img.src = svgUri(t.diagram);
      var dl = $('dl');
      if (dl) dl.addEventListener('click', function (ev) {
        ev.preventDefault();
        var b = new Blob([t.diagram], { type: 'image/svg+xml' }), u = URL.createObjectURL(b);
        var a = el('a', { href: u, download: 'topic-' + n + '.svg' }); document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
      });
      var btn = $('done'), badge = main.querySelector('.donebadge');
      function paint() { var d = loadProg()[n]; btn.setAttribute('aria-pressed', d ? 'true' : 'false'); btn.textContent = d ? 'Done (tap to undo)' : 'Mark as done'; badge.hidden = !d; }
      btn.addEventListener('click', function () { var o = loadProg(); if (o[n]) delete o[n]; else o[n] = 1; saveProg(o); paint(); });
      paint();
      document.title = t.n + '. Computer Basics';
    }, function (e) { failure(main, e, function () { viewTopic(main, n); }); });
  }

  function viewGlossary(main) {
    loading(main);
    cached('glossary', 'content.glossary').then(function (g) {
      clear(main);
      var gq = el('input', { id: 'gq', type: 'search', placeholder: 'Filter terms', autocomplete: 'off' });
      var none = el('p', { class: 'muted', hidden: true, text: 'No term matches.' });
      var dl = el('dl', { class: 'gloss' }), rows = [];
      g.terms.forEach(function (t) {
        var d = el('div', { class: 'g', 'data-hay': (t.term + ' ' + t.def).toLowerCase() },
          el('dt', { text: t.term }), el('dd', null, t.def + ' ', el('a', { href: '#/t/' + t.n, text: 'topic ' + t.n })));
        rows.push(d); dl.appendChild(d);
      });
      main.appendChild(el('h1', { text: 'Glossary' }));
      main.appendChild(el('p', { class: 'lead', text: g.terms.length + ' key terms from your notes. Tap a topic number to read more.' }));
      main.appendChild(el('label', { class: 'search' }, el('span', { class: 'sr', text: 'Filter terms' }), gq));
      main.appendChild(dl); main.appendChild(none);
      gq.addEventListener('input', function () {
        var v = gq.value.trim().toLowerCase(), s = 0;
        rows.forEach(function (r) { var m = !v || r.getAttribute('data-hay').indexOf(v) > -1; r.hidden = !m; if (m) s++; });
        none.hidden = s > 0;
      });
    }, function (e) { failure(main, e, function () { viewGlossary(main); }); });
  }

  function viewQuiz(main) {
    loading(main);
    cached('quiz', 'content.quiz').then(function (qd) {
      clear(main); main.className = 'wrap narrow';
      var S = { list: [], i: 0, wrong: [], right: 0 };
      var part = el('select', { id: 'qpart' }, el('option', { value: '0', text: 'All topics' }),
        el('option', { value: '1', text: 'Part 1' }), el('option', { value: '2', text: 'Part 2' }), el('option', { value: '3', text: 'Part 3' }), el('option', { value: '4', text: 'Part 4' }));
      var cnt = el('select', { id: 'qcount' }, el('option', { value: '10', text: '10' }), el('option', { value: '20', text: '20' }), el('option', { value: '999', text: 'All' }));
      var start = el('button', { class: 'btn', type: 'button', id: 'qstart', text: 'Start' });
      var meta = el('p', { class: 'qmeta', id: 'qmeta' }), text = el('h2', { id: 'qtext' }), ans = el('p', { class: 'qans', id: 'qans', hidden: true });
      var show = el('button', { class: 'btn', type: 'button', id: 'qshow', text: 'Show answer' });
      var yes = el('button', { class: 'btn ok', type: 'button', id: 'qyes', hidden: true, text: 'I knew it' });
      var no = el('button', { class: 'btn warn', type: 'button', id: 'qno', hidden: true, text: 'Review again' });
      var box = el('section', { class: 'qbox', id: 'qbox', hidden: true, 'aria-live': 'polite' }, meta, text, ans, el('p', { class: 'actions' }, show, ' ', yes, ' ', no));
      var score = el('p', { id: 'qscore' }), review = el('div', { id: 'qreview' });
      var again = el('button', { class: 'btn', type: 'button', id: 'qagain', text: 'Try again' });
      var end = el('section', { class: 'qbox', id: 'qend', hidden: true }, el('h2', { text: 'Finished' }), score, review, el('p', { class: 'actions' }, again));
      main.appendChild(el('h1', { text: 'Quick quiz' }));
      main.appendChild(el('p', { class: 'lead' }, 'Read the question, answer in your head or aloud, then tap ', el('b', { text: 'Show answer' }), '.'));
      main.appendChild(el('div', { class: 'qsetup' }, el('label', null, 'Topics ', part), ' ', el('label', null, 'Questions ', cnt), ' ', start));
      main.appendChild(box); main.appendChild(end);
      function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
      function showQ() {
        var c = S.list[S.i];
        meta.textContent = 'Question ' + (S.i + 1) + ' of ' + S.list.length + ' - topic ' + c.n + ': ' + c.title;
        text.textContent = c.q; ans.textContent = c.a; ans.hidden = true;
        show.hidden = false; yes.hidden = true; no.hidden = true; show.focus();
      }
      function next(ok) {
        if (ok) S.right++; else S.wrong.push(S.list[S.i]);
        S.i++;
        if (S.i >= S.list.length) {
          box.hidden = true; end.hidden = false;
          score.textContent = 'You knew ' + S.right + ' of ' + S.list.length + '.';
          clear(review);
          if (S.wrong.length) {
            review.appendChild(el('h3', { text: 'Review these topics' }));
            var seen = {}, ul = el('ul');
            S.wrong.forEach(function (w) { if (seen[w.n]) return; seen[w.n] = 1; ul.appendChild(el('li', null, el('a', { href: '#/t/' + w.n, text: w.n + '. ' + w.title }))); });
            review.appendChild(ul);
          }
        } else showQ();
      }
      function begin() {
        var p = +part.value, c = +cnt.value;
        var pool = qd.questions.filter(function (x) { return !p || x.part === p; });
        S.list = shuffle(pool.slice()).slice(0, c); S.i = 0; S.wrong = []; S.right = 0;
        end.hidden = true; box.hidden = false; showQ();
      }
      start.addEventListener('click', begin); again.addEventListener('click', begin);
      show.addEventListener('click', function () { ans.hidden = false; show.hidden = true; yes.hidden = false; no.hidden = false; yes.focus(); });
      yes.addEventListener('click', function () { next(true); }); no.addEventListener('click', function () { next(false); });
    }, function (e) { failure(main, e, function () { viewQuiz(main); }); });
  }

  function viewPrint(main) {
    loading(main);
    cached('all', 'content.all', {}, { timeout: 90000 }).then(function (d) {
      clear(main);
      main.appendChild(el('div', { class: 'noprint' }, el('h1', { text: 'All topics on one page' }),
        el('p', { class: 'lead' }, 'Press the button, then choose ', el('b', { text: 'Save as PDF' }), ' or a printer. Each topic starts on a new page.'),
        el('p', null, el('button', { class: 'btn', type: 'button', text: 'Print / Save as PDF', on: { click: function () { window.print(); } } }))));
      main.appendChild(el('p', { class: 'printonly', text: 'Printed for ' + state.user.name + ' (' + state.user.username + '). Personal copy - please do not share.' }));
      d.topics.forEach(function (t) {
        var a = el('article', { class: 'ptopic' }); a.innerHTML = t.html;
        var im = a.querySelector('img.pdia'); if (im) im.src = svgUri(t.diagram);
        main.appendChild(a);
      });
    }, function (e) { failure(main, e, function () { viewPrint(main); }); });
  }

  // ---------------------------------------------------------------- admin
  var adminTab = 'users', editing = null, lastCred = null;

  function fmtDate(s) { return s ? s.replace('T', ' ').slice(0, 16) : 'never'; }

  function viewAdmin(main) {
    if (state.user.role !== 'Admin') { clear(main); main.appendChild(el('div', { class: 'notice', text: 'This page is only for the owner.' })); return; }
    clear(main);
    main.appendChild(el('h1', { text: 'Admin' }));
    var tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Admin sections' });
    [['users', 'Users'], ['activity', 'Activity']].forEach(function (t) {
      tabs.appendChild(el('button', { class: 'btn alt', type: 'button', 'aria-pressed': adminTab === t[0] ? 'true' : 'false', text: t[1],
        on: { click: function () { adminTab = t[0]; viewAdmin(main); } } }));
    });
    main.appendChild(tabs);
    var body = el('div'); main.appendChild(body);
    if (adminTab === 'activity') return adminActivity(body);
    adminUsers(body, main);
  }

  function adminActivity(body) {
    loading(body);
    api('audit.list').then(function (d) {
      clear(body);
      var tb = el('tbody');
      d.rows.forEach(function (r) { tb.appendChild(el('tr', null, el('td', { text: fmtDate(r.time) }), el('td', { text: r.user }), el('td', { text: r.action }), el('td', { text: r.detail }))); });
      body.appendChild(el('p', { class: 'muted', text: 'The latest 100 events, newest first.' }));
      body.appendChild(el('div', { class: 'tw' }, el('table', { class: 'ut' }, el('thead', null, el('tr', null, el('th', { text: 'Time' }), el('th', { text: 'User' }), el('th', { text: 'Event' }), el('th', { text: 'Detail' }))), tb)));
    }, function (e) { failure(body, e); });
  }

  function credBox(c, verb) {
    var url = location.href.split('#')[0];
    var msg = 'GD Computer Basics - One Shot Revision\nSite: ' + url + '\nUsername: ' + c.user.username + '\nPassword: ' + c.password +
      '\n' + (c.user.expires_on ? 'Valid until: ' + c.user.expires_on + '\n' : '') + 'Please keep this private.';
    var status = el('span', { class: 'muted', role: 'status' });
    return el('div', { class: 'cred', role: 'status' },
      el('p', null, el('b', { text: verb + ' ' })),
      el('p', null, 'Username: ', el('code', { text: c.user.username })),
      el('p', null, 'Password: ', el('code', { text: c.password })),
      el('p', { class: 'small', text: 'This password is shown only now. It is not stored anywhere in readable form.' }),
      el('p', null, el('button', { class: 'btn', type: 'button', text: 'Copy login message', on: { click: function () {
        (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(msg) : Promise.reject()).then(
          function () { status.textContent = 'Copied.'; }, function () { status.textContent = 'Copy not allowed here - select the text above and copy it.'; });
      } } }), ' ', status));
  }

  function adminUsers(body, main) {
    loading(body);
    api('users.list').then(function (d) {
      clear(body);
      var credHolder = el('div'); if (lastCred) credHolder.appendChild(credBox(lastCred.c, lastCred.verb));
      // ---- add form
      var f = {
        username: el('input', { id: 'nu', maxlength: '32', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' }),
        name: el('input', { id: 'nn', maxlength: '60', autocomplete: 'off' }),
        pass: el('input', { id: 'np', maxlength: '128', autocomplete: 'off', placeholder: 'leave empty = auto' }),
        days: el('input', { id: 'nd', type: 'number', min: '1', max: '3650', placeholder: 'empty = no expiry' }),
        note: el('input', { id: 'nt', maxlength: '200', autocomplete: 'off' })
      };
      var err = el('p', { class: 'msg', hidden: true, role: 'alert' });
      var add = el('button', { class: 'btn', type: 'button', id: 'nadd', text: 'Create user' });
      add.addEventListener('click', function () {
        add.disabled = true; err.hidden = true;
        api('users.create', { username: f.username.value, display_name: f.name.value, password: f.pass.value, days: f.days.value === '' ? '' : Number(f.days.value), note: f.note.value }).then(function (r) {
          lastCred = { c: r, verb: 'User created.' }; viewAdmin(main);
        }, function (e) { err.textContent = e.message; err.hidden = false; add.disabled = false; });
      });
      body.appendChild(el('section', { class: 'panel' }, el('h2', { text: 'Add a user' }),
        el('div', { class: 'fgrid' },
          el('div', null, el('label', { for: 'nu', text: 'Username' }), f.username), el('div', null, el('label', { for: 'nn', text: 'Name' }), f.name),
          el('div', null, el('label', { for: 'np', text: 'Password' }), f.pass), el('div', null, el('label', { for: 'nd', text: 'Valid for (days)' }), f.days),
          el('div', null, el('label', { for: 'nt', text: 'Note (only you see it)' }), f.note)),
        err, el('p', null, add)));
      body.appendChild(credHolder);
      // ---- edit panel
      if (editing) {
        var u = d.users.filter(function (x) { return x.username === editing; })[0];
        if (u) body.appendChild(editPanel(u, main));
      }
      // ---- table
      var tb = el('tbody');
      d.users.forEach(function (u) {
        var st = u.state === 'ok' ? el('span', { class: 'badge', text: 'Active' }) : u.state === 'expired' ? el('span', { class: 'badge exp', text: 'Expired' }) : el('span', { class: 'badge off', text: 'Disabled' });
        function act(label, fn, cls) { return el('button', { class: 'btn ' + (cls || 'alt'), type: 'button', text: label, on: { click: function (ev) { ev.target.disabled = true; fn(); } } }); }
        var acts = el('td', null, el('div', { class: 'actsin' },
          act(u.status === 'Active' ? 'Disable' : 'Enable', function () { api('users.update', { username: u.username, status: u.status === 'Active' ? 'Disabled' : 'Active' }).then(function () { lastCred = null; viewAdmin(main); }, adminErr(main)); }),
          act('Edit', function () { editing = u.username; viewAdmin(main); }),
          act('New password', function () { if (!window.confirm('Make a new password for ' + u.username + '? The old one stops working.')) { viewAdmin(main); return; } api('users.resetPassword', { username: u.username }).then(function (r) { lastCred = { c: r, verb: 'New password made.' }; viewAdmin(main); }, adminErr(main)); }),
          u.signed_in ? act('Sign out', function () { api('users.signOut', { username: u.username }).then(function () { viewAdmin(main); }, adminErr(main)); }) : null));
        tb.appendChild(el('tr', null,
          el('td', null, el('b', { text: u.display_name }), el('br'), el('small', { text: u.username + (u.note ? ' - ' + u.note : '') })),
          el('td', null, st), el('td', { text: u.expires_on || 'never' }), el('td', { text: fmtDate(u.last_login) }), el('td', { text: String(u.login_count) }), acts));
      });
      body.appendChild(el('h2', { text: 'Users (' + d.users.length + ')' }));
      if (!d.users.length) body.appendChild(el('p', { class: 'muted', text: 'No users yet. Add the first one above.' }));
      else body.appendChild(el('div', { class: 'tw' }, el('table', { class: 'ut' },
        el('thead', null, el('tr', null, ['User', 'Status', 'Expires', 'Last sign-in', 'Sign-ins', ''].map(function (h) { return el('th', { text: h }); }))), tb)));
      body.appendChild(el('p', { class: 'small muted', text: 'Today is ' + d.today + '. An account stops working at the end of its expiry date.' }));
    }, function (e) { failure(body, e); });
  }

  function adminErr(main) { return function (e) { window.alert(e.message); viewAdmin(main); }; }

  function editPanel(u, main) {
    var name = el('input', { id: 'en', value: u.display_name, maxlength: '60' }), ex = el('input', { id: 'ee', type: 'date', value: u.expires_on || '' }), note = el('input', { id: 'et', value: u.note || '', maxlength: '200' });
    var err = el('p', { class: 'msg', hidden: true, role: 'alert' });
    function go(extra) {
      var p = { username: u.username, display_name: name.value, note: note.value, expires_on: ex.value };
      Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
      if (extra && extra.extend_days) delete p.expires_on;
      api('users.update', p).then(function () { editing = null; lastCred = null; viewAdmin(main); }, function (e) { err.textContent = e.message; err.hidden = false; });
    }
    function btn(label, fn) { return el('button', { class: 'btn alt', type: 'button', text: label, on: { click: fn } }); }
    return el('section', { class: 'panel', id: 'epanel' }, el('h2', { text: 'Edit ' + u.username }),
      el('div', { class: 'fgrid' }, el('div', null, el('label', { for: 'en', text: 'Name' }), name), el('div', null, el('label', { for: 'ee', text: 'Expiry date' }), ex), el('div', null, el('label', { for: 'et', text: 'Note' }), note)),
      el('p', null, 'Quick extend: ', btn('+30 days', function () { go({ extend_days: 30 }); }), ' ', btn('+90 days', function () { go({ extend_days: 90 }); }), ' ', btn('+365 days', function () { go({ extend_days: 365 }); }), ' ', btn('Remove expiry', function () { ex.value = ''; go(); })),
      err, el('p', null, el('button', { class: 'btn', type: 'button', text: 'Save', on: { click: function () { go(); } } }), ' ', btn('Cancel', function () { editing = null; viewAdmin(main); })));
  }

  // ---------------------------------------------------------------- router
  function setActive(r) {
    [].forEach.call(document.querySelectorAll('#nav a'), function (a) { if (a.getAttribute('data-r') === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  function route() {
    if (!state.token) return;
    var main = $('main'); main.className = 'wrap';
    var h = location.hash.replace(/^#\/?/, ''), m;
    document.title = 'Computer Basics - One Shot Revision';
    if ((m = /^t\/(\d{1,3})$/.exec(h))) { setActive('home'); viewTopic(main, Number(m[1])); }
    else if (h === 'quiz') { setActive('quiz'); viewQuiz(main); }
    else if (h === 'glossary') { setActive('glossary'); viewGlossary(main); }
    else if (h === 'print') { setActive('print'); viewPrint(main); }
    else if (h === 'admin') { setActive('admin'); viewAdmin(main); }
    else { setActive('home'); viewHome(main); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- start
  (function boot() {
    var t = store(true, TOKEN_KEY);
    if (!CFG.API_URL) { showLogin('This site is not connected yet. The owner must put the Apps Script URL in js/config.js.'); return; }
    if (!t) { showLogin(''); return; }
    state.token = t;
    api('auth.me').then(function (u) {
      state.user = u; store(false, USER_KEY, JSON.stringify(u)); enterApp();
    }, function (e) { if (e.code !== 'UNAUTHORIZED' && e.code !== 'FORBIDDEN') { state.token = null; showLogin(e.message); } });
  })();
})();
