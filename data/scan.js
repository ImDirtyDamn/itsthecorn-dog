/* SCAN SHEET (tryout): take a photo of a hand-filled P-310, read it, and show a review screen.
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
      '<button id="scan-x" type="button" class="warn big" style="margin-top:10px">CANCEL</button></div>';
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
      '<button id="scan-x" type="button" class="warn big" style="margin-top:10px">CANCEL</button></div>';
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
  function tbox(p, label, val, ph, mode) {
    var m = mark(p), id = "sc-" + p.replace(/\./g, "-");
    return '<div class="f"><label for="' + id + '">' + label + '</label><input id="' + id + '" data-p="' + p + '" class="' + m.cls.trim() + '" value="' + esc(val) + '" placeholder="' + esc(ph) + '" autocomplete="off" inputmode="' + (mode || "text") + '">' + m.note + '</div>';
  }
  function clockbox(p, label, val) {
    var ok = isClock(val), m = mark(p, ok ? "" : val), id = "sc-" + p.replace(/\./g, "-");
    if (!ok && val && !flagOf(p)) m = { cls: " scan-unclear", note: '<span class="scan-hint bad">Hard to read: looked like \u201c' + esc(val) + '\u201d. Check it.</span>' };
    return '<div class="field"><label class="lbl" for="' + id + '">' + label + '</label><input class="in' + m.cls + '" type="time" id="' + id + '" data-p="' + p + '" value="' + (ok ? val : "") + '">' + m.note + '</div>';
  }
  function machbox(p, label, val, allLabel) {
    var m = mark(p, DRAWS.indexOf(val) < 0 ? val : ""), id = "sc-" + p.replace(/\./g, "-"), opts = DRAWS.slice();
    if (val && opts.indexOf(val) < 0) opts.push(val);
    return '<div class="f"><label for="' + id + '">' + label + '</label><select id="' + id + '" data-p="' + p + '" class="' + m.cls.trim() + '"><option value="">' + esc(allLabel || "\u2013") + '</option>' +
      opts.map(function (n) { return '<option' + (n === val ? " selected" : "") + '>' + esc(n) + '</option>'; }).join("") + '</select>' + m.note + '</div>';
  }
  function xbtn(kind, i, what) { return '<button class="xbtn" type="button" data-scdel="' + kind + '-' + i + '" aria-label="Remove ' + what + '">&times;</button>'; }
  function v(x) { return x === null || x === undefined ? "" : x; }

  function review(c) {
    var d = c.data, s = d.scan, o = c.opts, h = '<div class="scan-review" id="scan-review">';
    h += '<h2 style="margin-top:6px">Check what was read</h2><p class="muted" style="margin-top:0">Fix anything that\u2019s wrong. Nothing is filled in until you tap ' + esc(o.applyLabel || "REPLACE or ADD") + '. Blank = not on the sheet yet.</p>';
    var nf = Object.keys(d.flags || {}).length;
    if (nf) h += '<div class="scan-legend"><span><i></i>hard to read</span><span><i class="c"></i>math doesn\u2019t add up</span></div>';
    if (d.checks && d.checks.length) h += '<ul class="warnbox">' + d.checks.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul>';
    if (o.intro) h += o.intro;

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
          '<div class="grid2">' + machbox(p + ".machine", "Machine", sg.machine) + tbox(p + ".goal", "Need rate (lb/hr)", v(sg.goal), "need rate", "numeric") + '</div>' +
          (j ? clockbox(p + ".from", "Switch time", sg.from) + '</div>' : "");
      });
      h += '</div>';
    });

    h += '<h3>Cards (' + s.coils.length + ')</h3>';
    if (!s.coils.length) h += '<p class="muted">No cards on the sheet yet.</p>';
    s.coils.forEach(function (r, i) {
      var p = "coils." + i;
      h += '<div class="card"><div class="cardhead"><b>CARD ' + (i + 1) + '</b>' + xbtn("c", i, "card " + (i + 1)) + '</div>' +
        tbox(p + ".card", "Card #", r.card, "card number", "numeric") +
        '<div class="grid2">' + tbox(p + ".avg_wgt", "Avg. Wgt. (lb)", v(r.avg_wgt), "avg weight", "numeric") + tbox(p + ".coils_drawn", "Coils Drawn (in=out)", r.coils_text, "like 3 or 3=6", "text") + '</div>' +
        '<div class="grid2">' + tbox(p + ".weight", "Weight (lb)", v(r.weight), "weight", "numeric") + machbox(p + ".machine", "Machine", r.machine) + '</div>' +
        '<div class="grid2">' + tbox(p + ".finish", "Finish Size", r.finish, "finish size", "decimal") + tbox(p + ".grade", "Grade", r.grade, "grade") + '</div>' +
        '<div class="grid2">' + tbox(p + ".compound", "Draw Compound", r.compound, "compound") + tbox(p + ".package", "Package", r.package, "package") + '</div></div>';
    });

    if (full) h += '<h3>Downtime</h3>';
    if (full && !s.downtime.length) h += '<p class="muted">None on the sheet.</p>';
    if (full) s.downtime.forEach(function (x, i) {
      var p = "downtime." + i;
      h += '<div class="card"><div class="cardhead"><b>DOWNTIME ' + (i + 1) + '</b>' + xbtn("d", i, "downtime " + (i + 1)) + '</div>' +
        '<div class="row2">' + clockbox(p + ".start", "Started at", x.start) + clockbox(p + ".end", "Ended at", x.end) + '</div>' +
        '<div class="grid2">' + tbox(p + ".minutes", "Minutes down", v(x.minutes), "minutes down", "numeric") + machbox(p + ".machine", "Machine", x.machine, "All machines") + '</div>' +
        tbox(p + ".reason", "Reason", x.reason, "what happened, like die change") + '</div>';
    });

    if (full) h += '<h3>Breaks</h3>';
    if (full && !s.breaks.length) h += '<p class="muted">None on the sheet.</p>';
    if (full) s.breaks.forEach(function (b, i) {
      var p = "breaks." + i;
      h += '<div class="break-row">' + clockbox(p + ".start", "Break " + (i + 1) + " start", b.start) +
        '<div class="field"><label class="lbl" for="sc-breaks-' + i + '-minutes">Minutes</label><input class="in' + mark(p + ".minutes").cls + '" type="number" id="sc-breaks-' + i + '-minutes" data-p="' + p + '.minutes" value="' + esc(v(b.minutes)) + '" placeholder="min" inputmode="numeric" min="1" step="5"></div>' +
        '<button type="button" class="btn warn" data-scdel="b-' + i + '" aria-label="Remove break ' + (i + 1) + '">X</button></div>';
    });

    if (full) h += '<h3>Maintenance</h3><div class="f"><label for="sc-maintenance">Maintenance issues to follow up on</label><textarea id="sc-maintenance" data-p="maintenance" placeholder="maintenance issues">' + esc(s.maintenance) + '</textarea></div>';
    var t = s.totals || {}, said = [];
    if (t.total_weight !== "") said.push("Total Weight " + t.total_weight);
    if (t.hours !== "") said.push("Hours " + t.hours);
    if (t.goal_lbhr !== "") said.push("Goal " + t.goal_lbhr + " lb/hr");
    if (t.avg_lbhr !== "") said.push("Average " + t.avg_lbhr + " lb/hr");
    if (full && (said.length || s.problems)) h += '<div class="panel"><b style="color:var(--white)">Also written on the sheet (for checking, not filled in):</b>' +
      (said.length ? '<p class="muted' + (flagOf("totals.total_weight") ? '" style="color:var(--amber)' : "") + '">' + esc(said.join(" \u00b7 ")) + '</p>' : "") +
      (s.problems ? '<p class="muted" style="white-space:pre-wrap">' + esc(s.problems) + '</p>' : "") + '</div>';
    h += '<p class="muted" style="font-size:12px">Read by ' + esc(String(d.model || "").split("/").pop()) + ' in ' + Math.round((d.ms || 0) / 1000) + ' s. The photo is not saved.</p>';

    h += (o.actionNote ? '<p class="muted" style="margin:14px 0 0;font-size:13px">' + o.actionNote + '</p>' : "") +
      (o.applyLabel ? '<div class="scan-actions"><button id="scan-replace" type="button" class="solid big">' + esc(o.applyLabel) + '</button></div>'
        : '<div class="scan-actions"><div class="grid2"><button id="scan-replace" type="button" class="solid">REPLACE</button><button id="scan-add" type="button">ADD</button></div></div>') +
      '<button id="scan-cancel" type="button" class="warn big" style="margin-top:4px">CANCEL</button></div>';
    c.host.innerHTML = h;
    document.body.classList.add("scan-open");
    var host = c.host;
    host.querySelectorAll("[data-p]").forEach(function (el) {
      var clear = function () { el.classList.remove("scan-unclear", "scan-check"); var n = el.parentNode.querySelector(".scan-hint"); if (n) n.remove(); };
      el.addEventListener("input", clear); el.addEventListener("change", clear);
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
      document.body.classList.remove("scan-open");
      var ok = o.onApply(JSON.parse(JSON.stringify(s)), replace);
      if (ok !== false) { host.innerHTML = ""; cur = null; } else document.body.classList.add("scan-open");
    };
    host.querySelector("#scan-replace").onclick = function () { apply(true); };
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
      if (k === "coils_drawn") { var cd = coilsParse(val); o.coils_text = val; o.coils_in = cd.in; o.coils_out = cd.out; return; }
      if (el.type === "time") { o[k] = val; return; }
      if (["goal", "avg_wgt", "weight", "minutes"].indexOf(k) >= 0) { var n = num(val); o[k] = n === null ? val : n; return; }
      o[k] = val;
    });
    return s;
  }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (t) { t.textContent = msg; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(function () { t.style.display = "none"; }, 2200); }
    else alert(msg);
  }

  window.SheetScan = { start: start, shrink: shrink, num: num, drawName: drawName, isClock: isClock, coilsParse: coilsParse, DRAWS: DRAWS };
})();
