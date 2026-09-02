(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var K = { token: 'my.token', photos: 'my.photos', seen: 'my.seen', outbox: 'my.outbox', name: 'my.name' };

  var KINDS = [
    { k: 'missyou',  ic: '',                label: 'Miss You',   said: 'Misses you',           out: 'You missed',        inn: 'missed you',      hue: ['#7E9BC4', '#EAF1FA', '#C97B6E'] },
    { k: 'hug',      ic: '\uD83E\uDD17', label: 'Hug',        said: 'Sent you a hug',       out: 'You hugged',        inn: 'sent you a hug',  hue: ['#E4A950', '#FFE6BB', '#C97B6E'] },
    { k: 'thinking', ic: '\u2615',        label: 'Thinking',   said: 'Is thinking of you',   out: 'You thought of',    inn: 'thought of you',  hue: ['#C9A227', '#F7F0E4', '#B98C5A'] },
    { k: 'laugh',    ic: '\uD83D\uDE02', label: 'Laughing',   said: 'Is laughing with you', out: 'You laughed with',  inn: 'laughed with you', hue: ['#E4A950', '#F7F0E4', '#8FB98A'] },
    { k: 'proud',    ic: '\u2B50',        label: 'Proud',      said: 'Is proud of you',      out: 'You cheered',       inn: 'is proud of you', hue: ['#E4C64F', '#FFF3D0', '#E4A950'] },
    { k: 'night',    ic: '\uD83C\uDF19', label: 'Good Night', said: 'Says good night',      out: 'You said night to', inn: 'said good night', hue: ['#7E9BC4', '#C9BCE0', '#F7F0E4'] },
    { k: 'text',     ic: '',              label: 'Message',    said: 'Says',                 out: 'You wrote to',      inn: 'wrote to you',    hue: ['#E4A950', '#F7F0E4', '#7E9BC4'] }
  ];

  var TEXT_MAX = 200;

  function kindOf(k) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].k === k) return KINDS[i];
    return KINDS[0];
  }

  var state = {
    token: null,
    user: null,
    friend: null,
    activity: [],
    live: false,
    awayCount: 0,
    stale: false
  };

  var ws = null, retry = 0, retryTimer = null;
  var popQueue = [], popShowing = false, popKind = 'missyou';

  /* Storage is versioned, never wiped. A new version of the app migrates what
     it finds rather than starting clean, so shipping a change can never sign
     anyone out. Keys added later go in MIGRATIONS, and old keys are read
     before they are retired. If localStorage itself is unavailable the app
     falls back to memory for the session instead of failing. */

  var SCHEMA = '3';
  var mem = {};

  function get(k, fb) {
    try {
      var v = localStorage.getItem(k);
      if (v !== null) return v;
    } catch (e) {
      if (Object.prototype.hasOwnProperty.call(mem, k)) return mem[k];
    }
    return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : fb;
  }

  function put(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }

  /* Only ever called from a path the user chose. */
  function del(k) {
    delete mem[k];
    try { localStorage.removeItem(k); } catch (e) {}
  }

  function migrate() {
    var was = get('my.schema', null);
    if (was === SCHEMA) return;

    /* carry anything an older build wrote under a different name */
    var LEGACY = [['aemerg.token', K.token], ['missyou.token', K.token],
                  ['aemerg.name', K.name],   ['missyou.name', K.name]];
    for (var i = 0; i < LEGACY.length; i++) {
      var from = LEGACY[i][0], to = LEGACY[i][1];
      var v = get(from, null);
      if (v && !get(to, null)) put(to, v);
    }
    put('my.schema', SCHEMA);
  }

  function jsonGet(k, fb) { try { return JSON.parse(get(k, JSON.stringify(fb))) || fb; } catch (e) { return fb; } }

  migrate();

  var seen   = jsonGet(K.seen, []);
  var outbox = jsonGet(K.outbox, []);

  function markSeen(id) {
    if (seen.indexOf(id) > -1) return false;
    seen.push(id);
    if (seen.length > 300) seen = seen.slice(-300);
    put(K.seen, JSON.stringify(seen));
    return true;
  }

  var toastTimer;
  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.remove('on'); }, 3400);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || 'Something went wrong. Try again.');
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    if (s < 90) return '1 min ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 7200) return '1 hour ago';
    if (s < 86400) return Math.round(s / 3600) + ' hours ago';
    if (s < 172800) return 'yesterday';
    return Math.round(s / 86400) + ' days ago';
  }

  function shortAgo(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  function updateDate() {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var day = new Date(now.getFullYear(), 8, 11);
    if (today > day) day = new Date(now.getFullYear() + 1, 8, 11);
    var left = Math.round((day - today) / 86400000);
    var s = '11 September';
    if (left === 0)      s += ' · today';
    else if (left === 1) s += ' · tomorrow';
    else                 s += ' · ' + left + ' days to go';
    $('dateText').textContent = s;
    return left;
  }

  function screen(which) {
    ['scr-onboard', 'scr-connect', 'scr-home', 'scr-stale'].forEach(function (s) {
      $(s).classList.toggle('on', s === which);
    });
    $('openSettings').hidden = !state.token;
    $('activity').classList.toggle('on', which === 'scr-home');
  }

  function fitName() {
    var el = $('friendName');
    el.style.transform = 'scale(1)';
    var box = el.parentElement.clientWidth;
    if (el.scrollWidth > box && box > 0) {
      el.style.transform = 'scale(' + (box / el.scrollWidth).toFixed(4) + ')';
    }
  }

  function paint() {
    if (!state.token)      { screen('scr-onboard'); return; }
    if (state.stale) {
      var who = get(K.name, '');
      $('staleWho').textContent = who
        ? 'This device is signed in as ' + who + ', but the server does not recognise it right now.'
        : 'The server does not recognise this device right now.';
      screen('scr-stale');
      return;
    }
    if (!state.friend)     { screen('scr-connect'); paintCodes(); return; }

    screen('scr-home');
    paintCodes();
    $('friendName').textContent = state.friend.name;
    fitName();
    setPresence(state.friend.online);
    paintActivity();
  }

  function paintCodes() {
    var code = state.user ? state.user.code : '------';
    $('myCode').textContent = code;
    $('setCode').textContent = code;
  }

  function buildSendButtons() {
    var wrap = $('sendMore');
    wrap.innerHTML = '';
    KINDS.slice(1).filter(function (k) { return k.k !== 'text'; }).forEach(function (kind) {
      var b = document.createElement('button');
      b.className = 'send';
      b.type = 'button';
      b.setAttribute('data-kind', kind.k);
      if (kind.ic) {
        var ic = document.createElement('span');
        ic.className = 'ic';
        ic.textContent = kind.ic;
        b.appendChild(ic);
      }
      var tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = kind.label;
      b.appendChild(tx);
      b.onclick = function () { sendMiss(kind.k); };
      wrap.appendChild(b);
    });
  }

  function sendButtons() {
    return [].slice.call(document.querySelectorAll('.send'));
  }

  function setPresence(online) {
    if (state.friend) state.friend.online = online;
    $('status').classList.toggle('up', !!online);
    $('statusText').textContent = online ? 'Online now' : 'Offline';
    $('setFriendState').textContent = online ? 'Online' : 'Offline';
    if (online) { state.awayCount = 0; $('setQueued').textContent = '0'; }
    sendButtons().forEach(function (b) { b.disabled = !state.friend; });
    $('composeText').disabled = !state.friend;
    $('composeGo').disabled = !state.friend;
    $('missNote').textContent = state.friend
      ? (online ? '' : 'They are away. Anything you send waits until they open the app.')
      : '';
  }

  function paintActivity() {
    var list = $('activityList');
    list.innerHTML = '';
    var rows = state.activity.slice(0, 6);
    $('activityNone').hidden = rows.length > 0;
    rows.forEach(function (a) {
      var li = document.createElement('li');
      li.className = a.dir;
      var arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = a.dir === 'in' ? '←' : '→';
      var who = document.createElement('span');
      who.className = 'who';
      var kind = kindOf(a.kind);
      if (a.text) {
        who.textContent = (a.dir === 'in' ? a.name + ': ' : 'You: ') + a.text;
        li.title = a.text;
      } else {
        who.textContent = (kind.ic ? kind.ic + '  ' : '') +
          (a.dir === 'in' ? a.name + ' ' + kind.inn : kind.out + ' ' + a.name);
      }
      var when = document.createElement('span');
      when.className = 'when';
      when.textContent = shortAgo(a.at);
      li.appendChild(arrow); li.appendChild(who); li.appendChild(when);
      list.appendChild(li);
    });
  }

  function addActivity(entry) {
    if (state.activity.some(function (a) { return a.id === entry.id && a.dir === entry.dir; })) return;
    state.activity.unshift(entry);
    state.activity = state.activity.slice(0, 40);
    paintActivity();
  }

  function paintRequests(incoming) {
    var wrap = $('requests');
    wrap.innerHTML = '';
    (incoming || []).forEach(function (r) {
      var el = document.createElement('div');
      el.className = 'request';
      var txt = document.createElement('div');
      txt.className = 'txt';
      txt.innerHTML = '<b></b> wants to connect with you.';
      txt.querySelector('b').textContent = r.from;
      var yes = document.createElement('button');
      yes.className = 'btn solid'; yes.type = 'button'; yes.textContent = 'Accept';
      var no = document.createElement('button');
      no.className = 'btn ghost'; no.type = 'button'; no.textContent = 'Decline';
      yes.onclick = function () { respond(r.id, true); };
      no.onclick  = function () { respond(r.id, false); };
      el.appendChild(txt); el.appendChild(yes); el.appendChild(no);
      wrap.appendChild(el);
    });
  }

  function respond(requestId, accept) {
    api('respond', { method: 'POST', body: { requestId: requestId, accept: accept } })
      .then(function (d) {
        $('requests').innerHTML = '';
        if (d.friend) {
          state.friend = d.friend;
          toast('Connected with ' + d.friend.name);
          Collage.celebrate($('mark'));
        }
        paint();
      })
      .catch(function (e) { toast(e.message); refresh(); });
  }

  function linkChip(text, up) {
    $('linkText').textContent = text;
    $('link').classList.toggle('up', !!up);
    $('setLink').textContent = text;
  }

  function connect() {
    if (!state.token) return;
    clearTimeout(retryTimer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

    linkChip('Connecting', false);
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(state.token));

    ws.onopen = function () {
      retry = 0;
      state.live = true;
      linkChip('Live', true);
      flushOutbox();
    };

    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }

      if (m.t === 'ready') {
        state.user = m.user;
        state.friend = m.friend;
        paint();
        return;
      }
      if (m.t === 'friend') {
        state.friend = m.friend;
        if (m.friend) { toast('Connected with ' + m.friend.name); Collage.celebrate($('mark')); }
        else toast('Your friend disconnected.');
        paintSettings();
        paint();
        return;
      }
      if (m.t === 'presence') { setPresence(m.online); return; }
      if (m.t === 'request')  { paintRequests([m.request]); toast(m.request.from + ' wants to connect'); return; }
      if (m.t === 'error')    { toast(m.text); return; }

      if (m.t === 'sent') {
        addActivity({ id: m.id, kind: m.kind, text: m.text, dir: 'out', name: state.friend ? state.friend.name : 'your friend', at: m.at });
        if (m.delivered) {
          toast('Delivered');
        } else {
          state.awayCount++;
          $('setQueued').textContent = String(state.awayCount);
          toast('Saved. They will get it the moment they come online');
        }
        return;
      }

      if (m.t === 'missyou') {

        try { ws.send(JSON.stringify({ t: 'ack', id: m.id })); } catch (e) {}
        if (!markSeen(m.id)) return;
        addActivity({ id: m.id, kind: m.kind, text: m.text, dir: 'in', name: m.fromName, at: m.at });
        popQueue.push(m);
        nextPopup();
      }
    };

    ws.onclose = function (ev) {
      state.live = false;
      linkChip('Offline', false);
      sendButtons().forEach(function (b) { b.disabled = !state.friend; });

      /* 4001 is the server saying it does not know this token. Keep the
         session on the device and show the stale screen, but stop
         reconnecting in a tight loop. */
      if (ev && ev.code === 4001) {
        state.stale = true;
        paint();
        retryTimer = setTimeout(connect, 30000);
        return;
      }
      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(connect, [800, 1500, 2500, 4000, 7000, 11000, 15000][retry]);
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function flushOutbox() {
    if (!ws || ws.readyState !== 1 || !outbox.length) return;
    var pending = outbox.slice();
    outbox = [];
    put(K.outbox, '[]');
    pending.forEach(function (o) {
      var m = { t: 'missyou', kind: (o && o.kind) || 'missyou' };
      if (o && o.text) m.text = o.text;
      ws.send(JSON.stringify(m));
    });
    if (pending.length) toast('Sent ' + pending.length + ' saved ' + (pending.length === 1 ? 'press' : 'presses'));
  }

  function sendMiss(k, text) {
    var kind = kindOf(k);
    if (!state.friend) { toast('Connect with a friend first.'); return; }
    text = (text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
    if (kind.k === 'text' && !text) { toast('Type something first'); return; }

    var msg = { t: 'missyou', kind: kind.k };
    if (text) msg.text = text;

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    } else {
      outbox.push({ at: Date.now(), kind: kind.k, text: text });
      put(K.outbox, JSON.stringify(outbox));
      toast('You are offline. It will send when you reconnect');
      connect();
    }
    var btn = (kind.k === 'text' && $('composeGo')) ||
              document.querySelector('.send[data-kind="' + kind.k + '"]') || $('miss');
    var r = btn.getBoundingClientRect();
    Collage.burst(r.left + r.width / 2, r.top + r.height / 2, 26, 1.1, kind.hue);
  }

  function nextPopup() {
    if (popShowing || !popQueue.length) return;
    var m = popQueue.shift();
    popShowing = true;

    var kind = kindOf(m.kind);
    popKind = kind.k;
    $('popIcon').textContent = kind.ic;
    $('popIcon').hidden = !kind.ic;
    $('popSaid').textContent = kind.said;
    $('popText').textContent = m.text || '';
    $('popText').hidden = !m.text;
    $('popBack').textContent = kind.k === 'text' ? 'Write back' : 'Send one back';
    $('popWho').textContent = m.fromName;
    $('popWhen').textContent = ago(m.at);
    $('popQueued').hidden = (Date.now() - m.at) < 15000;
    $('popup').classList.add('on');
    $('popClose').focus();

    if (!Collage.reduced) {
      setTimeout(function () { Collage.celebrate($('popWho'), kind.hue); }, 160);
    }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(m.fromName + ' ' + kind.inn, {
          body: m.text || 'Open Aemerg to send one back.'
        });
      } catch (e) {}
    }
  }

  function closePopup() {
    $('popup').classList.remove('on');
    popShowing = false;
    setTimeout(nextPopup, 260);
  }

  var geoWatch = null;

  function geoSupported() {
    return 'geolocation' in navigator && (window.isSecureContext || location.hostname === 'localhost');
  }

  function showPosition(pos) {
    $('geoState').textContent = 'Allowed';
    $('geoLat').textContent = pos.coords.latitude.toFixed(6) + '°';
    $('geoLon').textContent = pos.coords.longitude.toFixed(6) + '°';
    $('geoAcc').textContent = Math.round(pos.coords.accuracy) + ' m';
    $('geoAt').textContent  = new Date(pos.timestamp).toLocaleTimeString();
  }

  function geoError(err) {
    var msg = err.code === 1 ? 'Denied'
            : err.code === 2 ? 'Unavailable'
            : 'Timed out';
    $('geoState').textContent = msg;
    if (err.code === 1) toast('Location permission was denied in the browser');
  }

  function askLocation() {
    if (!geoSupported()) {
      $('geoState').textContent = 'Unavailable here';
      toast('Location needs https or localhost');
      return;
    }
    $('geoState').textContent = 'Asking…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      showPosition(pos);
      if (geoWatch === null) {
        geoWatch = navigator.geolocation.watchPosition(showPosition, geoError, { enableHighAccuracy: false });
      }
    }, geoError, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function refreshGeoState() {
    if (!geoSupported()) { $('geoState').textContent = 'Unavailable here'; $('geoAsk').disabled = true; return; }
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
      if (p.state === 'granted') { $('geoState').textContent = 'Allowed'; askLocation(); }
      else if (p.state === 'denied') $('geoState').textContent = 'Denied';
      else $('geoState').textContent = 'Not asked';
      p.onchange = function () { refreshGeoState(); };
    }).catch(function () {});
  }

  var photos = jsonGet(K.photos, []);
  Collage.init({
    onPick: function (i, src) {
      if (src) openBox(i);
      else $('file').click();
    }
  });
  Collage.setPhotos(photos);

  function savePhotos() {
    if (!put(K.photos, JSON.stringify(photos))) toast('Added for this visit. Too many photos to save');
  }

  function intake(files) {
    var list = [].slice.call(files).filter(function (f) { return /^image\//.test(f.type); });
    if (!list.length) return;
    Promise.all(list.map(function (f) { return Collage.downscale(f).catch(function () { return null; }); }))
      .then(function (urls) {
        var added = urls.filter(Boolean);
        if (!added.length) { toast('Those files could not be read'); return; }
        photos = photos.concat(added);
        Collage.setPhotos(photos);
        savePhotos();
        Collage.celebrate($('friendName'));
      });
  }

  var openIdx = -1;
  function openBox(i) {
    openIdx = i;
    $('boxImg').src = photos[i];
    $('box').classList.add('on');
    $('boxClose').focus();
  }
  function closeBox() {
    $('box').classList.remove('on');
    $('boxImg').src = '';
    openIdx = -1;
  }

  var installPrompt = null;
  var swReg = null;

  function standalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.matchMedia('(display-mode: minimal-ui)').matches ||
           window.navigator.standalone === true;
  }

  function paintPwa() {
    var installed = standalone();
    $('pwaInstalled').textContent = installed ? 'Yes, running as an app' : 'Running in a browser tab';
    $('pwaInstalled').classList.toggle('warm', !installed);

    $('pwaInstall').hidden = installed || !installPrompt;

    if (installed) {
      $('pwaHow').textContent = 'Aemerg is installed on this device.';
    } else if (installPrompt) {
      $('pwaHow').textContent = 'Install it and Aemerg opens in its own window, with its own icon.';
    } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      $('pwaHow').textContent = 'On iPhone: tap Share, then Add to Home Screen.';
    } else if (!window.isSecureContext && location.hostname !== 'localhost') {
      $('pwaHow').textContent = 'Installing needs https. Open Aemerg over a secure address to install it.';
    } else {
      $('pwaHow').textContent = 'Your browser offers Install from its own menu, usually in the address bar.';
    }

    if (!('serviceWorker' in navigator)) {
      $('pwaOffline').textContent = 'Not supported here';
    } else if (navigator.serviceWorker.controller) {
      $('pwaOffline').textContent = 'Ready';
    } else if (swReg) {
      $('pwaOffline').textContent = 'Preparing';
    } else {
      $('pwaOffline').textContent = 'Off';
    }

    if (!('Notification' in window)) {
      $('pwaNotify').textContent = 'Not supported here';
      $('pwaNotifyAsk').disabled = true;
    } else {
      var perm = Notification.permission;
      $('pwaNotify').textContent = perm === 'granted' ? 'Allowed'
                                : perm === 'denied'  ? 'Blocked'
                                : 'Not asked';
      $('pwaNotifyAsk').hidden = perm !== 'default';
    }
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) { paintPwa(); return; }
    if (!window.isSecureContext && location.hostname !== 'localhost') { paintPwa(); return; }

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      swReg = reg;
      paintPwa();

      function watch(w) {
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            $('pwaUpdate').hidden = false;
          }
          paintPwa();
        });
      }
      watch(reg.installing);
      reg.addEventListener('updatefound', function () { watch(reg.installing); });
    }).catch(function () { paintPwa(); });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) location.reload();
    });
  }

  var reloading = false;

  function paintSettings() {
    if (state.user) {
      $('setName').value = state.user.name;
      $('setJoined').textContent = 'this browser';
    }
    paintCodes();
    if (state.friend) {
      $('setFriendName').textContent = state.friend.name;
      $('setFriendCode').textContent = state.friend.code;
      $('setFriendState').textContent = state.friend.online ? 'Online' : 'Offline';
      $('unfriend').hidden = false;
    } else {
      $('setFriendName').textContent = 'Nobody yet';
      $('setFriendCode').textContent = '-';
      $('setFriendState').textContent = '-';
      $('unfriend').hidden = true;
    }
  }

  function openSettings() {
    paintSettings();
    refreshGeoState();
    paintPwa();
    $('settings').classList.add('on');
    $('settings').setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    $('settings').classList.remove('on');
    $('settings').setAttribute('aria-hidden', 'true');
  }

  function refresh() {
    if (!state.token) return Promise.resolve();
    return api('me').then(function (d) {
      state.user = d.user;
      state.friend = d.friend;
      state.activity = d.activity || [];
      if (d.user && d.user.name) put(K.name, d.user.name);
      if (state.stale) { state.stale = false; toast('Signed back in'); }
      paintRequests(d.incoming);
      if (d.outgoing && d.outgoing.length) {
        $('connectNote').textContent = 'Waiting for ' + d.outgoing[0].to + ' to accept.';
      }
      paint();
      paintSettings();
    }).catch(function (e) {
      /* The token is never thrown away here. A 401 can mean the server
         restarted or lost its data, and silently wiping the session on a
         server hiccup is exactly the surprise logout this avoids. Only the
         user signs themselves out. */
      if (e && e.status === 401) { state.stale = true; paint(); }
    });
  }

  $('regGo').onclick = function () {
    var name = $('regName').value.trim();
    if (!name) { toast('Type a name first'); $('regName').focus(); return; }
    $('regGo').disabled = true;
    api('register', { method: 'POST', body: { name: name } })
      .then(function (d) {
        state.token = d.token;
        state.user = d.user;
        put(K.token, d.token);
        put(K.name, d.user.name);
        paint();
        connect();
        toast('Your code is ' + d.user.code);
        Collage.celebrate($('myCode'));
      })
      .catch(function (e) { toast(e.message); })
      .then(function () { $('regGo').disabled = false; });
  };
  $('regName').onkeydown = function (e) { if (e.key === 'Enter') $('regGo').click(); };

  $('peerCode').oninput = function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
  };
  $('peerCode').onkeydown = function (e) { if (e.key === 'Enter') $('connectGo').click(); };

  $('connectGo').onclick = function () {
    var code = $('peerCode').value.replace(/\D/g, '');
    if (code.length !== 6) { toast('A code is 6 digits'); return; }
    $('connectGo').disabled = true;
    $('connectNote').textContent = '';
    api('connect', { method: 'POST', body: { code: code } })
      .then(function (d) {
        if (d.linked) {
          state.friend = d.friend;
          toast('Connected with ' + d.friend.name);
          Collage.celebrate($('mark'));
          paint();
        } else {
          $('connectNote').textContent = 'Request sent. They will see it when they open the app.';
          $('peerCode').value = '';
        }
      })
      .catch(function (e) { $('connectNote').textContent = e.message; })
      .then(function () { $('connectGo').disabled = false; });
  };

  function copyCode() {
    var code = state.user ? state.user.code : '';
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { toast('Code copied'); },
                                               function () { toast('Copy failed. Your code is ' + code); });
    } else {
      toast('Your code is ' + code);
    }
  }
  $('copyCode').onclick = copyCode;
  $('setCopy').onclick = copyCode;

  $('miss').onclick = function () { sendMiss('missyou'); };

  $('compose').onsubmit = function (e) {
    e.preventDefault();
    var v = $('composeText').value;
    if (!v.trim()) { $('composeText').focus(); return; }
    sendMiss('text', v);
    $('composeText').value = '';
    countText();
  };

  function countText() {
    var n = $('composeText').value.length;
    $('composeCount').textContent = n > TEXT_MAX - 40 ? (TEXT_MAX - n) + ' left' : '';
  }
  $('composeText').oninput = countText;
  buildSendButtons();

  $('popClose').onclick = closePopup;
  $('popBack').onclick = function () {
    var k = popKind;
    closePopup();
    /* there is nothing to echo back for a written note: hand them the field */
    if (k === 'text') {
      setTimeout(function () { $('composeText').focus(); }, 300);
      return;
    }
    sendMiss(k);
  };

  $('openSettings').onclick = openSettings;
  $('closeSettings').onclick = closeSettings;
  $('geoAsk').onclick = askLocation;

  $('staleRetry').onclick = function () {
    toast('Checking');
    refresh().then(function () {
      if (state.stale) toast('The server still does not recognise this device');
      else connect();
    });
  };

  $('staleFresh').onclick = function () {
    if (!confirm('Start over? This device gets a new code, and your current connection is lost.')) return;
    del(K.token); del(K.seen); del(K.outbox); del(K.name);
    location.reload();
  };

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
    paintPwa();
  });

  window.addEventListener('appinstalled', function () {
    installPrompt = null;
    paintPwa();
    toast('Aemerg installed');
  });

  $('pwaInstall').onclick = function () {
    if (!installPrompt) { toast('Use your browser menu to install'); return; }
    installPrompt.prompt();
    installPrompt.userChoice.then(function (choice) {
      if (choice.outcome !== 'accepted') toast('Install cancelled');
      installPrompt = null;
      paintPwa();
    }).catch(function () { installPrompt = null; paintPwa(); });
  };

  $('pwaNotifyAsk').onclick = function () {
    if (!('Notification' in window)) return;
    Notification.requestPermission().then(function (perm) {
      paintPwa();
      toast(perm === 'granted' ? 'Notifications allowed' : 'Notifications not allowed');
    }).catch(function () {});
  };

  $('pwaUpdate').onclick = function () {
    if (!swReg || !swReg.waiting) { location.reload(); return; }
    reloading = true;
    swReg.waiting.postMessage({ t: 'skip-waiting' });
  };

  $('saveName').onclick = function () {
    var name = $('setName').value.trim();
    if (!name) { toast('A name cannot be empty'); return; }
    api('name', { method: 'POST', body: { name: name } })
      .then(function (d) { state.user = d.user; toast('Name saved'); paint(); })
      .catch(function (e) { toast(e.message); });
  };

  $('unfriend').onclick = function () {
    api('unfriend', { method: 'POST', body: {} })
      .then(function () { state.friend = null; paintSettings(); paint(); toast('Disconnected'); })
      .catch(function (e) { toast(e.message); });
  };

  $('signOut').onclick = function () {
    del(K.token); del(K.seen); del(K.outbox);
    location.reload();
  };

  $('addPhotos').onclick = function () { $('file').click(); };
  $('file').onchange = function () { intake(this.files); this.value = ''; };
  $('clearPhotos').onclick = function () {
    if (!photos.length) { toast('No photos to clear'); return; }
    photos = []; Collage.setPhotos(photos); savePhotos(); toast('Photos cleared');
  };

  $('boxClose').onclick = closeBox;
  $('boxDel').onclick = function () {
    if (openIdx < 0) return;
    photos.splice(openIdx, 1);
    Collage.setPhotos(photos);
    savePhotos();
    closeBox();
  };
  $('box').onclick = function (e) { if (e.target === $('box')) closeBox(); };

  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; });
  window.addEventListener('dragover',  function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function (e) { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0;
    if (e.dataTransfer && e.dataTransfer.files) intake(e.dataTransfer.files);
  });

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('popup').classList.contains('on')) closePopup();
    else if ($('box').classList.contains('on')) closeBox();
    else if ($('settings').classList.contains('on')) closeSettings();
  });

  window.addEventListener('online',  function () { toast('Back online'); connect(); });
  window.addEventListener('offline', function () { linkChip('Offline', false); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { connect(); refresh(); }
  });
  window.addEventListener('resize', fitName);

  state.token = get(K.token, null);
  updateDate();
  setInterval(updateDate, 60000);
  setInterval(paintActivity, 60000);

  paint();
  if (state.token) {
    refresh().then(connect);
    /* asking for notifications is a button in Settings, not a surprise on load */
  } else {
    linkChip('Not signed in', false);
    setTimeout(function () { $('regName').focus(); }, 300);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitName);
  registerSw();
  paintPwa();

})();
