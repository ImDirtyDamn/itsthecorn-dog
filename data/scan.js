/* SCAN SHEET: take a photo of a hand-filled P-310, read it, and show a review screen.
   Needs data/config.js first (window.LOGDB_API_BASE). Uses the same crew code as Submit (localStorage "logdbCrewCode").
   The photo is shrunk on the phone (about 1600 px, JPEG), sent once to POST /scan, and never saved anywhere.
   Nothing is filled in until the operator taps REPLACE or ADD on the review screen.

   SheetScan.start(hostEl, { onApply: function (scan, replace) {}, intro: "html above the review", applyLabel: "one button instead of REPLACE / ADD" })
     opens the camera, then shows progress, errors and the review inside hostEl.
   SheetScan.input()  -> markup for the hidden camera input (put it once in the page; start() makes one if missing).
   scan shape (all strings or numbers, blank = not on the sheet):
     { name, date "YYYY-MM-DD", shift, shift_start "HH:MM", shift_end,
       machines: [{ segments: [{ machine "Draw 6", goal 2800, from "HH:MM" }] }],
       coils: [{ card, finish, grade, compound, package, avg_wgt, coils_in, coils_out, coils_text "3=6", weight, machine }],
       downtime: [{ machine, start, end, minutes, reason }], breaks: [{ start, minutes }],
       totals: { total_weight, hours, goal_lbhr, avg_lbhr }, problems, maintenance } */
(function () {
  "use strict";
  var LONG_EDGE = 1600, QUALITY = 0.8, MAX_BYTES = 3.5 * 1024 * 1024, TIMEOUT_MS = 100000;
  var DRAWS = ["Draw 1", "Draw 2", "Draw 3", "Draw 4", "Draw 5", "Draw 6", "Draw 7", "Draw 8", "Draw 9"];
  var CODE_KEY = "logdbCrewCode";

  function api() { return String(window.LOGDB_API_BASE || "").replace(/\/+$/, ""); }
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function getCode() { try { var v = localStorage.getItem(CODE_KEY); return v ? String(JSON.parse(v) || "") : ""; } catch (e) { return ""; } }
  function setCode(c) { try { localStorage.setItem(CODE_KEY, JSON.stringify(c)); } catch (e) {} }
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    var s = String(v).replace(/,/g, "").trim();
    return /^\d+(\.\d+)?$|^\.\d+$/.test(s) ? parseFloat(s) : null;
  }
  function drawName(n) {
    var m = /^\s*(?:draw|d)?\s*#?\s*([1-9])\s*$/i.exec(String(n === null || n === undefined ? "" : n));
    return m ? "Draw " + m[1] : String(n === null || n === undefined ? "" : n).trim();
  }
  function isClock(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")); }
  function coilsParse(s) {
    s = String(s || "").replace(/\s+/g, "");
    if (!s) return { in: null, out: null, text: "" };
    var m = /^(\d+(?:\.\d+)?)(?:[=\/](\d+(?:\.\d+)?))?$/.exec(s);
    if (!m) return { in: null, out: null, text: s, bad: true };
    var a = +m[1], b = m[2] ? +m[2] : a;
    return { in: a, out: b, text: s };
  }

  var css = '.scan-unclear{border-color:var(--red)!important;box-shadow:0 0 0 1px var(--red)}' +
    '.scan-check{border-color:var(--amber)!important;box-shadow:0 0 0 1px var(--amber)}' +
    '.scan-hint{display:block;font-size:12px;margin-top:3px;color:var(--amber)}.scan-hint.bad{color:var(--red)}' +
    '.scan-wait{border:1px dashed var(--amber);padding:14px;margin:10px 0;color:var(--white)}' +
    '.scan-wait b{color:var(--amber);display:block;margin-bottom:6px}' +
    '.scan-dots::after{content:"";animation:scandots 1.2s steps(4,end) infinite}@keyframes scandots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}' +
    '.scan-review h3{color:var(--white);font-size:15px;letter-spacing:.1em;margin:16px 0 6px;text-transform:uppercase}' +
    '.scan-review .card .cardhead b{font-size:15px}' +
    '.scan-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;margin:6px 0 10px}' +
    '.scan-legend span{display:inline-flex;align-items:center;gap:6px;color:var(--fg-dim)}' +
    '.scan-legend i{display:inline-block;width:18px;height:14px;border:2px solid var(--red)}.scan-legend i.c{border-color:var(--amber)}' +
    'body.scan-open .navbar{display:none!important}' +
    '.scan-avg{display:flex;align-items:center;min-height:48px;opacity:.9}.scan-avg .muted{font-size:13px}' +
    '.scan-fix{display:block;width:100%;min-height:44px;margin-top:6px;font-size:15px}' +
    '.scan-warn{border:2px solid var(--amber);padding:12px;margin:10px 0;color:var(--white)}.scan-warn b{display:block;color:var(--amber);font-size:17px;margin-bottom:6px}.scan-warn span{display:block;font-size:14px}' +
    '.scan-note{border:1px solid var(--fg-dim);padding:10px;margin:10px 0;color:var(--white);font-size:14px}' +
    '.scan-actions{position:sticky;bottom:0;background:var(--bg);padding:8px 0 calc(8px + env(safe-area-inset-bottom));border-top:1px solid var(--fg-faint);margin-top:8px;z-index:5}';
  function addCss() { if (document.getElementById("scan-css")) return; var s = document.createElement("style"); s.id = "scan-css"; s.textContent = css; document.head.appendChild(s); }

  /* ---------- photo -> small JPEG ---------- */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, LONG_EDGE / Math.max(w, h));
        var c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
        var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var q = QUALITY;
        (function go() {
          c.toBlob(function (b) {
            if (!b) return reject(new Error("That photo couldn't be opened. Take it again with the camera."));
            if (b.size > MAX_BYTES && q > 0.45) { q -= 0.15; return go(); }
            resolve(b);
          }, "image/jpeg", q);
        })();
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That photo couldn't be opened. Take it again with the camera.")); };
      img.src = url;
    });
  }

  /* ---------- send ---------- */
  function send(blob, code) {
    var ctl = window.AbortController ? new AbortController() : null, t = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT_MS);
    return fetch(api() + "/scan", { method: "POST", headers: { "Content-Type": "image/jpeg", "X-Crew-Code": code }, body: blob,
      credentials: "omit", cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { clearTimeout(t); return { status: r.status, ok: r.ok && j.ok, j: j }; }); },
        function () { clearTimeout(t); return { status: 0, ok: false, j: {} }; });
  }
  function errText(x) {
    var s = x.status, e = x.j && x.j.error ? String(x.j.error) : "";
    if (s === 0) return "Couldn't reach the sheet reader. Check your signal and try again.";
    if (s === 401) return "That crew code didn't work. Type it again.";
    if (s === 422) return "Couldn't find a filled-in sheet in that photo. Lay the sheet flat, get the whole page in the picture, with good light, and try again.";
    if (s === 429) return e || "Too many scans. Try again later.";
    if (s === 413) return "That photo is too big. Try again.";
    if (s === 502 || s === 503) return "The sheet reader is busy right now. Try again in a minute.";
    return e || "Something went wrong reading the sheet. Try again.";
  }

  /* ---------- flow ---------- */
  var cur = null;   // { host, opts, blob }
  function camInput() {
    var el = document.getElementById("scan-cam");
    if (!el) {
      el = document.createElement("input");
      el.type = "file"; el.accept = "image/*"; el.setAttribute("capture", "environment"); el.id = "scan-cam"; el.hidden = true;
      el.setAttribute("aria-hidden", "true"); el.tabIndex = -1;
      document.body.appendChild(el);
    }
    return el;
  }
  function start(host, opts) {
    addCss(); document.body.classList.remove("scan-open");
    cur = { host: host, opts: opts || {} };
    var inp = camInput();
    inp.value = "";
    inp.onchange = function () { var f = inp.files && inp.files[0]; if (f) gotFile(f); };
    inp.click();
  }
  function gotFile(f) {
    var c = cur;
    wait(c, "Getting the photo ready");
    shrink(f).then(function (b) { c.blob = b; upload(c); }, function (e) { showErr(c, e.message); });
  }
  function wait(c, msg) {
    c.host.innerHTML = '<div class="scan-wait" role="status"><b class="scan-dots">' + esc(msg) + '</b>' +
      '<span class="muted">Reading a sheet takes about 15 seconds. Keep this screen open.</span></div>';
    c.host.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  function askCode(c, msg) {
    c.host.innerHTML = '<div class="panel">' + (msg ? '<p class="warnbox" style="padding-left:0">' + esc(msg) + '</p>' : '<p class="muted" style="margin-top:0">The sheet reader needs the crew code (same one as Submit).</p>') +
      '<div class="f"><label for="scan-code">Crew code</label><input id="scan-code" type="password" autocomplete="off" placeholder="crew code"></div>' +
      '<button id="scan-code-go" type="button" class="big solid">READ THE SHEET</button>' +
      '<button id="scan-x" type="button" class="big" style="margin-top:10px">CANCEL</button></div>';
    var go = function () { var v = document.getElementById("scan-code").value.trim(); if (!v) return; setCode(v); upload(c); };
    document.getElementById("scan-code-go").onclick = go;
    document.getElementById("scan-code").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    document.getElementById("scan-x").onclick = function () { c.host.innerHTML = ""; };
  }
  function upload(c) {
    if (!api() || /REPLACE-ME/.test(api())) return showErr(c, "The sheet reader isn't set up yet.");
    var code = getCode();
    if (!code) return askCode(c);
    wait(c, "Reading the sheet");
    send(c.blob, code).then(function (x) {
      if (x.ok) { c.data = x.j; return review(c); }
      if (x.status === 401) return askCode(c, errText(x));
      showErr(c, errText(x), x.status !== 429);
    });
  }
  function showErr(c, msg, retry) {
    c.host.innerHTML = '<div class="panel"><p class="warnbox" style="padding-left:0;margin-top:0">' + esc(msg) + '</p>' +
      (retry && c.blob ? '<button id="scan-retry" type="button" class="big">TRY AGAIN</button>' : "") +
      '<button id="scan-new" type="button" class="big amber" style="margin-top:10px">TAKE A NEW PHOTO</button>' +
      '<button id="scan-x" type="button" class="big" style="margin-top:10px">CANCEL</button></div>';
    if (document.getElementById("scan-retry")) document.getElementById("scan-retry").onclick = function () { upload(c); };
    document.getElementById("scan-new").onclick = function () { start(c.host, c.opts); };
    document.getElementById("scan-x").onclick = function () { c.host.innerHTML = ""; };
  }

  /* ---------- review: every box editable, unclear ones in red, math mismatches in amber ---------- */
  function flagOf(p) { var f = cur && cur.data && cur.data.flags ? cur.data.flags[p] : null; return f === "unclear" || f === "check" ? f : null; }
  function mark(p, raw) {
    var f = flagOf(p), cls = f ? ' scan-' + f : "", note = "";
    if (f === "unclear") note = '<span class="scan-hint bad">Hard to read' + (raw ? ': looked like \u201c' + esc(raw) + '\u201d' : "") + '. Check it.</span>';
    else if (f === "check") note = '<span class="scan-hint">The math doesn\u2019t add up. Check it.</span>';
    return { cls: cls, note: note };
  }
  function tbox(p, label, val, ph, mode, extra) {
    var m = mark(p), id = "sc-" + p.replace(/\./g, "-");
    return '<div class="f"><label for="' + id + '">' + label + '</label><input id="' + id + '" data-p="' + p + '" class="' + m.cls.trim() + '" value="' + esc(val) + '" placeholder="' + esc(ph) + '" autocomplete="off" inputmode="' + (mode || "text") + '"' +
      (mode === "numeric" ? ' pattern="[0-9]*"' : "") + (extra || "") + '>' + m.note + '</div>';
  }
  function clockbox(p, label, val) {
    var ok = isClock(val), m = mark(p, ok ? "" : val), id = "sc-" + p.replace(/\./g, "-");
    if (!ok && val && !flagOf(p)) m = { cls: " scan-unclear", note: '<span class="scan-hint bad">Hard to read: looked like \u201c' + esc(val) + '\u201d. Check it.</span>' };
    return '<div class="field"><label class="lbl" for="' + id + '">' + label + '</label><input class="in' + m.cls + '" type="time" id="' + id + '" data-p="' + p + '" value="' + (ok ? val : "") + '">' + m.note + '</div>';
  }
  // Draw 1-9 only: a machine name the sheet had that isn't a draw number is shown as a note, never offered as a pick
  function machbox(p, label, val, allLabel) {
    var m = mark(p, DRAWS.indexOf(val) < 0 ? val : ""), id = "sc-" + p.replace(/\./g, "-"), opts = DRAWS.slice();
    if (val && opts.indexOf(val) < 0) { if (!m.note) m = { cls: " scan-unclear", note: '<span class="scan-hint bad">Couldn\u2019t tell which draw. Pick its draw number.</span>' }; val = ""; }
    return '<div class="f"><label for="' + id + '">' + label + '</label><select id="' + id + '" data-p="' + p + '" class="' + m.cls.trim() + '"><option value="">' + esc(allLabel || "\u2013") + '</option>' +
      opts.map(function (n) { return '<option' + (n === val ? " selected" : "") + '>' + esc(n) + '</option>'; }).join("") + '</select>' + m.note + '</div>';
  }
  /* ---------- card math checks (job cards and the P-310 rows) ----------
     A job card has the CARD TOTAL WEIGHT in its upper right corner: it is the sum of the coil weights, and the
     average is that total / coils on the card. The reader sometimes returns that total as one more coil row, so it
     got added to the coils (a 5-coil card came out as 105,070 lbs). Here: a row whose weight equals the sum of the
     other rows (or equals the printed total) is the card total, never a coil. Coil weights only check the total.
     Every per-coil weight and the average must sit in the plausible range (Fields.COIL_LBS), or the review warns. */
  function coilRange() { return window.Fields && Fields.COIL_LBS ? Fields.COIL_LBS : { min: 3000, max: 6000 }; }
  function near(a, b) { return Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.005); }
  function rowInfo(r) {
    var cp = coilsParse(r.coils_text), cin = num(r.coils_in) !== null ? num(r.coils_in) : cp.in;
    return { w: num(r.weight), a: num(r.avg_wgt), cin: cin !== null && cin > 0 ? cin : null };
  }
  function findTotalRow(s) {
    var rows = (s.coils || []).map(rowInfo), printed = num((s.totals || {}).total_weight);
    var withW = rows.map(function (x, i) { return x.w !== null && x.w > 0 ? i : -1; }).filter(function (i) { return i >= 0; });
    if (withW.length < 2) return -1;
    for (var k = 0; k < withW.length; k++) {
      var i = withW[k], others = withW.filter(function (j) { return j !== i; });
      var sumO = others.reduce(function (t, j) { return t + rows[j].w; }, 0);
      if (others.length >= 1 && near(rows[i].w, sumO) && (others.length >= 2 || rows[i].cin === null || rows[i].cin === 1)) return i;
      if (printed !== null && near(rows[i].w, printed) && others.length >= 1) return i;
    }
    return -1;
  }
  function cardMath(s) {
    var rng = coilRange(), rows = (s.coils || []).map(rowInfo), issues = [];
    var printed = num((s.totals || {}).total_weight);
    var n = 0, sum = 0, sumN = 0, allW = rows.length > 0;
    rows.forEach(function (x, i) {
      var c = x.cin !== null ? x.cin : (x.w !== null || x.a !== null ? 1 : 0);
      n += c;
      var w = x.w !== null && x.w > 0 ? x.w : (x.a !== null && x.a > 0 && c ? x.a * c : null);
      if (w === null) { allW = false; return; }
      sum += w; sumN += c;
      var per = c ? w / c : null;
      if (per !== null && (per < rng.min || per > rng.max))
        issues.push({ p: "coils." + i + (x.w !== null ? ".weight" : ".avg_wgt"), msg: fmtW(per) + " lbs a coil looks off" });
    });
    (s.coils || []).forEach(function (r, i) {
      var f = num(r.finish);
      if (f !== null && f > 0 && f < 10 && (f < 0.02 || f > 3)) issues.push({ p: "coils." + i + ".finish", soft: true, msg: f + " in looks off for a finish size" });
    });
    var total = printed !== null && printed > 0 ? printed : (sum > 0 ? sum : null);
    var avg = total !== null && n > 0 ? total / n : null, warn = "";
    if (avg !== null && (avg < rng.min || avg > rng.max)) warn = "That looks off: " + fmtW(avg) + " lbs a coil. Check the numbers below.";
    if (printed !== null && printed > 0 && allW && sum > 0 && !near(sum, printed)) {
      issues.push({ p: "coils.0.weight", msg: "The card total says " + fmtW(printed) + " lbs, the weights add up to " + fmtW(sum) + " lbs" });
      if (!warn) warn = "The card total says " + fmtW(printed) + " lbs, but the coil weights add up to " + fmtW(sum) + " lbs. Check the numbers below.";
    }
    var hard = issues.filter(function (x) { return !x.soft; });
    if (!warn && hard.length) warn = "That looks off: " + hard[0].msg + ". Check the numbers below.";
    return { total: total, printed: printed, sum: sum, coils: n, avg: avg, issues: issues, warn: warn, matched: printed !== null && allW && sum > 0 && near(sum, printed) };
  }
  function fmtW(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  // Avg. Wgt. is never typed or read: it is worked out live as Weight / Coils Drawn
  function avgbox(i, r) {
    var x = rowInfo(r), a = x.w !== null && x.cin ? fmtW(x.w / x.cin) : "";
    return '<div class="f"><label>Avg. Wgt. (lbs)</label><output class="in scan-avg" id="sc-avg-' + i + '" data-avg="' + i + '" aria-live="polite">' + (a || '<span class="muted">weight \u00f7 coils</span>') + '</output></div>';
  }
  function xbtn(kind, i, what) { return '<button class="xbtn" type="button" data-scdel="' + kind + '-' + i + '" aria-label="Remove ' + what + '">&times;</button>'; }
  function v(x) { return x === null || x === undefined ? "" : x; }

  /* ---------- tidy what the reader returned (job cards and P-310 rows) ----------
     Machine names written on cards (process lines) become their Draw number; only "Draw N" is ever shown.
     Same card # twice in one photo = one card. Finish is the DRAW TO size, never the start size (a fraction like
     31/64) or the tolerance (+/- .0015). "CHO" in a grade is the CHQ suffix. Compound stays blank unless it is a
     real compound. On the job card flow nothing else from the card (names, notes) is kept. */
  var DRAW_NAMES = [["west vaughn", 2], ["east vaughn", 9], ["vaughn", 3], ["cheng", 1], ["robinson", 4], ["macbee", 5],
    ["showa", 6], ["v-22", 7], ["v 22", 7], ["v22", 7], ["shaver", 8]];
  function drawOf(t) {
    t = String(t == null ? "" : t).toLowerCase().replace(/\s+/g, " ").trim();
    if (!t) return "";
    var m = /^(?:draw|d|#)?\s*#?\s*([1-9])$/.exec(t) || /\b(?:draw|d)\s*#?\s*([1-9])\b(?![.\d])/.exec(t);
    if (m) return "Draw " + m[1];
    for (var i = 0; i < DRAW_NAMES.length; i++) if (t.indexOf(DRAW_NAMES[i][0]) >= 0) return "Draw " + DRAW_NAMES[i][1];
    return "";
  }
  function cardKey(v) { return String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  function plausibleEach(w, n) { var r = coilRange(); return w > 0 && n > 0 && w / n >= r.min && w / n <= r.max; }
  // a weight that is one digit off (an extra 0, a dropped 0, one extra digit) and would fit the coil range
  function digitFixes(w, n) {
    if (!(w > 0) || !(n > 0) || plausibleEach(w, n) || w % 1) return [];
    var out = [];
    if (w % 10 === 0 && plausibleEach(w / 10, n)) out.push(w / 10);
    if (plausibleEach(w * 10, n)) out.push(w * 10);
    if (out.length) return out;
    var t = String(w);
    for (var i = 0; i < t.length; i++) { var v = +(t.slice(0, i) + t.slice(i + 1)); if (plausibleEach(v, n) && out.indexOf(v) < 0) out.push(v); }
    return out.length && out.length <= 2 ? out : [];
  }
  function fmtChecks(list) {   // the reader's own math notes: 825680 -> 825,680 lbs
    return (list || []).map(function (x) {
      return String(x).replace(/\b\d{4,}(?:\.\d+)?\b(?!\s*(?:lbs|coils|min))/g, function (n) { return fmtW(+n) + " lbs"; });
    });
  }
  function tidy(c) {
    var s = c.data.scan, f = c.data.flags = c.data.flags || {}, only = c.opts.coilsOnly, notes = [];
    c.extra = [];
    var fixMach = function (o, k, p) {
      if (!o || !o[k] || DRAWS.indexOf(o[k]) >= 0) return;
      var d = drawOf(o[k]); if (d) { o[k] = d; if (p) delete f[p]; }
    };
    (s.machines || []).forEach(function (m, i) { (m.segments || []).forEach(function (sg, j) { fixMach(sg, "machine", "machines." + i + ".segments." + j + ".machine"); }); });
    (s.downtime || []).forEach(function (x, i) { fixMach(x, "machine", "downtime." + i + ".machine"); });
    (s.coils || []).forEach(function (r, i) {
      var p = "coils." + i + ".";
      fixMach(r, "machine", p + "machine");
      var cp = String(r.compound == null ? "" : r.compound).trim();
      if (cp && !(window.Fields && Fields.compoundKnown && Fields.compoundKnown(cp))) {
        var looksMach = drawOf(cp) || /draw|aor|\d*\.\d|"/i.test(cp);
        if (looksMach && !r.machine && drawOf(cp)) r.machine = drawOf(cp);
        if (only || looksMach) { r.compound = ""; delete f[p + "compound"]; }
      }
      if (r.grade) r.grade = String(r.grade).replace(/(\d\s*)CH[O0]\b/i, "$1CHQ").replace(/\bCH[O0]$/i, "CHQ");
      var fs = String(r.finish == null ? "" : r.finish).trim(), fn = num(fs);
      if (fs && /\d\s*\/\s*\d/.test(fs)) {
        c.extra.push({ p: p + "finish", soft: true, msg: fs + " is the start size. Type the DRAW TO size" }); r.finish = "";
      } else if (fn !== null && fn > 0 && fn < 0.02) {
        c.extra.push({ p: p + "finish", soft: true, msg: fs + " is the tolerance, not the size. Type the DRAW TO size" }); r.finish = "";
      }
    });
    // same card # twice = one card
    var seen = {}, keep = [];
    (s.coils || []).forEach(function (r, i) {
      var k = cardKey(r.card);
      if (!k || seen[k] === undefined) { if (k) seen[k] = keep.length; keep.push({ r: r, from: [i], dups: [r] }); return; }
      keep[seen[k]].dups.push(r); keep[seen[k]].from.push(i);
    });
    if (keep.length < (s.coils || []).length) {
      var nf = {};
      Object.keys(f).forEach(function (key) { if (!/^coils\./.test(key)) nf[key] = f[key]; });
      s.coils = keep.map(function (g, ni) {
        var r = g.r;
        g.from.forEach(function (oi) { Object.keys(f).forEach(function (key) { var m = new RegExp("^coils\\." + oi + "(\\..*)$").exec(key); if (m && !nf["coils." + ni + m[1]]) nf["coils." + ni + m[1]] = f[key]; }); });
        if (g.dups.length < 2) return r;
        g.dups.slice(1).forEach(function (d) { ["finish", "grade", "compound", "package", "machine", "coils_text"].forEach(function (k) { if (!r[k] && d[k]) r[k] = d[k]; }); if (r.coils_in == null && d.coils_in != null) { r.coils_in = d.coils_in; r.coils_out = d.coils_out; } });
        var n = rowInfo(r).cin || 1, ws = [], picks = [];
        g.dups.forEach(function (d) {
          [num(d.weight), num(d.avg_wgt)].forEach(function (w) {
            if (!(w > 0)) return;
            if (ws.indexOf(w) < 0) ws.push(w);
            var c1 = plausibleEach(w, n) ? [w] : digitFixes(w, n);
            c1.forEach(function (v) { picks.push(v); });
          });
        });
        var count = {}; picks.forEach(function (v) { count[v] = (count[v] || 0) + 1; });
        var best = picks.slice().sort(function (a, b) { return count[b] - count[a]; })[0];
        var uniq = picks.filter(function (v, i2) { return picks.indexOf(v) === i2; });
        if (best !== undefined) { r.weight = best; r.avg_wgt = null; }
        delete nf["coils." + ni + ".weight"];
        if (uniq.length > 1 && count[best] < 2) c.extra.push({ p: "coils." + ni + ".weight", msg: "Read two ways (" + ws.map(fmtW).join(" and ") + " lbs). Check Tot Avg Wgt on the card and tap the right one", fix: uniq.slice(0, 3), at: best,
          warn: "Card " + (r.card || (ni + 1)) + "\u2019s weight was read two ways. Tap the right one below." });
        var ms = g.dups.map(function (d) { return d.machine; }).filter(function (m, i3, a) { return m && a.indexOf(m) === i3; });
        if (ms.length > 1) c.extra.push({ p: "coils." + ni + ".machine", soft: true, msg: "Read as " + ms.join(" and ") + ". Pick the right one" });
        notes.push("Card " + (r.card || (ni + 1)) + " was read " + g.dups.length + " times, so it is shown once.");
        return r;
      });
      c.data.flags = f = nf;
      s.totals = s.totals || {}; s.totals.total_weight = "";   // its total was the doubled cards
    }
    if (only) {
      // the job card flow keeps nothing but the numbers: no names, notes or the reader's P-310 math notes
      s.name = ""; s.problems = ""; s.maintenance = ""; s.notes = "";
      // rows that are whole cards (more than one coil each) already carry the card totals: a "total" next to them is
      // only the reader adding cards up (it was 825,680 for one 41,528 lbs card read twice), so the sum of the cards wins.
      // Rows that are single coils keep a printed total to check them against.
      if ((s.coils || []).some(function (r) { return (num(r.weight) > 0 || num(r.avg_wgt) > 0) && (rowInfo(r).cin || 1) > 1; })) { s.totals = s.totals || {}; s.totals.total_weight = ""; }
      c.data.checks = [];
    } else c.data.checks = fmtChecks(c.data.checks);
    return notes;
  }

  // take the card total out of the coil rows (it is never a coil) and run the checks
  function prep(c) {
    var s = c.data.scan, notes = [];
    if (!c.tidied) { c.tidied = true; c.tidyNotes = tidy(c); }
    notes = notes.concat(c.tidyNotes || []);
    if (!c.movedAvg) {
      c.movedAvg = true;
      (s.coils || []).forEach(function (r, i) {
        var x = rowInfo(r), w;
        if (x.w !== null || x.a === null || x.a <= 0) return;
        // A job card has no per-coil average on it: the number the reader called Avg. Wgt. is the card total
        // (upper right). On a P-310 row a real average is only kept when it is a plausible coil weight.
        if (c.opts.coilsOnly || x.a > coilRange().max || !x.cin) w = x.a;
        else w = x.a * x.cin;
        r.weight = Math.round(w * 10) / 10;
        var f = c.data.flags || {}; delete f["coils." + i + ".weight"];
        if (w === x.a) notes.push(fmtW(w) + " lbs (upper right) is the card total, so it went in Weight for card " + (i + 1) + ".");
      });
    }
    var pt = num((s.totals || {}).total_weight), noW = (s.coils || []).every(function (r) { return num(r.weight) === null; });
    if (c.opts.coilsOnly && pt !== null && pt > 0 && noW && (s.coils || []).length <= 1) {
      if (!s.coils.length) s.coils.push({ card: "", finish: "", grade: "", compound: "", package: "", avg_wgt: null, coils_text: "", coils_in: null, coils_out: null, weight: null, machine: "" });
      s.coils[0].weight = pt; s.totals.total_weight = "";
      var f0 = c.data.flags || {}; delete f0["coils.0.weight"];
      notes.push(fmtW(pt) + " lbs (upper right) is the card total, so it went in Weight.");
    }
    (s.coils || []).forEach(function (r) { var x = rowInfo(r); r.avg_wgt = x.w !== null && x.cin ? Math.round(x.w / x.cin) : null; });
    var ti = findTotalRow(s);
    if (ti >= 0) {
      var tr = rowInfo(s.coils[ti]);
      s.totals = s.totals || {};
      if (num(s.totals.total_weight) === null) s.totals.total_weight = tr.w;
      s.coils.splice(ti, 1); shiftFlags(c, "coils", ti);
      notes.push(fmtW(tr.w) + " lbs is the card total (upper right), not a coil, so it was taken out of the coil list" + (c.opts.coilsOnly ? " and kept to check the weights." : "."));
    }
    if (notes.length) c.totalNote = notes.join(" ");
    var cm = cardMath(s);
    // a weight one digit off: offer the fix next to the box
    cm.issues.forEach(function (x) {
      var m = /^coils\.(\d+)\.weight$/.exec(x.p); if (!m || x.fix) return;
      var x2 = rowInfo(s.coils[+m[1]]); var fx = digitFixes(x2.w, x2.cin || 1);
      if (fx.length) x.fix = fx;
    });
    var have = {}; cm.issues.forEach(function (x) { have[x.p] = 1; });
    (c.extra || []).forEach(function (x) {
      if (have[x.p] && !x.fix) return;
      if (x.resolved) return;
      var r0 = s.coils[+x.p.split(".")[1]] || {};
      if (/\.weight$/.test(x.p) && x.at !== undefined && num(r0.weight) !== x.at) return;   // the operator changed it
      if (/\.finish$/.test(x.p) && String(r0.finish == null ? "" : r0.finish).trim()) return;
      cm.issues = cm.issues.filter(function (y) { return y.p !== x.p; }); cm.issues.push(x);
    });
    if (!cm.warn) { var hard = cm.issues.filter(function (x) { return !x.soft; }); if (hard.length) cm.warn = hard[0].warn || "That looks off: " + hard[0].msg + ". Check the numbers below."; }
    c.issues = cm.issues; c.warn = cm.warn;
  }

  function review(c) {
    if (!c.prepped) { c.prepped = true; prep(c); }
    var d = c.data, s = d.scan, o = c.opts, h = '<div class="scan-review" id="scan-review">';
    h += '<h2 style="margin-top:6px">Check what was read</h2><p class="muted" style="margin-top:0">Fix anything that\u2019s wrong. Nothing is filled in until you tap ' + esc(o.applyLabel || "REPLACE or ADD") + '. Blank = not on the sheet yet.</p>';
    var nf = Object.keys(d.flags || {}).length;
    if (nf) h += '<div class="scan-legend"><span><i></i>hard to read</span><span><i class="c"></i>math doesn\u2019t add up</span></div>';
    if (d.checks && d.checks.length) h += '<ul class="warnbox">' + d.checks.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul>';
    if (o.intro) h += o.intro;
    if (c.totalNote) h += '<p class="scan-note" id="scan-total-note">' + esc(c.totalNote) + '</p>';
    if (c.warn) h += '<div class="scan-warn" id="scan-warn" role="alert"><b>' + esc(c.warn) + '</b>' +
      '<span>Fix any box, then tap ' + esc(o.applyLabel || "REPLACE or ADD") + ' again.</span>' +
      '<button id="scan-anyway" type="button" class="big" style="margin-top:10px">USE THESE NUMBERS ANYWAY</button></div>';

    var full = !o.coilsOnly;   // coilsOnly: just the cards (the average coil weight tool)
    if (full) h += '<h3>Top of the sheet</h3><div class="panel">' + tbox("name", "Name", s.name, "your name") +
      '<div class="grid2">' + tbox("date", "Date", s.date, "date") + tbox("shift", "Shift", s.shift, "shift, like 1st") + '</div>' +
      '<div class="row2">' + clockbox("shift_start", "Shift start", s.shift_start) + clockbox("shift_end", "Shift end", s.shift_end) + '</div>' +
      (o.endNote ? '<p class="sub" style="margin-top:-8px">' + o.endNote + '</p>' : "") + '</div>';

    if (full) h += '<h3>Machines and need rates</h3>';
    if (full && !s.machines.length) h += '<p class="muted">None on the sheet.</p>';
    if (full) s.machines.forEach(function (sl, si) {
      h += '<div class="card"><div class="cardhead"><b>MACHINE ' + (si + 1) + '</b>' + xbtn("m", si, "machine " + (si + 1)) + '</div>';
      sl.segments.forEach(function (sg, j) {
        var p = "machines." + si + ".segments." + j;
        h += (j ? '<div class="seg"><b style="color:var(--amber);font-size:13px;letter-spacing:.08em">MOVED TO</b>' : "") +
          '<div class="grid2">' + machbox(p + ".machine", "Machine", sg.machine) + tbox(p + ".goal", "Need rate (lbs/hr)", v(sg.goal), "need rate", "decimal") + '</div>' +
          (j ? clockbox(p + ".from", "Switch time", sg.from) + '</div>' : "");
      });
      h += '</div>';
    });

    h += '<h3>Cards (' + s.coils.length + ')</h3>';
    if (!s.coils.length) h += '<p class="muted">No cards on the sheet yet.</p>';
    s.coils.forEach(function (r, i) {
      var p = "coils." + i;
      h += '<div class="card"><div class="cardhead"><b>CARD ' + (i + 1) + '</b>' + xbtn("c", i, "card " + (i + 1)) + '</div>' +
        tbox(p + ".card", "Card #", r.card, "card number", "text") +
        '<div class="grid2">' + avgbox(i, r) + tbox(p + ".coils_drawn", "Coils Drawn (in=out)", r.coils_text, "like 3 or 3=6", "text") + '</div>' +
        '<div class="grid2">' + tbox(p + ".weight", full ? "Weight (lbs)" : "Weight (lbs, card total)", v(r.weight), full ? "weight" : "upper right", "decimal") + machbox(p + ".machine", "Machine", r.machine) + '</div>' +
        '<div class="grid2">' + tbox(p + ".finish", "Finish Size (in)", r.finish, "finish size", "decimal") + tbox(p + ".grade", "Grade", r.grade, "grade") + '</div>' +
        '<div class="grid2">' + tbox(p + ".compound", "Draw Compound", r.compound, "compound", "text", ' data-compound="1"') + tbox(p + ".package", "Package", r.package, "package") + '</div></div>';
    });

    if (full) h += '<h3>Downtime</h3>';
    if (full && !s.downtime.length) h += '<p class="muted">None on the sheet.</p>';
    if (full) s.downtime.forEach(function (x, i) {
      var p = "downtime." + i;
      h += '<div class="card"><div class="cardhead"><b>DOWNTIME ' + (i + 1) + '</b>' + xbtn("d", i, "downtime " + (i + 1)) + '</div>' +
        '<div class="row2">' + clockbox(p + ".start", "Started at", x.start) + clockbox(p + ".end", "Ended at", x.end) + '</div>' +
        '<div class="grid2">' + tbox(p + ".minutes", "Time down", v(x.minutes), "minutes down", "numeric", ' data-hm="min"') + machbox(p + ".machine", "Machine", x.machine, "Every draw (whole shift)") + '</div>' +
        tbox(p + ".reason", "Reason", x.reason, "what happened, like die change") + '</div>';
    });

    if (full) h += '<h3>Breaks</h3>';
    if (full && !s.breaks.length) h += '<p class="muted">None on the sheet.</p>';
    if (full) s.breaks.forEach(function (b, i) {
      var p = "breaks." + i;
      h += '<div class="break-row">' + clockbox(p + ".start", "Break " + (i + 1) + " start", b.start) +
        '<div class="field"><label class="lbl" for="sc-breaks-' + i + '-minutes">How long</label><input class="in' + mark(p + ".minutes").cls + '" type="number" id="sc-breaks-' + i + '-minutes" data-p="' + p + '.minutes" value="' + esc(v(b.minutes)) + '" placeholder="min" inputmode="numeric" pattern="[0-9]*" min="1" step="5" data-hm="min"></div>' +
        '<button type="button" class="btn warn" data-scdel="b-' + i + '" aria-label="Remove break ' + (i + 1) + '">X</button></div>';
    });

    if (full) h += '<h3>Maintenance</h3><div class="f"><label for="sc-maintenance">Maintenance issues to follow up on</label><textarea id="sc-maintenance" data-p="maintenance" placeholder="maintenance issues">' + esc(s.maintenance) + '</textarea></div>';
    var t = s.totals || {}, said = [];
    if (v(t.total_weight) !== "") said.push("Total Weight " + t.total_weight);
    if (v(t.hours) !== "") said.push("Hours " + t.hours);
    if (v(t.goal_lbhr) !== "") said.push("Goal " + t.goal_lbhr + " lbs/hr");
    if (v(t.avg_lbhr) !== "") said.push("Average " + t.avg_lbhr + " lbs/hr");
    if (full && (said.length || s.problems)) h += '<div class="panel"><b style="color:var(--white)">Also written on the sheet (for checking, not filled in):</b>' +
      (said.length ? '<p class="muted' + (flagOf("totals.total_weight") ? '" style="color:var(--amber)' : "") + '">' + esc(said.join(" \u00b7 ")) + '</p>' : "") +
      (s.problems ? '<p class="muted" style="white-space:pre-wrap">' + esc(s.problems) + '</p>' : "") + '</div>';
    h += '<p class="muted" style="font-size:12px">Read in ' + Math.max(1, Math.round((d.ms || 0) / 1000)) + ' s. The photo is not saved.</p>';

    h += (o.actionNote ? '<p class="muted" style="margin:14px 0 0;font-size:13px">' + o.actionNote + '</p>' : "") +
      (o.applyLabel ? '<div class="scan-actions"><button id="scan-replace" type="button" class="solid big">' + esc(o.applyLabel) + '</button></div>'
        : '<div class="scan-actions"><div class="grid2"><button id="scan-replace" type="button" class="solid">REPLACE</button><button id="scan-add" type="button">ADD</button></div></div>') +
      '<button id="scan-cancel" type="button" class="big" style="margin-top:4px">CANCEL</button></div>';
    c.host.innerHTML = h;
    document.body.classList.add("scan-open");
    var host = c.host;
    host.querySelectorAll("[data-p]").forEach(function (el) {
      var clear = function () { el.classList.remove("scan-unclear", "scan-check"); var n = el.parentNode.querySelector(".scan-hint"); if (n) n.remove(); };
      el.addEventListener("input", clear); el.addEventListener("change", clear);
    });
    var liveAvg = function (i) {
      var w = host.querySelector('[data-p="coils.' + i + '.weight"]'), cd = host.querySelector('[data-p="coils.' + i + '.coils_drawn"]'), o = host.querySelector("#sc-avg-" + i);
      if (!w || !cd || !o) return;
      var ww = num(w.value), n = coilsParse(cd.value).in;
      o.innerHTML = ww !== null && ww > 0 && n ? esc(fmtW(ww / n)) : '<span class="muted">weight \u00f7 coils</span>';
    };
    host.querySelectorAll('[data-p$=".weight"],[data-p$=".coils_drawn"]').forEach(function (el) {
      var m = /^coils\.(\d+)\./.exec(el.getAttribute("data-p")); if (m) el.addEventListener("input", function () { liveAvg(+m[1]); });
    });
    (c.issues || []).forEach(function (x) {
      var el = host.querySelector('[data-p="' + x.p + '"]'); if (!el) return;
      el.classList.add("scan-check");
      var old = el.parentNode.querySelector(".scan-hint"); if (old && x.fix) old.parentNode.removeChild(old);
      if (!el.parentNode.querySelector(".scan-hint")) {
        var sp = document.createElement("span"); sp.className = "scan-hint"; sp.textContent = x.msg + (/[.]$/.test(x.msg) ? "" : ".") + (x.fix || /Type |Pick |tap /.test(x.msg) ? "" : " Check it."); el.parentNode.appendChild(sp);
        (x.fix || []).forEach(function (v) {
          var fb = document.createElement("button"); fb.type = "button"; fb.className = "scan-fix"; fb.textContent = "USE " + fmtW(v) + " LBS";
          fb.onclick = function () { x.resolved = true; el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); el.classList.remove("scan-check", "scan-unclear"); el.parentNode.querySelectorAll(".scan-hint,.scan-fix").forEach(function (n) { n.parentNode.removeChild(n); }); };
          el.parentNode.appendChild(fb);
        });
      }
    });
    host.querySelectorAll("[data-scdel]").forEach(function (b) {
      b.onclick = function () {
        collect(c); var k = b.dataset.scdel.split("-"), i = +k[1];
        var list = { m: s.machines, c: s.coils, d: s.downtime, b: s.breaks }[k[0]];
        list.splice(i, 1); shiftFlags(c, { m: "machines", c: "coils", d: "downtime", b: "breaks" }[k[0]], i);
        var y = window.scrollY; review(c); window.scrollTo(0, y);
      };
    });
    host.querySelector("#scan-cancel").onclick = function () { host.innerHTML = ""; cur = null; document.body.classList.remove("scan-open"); };
    var apply = function (replace) {
      collect(c);
      var q = Array.prototype.slice.call(host.querySelectorAll("input[data-p]")).filter(function (el) { return /\?/.test(el.value); });
      if (q.length) { q[0].scrollIntoView({ block: "center" }); q[0].focus(); return toast("Fix the boxes with a ? first"); }
      // a finish size with no point (600, 1250): one tap to say what it is, before anything is filled in
      var fins = Array.prototype.slice.call(host.querySelectorAll('input[data-p$=".finish"]'));
      var need = window.Fields ? Fields.sizeNeedsPick(fins) : null;
      if (need) { Fields.sizePick(need, "Card " + (+need.getAttribute("data-p").split(".")[1] + 1) + " finish size", function () { apply(replace); }); return; }
      if (!c.forced) {
        prep(c);
        if (c.warn) { review(c); var wb = host.querySelector("#scan-warn"); if (wb) wb.scrollIntoView({ block: "center" }); return; }
      }
      c.forced = false;
      if (o.coilsOnly) s.card_check = cardMath(s);
      document.body.classList.remove("scan-open");
      var ok = o.onApply(JSON.parse(JSON.stringify(s)), replace);
      if (ok !== false) { host.innerHTML = ""; cur = null; } else document.body.classList.add("scan-open");
    };
    host.querySelector("#scan-replace").onclick = function () { apply(true); };
    if (host.querySelector("#scan-anyway")) host.querySelector("#scan-anyway").onclick = function () { c.forced = true; c.warn = ""; apply(true); };
    if (host.querySelector("#scan-add")) host.querySelector("#scan-add").onclick = function () { apply(false); };
    host.scrollIntoView({ block: "start" });
  }
  function shiftFlags(c, kind, i) {
    var f = c.data.flags || {}, out = {};
    Object.keys(f).forEach(function (k) {
      var m = new RegExp("^" + kind + "\\.(\\d+)(\\..*)$").exec(k);
      if (!m) { out[k] = f[k]; return; }
      var n = +m[1]; if (n === i) return;
      out[kind + "." + (n > i ? n - 1 : n) + m[2]] = f[k];
    });
    c.data.flags = out;
  }
  /* read the boxes back into the scan object */
  function collect(c) {
    var s = c.data.scan;
    c.host.querySelectorAll("[data-p]").forEach(function (el) {
      var p = el.dataset.p.split("."), val = el.value.trim(), o = s;
      for (var i = 0; i < p.length - 1; i++) { o = o[isNaN(+p[i]) ? p[i] : +p[i]]; if (!o) return; }
      var k = p[p.length - 1];
      if (k === "avg_wgt") return;
      if (k === "coils_drawn") { var cd = coilsParse(val); o.coils_text = val; o.coils_in = cd.in; o.coils_out = cd.out; return; }
      if (el.type === "time") { o[k] = val; return; }
      if (["goal", "avg_wgt", "weight", "minutes"].indexOf(k) >= 0) { var n = num(val); o[k] = n === null ? val : n; return; }
      o[k] = val;
    });
    (s.coils || []).forEach(function (r) { var x = rowInfo(r); r.avg_wgt = x.w !== null && x.cin ? Math.round(x.w / x.cin) : null; });
    return s;
  }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (t) { t.textContent = msg; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(function () { t.style.display = "none"; }, 2200); }
    else alert(msg);
  }

  window.SheetScan = { cardMath: cardMath, findTotalRow: findTotalRow, start: start, shrink: shrink, num: num, drawName: drawName, isClock: isClock, coilsParse: coilsParse, DRAWS: DRAWS };
})();
