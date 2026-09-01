window.Collage = (function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var stage, holder, glow, sparks, sctx;
  var plates = [], slots = [], photos = [];
  var pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  var hover = -1;
  var bits = [];
  var onPick = null;

  var DESKTOP = [
    { x: 10.0, y: 40.0, w: 152, ar: 1.18, r: -6, d: 0.85 },
    { x: 24.0, y: 31.0, w: 132, ar: 1.35, r:  3, d: 0.50 },
    { x: 44.5, y: 22.0, w: 120, ar: 1.00, r:  0, d: 0.35 },
    { x: 66.5, y: 24.0, w: 124, ar: 1.20, r:  0, d: 0.40 },
    { x: 84.5, y: 35.0, w: 120, ar: 1.15, r:  5, d: 0.55 },
    { x: 93.5, y: 48.5, w: 128, ar: 0.95, r:  6, d: 0.70 },
    { x: 89.5, y: 62.5, w: 162, ar: 1.30, r: -8, d: 0.95 },
    { x: 14.0, y: 66.0, w: 182, ar: 1.35, r: -4, d: 1.00 },
    { x: 31.0, y: 78.0, w: 178, ar: 1.40, r:  2, d: 1.00 },
    { x: 70.0, y: 80.0, w: 180, ar: 1.32, r:  0, d: 0.90 },
    { x: 78.0, y: 66.0, w: 168, ar: 1.38, r: -3, d: 0.95 },
    { x:  5.0, y: 45.0, w: 112, ar: 1.25, r:  8, d: 0.60 },
    { x: 70.0, y: 10.0, w: 102, ar: 1.30, r: -5, d: 0.30 },
    { x: 30.0, y: 11.0, w: 106, ar: 0.90, r:  4, d: 0.30 },
    { x: 97.0, y: 21.0, w: 114, ar: 1.20, r: -7, d: 0.45 },
    { x:  2.5, y: 80.0, w: 152, ar: 1.30, r:  5, d: 0.90 }
  ];
  var MOBILE = [
    { x: 13, y: 13, w: 148, ar: 1.25, r: -6, d: 0.45 },
    { x: 80, y: 11, w: 138, ar: 1.00, r:  5, d: 0.40 },
    { x: 90, y: 28, w: 152, ar: 1.30, r: -4, d: 0.60 },
    { x:  8, y: 30, w: 142, ar: 0.95, r:  7, d: 0.60 },
    { x: 12, y: 62, w: 160, ar: 1.35, r:  3, d: 0.95 },
    { x: 88, y: 60, w: 156, ar: 1.30, r: -5, d: 0.95 },
    { x: 94, y: 45, w: 126, ar: 1.15, r:  8, d: 0.75 },
    { x:  4, y: 46, w: 126, ar: 1.20, r: -8, d: 0.75 }
  ];

  function isMobile() { return window.innerWidth < 720; }

  function makeGrain() {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var x = c.getContext('2d');
    var d = x.createImageData(128, 128), p = d.data;
    for (var i = 0; i < p.length; i += 4) {
      var n = 120 + Math.random() * 135;
      p[i] = p[i + 1] = p[i + 2] = n; p[i + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    document.documentElement.style.setProperty('--grain', 'url(' + c.toDataURL('image/png') + ')');
  }

  function buildSlots(n) {
    var base = isMobile() ? MOBILE : DESKTOP;
    var out = base.slice(0, Math.max(base.length, n));
    for (var i = base.length; i < n; i++) {
      var k = i - base.length;
      var a = (k * 2.399) + 0.6;
      var rad = 0.40 + ((k % 3) * 0.045);
      out.push({
        x: 50 + Math.cos(a) * rad * 100,
        y: 50 + Math.sin(a) * rad * 78,
        w: 118 + (k % 4) * 16,
        ar: [1.0, 1.3, 1.22, 0.95][k % 4],
        r: ((k * 37) % 17) - 8,
        d: 0.4 + ((k % 5) * 0.12)
      });
    }
    return out;
  }

  function scaleFactor() {
    var w = stage.clientWidth;
    if (isMobile()) return Math.max(0.5, Math.min(1.0, w / 620));
    return Math.max(0.52, Math.min(1.25, w / 1440));
  }

  function bindPlate(p) {
    p.el.addEventListener('pointerenter', function () { hover = plates.indexOf(p); });
    p.el.addEventListener('pointerleave', function () { if (plates[hover] === p) hover = -1; });
    p.el.addEventListener('focus', function () { hover = plates.indexOf(p); });
    p.el.addEventListener('blur',  function () { if (plates[hover] === p) hover = -1; });
    p.el.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (onPick) onPick(plates.indexOf(p), photos[plates.indexOf(p)] || null);
    });
  }

  function render() {
    var count = Math.max(isMobile() ? MOBILE.length : DESKTOP.length, photos.length);
    slots = buildSlots(count);

    while (plates.length > slots.length) plates.pop().el.remove();

    var t = performance.now();
    while (plates.length < slots.length) {
      var el = document.createElement('button');
      el.className = 'plate';
      el.type = 'button';
      el.setAttribute('aria-label', 'Photo ' + (plates.length + 1));
      holder.appendChild(el);
      plates.push({ el: el, lift: 0, born: t + plates.length * (reduce ? 0 : 55) });
      bindPlate(plates[plates.length - 1]);
    }

    var f = scaleFactor();
    for (var i = 0; i < plates.length; i++) {
      var p = plates[i], s = slots[i];
      p.slot = s;
      p.el.style.width  = Math.round(s.w * f) + 'px';
      p.el.style.height = Math.round(s.w * f * s.ar) + 'px';

      var src = photos[i];
      if (p.src !== src) {
        p.src = src;
        p.el.innerHTML = '';
        if (src) {
          var im = document.createElement('img');
          im.src = src; im.alt = '';
          p.el.appendChild(im);
        } else {
          var e = document.createElement('div');
          e.className = 'empty';
          e.style.background = 'radial-gradient(120% 100% at 30% 20%, hsla(' +
            (26 + (i * 11) % 40) + ',38%,' + (24 + (i % 4) * 5) + '%,1) 0%, hsla(' +
            (14 + (i * 7) % 26) + ',30%,11%,1) 70%)';
          var sp = document.createElement('span');
          sp.textContent = '+';
          e.appendChild(sp);
          p.el.appendChild(e);
        }
      }
    }
  }

  var HUES = ['#E4A950', '#C97B6E', '#F7F0E4', '#7E9BC4'];

  function sizeCanvas() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    sparks.width  = Math.round(stage.clientWidth  * dpr);
    sparks.height = Math.round(stage.clientHeight * dpr);
    sparks.style.width  = stage.clientWidth + 'px';
    sparks.style.height = stage.clientHeight + 'px';
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function burst(x, y, n, power, hues) {
    if (reduce) return;
    power = power || 1;
    var pal = hues || HUES;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var v = (1.4 + Math.random() * 4.6) * power;
      bits.push({
        x: x, y: y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 1.6 * power,
        life: 1,
        decay: 0.008 + Math.random() * 0.012,
        size: 1.4 + Math.random() * 2.8,
        c: pal[(Math.random() * pal.length) | 0]
      });
    }
    if (bits.length > 900) bits.splice(0, bits.length - 900);
  }

  function celebrate(el, hues) {
    if (reduce || !el) return;
    var r = el.getBoundingClientRect();
    var y = r.top + r.height * 0.55;
    for (var i = 0; i < 5; i++) burst(r.left + r.width * (0.1 + i * 0.2), y, 26, 1.25, hues);
  }

  function frame(now) {
    pointer.x += (pointer.tx - pointer.x) * 0.07;
    pointer.y += (pointer.ty - pointer.y) * 0.07;
    var ox = pointer.x - 0.5, oy = pointer.y - 0.5;

    glow.style.transform = 'translate3d(' + (pointer.x * stage.clientWidth) + 'px,' +
                                            (pointer.y * stage.clientHeight) + 'px,0)';

    var sw = stage.clientWidth, sh = stage.clientHeight;
    for (var i = 0; i < plates.length; i++) {
      var p = plates[i], s = p.slot;
      if (!s) continue;

      if (p.lx !== s.x) { p.lx = s.x; p.el.style.left = s.x + '%'; }
      if (p.ly !== s.y) { p.ly = s.y; p.el.style.top  = s.y + '%'; }

      var e = reduce ? 1 : Math.min(1, Math.max(0, (now - p.born) / 760));
      e = 1 - Math.pow(1 - e, 3);

      p.lift += (((hover === i) ? 1 : 0) - p.lift) * 0.14;
      if (p.lift > 0.02 && !p.hot) { p.hot = true;  p.el.classList.add('hot'); }
      if (p.lift <= 0.02 && p.hot) { p.hot = false; p.el.classList.remove('hot'); }

      var dx = ox * -88 * s.d;
      var dy = oy * -54 * s.d - p.lift * 12;

      dx += (50 - s.x) / 100 * sw * (1 - e) * 0.34;
      dy += (47 - s.y) / 100 * sh * (1 - e) * 0.34;

      p.el.style.opacity = e;
      p.el.style.zIndex = 10 + Math.round(s.d * 12) + (p.lift > 0.02 ? 40 : 0);
      p.el.style.transform =
        'translate(-50%,-50%) translate3d(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px,0) rotate(' +
        (s.r * (1 - p.lift * 0.78)).toFixed(2) + 'deg) scale(' +
        ((0.74 + 0.26 * e) * (1 + 0.13 * p.lift)).toFixed(3) + ')';
    }

    sctx.clearRect(0, 0, sparks.width, sparks.height);
    for (var j = bits.length - 1; j >= 0; j--) {
      var b = bits[j];
      b.vy += 0.085; b.vx *= 0.988; b.vy *= 0.992;
      b.x += b.vx; b.y += b.vy;
      b.life -= b.decay;
      if (b.life <= 0) { bits.splice(j, 1); continue; }
      sctx.globalAlpha = Math.max(0, b.life);
      sctx.fillStyle = b.c;
      sctx.beginPath();
      sctx.arc(b.x, b.y, b.size * (0.4 + b.life * 0.6), 0, 6.283);
      sctx.fill();
    }
    sctx.globalAlpha = 1;

    requestAnimationFrame(frame);
  }

  function downscale(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = rej;
      fr.onload = function () {
        var img = new Image();
        img.onerror = rej;
        img.onload = function () {
          var max = 900;
          var k = Math.min(1, max / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width  = Math.max(1, Math.round(img.width  * k));
          c.height = Math.max(1, Math.round(img.height * k));
          var x = c.getContext('2d');
          x.fillStyle = '#17100C';
          x.fillRect(0, 0, c.width, c.height);
          x.drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.78));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function init(opts) {
    stage  = document.getElementById('stage');
    holder = document.getElementById('plates');
    glow   = document.getElementById('glow');
    sparks = document.getElementById('sparks');
    sctx   = sparks.getContext('2d');
    onPick = opts && opts.onPick;

    makeGrain();
    sizeCanvas();
    render();
    requestAnimationFrame(frame);

    window.addEventListener('pointermove', function (ev) {
      pointer.tx = ev.clientX / stage.clientWidth;
      pointer.ty = ev.clientY / stage.clientHeight;
    });
    window.addEventListener('pointerleave', function () { pointer.tx = 0.5; pointer.ty = 0.5; });

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { sizeCanvas(); render(); }, 120);
    });
  }

  return {
    init: init,
    reduced: reduce,
    setPhotos: function (arr) { photos = arr || []; render(); },
    getPhotos: function () { return photos.slice(); },
    burst: burst,
    celebrate: celebrate,
    downscale: downscale
  };
})();
