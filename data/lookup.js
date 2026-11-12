/* JOB LOOKUP: search the crew's past runs and job tips in the master log by finish size, grade, start size and
   % area reduction. Shared by the phone tracker (/draw/app/, crew code) and the /data/ dashboard (passcode).
   JobLookup.mount(el, { auth: function () { return headers }, needCode, canTip, prefill: { size, grade, start }, msg })
   Reads only, except JOB TIPS: POST /tip (queued on the phone when there's no signal). The last results are kept on
   this device so the search still shows something offline. */
(function () {
  "use strict";
  var API = String(window.LOGDB_API_BASE || "").replace(/\/+$/, "");
  var CACHE = "jobLookupCacheV1", TIPQ = "jobTipQueueV1", K_CODE = "logdbCrewCode", K_OP = "logdbOperator";
  var RED_NEAR = 3;
  var TAGS = ["Grease", "Soap", "Shape change", "Stainless", "New die", "Die change", "Slow speed", "Hot"];
  function get(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function put(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function uid() { return "tip_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function today() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  // same reading of sizes as the server: ".600", "0.6", '.6"', "600" (= .600), "5/16"
  function sizeIn(v) {
    var t = String(v == null ? "" : v).trim().toLowerCase().replace(/\s*(?:"|''|in\.?|inch(?:es)?)$/, "");
    if (!t) return null;
    var m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
    if (m) { var f = +m[1] / +m[2]; return +m[2] > 0 && f > 0 && f < 3 ? Math.round(f * 10000) / 10000 : null; }
    if (/^\d{2,4}$/.test(t)) return +t / 1000 < 3 ? +t / 1000 : null;
    if (/^\d*\.\d+$|^\d+\.?$/.test(t)) { var n = +t; return n > 0 && n < 3 ? Math.round(n * 10000) / 10000 : null; }
    return null;
  }
  function reduction(fin, start) {
    var a = sizeIn(fin), b = sizeIn(start);
    if (!(a > 0) || !(b > 0) || a >= b) return null;
    return Math.round((1 - Math.pow(a / b, 2)) * 1000) / 10;
  }
  function fmtSize(v) { var n = sizeIn(v); return n == null ? String(v || "") : (n < 1 ? String(n.toFixed(3)).replace(/^0/, "") : n.toFixed(3)) + '"'; }
  function day(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); if (!m) return s || "";
    var d = new Date(+m[1], +m[2] - 1, +m[3]); return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + (+m[2]) + "/" + (+m[3]) + "/" + m[1].slice(2);
  }
  function when(ms) { var d = new Date(ms); return d.toLocaleString([], { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  function lb(n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function qText(q) { return [q.size && "size " + q.size, q.grade && "grade " + q.grade, q.start && "from " + q.start, q.red && q.red + "% \u00b1" + RED_NEAR, (q.red_min || q.red_max) && (q.red_min || "0") + " to " + (q.red_max || "100") + "%"].filter(Boolean).join(", "); }

  /* ---- job tips waiting to send (phone) ---- */
  function queue() { return get(TIPQ, []); }
  var flushing = false;
  function flushTips(code) {
    code = code || get(K_CODE, "");
    var q = queue();
    if (flushing || !q.length || !code || !API || navigator.onLine === false) return Promise.resolve(false);
    flushing = true;
    var t = q[0];
    return fetch(API + "/tip", { method: "POST", headers: { "Content-Type": "application/json", "X-Crew-Code": code }, body: JSON.stringify(t), credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        flushing = false;
        if (x.r.ok && x.j.ok) { put(TIPQ, queue().filter(function (o) { return o.id !== t.id; })); return flushTips(code).then(function () { return true; }); }
        if (x.r.status === 400) { put(TIPQ, queue().map(function (o) { if (o.id === t.id) o.rejected = x.j.error || "turned down"; return o; }).filter(function (o) { return o.id !== t.id || !o.rejected; })); }
        return false;
      }).catch(function () { flushing = false; return false; });
  }
  window.addEventListener("online", function () { flushTips(); });

  var CSS = ".jl{margin-top:.5rem}.jl-sub{color:var(--fg-dim);font-size:.9rem;line-height:1.4;margin:0 0 .75rem}" +
    ".jl-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.6rem}.jl-f{display:block;min-width:0}.jl-f.full{grid-column:1/-1;margin-top:.6rem}" +
    ".jl-f span,.jl-lbl{display:block;color:var(--amber);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;margin-bottom:.3rem}" +
    ".jl .in{width:100%;min-width:0;height:3rem;padding:0 .7rem;background:#000;color:var(--white);border:2px solid var(--fg-dim);font:inherit;font-size:1.1rem;box-sizing:border-box;border-radius:3px}" +
    ".jl textarea.in{height:auto;padding:.5rem .7rem;font-size:1rem}.jl .in:focus{outline:none;border-color:var(--fg)}" +
    ".jl-ra{color:var(--fg);font-size:.9rem;margin:.5rem 0 0;min-height:1em}" +
    ".jl button{font:inherit;cursor:pointer}.jl-go,.jl-add,.jl-cancel{width:100%;min-height:3.25rem;margin-top:.75rem;font-weight:700;letter-spacing:.06em;font-size:1.05rem;border:2px solid var(--fg);background:var(--fg);color:#000}" +
    ".jl-add,.jl-cancel{background:#000;color:var(--fg)}.jl-go:disabled{opacity:.5}.jl-btns{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}" +
    ".jl-st{margin:.6rem 0;font-size:.9rem;line-height:1.4;color:var(--fg)}.jl-st:empty{display:none}.jl-st.warn{color:var(--amber);border:1px solid var(--amber);padding:.5rem .6rem}.jl-st.bad{color:var(--red);border:1px solid var(--red);padding:.5rem .6rem}" +
    ".jl-count{color:var(--fg-dim);font-size:.85rem;margin:.6rem 0 .3rem}.jl-none{color:var(--white)}" +
    ".jl-card{display:block;width:100%;text-align:left;background:var(--panel);border:1px solid var(--fg-faint);color:var(--white);padding:.7rem;margin:.45rem 0;min-height:3.5rem;letter-spacing:0}" +
    ".jl-card.tip{border:2px solid var(--amber)}.jl-card.open{border-color:var(--fg)}.jl-card span{display:block}" +
    ".jl-l1{display:flex!important;justify-content:space-between;gap:.5rem}.jl-l1 b{color:var(--white)}.jl-card.tip .jl-l1 b{color:var(--amber)}.jl-l1 span{color:var(--fg-dim);font-size:.85rem;white-space:nowrap}" +
    ".jl-l2{color:var(--fg);margin-top:.3rem;font-size:1rem}.jl-l3{color:var(--fg-dim);font-size:.85rem;margin-top:.25rem}.jl-tip{color:var(--white);margin-top:.35rem;line-height:1.4;white-space:pre-wrap}" +
    ".jl-more{margin-top:.5rem;border-top:1px solid var(--fg-faint);padding-top:.5rem;font-size:.9rem}.jl-more[hidden]{display:none!important}.jl-more b{display:block;color:var(--amber);font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;margin:.4rem 0 .15rem}" +
    ".jl-li{color:var(--white);line-height:1.4;white-space:pre-wrap}.jl-li.dim{color:var(--fg-dim)}" +
    ".jl-tipform{border:2px solid var(--amber);padding:.75rem;margin-top:.75rem}.jl-h{color:var(--amber);letter-spacing:.08em}" +
    ".jl-tags{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.2rem}.jl-tag{min-height:2.75rem;padding:.2rem .7rem;background:#000;color:var(--fg);border:1px solid var(--fg-dim)}.jl-tag.on{background:var(--fg);color:#000}" +
    ".jl-err{color:var(--red);margin-top:.5rem;min-height:1em}";
  (function () { var st = document.createElement("style"); st.textContent = CSS; (document.head || document.documentElement).appendChild(st); })();

  function mount(el, opts) {
    opts = opts || {};
    var pre = opts.prefill || {}, last = get(CACHE, null);
    var q0 = last && last.q && !pre.size && !pre.grade ? last.q : { size: pre.size || "", grade: pre.grade || "", start: pre.start || "", red: "", red_min: "", red_max: "" };
    var h = '<div class="jl">' +
      '<p class="jl-sub">Search everyone\u2019s past runs and job tips in the master log. Every box is optional. Sizes match within .005"; a reduction matches within \u00b1' + RED_NEAR + ' points.</p>' +
      '<div class="jl-grid">' +
      fld("Finish size (in)", "jl-size", q0.size, 'inputmode="decimal" placeholder=".600"') + fld("Grade", "jl-grade", q0.grade, 'placeholder="1018" autocapitalize="characters"') +
      fld("Start size (in)", "jl-start", q0.start, 'inputmode="decimal" placeholder=".750"') + fld("Reduction %", "jl-red", q0.red, 'inputmode="decimal" placeholder="36"') +
      fld("Reduction from %", "jl-rmin", q0.red_min, 'inputmode="decimal" placeholder="30"') + fld("to %", "jl-rmax", q0.red_max, 'inputmode="decimal" placeholder="40"') +
      '</div><p class="jl-ra" id="jl-ra"></p>' +
      (opts.needCode ? '<div id="jl-codebox"' + (get(K_CODE, "") ? " hidden" : "") + '>' + fld("Crew code (once, this phone keeps it)", "jl-code", "", 'type="password" autocomplete="off"') + '</div>' : "") +
      '<button type="button" class="jl-go" id="jl-go">SEARCH</button>' +
      '<div class="jl-st" id="jl-st" role="status" aria-live="polite"></div><div id="jl-res"></div>' +
      (opts.canTip ? '<button type="button" class="jl-add" id="jl-add">+ ADD A JOB TIP</button><div id="jl-tipbox" hidden></div>' : "") +
      '</div>';
    el.innerHTML = h;
    function fld(label, id, val, attrs) { return '<label class="jl-f"><span>' + esc(label) + '</span><input class="in" id="' + id + '" value="' + esc(val || "") + '" autocomplete="off" ' + (attrs || "") + '></label>'; }
    var $ = function (id) { return el.querySelector("#" + id); };
    function form() { return { size: $("jl-size").value.trim(), grade: $("jl-grade").value.trim(), start: $("jl-start").value.trim(), red: $("jl-red").value.trim(), red_min: $("jl-rmin").value.trim(), red_max: $("jl-rmax").value.trim() }; }
    function paintRa() {
      var f = form(), r = reduction(f.size, f.start);
      $("jl-ra").textContent = r != null ? "Reduction from " + fmtSize(f.start) + " to " + fmtSize(f.size) + ": " + r + "%" : (f.size && f.start ? "Start size has to be bigger than the finish size to work out a reduction." : "");
    }
    ["jl-size", "jl-start"].forEach(function (id) { $(id).addEventListener("input", paintRa); });
    paintRa();
    function status(kind, msg) { var s = $("jl-st"); s.className = "jl-st " + (kind || ""); s.textContent = msg || ""; }
    function code() { if (!opts.needCode) return ""; var c = $("jl-code") && $("jl-code").value.trim(); if (c) put(K_CODE, c); return c || get(K_CODE, ""); }
    function pendingTips(f) {
      var fi = sizeIn(f.size), gk = String(f.grade || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return queue().filter(function (t) {
        var ti = sizeIn(t.finish), tg = String(t.grade || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        return (fi == null || (ti != null && Math.abs(ti - fi) <= 0.005)) && (!gk || (tg && (tg.indexOf(gk) >= 0 || gk.indexOf(tg) >= 0)));
      }).map(function (t) { return { id: t.id, date: t.date, operator: t.operator, machine: t.machine, finish: t.finish, start_size: t.start_size, grade: t.grade, reduction: reduction(t.finish, t.start_size), tags: t.tags || [], tip: t.tip, waiting: true }; });
    }
    function render(res, f) {
      var box = $("jl-res"), tips = pendingTips(f).concat(res.tips || []), runs = res.runs || [];
      var out = '<p class="jl-count">' + tips.length + " job tip" + (tips.length === 1 ? "" : "s") + " \u00b7 " + runs.length + " past run" + (runs.length === 1 ? "" : "s") + "</p>";
      if (!tips.length && !runs.length) out += '<p class="jl-none">Nothing in the master log matches yet. Try fewer boxes, or a near size.</p>';
      tips.forEach(function (t, i) {
        out += '<button type="button" class="jl-card tip" data-k="t' + i + '"><span class="jl-l1"><b>JOB TIP' + (t.waiting ? " \u00b7 WAITING TO SEND" : "") + '</b><span>' + esc(day(t.date)) + '</span></span>' +
          '<span class="jl-l2">' + esc(spec(t)) + '</span><span class="jl-tip">' + esc(t.tip) + '</span>' +
          '<span class="jl-more" hidden>' + esc([t.operator, t.machine || (t.draw ? "Draw " + t.draw : ""), (t.tags || []).join(" + "), t.match === "near" ? "near match" : ""].filter(Boolean).join(" \u00b7 ")) + '</span></button>';
      });
      runs.forEach(function (r, i) {
        var more = [];
        if (r.notes && r.notes.length) more.push('<b>Coil notes</b>' + r.notes.map(function (n) { return '<span class="jl-li">' + esc(n) + '</span>'; }).join(""));
        if (r.day_notes) more.push('<b>Day notes</b><span class="jl-li">' + esc(r.day_notes) + '</span>');
        if (r.tags && r.tags.length) more.push('<b>Conditions</b><span class="jl-li">' + esc(r.tags.join(" + ")) + '</span>');
        if (r.parts && r.parts.length) more.push('<b>Part #</b><span class="jl-li">' + esc(r.parts.join(", ")) + '</span>');
        if (r.heats && r.heats.length) more.push('<b>Heat #</b><span class="jl-li">' + esc(r.heats.join(", ")) + '</span>');
        if (r.match === "near") more.push('<span class="jl-li dim">Near match (size or grade close, not exact)</span>');
        if (!more.length) more.push('<span class="jl-li dim">No notes were typed for this run.</span>');
        out += '<button type="button" class="jl-card" data-k="r' + i + '"><span class="jl-l1"><b>' + esc(day(r.date)) + (r.draws && r.draws.length ? " \u00b7 Draw " + r.draws.join(", ") : "") + '</b><span>' + esc(r.operator) + '</span></span>' +
          '<span class="jl-l2">' + esc(spec(r)) + '</span>' +
          '<span class="jl-l3">' + r.coils + " coil" + (r.coils === 1 ? "" : "s") + " \u00b7 " + lb(r.lbs) + " lb" + ((r.notes && r.notes.length) || r.day_notes ? " \u00b7 NOTES" : "") + (r.tags && r.tags.length ? " \u00b7 " + esc(r.tags.join(" + ")) : "") + '</span>' +
          '<span class="jl-more" hidden>' + more.join("") + '</span></button>';
      });
      box.innerHTML = out;
      Array.prototype.forEach.call(box.querySelectorAll(".jl-card"), function (c) {
        c.onclick = function () { var m = c.querySelector(".jl-more"); m.hidden = !m.hidden; c.classList.toggle("open", !m.hidden); c.setAttribute("aria-expanded", String(!m.hidden)); };
        c.setAttribute("aria-expanded", "false");
      });
    }
    function spec(x) {
      var red = x.reduction != null ? x.reduction : reduction(x.finish, x.start_size);
      return [x.finish ? fmtSize(x.finish) : "", x.grade || "", x.start_size ? "from " + fmtSize(x.start_size) : "", red != null ? red + "% RA" : ""].filter(Boolean).join(" \u00b7 ") || "no size or grade";
    }
    function search() {
      var f = form();
      if (!f.size && !f.grade && !f.start && !f.red && !f.red_min && !f.red_max) { status("bad", "Type a finish size, a grade, a start size or a reduction."); return; }
      if (f.size && sizeIn(f.size) == null) { status("bad", "Finish size must look like .600 or 0.6 (inches)."); return; }
      if (f.start && sizeIn(f.start) == null) { status("bad", "Start size must look like .750 or 3/4 (inches)."); return; }
      var hd = opts.auth ? opts.auth() : {}, c = code();
      if (opts.needCode) { if (!c) { status("bad", "Type the crew code to search the master log."); return; } hd = { "X-Crew-Code": c }; }
      var qs = Object.keys(f).filter(function (k) { return f[k]; }).map(function (k) { return k + "=" + encodeURIComponent(f[k]); }).join("&");
      var offline = function (why) {
        var cached = get(CACHE, null);
        if (cached && cached.res) {
          status("warn", (why || "Offline.") + " Showing the last results saved on this " + (opts.needCode ? "phone" : "device") + " (" + when(cached.at) + ", " + (qText(cached.q) || "search") + "). Search again when there\u2019s signal.");
          render(cached.res, cached.q);
        } else { status("bad", (why || "Offline.") + " There are no saved results on this " + (opts.needCode ? "phone" : "device") + " yet. Search again when there\u2019s signal."); $("jl-res").innerHTML = ""; }
      };
      if (!API) { offline("The master log address isn't set."); return; }
      if (navigator.onLine === false) { offline("Offline."); return; }
      status("", "Searching\u2026"); $("jl-go").disabled = true;
      fetch(API + "/search?" + qs, { headers: hd, credentials: "omit", cache: "no-store" })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
        .then(function (x) {
          $("jl-go").disabled = false;
          if (x.r.ok && x.j.ok) {
            put(CACHE, { at: Date.now(), q: f, res: { tips: x.j.tips, runs: x.j.runs } });
            status("ok", "From the master log, " + when(Date.now()) + ". Newest first; job tips on top. Tap one to see its notes.");
            render(x.j, f);
            if (opts.needCode && $("jl-codebox")) $("jl-codebox").hidden = true;
            if (opts.canTip) flushTips(c);
          } else if (x.r.status === 401) {
            status("bad", opts.needCode ? "The crew code is wrong. Fix it and search again." : "Wrong passcode.");
            if (opts.needCode && $("jl-codebox")) $("jl-codebox").hidden = false;
          } else if (x.r.status === 404) offline("The master log can't search yet.");
          else status("bad", x.j.error || "The master log said " + x.r.status + ". Try again.");
        }).catch(function () { $("jl-go").disabled = false; offline("No signal."); });
    }
    $("jl-go").onclick = search;
    el.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.closest(".jl-grid")) { e.preventDefault(); search(); } });
    if (last && last.res && !pre.size && !pre.grade) { status("", "Last search " + when(last.at) + " (" + (qText(last.q) || "search") + "). Tap SEARCH to update it."); render(last.res, last.q); }

    /* job tips (phone) */
    if (opts.canTip) {
      flushTips();
      $("jl-add").onclick = function () {
        var box = $("jl-tipbox"), f = form(), op = get(K_OP, "") || "";
        box.hidden = false; $("jl-add").hidden = true;
        box.innerHTML = '<div class="jl-tipform"><b class="jl-h">NEW JOB TIP</b><p class="jl-sub">Something the next person running this job should know. Everyone on the crew sees it in JOB LOOKUP, on top.</p><div class="jl-grid">' +
          fld("Finish size (in)", "jt-size", f.size || pre.size, 'inputmode="decimal" placeholder=".600"') + fld("Grade", "jt-grade", f.grade || pre.grade, 'placeholder="1018"') +
          fld("Start size (in)", "jt-start", f.start || pre.start, 'inputmode="decimal" placeholder=".750"') + fld("Your name", "jt-op", op, 'maxlength="60"') + '</div>' +
          '<span class="jl-lbl">Conditions (optional)</span><div class="jl-tags">' + TAGS.map(function (t, i) { return '<button type="button" class="jl-tag" id="jt-tag-' + i + '" aria-pressed="false">' + esc(t) + '</button>'; }).join("") + '</div>' +
          '<label class="jl-f full"><span>Tip</span><textarea class="in" id="jt-tip" rows="4" maxlength="1000" placeholder="What worked, what to watch for"></textarea></label>' +
          '<div class="jl-err" id="jt-err"></div><div class="jl-btns"><button type="button" class="jl-cancel" id="jt-cancel">CANCEL</button><button type="button" class="jl-go" id="jt-save">SAVE TIP</button></div></div>';
        Array.prototype.forEach.call(box.querySelectorAll(".jl-tag"), function (b) { b.onclick = function () { var on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(on)); b.classList.toggle("on", on); }; });
        $("jt-cancel").onclick = function () { box.hidden = true; box.innerHTML = ""; $("jl-add").hidden = false; };
        $("jt-save").onclick = function () {
          var t = { id: uid(), date: today(), operator: $("jt-op").value.trim(), finish: $("jt-size").value.trim(), grade: $("jt-grade").value.trim(), start_size: $("jt-start").value.trim(),
            machine: pre.machine || "", tags: Array.prototype.filter.call(box.querySelectorAll(".jl-tag.on"), function () { return true; }).map(function (b) { return b.textContent; }), tip: $("jt-tip").value.trim() };
          var err = function (m) { $("jt-err").textContent = m; };
          if (!t.tip) return err("Type the tip.");
          if (!t.finish && !t.grade) return err("Add the finish size or the grade, so people can find it.");
          if (t.finish && sizeIn(t.finish) == null) return err("Finish size must look like .600 or 0.6 (inches).");
          if (t.start_size && sizeIn(t.start_size) == null) return err("Start size must look like .750 or 3/4 (inches).");
          if (!t.operator) return err("Type your name.");
          put(K_OP, t.operator);
          var q = queue(); q.push(t); if (!put(TIPQ, q)) return err("Couldn't save on this phone.");
          box.hidden = true; box.innerHTML = ""; $("jl-add").hidden = false;
          status("warn", "Tip saved on this phone \u2713 Sending to the master log\u2026");
          flushTips(code()).then(function (ok) {
            status(ok ? "ok" : "warn", ok ? "Tip saved to the master log \u2713 Everyone on the crew can find it now." : "Tip saved on this phone \u2713 It goes to the master log by itself when there\u2019s signal" + (get(K_CODE, "") ? "." : " and the crew code is set (type it above and search once)."));
            var c = get(CACHE, null); render(c && c.res ? c.res : { tips: [], runs: [] }, form());
          });
        };
        setTimeout(function () { try { $("jt-tip").focus(); } catch (e) {} }, 0);
      };
    }
  }
  window.JobLookup = { mount: mount, sizeIn: sizeIn, reduction: reduction, flushTips: flushTips, queue: queue };
})();
