/* The phone as a second local worker (proof of concept). When a Pixel is plugged into the Mac, a drop-in-water
   ripple made of dots spreads from the centre of the screen and a pill says what was linked: the phone's Gemma is
   there as a capability, the reviews still run on the Mac. Rehearse without the phone: katsePhone.simulate(). */
(function () {
  var last = 0, hideT = 0, pill = null;

  // A grid of dots lit from the centre outwards in patches; three rings swell them as they pass, then all fade.
  function ripple() {
    if (Date.now() - last < 3000) return;                // a Pixel re-enumerates right after it is plugged
    last = Date.now();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var cv = document.createElement('canvas'), cx = cv.getContext('2d');
    cv.className = 'phfx'; document.body.appendChild(cv);
    var W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var gap = 17, r0 = 1.15, r1 = gap * .19, DUR = 2600;
    var clamp = function (t) { return t < 0 ? 0 : t > 1 ? 1 : t; };
    var seg = function (p, a, b) { return clamp((p - a) / (b - a)); };
    var outQuart = function (t) { return 1 - Math.pow(1 - t, 4); };
    var PAL = [[66, 133, 244], [110, 120, 240], [155, 114, 203], [217, 101, 112]], GREEN = [92, 214, 110]; // blue → violet → pink, a few green
    function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    function grad(t) { t = clamp(t) * (PAL.length - 1); var i = Math.min(PAL.length - 2, Math.floor(t)); return mix(PAL[i], PAL[i + 1], t - i); }

    var cols = Math.ceil(W / gap) + 1, rows = Math.ceil(H / gap) + 1;
    var ox = (W - (cols - 1) * gap) / 2, oy = (H - (rows - 1) * gap) / 2, R = Math.hypot(W / 2, H / 2);
    var dots = [], seed = 3;
    for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
      var px = ox + x * gap, py = oy + y * gap;
      seed = seed * 16807 % 2147483647;
      var r = seed / 2147483647;
      var n = (Math.sin(px * .011 + 1.3) * Math.sin(py * .015 + .4) + Math.sin(px * .006 - py * .008 + 2.1)) / 4 + .5;
      var c = Math.hypot(px - W / 2, py - H / 2);
      var live = (Math.sin(px * .009 + .7) * Math.sin(py * .012 + 2.2) + Math.sin((px + py) * .005)) / 4 + .5 + ((seed % 1000) / 1000 - .5) * .6 > .42;
      dots.push({ x: px, y: py, c: c, d: c / R, t: c / R * .75 + n * .17 + r * .08, live: live, g: r < .06, col: grad(c / R * .85 + (n - .5) * .5) });
    }

    var start = performance.now();
    setTimeout(function () { cv.remove(); }, DUR + 2000); // a tab in the background draws no frames: never leave the canvas behind
    function frame(now) {
      var p = (now - start) / DUR;
      if (p >= 1) { cv.remove(); return; }
      cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);
      var lit = outQuart(seg(p, 0, .55)), fade = seg(p, .55, 1);
      var rings = [seg(p, 0, .75), seg(p, .12, .9), seg(p, .26, 1)];
      var h = 1 - seg(p, 0, .35);                         // soft halo where the drop lands
      if (h > 0) {
        var g = cx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 260 * (.4 + seg(p, 0, .35)));
        g.addColorStop(0, 'rgba(120,140,255,' + (.28 * h) + ')'); g.addColorStop(1, 'rgba(120,140,255,0)');
        cx.fillStyle = g; cx.fillRect(0, 0, W, H);
      }
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i], on = d.live ? clamp((lit * 1.1 - d.t) / .08) : 0, boost = 0;
        for (var k = 0; k < 3; k++) {
          var rr = outQuart(rings[k]) * R * 1.15, dist = Math.abs(d.c - rr), w = 70 - k * 15;
          if (rings[k] > 0 && rings[k] < 1 && dist < w) boost = Math.max(boost, (1 - dist / w) * (1 - k * .28) * (1 - rings[k] * .6));
        }
        var a = (on * .85 + boost * .9) * (1 - fade) * (1 - d.d * .35);
        if (a < .02) continue;
        var col = d.g ? GREEN : d.col;
        cx.fillStyle = 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',' + a.toFixed(3) + ')';
        cx.beginPath(); cx.arc(d.x, d.y, (r0 + (r1 - r0) * on) * (1 + 1.1 * boost), 0, 6.2832); cx.fill();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // What was linked, in one line. It goes away by itself.
  var GEMMA = { connecting: 'linking its Gemma…', ready: 'Gemma 4 E2B ready on its TPU', standby: 'its Gemma on standby', off: '' };
  function say(s, hold) {
    if (!pill) { pill = document.createElement('div'); pill.className = 'phpill'; pill.setAttribute('role', 'status'); document.body.appendChild(pill); }
    pill.textContent = '';
    var dot = document.createElement('i'), b = document.createElement('b'), rest = document.createElement('span');
    b.textContent = (s.name || 'Phone') + ' connected';
    rest.textContent = [GEMMA[s.gemma.state], 'reviews run on ' + (s.using === 'phone' ? 'the phone' : 'this Mac')].filter(Boolean).join(' · ');
    pill.append(dot, b, rest);
    pill.classList.toggle('ready', s.gemma.state === 'ready');
    pill.classList.add('on');
    clearTimeout(hideT); hideT = setTimeout(hide, hold);
  }
  function hide() { clearTimeout(hideT); if (pill) pill.classList.remove('on'); }

  function onEvent(e) {
    if (e.type === 'connect') { ripple(); say(e, 9000); }
    else if (e.type === 'gemma' && e.connected) say(e, e.gemma.state === 'connecting' ? 30000 : 6000);
    else if (e.type === 'disconnect') hide();
  }
  if (window.EventSource) new EventSource('/api/phone/events').onmessage = function (m) { try { onEvent(JSON.parse(m.data)); } catch (_) { /* not ours */ } };

  window.katsePhone = { play: function () { last = 0; ripple(); }, simulate: function () { return fetch('/api/phone/simulate', { method: 'POST' }); } };
})();
