(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var K = { token: 'my.token', photos: 'my.photos', seen: 'my.seen', outbox: 'my.outbox' };

  var state = {
    token: null,
    user: null,
    friend: null,
    activity: [],
    live: false,
    awayCount: 0
  };

  var ws = null, retry = 0, retryTimer = null;
  var popQueue = [], popShowing = false;

  function get(k, fb) { try { var v = localStorage.getItem(k); return v === null ? fb : v; } catch (e) { return fb; } }
  function put(k, v)  { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function del(k)     { try { localStorage.removeItem(k); } catch (e) {} }

  function jsonGet(k, fb) { try { return JSON.parse(get(k, JSON.stringify(fb))) || fb; } catch (e) { return fb; } }

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
        if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
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
    ['scr-onboard', 'scr-connect', 'scr-home'].forEach(function (s) {
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

  function setPresence(online) {
    if (state.friend) state.friend.online = online;
    $('status').classList.toggle('up', !!online);
    $('statusText').textContent = online ? 'Online now' : 'Offline';
    $('setFriendState').textContent = online ? 'Online' : 'Offline';
    if (online) { state.awayCount = 0; $('setQueued').textContent = '0'; }
    $('miss').disabled = !state.friend;
    $('missNote').textContent = state.friend
      ? (online ? '' : 'They are away. This will be waiting when they open the app.')
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
      who.textContent = a.dir === 'in' ? a.name + ' missed you' : 'You missed ' + a.name;
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
        addActivity({ id: m.id, dir: 'out', name: state.friend ? state.friend.name : 'your friend', at: m.at });
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
        addActivity({ id: m.id, dir: 'in', name: m.fromName, at: m.at });
        popQueue.push(m);
        nextPopup();
      }
    };

    ws.onclose = function () {
      state.live = false;
      linkChip('Offline', false);
      $('miss').disabled = false;
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
    pending.forEach(function () { ws.send(JSON.stringify({ t: 'missyou' })); });
    if (pending.length) toast('Sent ' + pending.length + ' saved ' + (pending.length === 1 ? 'press' : 'presses'));
  }

  function sendMiss() {
    if (!state.friend) { toast('Connect with a friend first.'); return; }
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'missyou' }));
    } else {
      outbox.push(Date.now());
      put(K.outbox, JSON.stringify(outbox));
      toast('You are offline. It will send when you reconnect');
      connect();
    }
    var r = $('miss').getBoundingClientRect();
    Collage.burst(r.left + r.width / 2, r.top + r.height / 2, 26, 1.1, ['#7E9BC4', '#EAF1FA', '#C97B6E']);
  }

  function nextPopup() {
    if (popShowing || !popQueue.length) return;
    var m = popQueue.shift();
    popShowing = true;

    $('popWho').textContent = m.fromName;
    $('popWhen').textContent = ago(m.at);
    $('popQueued').hidden = (Date.now() - m.at) < 15000;
    $('popup').classList.add('on');
    $('popClose').focus();

    if (!Collage.reduced) {
      setTimeout(function () { Collage.celebrate($('popWho'), ['#7E9BC4', '#EAF1FA', '#C97B6E']); }, 160);
    }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(m.fromName + ' misses you', { body: 'Open Miss You to send one back.' }); } catch (e) {}
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
      paintRequests(d.incoming);
      if (d.outgoing && d.outgoing.length) {
        $('connectNote').textContent = 'Waiting for ' + d.outgoing[0].to + ' to accept.';
      }
      paint();
      paintSettings();
    }).catch(function (e) {
      if (/session/i.test(e.message)) { del(K.token); state.token = null; paint(); }
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

  $('miss').onclick = sendMiss;

  $('popClose').onclick = closePopup;
  $('popBack').onclick = function () { closePopup(); sendMiss(); };

  $('openSettings').onclick = openSettings;
  $('closeSettings').onclick = closeSettings;
  $('geoAsk').onclick = askLocation;

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
    if ('Notification' in window && Notification.permission === 'default') {

      setTimeout(function () { Notification.requestPermission().catch(function () {}); }, 4000);
    }
  } else {
    linkChip('Not signed in', false);
    setTimeout(function () { $('regName').focus(); }, 300);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitName);

})();
