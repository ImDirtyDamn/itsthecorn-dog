/* "Submit to master log" for the calculator's Sheet view.
   Needs data/config.js loaded first (window.LOGDB_API_BASE).

   Drop-in for /calc/try/ (two lines):
     <script src="/data/config.js"></script><script src="/data/submit.js"></script>      (in <head>)
     if (window.LogDB) LogDB.mount($("sv-body"), function () { return LogDB.fromTryout(S, calc()); });
                                                                       (at the end of openSheet())

   Remembered on this device (localStorage): operator name, crew code, the outbox of logs not sent yet,
   and the last 30 sent logs (so a second tap does not send the same shift twice).
   Every log gets an id made on the phone; the server stores each id once, so retries are safe. */
(function () {
  "use strict";
  var K = { op: "logdbOperator", code: "logdbCrewCode", queue: "logdbQueueV1", sent: "logdbSentV1" };
  var busy = false, timer = null, mounted = null, lastStatus = null;

  function api() { return String(window.LOGDB_API_BASE || "").replace(/\/+$/, ""); }
  function get(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function put(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function newId() {
    var r = "";
    if (window.crypto && crypto.getRandomValues) { var a = new Uint8Array(9); crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) r += (a[i] % 36).toString(36); }
    else r = Math.random().toString(36).slice(2, 11);
    return "L" + Date.now().toString(36) + r;
  }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ":" + s.length; }
  function hhmm(d) { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

  /* ---------- payload from the tryout calculator ---------- */
  function num(v) {
    if (v === null || v === undefined) return null;
    var n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
    return String(v).trim() === "" || !isFinite(n) || n < 0 ? null : n;
  }
  function txt(v, max) { return String(v === null || v === undefined ? "" : v).trim().slice(0, max); }
  function clk(v) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim()); return m && +m[1] < 24 && +m[2] < 60 ? (m[1].length < 2 ? "0" : "") + m[1] + ":" + m[2] : ""; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function isoDay(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  /* "2026-10-23", "10/23/26", "10/23/2026", "10-23-26"; blank or unreadable = today */
  function normDate(s) {
    s = String(s || "").trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) return m[1] + "-" + pad(+m[2]) + "-" + pad(+m[3]);
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(s);
    if (m) { var y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; var d = new Date(y, +m[1] - 1, +m[2]); if (d.getMonth() === +m[1] - 1) return isoDay(d); }
    return isoDay(new Date());
  }
  function r2(v) { return v === null || v === undefined ? null : Math.round(v * 100) / 100; }
  function minsBetween(a, b) { a = clk(a); b = clk(b); if (!a || !b) return null; var x = +a.slice(0, 2) * 60 + +a.slice(3), y = +b.slice(0, 2) * 60 + +b.slice(3); return ((y - x) % 1440 + 1440) % 1440 || null; }

  function fromTryout(S, c) {
    var sh = c.sh, res = c.res;
    var slots = (S.slots || []).slice(0, S.slotCount || 0), run = (res.machinesRun || []).slice();
    var names = [];
    var machines = slots.map(function (sl, si) {
      var segs = (sl.segments || []).filter(function (sg) { return txt(sg.machine, 30); });
      return { segments: segs.map(function (sg) {
        var name = txt(sg.machine, 30); if (names.indexOf(name) < 0) names.push(name);
        var hit = null;
        for (var i = 0; i < run.length; i++) if (run[i].slot === si && run[i].name === name) { hit = run.splice(i, 1)[0]; break; }
        return { machine: name, from: clk(sg.from), to: clk(sg.to), goal: num((S.goals || {})[name]),
          run_hours: hit && hit.runMin !== null ? r2(hit.runMin / 60) : null, goal_lbs: hit && hit.goalLbs !== null ? hit.goalLbs : null };
      }) };
    }).filter(function (sl) { return sl.segments.length; });
    var only = names.length === 1 ? names[0] : "";
    var coils = [];
    (S.rows || []).forEach(function (row, i) {
      var rr = (res.rows || [])[i] || {};
      var cin = num(row.coilsDrawn);
      if (!txt(row.card, 30) && cin === null && rr.weight === null && num(row.woTotal) === null) return;   // empty row
      coils.push({ work_order: txt(row.card, 30), tot_avg_wgt: num(row.woTotal), wo_coils: num(row.woCoils), avg_wgt: rr.avg !== undefined ? rr.avg : null,
        coils_in: cin, coils_out: rr.coilsOut !== null && rr.coilsOut !== undefined ? rr.coilsOut : cin, coils_text: txt(rr.coilsText, 20),
        weight: rr.weight !== undefined ? rr.weight : null, machine: txt(row.machine || only, 30),
        finish: txt(row.finish, 40), grade: txt(row.grade, 40), compound: txt(row.compound, 40), package: txt(row.package, 40) });
    });
    var raw = {}; Object.keys(S).forEach(function (k) { if (k !== "q" && k !== "screen" && k !== "step") raw[k] = S[k]; });
    return {
      v: 1,
      shift: { date: normDate(S.date), operator: txt(S.name, 60), shift: txt(S.shift, 20), start: clk(S.start), end: clk(S.end) },
      breaks: (S.breaks || []).filter(function (b) { return num(b.minutes) > 0; }).slice(0, 12).map(function (b) { return { start: clk(b.start), minutes: Math.min(num(b.minutes), 1440) }; }),
      downtime: (S.downtime || []).map(function (d) {
        var m = num(d.minutes); if (m === null) m = minsBetween(d.start, d.end);
        return { machine: txt(d.machine, 30), start: clk(d.start), end: clk(d.end), minutes: m === null ? null : Math.min(m, 1440), reason: txt(d.reason, 300) };
      }).filter(function (d) { return d.minutes || d.reason; }).slice(0, 40),
      machines: machines,
      coils: coils.slice(0, 60),
      totals: { total_lbs: res.total || (coils.length ? 0 : null), net_hours: res.hours, goal_lbs: res.shiftGoal, goal_lbhr: res.goal,
        avg_lbhr: res.rate10 !== null && res.rate10 !== undefined ? res.rate10 / 10 : null,
        goal_met: res.status === "met" ? true : res.status === "notmet" ? false : null },
      problems: (res.problems || []).slice(0, 40).map(function (p) { return txt(p, 300); }),
      maintenance: txt(res.maintenance, 2000),
      raw: { source: "calc/try", headline: res.headline || "", state: raw }
    };
  }

  /* ---------- outbox ---------- */
  function queue() { return get(K.queue, []); }
  function shiftKey(p) { return [p.shift.date, (p.shift.operator || "").toLowerCase(), p.shift.shift, p.shift.start].join("|"); }
  function contentHash(p) { var c = {}; Object.keys(p).forEach(function (k) { if (k !== "id" && k !== "created_at") c[k] = p[k]; }); return hash(JSON.stringify(c)); }
  function markSent(item, at) {
    var sent = get(K.sent, []).filter(function (s) { return s.id !== item.id; });
    sent.unshift({ id: item.id, key: item.key, hash: item.hash, at: at }); put(K.sent, sent.slice(0, 30));
  }
  function status(kind, msg) { lastStatus = { kind: kind, msg: msg }; paint(); }

  function flush(force) {
    if (busy) return Promise.resolve();
    var q = queue(), now = Date.now();
    var due = q.filter(function (it) { return force || !it.nextAt || it.nextAt <= now; });
    if (!due.length) { schedule(); return Promise.resolve(); }
    var code = get(K.code, "");
    if (!code) { status("bad", "Type the crew code, then tap SUBMIT."); return Promise.resolve(); }
    if (!api() || /REPLACE-ME/.test(api())) { status("bad", "Master log address not set up yet."); return Promise.resolve(); }
    busy = true; paint();
    var it = due[0];
    return fetch(api() + "/submit", { method: "POST", headers: { "Content-Type": "application/json", "X-Crew-Code": code },
      body: JSON.stringify(it.payload), credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        var r = x.r, j = x.j, rest = queue();
        if (r.ok && j.ok) {
          put(K.queue, rest.filter(function (o) { return o.id !== it.id; }));
          markSent(it, j.submitted_at || new Date().toISOString());
          status("ok", (j.duplicate ? "Already in the master log" : "Sent to the master log") + " \u2713 " + hhmm(new Date()) + ". It's locked now.");
          return "next";
        }
        if (r.status === 401) { status("bad", "Crew code is wrong. Fix it and tap SUBMIT again. (Your log is saved on this phone.)"); return "stop"; }
        if (r.status === 400 || r.status === 413) {
          put(K.queue, rest.filter(function (o) { return o.id !== it.id; }));
          status("bad", "Not sent: " + (j.error || "the log has a problem") + " Fix it and tap SUBMIT again.");
          return "stop";
        }
        var wait = r.status === 429 ? (Number(r.headers.get("Retry-After")) || 900) * 1000 : backoff(it);
        bump(it, wait, j.error || ("server said " + r.status));
        status("warn", r.status === 503 ? "Master log isn't set up yet. Your log is saved on this phone and will send by itself once it is." : r.status === 429 ? "Too many tries. Saved on this phone; it will send by itself later." : "Server busy. Saved on this phone; it will send by itself.");
        return "stop";
      }, function () {
        bump(it, backoff(it), "no signal");
        status("warn", "No signal. Saved on this phone \u2713 It will send by itself when you're back online.");
        return "stop";
      })
      .then(function (next) { busy = false; paint(); if (next === "next" && queue().length) return flush(force); schedule(); });
  }
  function backoff(it) { return Math.min(30000 * Math.pow(2, it.tries || 0), 15 * 60000); }
  function bump(it, wait, err) {
    put(K.queue, queue().map(function (o) { if (o.id === it.id) { o.tries = (o.tries || 0) + 1; o.nextAt = Date.now() + wait; o.error = err; } return o; }));
  }
  function schedule() {
    clearTimeout(timer); var q = queue(); if (!q.length) return;
    var next = Math.min.apply(null, q.map(function (o) { return o.nextAt || 0; }));
    timer = setTimeout(function () { flush(false); }, Math.max(5000, Math.min(next - Date.now(), 15 * 60000)));
  }

  /* Returns what happened, for the button and for tests. */
  function submit(getPayload) {
    var p;
    try { p = typeof getPayload === "function" ? getPayload() : getPayload; } catch (e) { status("bad", "Could not read the log: " + e.message); return Promise.resolve("error"); }
    var op = txt(get(K.op, ""), 60) || p.shift.operator;
    if (!op) { status("bad", "Type your name first."); focus("ldb-op"); return Promise.resolve("noname"); }
    if (!get(K.code, "")) { status("bad", "Type the crew code first."); focus("ldb-code"); return Promise.resolve("nocode"); }
    p.shift.operator = op;
    if (!p.coils || !p.coils.length) { status("bad", "Add at least one coil row before sending."); return Promise.resolve("empty"); }
    var key = shiftKey(p), h = contentHash(p), q = queue(), sent = get(K.sent, []);
    var same = sent.filter(function (s) { return s.key === key; })[0];
    if (same && same.hash === h) { status("ok", "Already sent \u2713 This log is locked."); return Promise.resolve("already"); }
    if (same && !confirm("You already sent this shift. Send the changed version as a NEW log?\n\nTell your lead so they can delete the old one.")) return Promise.resolve("cancelled");
    if (p.totals && p.totals.goal_met === null && !confirm("The results aren't finished (no goal or hours yet). Send anyway?")) return Promise.resolve("cancelled");
    var waiting = q.filter(function (o) { return o.key === key; })[0];
    if (waiting) {          // not sent yet: keep its id, send the newest version
      waiting.payload = Object.assign({}, p, { id: waiting.id, created_at: new Date().toISOString() }); waiting.hash = h; waiting.nextAt = 0;
      put(K.queue, q);
    } else {
      var id = newId();
      q.push({ id: id, key: key, hash: h, queuedAt: Date.now(), tries: 0, nextAt: 0, payload: Object.assign({}, p, { id: id, created_at: new Date().toISOString() }) });
      put(K.queue, q);
    }
    status("warn", "Sending\u2026");
    return flush(true).then(function () { return lastStatus && lastStatus.kind; });
  }

  /* ---------- UI ---------- */
  var CSS = ".ldb{border:1px solid var(--fg,#39ff6a);background:var(--panel,#061206);padding:12px;margin:22px 0 10px}" +
    ".ldb h4{margin:0 0 10px;color:var(--white,#eaffea);letter-spacing:.1em;font-size:15px}" +
    ".ldb label{display:block;color:var(--amber,#ffc23d);font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;margin:0 0 .4rem}" +
    ".ldb .f{margin-bottom:.9rem}.ldb input{width:100%;height:3.25rem;padding:0 .85rem;background:#000;color:var(--white,#eaffea);border:2px solid var(--fg-dim,#1f9a3e);" +
    "border-radius:3px;font-family:inherit;font-size:1.15rem}.ldb input:focus{outline:none;border-color:var(--fg,#39ff6a)}" +
    ".ldb input::placeholder{color:rgba(57,255,106,.35)}.ldb .row{display:grid;grid-template-columns:minmax(0,1fr) 4.5rem;gap:.5rem}" +
    ".ldb button{min-height:48px}.ldb .go{width:100%;min-height:60px;font-size:19px;font-weight:bold;background:var(--fg,#39ff6a);color:#000;border:0;letter-spacing:.06em}" +
    ".ldb .go:disabled{opacity:.6}.ldb .st{margin-top:10px;padding:10px;font-size:16px;line-height:1.4;border:1px solid;display:none}" +
    ".ldb .st.ok{display:block;color:var(--fg,#39ff6a);border-color:var(--fg,#39ff6a)}.ldb .st.warn{display:block;color:var(--amber,#ffc23d);border-color:var(--amber,#ffc23d)}" +
    ".ldb .st.bad{display:block;color:var(--red,#ff5f56);border-color:var(--red,#ff5f56)}.ldb .q{color:var(--amber,#ffc23d);font-size:14px;margin-top:8px}";
  function focus(id) { var e = document.getElementById(id); if (e) e.focus(); }
  function paint() {
    if (!mounted || !document.body.contains(mounted.el)) return;
    var b = mounted.el.querySelector(".go"), st = mounted.el.querySelector(".st"), qn = mounted.el.querySelector(".q");
    b.disabled = busy; b.textContent = busy ? "SENDING\u2026" : "SUBMIT TO MASTER LOG";
    st.className = "st" + (lastStatus ? " " + lastStatus.kind : ""); st.textContent = lastStatus ? lastStatus.msg : "";
    var n = queue().length;
    qn.textContent = n ? n + (n === 1 ? " log" : " logs") + " waiting on this phone to send" : "";
  }
  function mount(container, getPayload) {
    if (!document.getElementById("ldb-css")) { var s = document.createElement("style"); s.id = "ldb-css"; s.textContent = CSS; document.head.appendChild(s); }
    var p = null; try { p = getPayload(); } catch (e) {}
    var el = document.createElement("div"); el.className = "ldb";
    el.innerHTML = '<h4>SEND TO MASTER LOG</h4>' +
      '<div class="f"><label for="ldb-op">Your name</label><input id="ldb-op" autocomplete="name" placeholder="your name" maxlength="60" value="' + esc(get(K.op, "") || (p && p.shift.operator) || "") + '"></div>' +
      '<div class="f"><label for="ldb-code">Crew code</label><div class="row"><input id="ldb-code" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="crew code" value="' + esc(get(K.code, "")) + '">' +
      '<button type="button" class="ldb-show">SHOW</button></div></div>' +
      '<button type="button" class="go">SUBMIT TO MASTER LOG</button><div class="st" role="status" aria-live="polite"></div><div class="q"></div>';
    container.appendChild(el);
    mounted = { el: el };
    var op = el.querySelector("#ldb-op"), cd = el.querySelector("#ldb-code");
    op.addEventListener("input", function () { put(K.op, op.value.trim()); });
    cd.addEventListener("input", function () { put(K.code, cd.value.trim()); });
    el.querySelector(".ldb-show").onclick = function () { var t = cd.type === "password"; cd.type = t ? "text" : "password"; this.textContent = t ? "HIDE" : "SHOW"; };
    el.querySelector(".go").onclick = function () { put(K.op, op.value.trim()); put(K.code, cd.value.trim()); submit(getPayload); };
    // show where this shift stands right now
    if (!busy) lastStatus = null;
    if (p && !busy) {
      var key = shiftKey(Object.assign({}, p, { shift: Object.assign({}, p.shift, { operator: get(K.op, "") || p.shift.operator }) }));
      var s = get(K.sent, []).filter(function (x) { return x.key === key; })[0];
      var w = queue().filter(function (x) { return x.key === key; })[0];
      if (w) lastStatus = { kind: "warn", msg: "Saved on this phone \u2713 It will send by itself when there's signal." + (w.error ? " (Last try: " + w.error + ")" : "") };
      else if (s) lastStatus = { kind: "ok", msg: "Already sent \u2713 " + new Date(s.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) + ". This log is locked." };
    }
    paint();
    return el;
  }

  window.addEventListener("online", function () { flush(true); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") flush(false); });
  if (queue().length) setTimeout(function () { flush(true); }, 1500);

  window.LogDB = { mount: mount, submit: submit, flush: flush, queue: queue, fromTryout: fromTryout, normDate: normDate, keys: K };
})();
