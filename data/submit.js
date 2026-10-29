/* "Submit to master log" for the calculator's Sheet view.
   Needs data/config.js loaded first (window.LOGDB_API_BASE).

   Drop-in for /calc/try/ (two lines):
     <script src="/data/config.js"></script><script src="/data/submit.js"></script>      (in <head>)
     if (window.LogDB) LogDB.mount($("sv-body"), function () { return LogDB.fromTryout(S, calc()); });
                                                                       (at the end of openSheet())

   Remembered on this device (localStorage): operator name, crew code, the outbox of logs not sent yet,
   and the last 30 sent logs (so a second tap does not send the same shift twice).
   Every log gets an id made on the phone; the server stores each id once, so retries are safe.
   If the server says a log looks like one already in the master log (409: same operator, date, Draw and
   overlapping hours), the log is held on the phone and a "Looks like this was already submitted" box asks:
   SEND ANYWAY (resend with force: true) or DON'T SEND (keep it on the phone, nothing sent). Held logs are
   never sent by the background retry; the box comes back the next time the sheet view is opened.

   The Draw Rate tracker uses LogDB.enqueue(payload, { base: "T<shift id>" }) instead of submit(): no questions asked,
   the log id is "<base>-v1" (stable for that shift, so retries and double taps are stored once). If the shift is
   changed after it was sent, the next send is "<base>-v2" with replaces: "<base>-v1" and the server swaps the old
   one out (see /submit in the Worker). Tracker logs the server turns down (400) stay on the phone, marked rejected.
   A wrong crew code (401) is remembered so the background retry stops until the code is changed. */
(function () {
  "use strict";
  var K = { op: "logdbOperator", code: "logdbCrewCode", queue: "logdbQueueV1", sent: "logdbSentV1", badCode: "logdbBadCodeV1" };
  var busy = false, timer = null, mounted = null, lastStatus = null, listeners = [];
  var labels = { go: "SUBMIT TO MASTER LOG", word: "SUBMIT" };

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
  /* What counts as "the same log": everything but the ids and times. A tracker log's raw copy of the phone's
     state changes on every save, so it is left out too (the rest of the log already holds what it says). */
  function contentHash(p) {
    var tracker = p.raw && p.raw.source === "tracker", c = {};
    Object.keys(p).forEach(function (k) { if (k !== "id" && k !== "created_at" && k !== "replaces" && k !== "force" && !(tracker && k === "raw")) c[k] = p[k]; });
    return hash(JSON.stringify(c));
  }
  function nextId(id) { var m = /^(.*)-v(\d+)$/.exec(id); return m ? m[1] + "-v" + (+m[2] + 1) : id + "-v2"; }
  function markSent(item, at, h) {
    var sent = get(K.sent, []).filter(function (s) { return s.id !== item.id; });
    sent.unshift({ id: item.id, key: item.key, hash: h || item.hash, at: at }); put(K.sent, sent.slice(0, 30));
  }
  function status(kind, msg) { lastStatus = { kind: kind, msg: msg, at: Date.now() }; paint(); }
  function canSend(o) { return !o.held && !o.rejected; }
  function stats() {
    var q = queue(), sent = get(K.sent, []);
    return { pending: q.filter(canSend).length, held: q.filter(function (o) { return o.held && !o.held.kept; }).length,
      kept: q.filter(function (o) { return o.held && o.held.kept; }).length, rejected: q.filter(function (o) { return o.rejected && !o.held; }).length,
      total: q.length, busy: busy, lastSent: sent[0] || null, hasCode: !!get(K.code, ""), operator: get(K.op, ""),
      badCode: !!get(K.code, "") && get(K.badCode, "") === hash(get(K.code, "")) };
  }
  function notify() { var st = stats(); listeners.forEach(function (fn) { try { fn(lastStatus, st); } catch (e) {} }); }

  /* force: true = also items still waiting out a retry delay; "manual" = a person tapped a button (also tries a
     crew code that failed before). */
  function flush(force) {
    if (busy) return Promise.resolve();
    var q = queue(), now = Date.now();
    var due = q.filter(function (it) { return canSend(it) && (force || !it.nextAt || it.nextAt <= now); });
    if (!due.length) { schedule(); notify(); return Promise.resolve(); }
    var code = get(K.code, "");
    if (!code) { status("bad", "Type the crew code, then tap " + labels.word + ". (Your log is saved on this phone.)"); return Promise.resolve(); }
    if (force !== "manual" && get(K.badCode, "") === hash(code)) { status("bad", "Crew code is wrong. Fix it and tap " + labels.word + " again. (Your log is saved on this phone.)"); return Promise.resolve(); }
    if (!api() || /REPLACE-ME/.test(api())) { status("bad", "Master log address not set up yet."); return Promise.resolve(); }
    var it = due[0];
    if (!txt(it.payload.shift && it.payload.shift.operator, 60)) {      // queued before a name was typed
      var who = txt(get(K.op, ""), 60);
      if (!who) { status("bad", "Type your name, then tap " + labels.word + ". (Your log is saved on this phone.)"); return Promise.resolve(); }
      it.payload.shift.operator = who; it.hash = contentHash(it.payload);
      put(K.queue, q.map(function (o) { return o.id === it.id ? it : o; }));
    }
    busy = true; paint();
    var sentHash = it.hash;
    var body = it.force ? Object.assign({}, it.payload, { force: true }) : it.payload;
    return fetch(api() + "/submit", { method: "POST", headers: { "Content-Type": "application/json", "X-Crew-Code": code },
      body: JSON.stringify(body), credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        var r = x.r, j = x.j, rest = queue();
        if (r.ok && j.ok) {
          put(K.badCode, "");
          markSent(it, j.submitted_at || new Date().toISOString(), sentHash);
          var cur = rest.filter(function (o) { return o.id === it.id; })[0];
          if (cur && cur.hash !== sentHash && cur.key) {
            // changed while it was on its way: send the newer version as an update of the one just stored
            var nid = nextId(it.id);
            cur.payload = Object.assign({}, cur.payload, { id: nid, replaces: it.id }); cur.id = nid; cur.replaces = it.id;
            cur.tries = 0; cur.nextAt = 0; cur.force = false;
            put(K.queue, rest);
          } else put(K.queue, rest.filter(function (o) { return o.id !== it.id; }));
          var when = " \u2713 " + hhmm(new Date());
          status("ok", j.duplicate ? "Already in the master log" + when + (it.okMsg ? "" : ". It's locked now.")
            : it.replaces ? (j.replaced === false ? (it.okMsg || "Sent to the master log") : "Update sent to the master log") + when
            : it.okMsg ? it.okMsg + when : "Sent to the master log" + when + ". It's locked now.");
          return "next";
        }
        if (r.status === 409 && j.possible_duplicate) {
          put(K.queue, rest.map(function (o) { if (o.id === it.id) o.held = { match: j.match || {}, at: Date.now(), kept: false }; return o; }));
          status("warn", "Not sent yet: looks like this was already submitted. Choose below.");
          return "next";
        }
        if (r.status === 401) {
          put(K.badCode, hash(code));
          status("bad", "Crew code is wrong. Fix it and tap " + labels.word + " again. (Your log is saved on this phone.)"); return "stop";
        }
        if (r.status === 400 || r.status === 413) {
          if (it.keep) {     // tracker log: the phone has nothing else, so never throw it away
            put(K.queue, rest.map(function (o) { if (o.id === it.id) o.rejected = { error: j.error || ("server said " + r.status), at: Date.now() }; return o; }));
            status("bad", "The master log turned this log down: " + (j.error || "it has a problem.") + " It's kept on this phone.");
          } else {
            put(K.queue, rest.filter(function (o) { return o.id !== it.id; }));
            status("bad", "Not sent: " + (j.error || "the log has a problem") + " Fix it and tap " + labels.word + " again.");
          }
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
      .then(function (next) { busy = false; paint(); if (next === "next" && sendable().length) return flush(force); schedule(); });
  }
  function backoff(it) { return Math.min(30000 * Math.pow(2, it.tries || 0), 15 * 60000); }
  function bump(it, wait, err) {
    put(K.queue, queue().map(function (o) { if (o.id === it.id) { o.tries = (o.tries || 0) + 1; o.nextAt = Date.now() + wait; o.error = err; } return o; }));
  }
  function sendable() { return queue().filter(canSend); }
  function held() { return queue().filter(function (o) { return o.held; }); }
  /* SEND ANYWAY: stored as a new log even though it looks like one already there. */
  function sendAnyway(id) {
    var hit = false;
    put(K.queue, queue().map(function (o) { if (o.id === id) { hit = true; o.held = null; o.force = true; o.nextAt = 0; } return o; }));
    if (!hit) return Promise.resolve("gone");
    status("warn", "Sending\u2026");
    return flush("manual").then(function () { return lastStatus && lastStatus.kind; });
  }
  /* DON'T SEND: stays on this phone, never sent by itself. Tapping SUBMIT again on that shift asks the server again. */
  function keep(id) {
    put(K.queue, queue().map(function (o) { if (o.id === id && o.held) o.held.kept = true; return o; }));
    status("warn", "Not sent. Kept on this phone only.");
  }
  function schedule() {
    clearTimeout(timer); var q = sendable(); if (!q.length) return;
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
      waiting.held = null; waiting.force = false;
      put(K.queue, q);
    } else {
      var id = newId();
      q.push({ id: id, key: key, hash: h, queuedAt: Date.now(), tries: 0, nextAt: 0, payload: Object.assign({}, p, { id: id, created_at: new Date().toISOString() }) });
      put(K.queue, q);
    }
    status("warn", "Sending\u2026");
    return flush("manual").then(function () { return lastStatus && lastStatus.kind; });
  }

  /* For the Draw Rate tracker: queue (or update) this shift's log under a stable id and start sending.
     Never asks anything and never drops the log. opts: base (required, one per shift), manual (a person tapped
     SEND: also re-asks a held "looks already submitted" log and retries a turned-down one), okMsg. */
  function enqueue(p, opts) {
    opts = opts || {};
    var base = String(opts.base || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 58);
    if (base.length < 6) return Promise.resolve("error");
    if (!txt(p.shift.operator, 60)) p.shift.operator = txt(get(K.op, ""), 60);
    var h = contentHash(p), q = queue(), now = new Date().toISOString();
    var waiting = q.filter(function (o) { return o.key === base; })[0];
    var last = get(K.sent, []).filter(function (s) { return s.key === base; })[0];
    if (waiting) {
      var changed = waiting.hash !== h;
      waiting.payload = Object.assign({}, p, { id: waiting.id, created_at: now }, waiting.replaces ? { replaces: waiting.replaces } : {});
      waiting.hash = h; waiting.nextAt = 0; waiting.keep = true; if (opts.okMsg) waiting.okMsg = opts.okMsg;
      if (opts.manual) { if (waiting.held) { waiting.held = null; waiting.force = false; } waiting.rejected = null; }
      else if (changed) waiting.rejected = null;
    } else if (last && last.hash === h) {
      status("ok", "Already in the master log \u2713 (sent " + hhmm(new Date(last.at)) + ")");
      return Promise.resolve("already");
    } else {
      var id = last ? nextId(last.id) : base + "-v1";
      var item = { id: id, key: base, hash: h, queuedAt: Date.now(), tries: 0, nextAt: 0, keep: true, okMsg: opts.okMsg || "",
        payload: Object.assign({}, p, { id: id, created_at: now }) };
      if (last) { item.replaces = last.id; item.payload.replaces = last.id; }
      q.push(item);
    }
    put(K.queue, q);
    status("warn", "Saved on this phone \u2713 Sending\u2026");
    return flush(opts.manual ? "manual" : true).then(function () { return lastStatus && lastStatus.kind; });
  }
  function saveCreds(op, code) {
    if (op !== undefined && op !== null) put(K.op, txt(op, 60));
    if (code !== undefined && code !== null) put(K.code, String(code).trim());
    notify();
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
    ".ldb .st.bad{display:block;color:var(--red,#ff5f56);border-color:var(--red,#ff5f56)}.ldb .q{color:var(--amber,#ffc23d);font-size:14px;margin-top:8px}" +
    ".ldb .dup{margin-top:12px;padding:12px;border:2px solid var(--amber,#ffc23d);background:#140f00;color:var(--white,#eaffea)}" +
    ".ldb .dup b.t{display:block;color:var(--amber,#ffc23d);font-size:17px;letter-spacing:.04em;margin-bottom:8px}" +
    ".ldb .dup p{margin:0 0 8px;font-size:15px;line-height:1.45}.ldb .dup dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 12px;font-size:15px}" +
    ".ldb .dup dt{color:var(--amber,#ffc23d)}.ldb .dup dd{margin:0;color:var(--white,#eaffea)}" +
    ".ldb .dup .btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ldb .dup button{min-height:56px;font-size:16px;font-weight:bold;letter-spacing:.04em}" +
    ".ldb .dup .any{background:var(--amber,#ffc23d);color:#000;border:0}.ldb .dup .no{background:#000;color:var(--fg,#39ff6a);border:2px solid var(--fg,#39ff6a)}";
  function focus(id) { var e = document.getElementById(id); if (e) e.focus(); }
  function paint() {
    notify();
    if (!mounted || !document.body.contains(mounted.el)) return;
    var b = mounted.el.querySelector(".go"), st = mounted.el.querySelector(".st"), qn = mounted.el.querySelector(".q");
    b.disabled = busy; b.textContent = busy ? "SENDING\u2026" : (mounted.go || labels.go);
    st.className = "st" + (lastStatus ? " " + lastStatus.kind : ""); st.textContent = lastStatus ? lastStatus.msg : "";
    var x = stats(), n = x.pending, kept = x.kept, rej = x.rejected;
    qn.textContent = (n ? n + (n === 1 ? " log" : " logs") + " waiting on this phone to send. " : "") +
      (kept ? kept + (kept === 1 ? " log" : " logs") + " kept on this phone, not sent. " : "") +
      (rej ? rej + (rej === 1 ? " log" : " logs") + " the master log turned down, kept on this phone." : "");
    var box = mounted.el.querySelector(".dup"), it = held().filter(function (o) { return !o.held.kept; })[0];
    if (!it || busy) { if (box) box.remove(); return; }
    if (box && box.dataset.id === it.id) return;
    if (box) box.remove();
    box = document.createElement("div"); box.className = "dup"; box.dataset.id = it.id; box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-label", "Looks like this was already submitted");
    var m = it.held.match || {}, mine = it.payload && it.payload.shift || {};
    box.innerHTML = '<b class="t">LOOKS LIKE THIS WAS ALREADY SUBMITTED</b>' +
      '<p>The master log already has a log like this one' + (mine.operator ? " (" + esc(mine.operator) + ", " + esc(day(mine.date)) + ")" : "") + ':</p><dl>' +
      '<dt>Name</dt><dd>' + esc(m.operator || "\u2013") + '</dd>' +
      '<dt>Date</dt><dd>' + esc(day(m.shift_date)) + '</dd>' +
      '<dt>Shift</dt><dd>' + esc(m.shift_start && m.shift_end ? clock12(m.shift_start) + " \u2013 " + clock12(m.shift_end) : "\u2013") + '</dd>' +
      '<dt>Draws</dt><dd>' + esc((m.draws || []).map(function (d) { return "Draw " + d; }).join(", ") || "\u2013") + '</dd>' +
      (m.total_lbs !== null && m.total_lbs !== undefined ? '<dt>Weight</dt><dd>' + esc(Number(m.total_lbs).toLocaleString()) + ' lb</dd>' : "") +
      '<dt>Sent</dt><dd>' + esc(m.submitted_at ? new Date(m.submitted_at).toLocaleString([], { month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" }) : "\u2013") + '</dd></dl>' +
      '<p>If this is a different log, send it anyway. If it\'s the same one, don\'t send it again.</p>' +
      '<div class="btns"><button type="button" class="any">SEND ANYWAY</button><button type="button" class="no">DON\'T SEND</button></div>';
    mounted.el.appendChild(box);
    box.querySelector(".any").onclick = function () { sendAnyway(it.id); };
    box.querySelector(".no").onclick = function () { keep(it.id); };
  }
  function day(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? +m[2] + "/" + +m[3] + "/" + m[1].slice(2) : (iso || "\u2013"); }
  function clock12(v) { var m = /^(\d{2}):(\d{2})$/.exec(v || ""); if (!m) return v || ""; var h = +m[1]; return (h % 12 || 12) + ":" + m[2] + (h < 12 ? " AM" : " PM"); }
  /* opts (all optional): go = button text, send = what the button does instead of submit(getPayload),
     key = the outbox key of this log (tracker), title. */
  function mount(container, getPayload, opts) {
    opts = opts || {};
    if (!document.getElementById("ldb-css")) { var s = document.createElement("style"); s.id = "ldb-css"; s.textContent = CSS; document.head.appendChild(s); }
    var p = null; try { p = getPayload(); } catch (e) {}
    var el = document.createElement("div"); el.className = "ldb";
    el.innerHTML = '<h4>' + esc(opts.title || "SEND TO MASTER LOG") + '</h4>' +
      '<div class="f"><label for="ldb-op">Your name</label><input id="ldb-op" autocomplete="name" placeholder="your name" maxlength="60" value="' + esc(get(K.op, "") || (p && p.shift.operator) || "") + '"></div>' +
      '<div class="f"><label for="ldb-code">Crew code</label><div class="row"><input id="ldb-code" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="crew code" value="' + esc(get(K.code, "")) + '">' +
      '<button type="button" class="ldb-show">SHOW</button></div></div>' +
      '<button type="button" class="go">' + esc(opts.go || labels.go) + '</button><div class="st" role="status" aria-live="polite"></div><div class="q"></div>';
    container.appendChild(el);
    mounted = { el: el, go: opts.go || "" };
    var op = el.querySelector("#ldb-op"), cd = el.querySelector("#ldb-code");
    op.addEventListener("input", function () { put(K.op, op.value.trim()); });
    cd.addEventListener("input", function () { put(K.code, cd.value.trim()); });
    el.querySelector(".ldb-show").onclick = function () { var t = cd.type === "password"; cd.type = t ? "text" : "password"; this.textContent = t ? "HIDE" : "SHOW"; };
    el.querySelector(".go").onclick = function () {
      put(K.op, op.value.trim()); put(K.code, cd.value.trim());
      if (opts.send) opts.send(); else submit(getPayload);
    };
    // show where this shift stands right now
    if (!busy) lastStatus = null;
    if (p && !busy) {
      var key = opts.key || shiftKey(Object.assign({}, p, { shift: Object.assign({}, p.shift, { operator: get(K.op, "") || p.shift.operator }) }));
      var s = get(K.sent, []).filter(function (x) { return x.key === key; })[0];
      var w = queue().filter(function (x) { return x.key === key; })[0];
      if (w && w.held && w.held.kept) lastStatus = { kind: "warn", msg: "Not sent. Kept on this phone only (looked like it was already submitted). Tap " + labels.word + " to check again." };
      else if (w && w.held) lastStatus = { kind: "warn", msg: "Not sent yet: looks like this was already submitted. Choose below." };
      else if (w && w.rejected) lastStatus = { kind: "bad", msg: "The master log turned this log down: " + w.rejected.error + " It's kept on this phone. Tap " + labels.word + " to try again." };
      else if (w) lastStatus = { kind: "warn", msg: "Saved on this phone \u2713 It will send by itself when there's signal." + (w.error ? " (Last try: " + w.error + ")" : "") };
      else if (s) lastStatus = { kind: "ok", msg: "Already sent \u2713 " + new Date(s.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) +
        (opts.key ? ". Log more and it sends the update." : ". This log is locked.") };
    }
    paint();
    return el;
  }

  function onChange(fn) { listeners.push(fn); try { fn(lastStatus, stats()); } catch (e) {} }
  function setLabels(l) { Object.keys(l || {}).forEach(function (k) { labels[k] = l[k]; }); }

  window.addEventListener("online", function () { flush(true); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") flush(false); });
  if (sendable().length) setTimeout(function () { flush(true); }, 1500);

  window.LogDB = { mount: mount, submit: submit, flush: flush, queue: queue, held: held, sendAnyway: sendAnyway, keep: keep,
    enqueue: enqueue, saveCreds: saveCreds, stats: stats, onChange: onChange, setLabels: setLabels, nextId: nextId,
    status: function () { return lastStatus; }, fromTryout: fromTryout, normDate: normDate, keys: K };
})();
