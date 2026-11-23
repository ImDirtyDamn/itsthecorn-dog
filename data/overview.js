/* HOME tab for the Master Log: the week at a glance for the supervisor.
   Reads only (admin passcode): GET /analyze for this period and the one before it, and GET /logs/:id for the
   shifts that had downtime (for the reasons). The numbers come from the same engine as the REPORT tab
   (Report.compute), so HOME, REPORT and the PDF always agree. Tapping a shift opens it, same as the LOGS tab. */
(function (root) {
  "use strict";
  var LS = "overviewRangeV1", RANGES = [["thisweek", "THIS WEEK"], ["lastweek", "LAST WEEK"], ["last7", "7 DAYS"]];
  var TRIVIAL = /^\s*(no|none|n\/?a|-+|ok|okay|good|nothing|all good)\.?\s*$/i;

  /* ---- pure helpers (tested in node) ---- */
  function num(v) { v = +v; return isFinite(v) ? v : 0; }
  // same day, same crew, at least one Draw in common = probably the same shift sent twice (tracker + scanned sheet)
  function duplicates(logs) {
    var R = root.Report || (typeof require === "function" ? require("./report.js") : null), out = [];
    logs.forEach(function (a, i) {
      logs.slice(i + 1).forEach(function (b) {
        if (a.shift_date !== b.shift_date || R.crewName(a.operator).toLowerCase() !== R.crewName(b.operator).toLowerCase()) return;
        var da = String(a.draws || "").split(",").filter(Boolean), db = String(b.draws || "").split(",").filter(Boolean);
        var both = da.filter(function (x) { return db.indexOf(x) >= 0; });
        if (both.length) out.push({ a: a, b: b, draws: both });
      });
    });
    return out;
  }
  function maintenance(logs) {
    return logs.filter(function (l) { var m = String(l.maintenance || "").trim(); return m && !TRIVIAL.test(m); })
      .sort(function (a, b) { return a.shift_date < b.shift_date ? 1 : -1; });
  }
  var api = { duplicates: duplicates, maintenance: maintenance };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  /* ---- UI ---- */
  var C, host, range = "thisweek", busy = false, lastLogs = {};
  try { var sv = localStorage.getItem(LS); if (RANGES.some(function (r) { return r[0] === sv; })) range = sv; } catch (e) {}
  function esc(s) { return C.esc(s); }
  function pct(v) { return v === null || v === undefined || !isFinite(v) ? "\u2013" : (Math.round(v * 10) / 10).toFixed(1) + "%"; }
  function signed(v, f) { return (v >= 0 ? "+" : "\u2212") + f(Math.abs(v)); }
  function src(l) { return /^(scan|sheet)/i.test(l.id) ? "SCANNED SHEET" : "TRACKER"; }
  function card(l, extra, cls) {
    lastLogs[l.id] = l;
    var d = String(l.draws || "").split(",").filter(Boolean).map(function (x) { return '<span class="tag">D' + esc(x) + '</span>'; }).join("");
    return '<button type="button" class="logcard ovc' + (cls ? " " + cls : "") + '" data-id="' + esc(l.id) + '"><div class="lc1"><b>' + esc(l.operator) + '</b><span>' + esc(C.day(l.shift_date, true)) +
      (l.shift_label ? " \u00b7 " + esc(l.shift_label) : "") + '</span></div><div class="lc2">' + (extra.badge || "") + d + '</div>' +
      (extra.why ? '<div class="why">' + esc(extra.why) + '</div>' : "") +
      '<div class="lc3"><div><i>LBS</i><b>' + C.n0(l.total_lbs) + '</b></div><div><i>LBS/HR</i><b>' + C.n1(l.avg_lbhr) + '</b></div><div><i>GOAL/HR</i><b>' + C.n1(l.goal_lbhr) + '</b></div></div></button>';
  }
  function show(el, ctx) {
    host = el; C = ctx;
    host.innerHTML = '<div class="quick ovq">' + RANGES.map(function (r) { return '<button type="button" data-r="' + r[0] + '" class="' + (r[0] === range ? "on" : "") + '">' + r[1] + '</button>'; }).join("") +
      '<button type="button" id="ovref" class="ghost">REFRESH</button></div><div id="ovbody"><p class="muted">Loading\u2026</p></div>';
    Array.prototype.forEach.call(host.querySelectorAll("[data-r]"), function (b) { b.onclick = function () { range = b.dataset.r; try { localStorage.setItem(LS, range); } catch (e) {} show(host, C); }; });
    host.querySelector("#ovref").onclick = function () { show(host, C); };
    load();
  }
  function load() {
    if (busy) return; busy = true;
    var R = root.Report, r = R.rangeOf(range), len = Math.round((new Date(r.to) - new Date(r.from)) / 864e5) + 1;
    var pf = addDays(r.from, -len), pt = addDays(r.from, -1), A, P;
    if (range === "thisweek") { pt = addDays(pf, len - 1); }   // compare Mon..today with last Mon..same weekday
    var body = function () { return host.querySelector("#ovbody"); };
    Promise.all([C.api("/analyze?from=" + r.from + "&to=" + r.to), C.api("/analyze?from=" + pf + "&to=" + pt).catch(function () { return null; })]).then(function (x) {
      A = x[0]; P = x[1];
      var ids = (A.logs || []).filter(function (l) { return num(l.downtime_minutes) > 0; }).map(function (l) { return l.id; }).slice(-40), D = {};
      return Promise.all(ids.map(function (id) { return C.api("/logs/" + encodeURIComponent(id)).then(function (j) { D[id] = j; }, function () {}); })).then(function () { return D; });
    }).then(function (D) {
      if (!body()) return;
      render(R.compute(A, { from: r.from, to: r.to, details: D, prev: P, prevFrom: pf, prevTo: pt }), A, r, { from: pf, to: pt });
    }).catch(function (e) {
      if (e && e.message === "401") return;
      if (body()) body().innerHTML = '<div class="msg bad">Could not load: ' + esc(e && e.message === "Failed to fetch" ? "no connection to the database." : (e && e.message) || e) + '</div>';
    }).then(function () { busy = false; });
  }
  function addDays(s, n) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s), d = new Date(+m[1], +m[2] - 1, +m[3] + n); return d.getFullYear() + "-" + (d.getMonth() < 9 ? "0" : "") + (d.getMonth() + 1) + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate(); }
  function render(M, A, r, pr) {
    var S = M.shop, P = M.prev, logs = A.logs || [], h = "";
    lastLogs = {};
    h += '<p class="snote">' + esc(C.day(r.from, true)) + " \u2013 " + esc(C.day(r.to, true)) + (P ? " \u00b7 compared with " + esc(C.day(pr.from, true)) + " \u2013 " + esc(C.day(pr.to, true)) : "") + '</p>';
    if (!logs.length) { host.querySelector("#ovbody").innerHTML = h + '<div class="msg">No shifts logged in this period yet.</div>'; return; }
    var even = P && !M.uneven;
    var perCh = P && P.perShift ? (S.perShift - P.perShift) / P.perShift * 100 : null, rateCh = P && P.lbhr !== null && S.lbhr !== null ? S.lbhr - P.lbhr : null;
    h += '<div class="stats">' +
      '<div class="stat"><i>Output</i><b>' + C.n0(S.lbs) + '</b><small>' + (P ? (even ? signed((S.lbs - P.lbs) / P.lbs * 100, function (v) { return v.toFixed(1); }) + "% vs before" : "per shift " + signed(perCh, function (v) { return v.toFixed(1); }) + "% vs before") : "lbs") + '</small></div>' +
      '<div class="stat"><i>Avg lbs/hr</i><b>' + C.n0(S.lbhr) + '</b><small>' + (rateCh !== null ? signed(rateCh, C.n0) + " vs before" : "all lbs \u00f7 all hrs") + '</small></div>' +
      '<div class="stat"><i>Goal met</i><b>' + (S.rated ? S.met + " of " + S.rated : "\u2013") + '</b><small>' + (S.pct !== null ? pct(S.pct) + " of goal" : "no goals set") + (S.nogoal ? ", " + S.nogoal + " no goal" : "") + '</small></div>' +
      '<div class="stat"><i>Downtime</i><b>' + C.n1(S.downMin / 60) + ' hr</b><small>' + (M.downReasons.length ? "Top: " + esc(M.downReasons[0].label) : "none logged") + '</small></div>' +
      '<div class="stat wide"><i>Shifts</i><b>' + S.shifts + '</b><small>' + (P ? P.shifts + " in the period before" : "") + (M.uneven ? " \u00b7 different number of shifts logged, so compare per shift and lbs/hr, not totals" : "") + '</small></div></div>';

    // needs a look
    var dups = duplicates(logs), under = logs.filter(function (l) { return l.goal_met === 0; }).sort(function (a, b) { return a.shift_date < b.shift_date ? 1 : -1; }), mt = maintenance(logs);
    var nr = function (l) { return l.goal_met === 0 && !String(l.day_notes || "").trim() && !(num(l.downtime_minutes) > 0); };
    h += '<h3 class="ovh">NEEDS A LOOK</h3>';
    if (!dups.length && !under.length && !mt.length) h += '<div class="snote">Nothing flagged: no repeats, every rated shift met goal, no maintenance notes.</div>';
    dups.forEach(function (d) {
      h += '<div class="msg bad ovdup"><b>POSSIBLE DUPLICATE</b> \u00b7 ' + esc(C.day(d.a.shift_date, true)) + ", " + esc(d.a.operator) + " on Draw " + esc(d.draws.join(", Draw ")) +
        ' was sent twice. Both count in every total. Open each one and delete the copy you don\'t want.</div>' +
        card(d.a, { badge: '<span class="badge nr">COPY 1 \u00b7 ' + src(d.a) + '</span>' }) + card(d.b, { badge: '<span class="badge nr">COPY 2 \u00b7 ' + src(d.b) + '</span>' });
    });
    if (under.length) {
      h += '<div class="lbl ovl">Under goal (' + under.length + ')</div>';
      under.forEach(function (l) {
        var u = M.underList.filter(function (x) { return x.id === l.id; })[0];
        h += card(l, { badge: '<span class="badge notmet">' + (u && u.pct !== null ? Math.round(u.pct) + "% OF GOAL" : "NOT MET") + '</span>' + (nr(l) ? '<span class="badge nr">NO REASON</span>' : ""), why: nr(l) ? "" : (u ? (u.why === "(see day notes)" && u.notes ? u.notes.split("\n")[0] : u.why) : "") });
      });
    }
    if (mt.length) {
      h += '<div class="lbl ovl">Maintenance notes (' + mt.length + ')</div>';
      mt.forEach(function (l) { h += card(l, { why: String(l.maintenance).trim() }); });
    }

    // latest day
    var lastDay = logs.reduce(function (m, l) { return l.shift_date > m ? l.shift_date : m; }, ""), today = logs.filter(function (l) { return l.shift_date === lastDay; });
    h += '<h3 class="ovh">LATEST DAY \u00b7 ' + esc(C.day(lastDay, true)).toUpperCase() + '</h3>';
    today.sort(function (a, b) { return num(b.total_lbs) - num(a.total_lbs); }).forEach(function (l) {
      var b = l.goal_met === 1 ? '<span class="badge met">GOAL MET</span>' : l.goal_met === 0 ? '<span class="badge notmet">NOT MET</span>' : '<span class="badge inc">' + (num(l.goal_lbhr) > 0 || num(l.goal_lbs) > 0 ? "NOT FINISHED" : "NO GOAL SET") + '</span>';
      h += card(l, { badge: b });
    });

    // downtime reasons
    if (M.downReasons.length) {
      var top = M.downReasons.slice(0, 8), mx = top[0].v;
      h += '<h3 class="ovh">DOWNTIME BY REASON</h3><div class="panel">' + top.map(function (x) {
        return '<div class="ovbar"><div class="ovbl"><span>' + esc(x.label) + '</span><b>' + C.n1(x.v / 60) + ' hr</b></div><div class="meter"><span style="width:' + Math.max(2, x.v / mx * 100).toFixed(1) + '%"></span></div></div>';
      }).join("") + '</div>';
    }

    // by Draw
    var ms = M.machines.filter(function (m) { return m.key !== "none"; });
    if (ms.length) {
      h += '<h3 class="ovh">BY DRAW</h3><div class="tblwrap"><table class="tbl"><thead><tr><th>Draw</th><th>Lbs</th><th>Lbs/hr</th><th>% goal</th><th>Down hr</th></tr></thead><tbody>' +
        ms.map(function (m) { return '<tr><td>' + esc(m.label) + '</td><td>' + C.n0(m.lbs) + '</td><td>' + C.n0(m.lbhr) + '</td><td>' + pct(m.pct) + '</td><td>' + C.n1(m.downMin / 60) + '</td></tr>'; }).join("") +
        '</tbody></table></div><div class="snote">Lbs/hr is per machine: when one person runs Draw 1 and Draw 4 together, each machine shows its own share. % goal only counts shifts that have a goal rate.</div>';
    }
    if (S.nogoal) h += '<div class="snote" style="margin-top:12px">' + S.nogoal + ' of ' + S.shifts + ' shifts have no goal rate (mostly scanned sheets), so they are not in GOAL MET or % of goal. Add a goal with REVISIT THIS SHIFT to rate one.</div>';

    var b = host.querySelector("#ovbody"); b.innerHTML = h;
    Array.prototype.forEach.call(b.querySelectorAll(".ovc"), function (x) { x.onclick = function () { var l = lastLogs[x.dataset.id]; if (l && C.open) C.open(l); }; });
  }
  root.Overview = { show: show, duplicates: duplicates, maintenance: maintenance };
})(typeof window !== "undefined" ? window : globalThis);
