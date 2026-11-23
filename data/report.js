/* REPORT tab for the Master Log: a printable PDF the supervisor builds himself.
   Data (read only, admin passcode): GET /analyze for the range (and for the previous range of the same length),
   GET /logs/:id for downtime reasons and coil notes (capped), GET /search?shape= for job tips.
   The layout (sections on/off, order, chart type, table columns, title, range) is kept in localStorage so the
   sheet looks the same every week. The PDF is drawn here with the vendored jsPDF (data/vendor/), no CDN.
   The operator's calculator is never logged to the master log, so it is never in the report. */
(function (root) {
  "use strict";

  /* ================= sections ================= */
  var WHY = ["Tangled coil", "Scratch", "Dropped coil", "Small diameter (linear feet)", "Spin out", "Machine issue", "See downtime", "Jump strands", "Other"];
  var CH = { tiles: "Tiles", table: "Table only", bar: "Bar", line: "Line", pie: "Pie", list: "List" };
  /* pg: where a section prints. "summary" = page 1, "tables" = page 2, "appendix" = extra pages after that.
     on: on by default. Old saved layouts (v1) are swapped for this default once (see normLayout). */
  var SECTIONS = [
    { id: "kpi", pg: "summary", on: 1, title: "Summary", charts: ["tiles"], cols: [["lbs", "Output", 1], ["lbhr", "Avg lb/hr", 1], ["pct", "% of goal (rated shifts)", 1], ["down", "Downtime and running %", 1], ["coils", "Coils drawn", 1], ["shifts", "Shifts", 1], ["under", "Shifts under goal", 0], ["noreason", "Under goal, no reason", 0], ["avgcoil", "Average coil weight", 0], ["split", "Coils split", 0], ["goal", "Goal (lbs)", 0], ["util", "Running vs down %", 0]] },
    { id: "machine", pg: "tables", on: 1, title: "By Draw", charts: ["table", "bar"], tbl: 0, cols: [["shifts", "Shifts", 1], ["lbs", "Output (lbs)", 1], ["hrs", "Run hr", 1], ["lbhr", "Lb/hr", 1], ["goalrate", "Goal lb/hr", 0], ["pct", "% of goal", 1], ["down", "Down hr", 1], ["util", "Running %", 0], ["coils", "Coils", 0], ["reasons", "Top downtime reasons", 0], ["ops", "Operator time share", 0]] },
    { id: "operator", pg: "tables", on: 1, title: "By operator", charts: ["table", "bar"], tbl: 0, cols: [["shifts", "Shifts", 1], ["lbs", "Output (lbs)", 1], ["hrs", "Run hr", 1], ["lbhr", "Lb/hr", 1], ["pct", "% of goal", 1], ["met", "Goal met", 1], ["down", "Down hr", 1], ["best", "Best shift", 0], ["worst", "Worst shift", 0], ["steady", "Consistency", 0]] },
    { id: "underlist", pg: "appendix", on: 1, title: "Shifts under goal", charts: ["table"] },
    { id: "notes", pg: "appendix", on: 1, title: "Maintenance notes and job tips", charts: ["table"] },
    { id: "flags", pg: "appendix", title: "All flags", charts: ["list"] },
    { id: "compare", pg: "appendix", title: "Change vs previous period", charts: ["table", "bar"] },
    { id: "daily", pg: "appendix", title: "Daily output table", charts: ["table", "bar", "line"] },
    { id: "downreason", pg: "appendix", title: "Downtime by reason", charts: ["bar", "table", "pie"], tbl: 0 },
    { id: "downmach", pg: "appendix", title: "Downtime by Draw", charts: ["bar", "table", "pie"], tbl: 0 },
    { id: "downop", pg: "appendix", title: "Downtime by operator", charts: ["bar", "table", "pie"], tbl: 0 },
    { id: "util", pg: "appendix", title: "Running vs down time", charts: ["bar", "table", "pie"], tbl: 0 },
    { id: "under", pg: "appendix", title: "Shifts under goal, by reason", charts: ["bar", "table", "pie"], tbl: 0 },
    { id: "share", pg: "appendix", title: "Draw share of total output", charts: ["bar", "pie", "table"], tbl: 0 },
    { id: "machops", pg: "appendix", title: "Operator share of each Draw's run time", charts: ["bar", "pie", "table"], tbl: 0 },
    { id: "shift", pg: "appendix", title: "Output by shift", charts: ["table", "bar", "pie"], tbl: 0 },
    { id: "dow", pg: "appendix", title: "Output by day of week", charts: ["table", "bar", "line"], tbl: 0 },
    { id: "coils", pg: "appendix", title: "Coils and splits", charts: ["table", "pie"] },
    { id: "size", pg: "appendix", title: "Output by size and grade", charts: ["table", "bar"], tbl: 0 }
  ];
  var PAGES = [["summary", "Page 1: summary"], ["tables", "Page 2: Draws and operators"], ["appendix", "Appendix: extra pages"]];
  function pgIdx(id) { var s = BYID[id]; return s ? ["summary", "tables", "appendix"].indexOf(s.pg) : 9; }
  /* sections always print page group by page group; inside a group they keep the order picked */
  function groupSort(list) { return list.map(function (s, i) { return { s: s, i: i }; }).sort(function (a, b) { return pgIdx(a.s.id) - pgIdx(b.s.id) || a.i - b.i; }).map(function (x) { return x.s; }); }
  var BYID = {}; SECTIONS.forEach(function (s) { BYID[s.id] = s; });
  var RANGES = [["last7", "LAST 7 DAYS"], ["thisweek", "THIS WEEK"], ["lastweek", "LAST WEEK"], ["last30", "LAST 30 DAYS"], ["thismonth", "THIS MONTH"], ["lastmonth", "LAST MONTH"]];

  var LAYOUT_V = 2;
  function defaultLayout(only) {
    return { v: LAYOUT_V, title: "Production Report", plant: "Draw Room", range: "last7", sections: SECTIONS.map(function (s) {
      var cols = {}; (s.cols || []).forEach(function (c) { cols[c[0]] = !!c[2]; });
      return { id: s.id, on: only === "all" ? true : only ? only.indexOf(s.id) >= 0 : !!s.on, chart: s.charts[0], tbl: !!s.tbl, cols: cols };
    }) };
  }
  var PRESETS = [
    ["standard", "Standard weekly", null],
    ["onepage", "Summary page only", ["kpi"]],
    ["machines", "Draws focus", ["kpi", "machine", "downmach", "util", "share", "machops", "size"]],
    ["downtime", "Downtime and misses", ["kpi", "machine", "operator", "underlist", "downreason", "downmach", "downop", "under", "flags"]],
    ["operators", "Operators focus", ["kpi", "operator", "underlist", "notes", "machops", "shift"]],
    ["everything", "Everything (long)", "all"]
  ];
  function preset(id) {
    var p = PRESETS.filter(function (x) { return x[0] === id; })[0] || PRESETS[0];
    var L = defaultLayout(p[2]);
    if (Array.isArray(p[2])) { // presets also set the order inside each page group: picked sections first, in the preset's order
      var pos = {}; p[2].forEach(function (k, i) { pos[k] = i; });
      L.sections.sort(function (a, b) { var x = a.id in pos ? pos[a.id] : 100 + SECTIONS.indexOf(BYID[a.id]), y = b.id in pos ? pos[b.id] : 100 + SECTIONS.indexOf(BYID[b.id]); return x - y; });
      L.sections = groupSort(L.sections);
    }
    return L;
  }
  /* keep saved layouts working when sections are added or renamed later.
     A layout from before the v2 redesign gets the new default sections once; its title, area line and range are kept. */
  function normLayout(L, keepOld) {
    var d = defaultLayout(); if (!L || typeof L !== "object" || !Array.isArray(L.sections)) return d;
    var head = { title: typeof L.title === "string" ? L.title.slice(0, 80) : d.title, plant: typeof L.plant === "string" ? L.plant.slice(0, 80) : d.plant,
      range: RANGES.some(function (r) { return r[0] === L.range; }) || L.range === "custom" ? L.range : "last7" };
    if (!(L.v >= LAYOUT_V) && !keepOld) { d.title = head.title; d.plant = head.plant; d.range = head.range; return d; }
    var out = { v: LAYOUT_V, title: head.title, plant: head.plant, range: head.range, sections: [] }, seen = {};
    L.sections.forEach(function (s) {
      var def = s && BYID[s.id]; if (!def || seen[s.id]) return; seen[s.id] = 1;
      var cols = {}; (def.cols || []).forEach(function (c) { cols[c[0]] = s.cols && typeof s.cols[c[0]] === "boolean" ? s.cols[c[0]] : !!c[2]; });
      out.sections.push({ id: s.id, on: s.on !== false, chart: def.charts.indexOf(s.chart) >= 0 ? s.chart : def.charts[0], tbl: typeof s.tbl === "boolean" ? s.tbl : !!def.tbl, cols: cols });
    });
    d.sections.forEach(function (s) { if (!seen[s.id]) out.sections.push(s); });
    out.sections = groupSort(out.sections);
    return out;
  }

  /* ================= dates ================= */
  function ymd(d) { return d.getFullYear() + "-" + (d.getMonth() < 9 ? "0" : "") + (d.getMonth() + 1) + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate(); }
  function pd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function addDays(s, n) { var d = pd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function nDays(a, b) { return Math.round((pd(b) - pd(a)) / 864e5) + 1; }
  function rangeOf(q, today) {
    var t = today || ymd(new Date()), d = pd(t), dow = (d.getDay() + 6) % 7, mon = addDays(t, -dow);
    if (q === "thisweek") return { from: mon, to: t };
    if (q === "lastweek") return { from: addDays(mon, -7), to: addDays(mon, -1) };
    if (q === "last30") return { from: addDays(t, -29), to: t };
    if (q === "thismonth") return { from: t.slice(0, 8) + "01", to: t };
    if (q === "lastmonth") { var f = new Date(d.getFullYear(), d.getMonth() - 1, 1); return { from: ymd(f), to: ymd(new Date(d.getFullYear(), d.getMonth(), 0)) }; }
    return { from: addDays(t, -6), to: t };
  }
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dlong(s) { var d = pd(s); return d ? DOW[d.getDay()] + " " + MON3[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear() : String(s || ""); }
  function dshort(s) { var d = pd(s); return d ? MON3[d.getMonth()] + " " + d.getDate() : String(s || ""); }
  function dmid(s) { var d = pd(s); return d ? DOW[d.getDay()] + " " + MON3[d.getMonth()] + " " + d.getDate() : String(s || ""); }
  function rangeText(f, t) {
    var a = pd(f), b = pd(t); if (!a || !b) return f + " to " + t;
    return a.getFullYear() === b.getFullYear() ? dmid(f) + " to " + dmid(t) + ", " + b.getFullYear() : dlong(f) + " to " + dlong(t);
  }

  /* ================= engine (pure, tested in node) ================= */
  /* a crew is one name per person: "Oleh, Ihor", "Ihor & Oleh" and "ihor,oleh" are the same crew, shown as "Ihor, Oleh" */
  function crewName(s) {
    var t = String(s || "").trim().replace(/\s+/g, " "), ps = t.split(/\s*(?:,|&|\/|\+|\band\b)\s*/i).map(function (x) { return x.trim(); }).filter(Boolean);
    if (ps.length < 2) return t;
    var seen = {}; ps = ps.filter(function (x) { var k = x.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
    return ps.sort(function (a, b) { var x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }).join(", ");
  }
  function num(v) { v = +v; return isFinite(v) ? v : 0; }
  var TRIVIAL = /^\s*(no|none|n\/?a|-+|ok|okay|good|nothing|all good)\.?\s*$/i;
  function div(a, b) { return b > 0 ? a / b : null; }
  function canonWhy(s) { var k = String(s || "").trim().toLowerCase(); for (var i = 0; i < WHY.length; i++) if (WHY[i].toLowerCase() === k) return WHY[i]; return String(s || "").trim(); }
  /* "Under goal: Tangled coil, Scratch. typed words" -> picks + typed. Old wording still counts as its own reason. */
  function parseUnder(notes) {
    var m = /^Under goal:\s*(.*)$/m.exec(String(notes || "")); if (!m) return null;
    var s = m[1].trim(), i = s.search(/\.(\s|$)/), head = i >= 0 ? s.slice(0, i) : s, items = head.split(/,\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (items.length && items.every(function (x) { return x.length <= 40; })) return { picks: items.map(canonWhy), typed: i >= 0 ? s.slice(i + 1).trim() : "" };
    return { picks: [], typed: s };
  }
  function structReasons(u) {
    var a = null; if (Array.isArray(u)) a = u; else if (typeof u === "string" && u) { try { a = JSON.parse(u); } catch (e) { a = null; } }
    return Array.isArray(a) && a.length ? a.map(canonWhy).filter(Boolean) : null;
  }
  function noReason(l) { return l.goal_met === 0 && !String(l.day_notes || "").trim() && !(num(l.downtime_minutes) > 0); }
  var DT_RE = /^(.*?):\s*([\d.]+)\s*min down(?:,\s*(.*?))?(?:\s*\((?:\d|still)[^()]*\))?\s*$/i;
  function parseProblems(p) {
    return String(p || "").split("\n").map(function (x) { var m = DT_RE.exec(x.trim()); if (!m) return null; var dm = /draw\s*(\d+)/i.exec(m[1]);
      return { machine: m[1], draw: dm ? +dm[1] : null, minutes: +m[2], reason: (m[3] || "").trim() }; }).filter(Boolean);
  }
  function isSplit(c) { var t = String(c.tags || "").toLowerCase(), x = String(c.coils_text || ""); return /thirds?/.test(t) || x === "1/3" ? "third" : /cut in half/.test(t) || x === "1/2" ? "half" : ""; }
  function mkey(d) { return d === null || d === undefined || d === "" ? "none" : String(d); }
  function mlabel(k) { return k === "none" ? "No machine" : "Draw " + k; }
  function sortMach(a, b) { return (a.key === "none") - (b.key === "none") || (+a.key) - (+b.key); }
  function addTo(map, k, v) { map[k] = (map[k] || 0) + v; }
  function listOf(map, sortBy) { return Object.keys(map).map(function (k) { return { label: k, v: map[k] }; }).filter(function (x) { return x.v > 0; }).sort(sortBy || function (a, b) { return b.v - a.v || (a.label < b.label ? -1 : 1); }); }
  function shopOf(logs, coils) {
    var S = { shifts: logs.length, goalShifts: 0, rated: 0, met: 0, under: 0, unfinished: 0, noreason: 0, lbs: 0, hrs: 0, rlbs: 0, goal: 0, hlbs: 0, downMin: 0, coils: 0, coilLbs: 0, half: 0, third: 0, rows: 0 };
    logs.forEach(function (l) {
      var lbs = num(l.total_lbs), h = num(l.net_hours), g = num(l.goal_lbs);
      S.lbs += lbs; S.downMin += num(l.downtime_minutes);
      if (h > 0) { S.hrs += h; S.hlbs += lbs; }
      if (g > 0) { S.goal += g; S.rlbs += lbs; S.goalShifts++; }
      if (l.goal_met === 1 || l.goal_met === 0) { S.rated++; if (l.goal_met === 1) S.met++; else S.under++; } else if (g > 0) S.unfinished++;
      if (noReason(l)) S.noreason++;
    });
    (coils || []).forEach(function (c) {
      var sp = isSplit(c); S.rows++;
      if (sp === "half") S.half++; else if (sp === "third") S.third++;
      else { S.coils += num(c.coils_in) || 1; S.coilLbs += num(c.weight); }
    });
    S.lbhr = div(S.hlbs, S.hrs); S.pct = S.goal > 0 ? S.rlbs / S.goal * 100 : null; S.underPct = S.rated ? S.under / S.rated * 100 : null;
    S.util = S.hrs + S.downMin / 60 > 0 ? S.hrs / (S.hrs + S.downMin / 60) * 100 : null; S.avgCoil = div(S.coilLbs, S.coils);
    S.splitPct = S.rows ? (S.half + S.third) / S.rows * 100 : null;
    S.nogoal = S.shifts - S.goalShifts; S.perShift = div(S.lbs, S.shifts);
    return S;
  }
  /* A = /analyze answer, o = { from, to, details: {log_id: /logs/:id answer}, tips: [..] or null, prev: /analyze answer or null } */
  function compute(A, o) {
    o = o || {}; var logs = (A.logs || []).slice(), det = o.details || {};
    var coilsBy = {}, machBy = {}, downBy = {};
    (A.coils || []).forEach(function (c) { (coilsBy[c.log_id] = coilsBy[c.log_id] || []).push(c); });
    (A.machines || []).forEach(function (m) { (machBy[m.log_id] = machBy[m.log_id] || []).push(m); });
    (A.downtime || []).forEach(function (d) { (downBy[d.log_id] = downBy[d.log_id] || []).push(d); });
    var M = { from: o.from, to: o.to, days: o.from && o.to ? nDays(o.from, o.to) : null };
    M.shop = shopOf(logs, A.coils);
    var mach = {}, ops = {}, daily = {}, shift = {}, dow = {}, dReason = {}, dOp = {}, dMach = {}, uReason = {}, sizes = {}, repeatDt = {}, repeatPick = {};
    function MA(k) { return mach[k] || (mach[k] = { key: k, label: mlabel(k), shifts: 0, gShifts: 0, lbs: 0, hlbs: 0, glbs: 0, ghrs: 0, hrs: 0, goal: 0, downMin: 0, coils: 0, reasons: {}, ops: {} }); }
    var checked = 0, coilNotes = 0, dayNotes = 0, underLines = 0;
    M.underList = [];
    logs.forEach(function (l) {
      var lbs = num(l.total_lbs), h = num(l.net_hours), g = num(l.goal_lbs), dm = num(l.downtime_minutes), cs = coilsBy[l.id] || [], ms = machBy[l.id] || [];
      var pct = g > 0 ? lbs / g * 100 : null, op = crewName(l.operator) || "Unknown";
      // machines: lbs from coil rows, hours and goal from machine rows
      // a shift's lbs are its total; coil rows only say how it splits across machines (same as the Analyze tab)
      var coilSum = cs.reduce(function (a, c) { return a + num(c.weight); }, 0);
      var timed = ms.some(function (m) { return num(m.run_hours) > 0; });
      // % of goal per machine only counts lbs from machines that had a goal rate on this log (scanned sheets often have none)
      var hasGoal = {}; ms.forEach(function (m) { if (num(m.goal_lbhr) > 0 && num(m.run_hours) > 0) hasGoal[mkey(m.draw)] = 1; });
      cs.forEach(function (c) { var m = MA(mkey(c.draw)), v = coilSum > 0 ? lbs * num(c.weight) / coilSum : 0; m.lbs += v; if (timed) m.hlbs += v; if (hasGoal[mkey(c.draw)]) m.glbs += v; m.coils += isSplit(c) ? 0 : (num(c.coils_in) || 1); });
      var runSum = ms.reduce(function (a, m) { return a + num(m.run_hours); }, 0);
      // scanned sheets put the shift's one goal rate on every machine it ran (Draw 1 + Draw 4 both 2100): scale so the machines add up to the shift's goal
      var mgoal = ms.reduce(function (a, m) { return a + num(m.goal_lbhr) * num(m.run_hours); }, 0), gk = g > 0 && mgoal > 0 ? g / mgoal : 1;
      ms.forEach(function (m) { var x = MA(mkey(m.draw)); x.hrs += num(m.run_hours); x.goal += num(m.goal_lbhr) * num(m.run_hours) * gk; if (num(m.goal_lbhr) > 0) x.ghrs += num(m.run_hours); addTo(x.ops, op, num(m.run_hours)); });
      if (!(coilSum > 0) && lbs > 0) { // no coil rows (old or scanned logs): spread the shift's lbs over its machines by run time
        var dl = String(l.draws || "").split(",").filter(function (x) { return /^\d+$/.test(x); });
        if (runSum > 0) ms.forEach(function (m) { var x = MA(mkey(m.draw)), v = lbs * num(m.run_hours) / runSum; x.lbs += v; x.hlbs += v; if (hasGoal[mkey(m.draw)]) x.glbs += v; });
        else if (dl.length) dl.forEach(function (d) { MA(d).lbs += lbs / dl.length; }); else MA("none").lbs += lbs;
      }
      // downtime rows: reason from the full log when we have it, else from the "min down" lines
      var D = det[l.id], rows = D && Array.isArray(D.downtime) ? D.downtime : parseProblems(l.problems);
      if (D) checked++;
      var rsum = 0; rows.forEach(function (r) {
        var mn = num(r.minutes); if (!(mn > 0)) return; rsum += mn;
        var rs = String(r.reason || "").trim() || "No reason given"; addTo(dReason, rs, mn);
        var k = r.draw !== null && r.draw !== undefined && r.draw !== "" ? String(r.draw) : null;
        if (k) { addTo(MA(k).reasons, rs, mn); addTo(repeatDt, mlabel(k) + "|" + rs, 1); }
      });
      if (dm - rsum > 0.5) addTo(dReason, "Not broken out", dm - rsum);
      var asum = 0; (downBy[l.id] || rows).forEach(function (r) { var mn = num(r.minutes); if (!(mn > 0)) return; asum += mn; var k = mkey(r.draw); MA(k).downMin += mn; addTo(dMach, k === "none" ? "Not tied to one Draw" : mlabel(k), mn); });
      if (dm - asum > 0.5) addTo(dMach, "Not tied to one Draw", dm - asum);
      if (dm > 0) addTo(dOp, op, dm);
      // shifts per machine: every Draw the shift touched (machine rows, coil rows, or the draws list)
      var touched = {}; ms.forEach(function (m) { touched[mkey(m.draw)] = 1; }); cs.forEach(function (c) { touched[mkey(c.draw)] = 1; });
      String(l.draws || "").split(",").forEach(function (x) { if (/^\d+$/.test(x)) touched[x] = 1; });
      Object.keys(touched).forEach(function (k) { if (mach[k]) { mach[k].shifts++; if (hasGoal[k]) mach[k].gShifts++; } });
      if (D && Array.isArray(D.coils)) D.coils.forEach(function (c) { if (String(c.note || "").trim()) coilNotes++; });
      if (String(l.day_notes || "").trim()) dayNotes++;
      // operators
      var O = ops[op] || (ops[op] = { name: op, met: 0, shifts: 0, lbs: 0, hrs: 0, hlbs: 0, rlbs: 0, goal: 0, downMin: 0, under: 0, rated: 0, pcts: [], best: null, worst: null });
      O.shifts++; O.lbs += lbs; O.downMin += dm; if (h > 0) { O.hrs += h; O.hlbs += lbs; } if (g > 0) { O.goal += g; O.rlbs += lbs; }
      if (l.goal_met === 0 || l.goal_met === 1) { O.rated++; if (l.goal_met === 0) O.under++; else O.met++; }
      if (pct !== null && (l.goal_met === 0 || l.goal_met === 1)) {
        O.pcts.push(pct); var s = { date: l.shift_date, pct: pct, lbhr: div(lbs, h) };
        if (!O.best || pct > O.best.pct) O.best = s; if (!O.worst || pct < O.worst.pct) O.worst = s;
      }
      // daily, shift, day of week
      var dd = pd(l.shift_date);
      [[daily, l.shift_date], [shift, l.shift_label ? String(l.shift_label) : "No shift label"], [dow, dd ? (dd.getDay() + 6) % 7 : 7]].forEach(function (p) {
        var x = p[0][p[1]] || (p[0][p[1]] = { key: p[1], shifts: 0, gs: 0, lbs: 0, hrs: 0, hlbs: 0, rlbs: 0, goal: 0, downMin: 0, under: 0 });
        x.shifts++; x.lbs += lbs; x.downMin += dm; if (h > 0) { x.hrs += h; x.hlbs += lbs; } if (g > 0) { x.goal += g; x.rlbs += lbs; x.gs++; } if (l.goal_met === 0) x.under++;
      });
      // under goal
      var U = parseUnder(l.day_notes); if (U) underLines++;
      // the structured field (logs.under_reasons) wins; the day-notes line is the fallback for older logs
      var SR = structReasons(l.under_reasons); if (SR) U = { picks: SR, typed: U ? U.typed : "" };
      if (l.goal_met === 0) {
        var why;
        if (U && U.picks.length) { U.picks.forEach(function (p) { addTo(uReason, p, 1); addTo(repeatPick, p, 1); }); why = U.picks.join(", ") + (U.typed ? ". " + U.typed : ""); }
        else if (U) { addTo(uReason, "Typed reason only", 1); why = U.typed; }
        else if (String(l.day_notes || "").trim()) { addTo(uReason, "Day notes only, no pick", 1); why = "See day notes"; }
        else if (dm > 0) { addTo(uReason, "Downtime logged, no pick", 1); why = "Downtime: " + Math.round(dm) + " min"; }
        else { addTo(uReason, "No reason given", 1); why = "NO REASON GIVEN"; }
        var notes = String(l.day_notes || "").replace(/^Under goal:.*$/m, "").trim();
        M.underList.push({ id: l.id, date: l.shift_date, operator: op, shift: l.shift_label || "", draws: String(l.draws || "").split(",").filter(Boolean).map(function (d) { return "Draw " + d; }).join(", "), lbs: lbs, goal: g, pct: pct, why: why, notes: notes, none: noReason(l) });
      }
    });
    (A.coils || []).forEach(function (c) {
      var k = (c.finish ? String(c.finish) : "?") + "|" + (c.grade ? String(c.grade).toUpperCase() : "");
      var x = sizes[k] || (sizes[k] = { finish: c.finish || "-", grade: c.grade ? String(c.grade).toUpperCase() : "-", lbs: 0, coils: 0 });
      x.lbs += num(c.weight); x.coils += isSplit(c) ? 0 : (num(c.coils_in) || 1);
    });
    function fin(x) { x.lbhr = div(x.hlbs, x.hrs); x.pct = x.goal > 0 ? x.rlbs / x.goal * 100 : null; return x; }
    M.machines = Object.keys(mach).map(function (k) {
      var m = mach[k]; m.lbhr = div(m.hlbs, m.hrs); m.goalRate = div(m.goal, m.ghrs); m.pct = m.goal > 0 ? m.glbs / m.goal * 100 : null;
      m.util = m.hrs + m.downMin / 60 > 0 ? m.hrs / (m.hrs + m.downMin / 60) * 100 : null;
      m.reasonList = listOf(m.reasons); var oh = 0; Object.keys(m.ops).forEach(function (n) { oh += m.ops[n]; });
      m.opList = listOf(m.ops).map(function (x) { return { label: x.label, v: x.v, share: oh > 0 ? x.v / oh * 100 : 0 }; });
      return m;
    }).filter(function (m) { return m.lbs > 0 || m.hrs > 0 || m.downMin > 0; }).sort(sortMach);
    var tl = M.machines.reduce(function (a, m) { return a + m.lbs; }, 0);
    M.machines.forEach(function (m) { m.share = tl > 0 ? m.lbs / tl * 100 : 0; });
    M.ops = Object.keys(ops).map(function (k) {
      var O = fin(ops[k]); var n = O.pcts.length, mean = n ? O.pcts.reduce(function (a, b) { return a + b; }, 0) / n : 0;
      O.sd = n > 1 ? Math.sqrt(O.pcts.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1)) : null;
      O.steady = n === 0 ? "No goal" : O.sd === null ? "One shift" : O.sd < 5 ? "Steady" : O.sd < 12 ? "Some swing" : "Swings a lot";
      return O;
    }).sort(function (a, b) { return b.lbs - a.lbs; });
    M.daily = Object.keys(daily).sort().map(function (k) { return fin(daily[k]); });
    M.shifts = Object.keys(shift).sort().map(function (k) { return fin(shift[k]); });
    M.dow = Object.keys(dow).sort().map(function (k) { var x = fin(dow[k]); x.label = k === "7" ? "No date" : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][+k]; return x; });
    M.downReasons = listOf(dReason); M.downOps = listOf(dOp); M.downMach = listOf(dMach);
    var order = WHY.concat(["Typed reason only", "Day notes only, no pick", "Downtime logged, no pick", "No reason given"]);
    M.underReasons = listOf(uReason, function (a, b) { return b.v - a.v || ((order.indexOf(a.label) + 1 || 99) - (order.indexOf(b.label) + 1 || 99)); });
    M.underList.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.operator < b.operator ? -1 : 1; });
    var sz = Object.keys(sizes).map(function (k) { return sizes[k]; }).sort(function (a, b) { return b.lbs - a.lbs; }), szt = sz.reduce(function (a, x) { return a + x.lbs; }, 0);
    sz.forEach(function (x) { x.share = szt > 0 ? x.lbs / szt * 100 : 0; });
    if (sz.length > 15) { var rest = sz.slice(14); sz = sz.slice(0, 14); sz.push({ finish: "All others (" + rest.length + ")", grade: "", lbs: rest.reduce(function (a, x) { return a + x.lbs; }, 0), coils: rest.reduce(function (a, x) { return a + x.coils; }, 0), share: rest.reduce(function (a, x) { return a + x.share; }, 0) }); }
    M.sizes = sz;
    var tips = o.tips ? o.tips.filter(function (t) { return t.date >= o.from && t.date <= o.to; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }) : null;
    M.notes = { dayNotes: dayNotes, underLines: underLines, coilNotes: coilNotes, checked: checked, total: logs.length, tips: tips, capped: !!(o.tips && o.tips.capped) };
    // flags
    var F = [];
    M.underList.filter(function (u) { return u.none; }).forEach(function (u) { F.push({ t: "Under goal with no reason: " + dmid(u.date) + ", " + u.operator + (u.shift ? " (" + u.shift + " shift)" : "") + (u.pct !== null ? ", " + Math.round(u.pct) + "% of goal" : "") + "." }); });
    Object.keys(repeatDt).sort().forEach(function (k) { if (repeatDt[k] >= 3) { var p = k.split("|"); F.push({ t: "Repeat downtime: " + p[1] + " on " + p[0] + ", " + repeatDt[k] + " times." }); } });
    Object.keys(repeatPick).sort().forEach(function (k) { if (repeatPick[k] >= 3) F.push({ t: "Repeat under-goal reason: " + k + " on " + repeatPick[k] + " shifts." }); });
    M.ops.forEach(function (O) { if (O.under >= 3) F.push({ t: O.name + " was under goal on " + O.under + " of " + O.rated + " rated shifts." }); });
    M.machines.forEach(function (m) { if (m.pct !== null && m.pct < 90 && m.hrs >= 8) F.push({ t: m.label + " ran at " + f1(m.pct) + "% of goal (under 90%)." }); });
    if (M.shop.unfinished) F.push({ t: M.shop.unfinished + " shift" + (M.shop.unfinished === 1 ? " was" : "s were") + " sent before the shift was done (not rated)." });
    M.maint = logs.filter(function (l) { var m = String(l.maintenance || "").trim(); return m && !TRIVIAL.test(m); }).map(function (l) {
      return { id: l.id, date: l.shift_date, operator: crewName(l.operator) || "Unknown", draws: String(l.draws || "").split(",").filter(Boolean).map(function (d) { return "Draw " + d; }).join(", "), text: String(l.maintenance).trim() }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    M.dups = [];
    var seenDup = {}; logs.forEach(function (a, i) { logs.slice(i + 1).forEach(function (b) {
      if (a.shift_date !== b.shift_date || crewName(a.operator).toLowerCase() !== crewName(b.operator).toLowerCase()) return;
      var da = String(a.draws || "").split(",").filter(Boolean), db = String(b.draws || "").split(",").filter(Boolean), both = da.filter(function (x) { return db.indexOf(x) >= 0; });
      if (!both.length) return; var k = a.id + "|" + b.id; if (seenDup[k]) return; seenDup[k] = 1;
      M.dups.push({ a: a, b: b, draws: both });
      F.push({ t: "Possible duplicate: " + dmid(a.shift_date) + ", " + (String(a.operator || "").trim() || "Unknown") + " on Draw " + both.join(", Draw ") + " was sent twice (" + f0(num(a.total_lbs)) + " lb and " + f0(num(b.total_lbs)) + " lb). Both are counted in every total. Delete one in Logs." });
    }); });
    M.flags = F;
    M.prev = o.prev && (o.prev.logs || []).length ? shopOf(o.prev.logs, o.prev.coils || []) : null;
    M.prevRange = o.prevFrom ? { from: o.prevFrom, to: o.prevTo } : null;
    M.uneven = !!(M.prev && M.prev.shifts && Math.abs(M.shop.shifts - M.prev.shifts) / Math.max(M.shop.shifts, M.prev.shifts) > 0.25);
    if (M.uneven) F.push({ t: "The previous period has " + M.prev.shifts + " shifts logged and this one has " + M.shop.shifts + ", so total lbs, downtime and coils are not a fair comparison. Output per shift changed " + (M.shop.perShift >= M.prev.perShift ? "+" : "") + f1((M.shop.perShift - M.prev.perShift) / M.prev.perShift * 100) + "%." });
    return M;
  }

  /* ================= the summary (page 1 of the PDF and the top of HOME) ================= */
  /* Tiles, the comparison line, the top 3 flags and the top downtime reasons, in one place so the PDF and HOME say the same thing.
     Totals are only compared with the period before when both have about the same number of shifts logged (M.uneven is false);
     otherwise the change is per shift. Lb/hr and % of goal are rates, so they always compare. */
  function sg(v, f) { return (v >= 0 ? "+" : "-") + f(Math.abs(v)); }
  function summarize(M) {
    var S = M.shop, P = M.prev, even = !!(P && !M.uneven), tiles = {};
    function ch(a, b) { return b ? (a - b) / Math.abs(b) * 100 : null; }
    var perCh = P ? ch(S.perShift, P.perShift) : null;
    tiles.lbs = { label: "Output", value: f0(S.lbs) + " lb", sub: !P ? f0(S.perShift) + " lb per shift" : even ? sg(ch(S.lbs, P.lbs), f1) + "% vs before" : f0(S.perShift) + " lb/shift, " + sg(perCh, f1) + "% per shift", good: P ? (even ? S.lbs >= P.lbs : perCh >= 0) : null };
    tiles.lbhr = { label: "Avg lb/hr", value: f0(S.lbhr), sub: P && P.lbhr !== null && S.lbhr !== null ? sg(S.lbhr - P.lbhr, f0) + " vs before" : "all lbs / all run hours", good: P && P.lbhr !== null && S.lbhr !== null ? S.lbhr >= P.lbhr : null };
    tiles.pct = { label: "% of goal", value: S.pct !== null ? fp(S.pct) : "no goal", sub: S.goalShifts + " of " + S.shifts + " shifts rated" + (S.rated ? " (" + S.met + " met, " + S.under + " under)" : ""), good: S.pct !== null ? S.pct >= 100 : null };
    tiles.down = { label: "Downtime", value: fh(S.downMin) + " hr", sub: (S.util !== null ? fp(S.util) + " running" : "no run hours") + (even ? ", " + sg((S.downMin - P.downMin) / 60, f1) + " hr" : ""), good: even ? S.downMin <= P.downMin : null };
    tiles.coils = { label: "Coils drawn", value: f0(S.coils), sub: S.avgCoil !== null ? "avg " + f0(S.avgCoil) + " lb per coil" : "full coils", good: null };
    tiles.shifts = { label: "Shifts", value: f0(S.shifts), sub: P ? P.shifts + " the period before" + (M.uneven ? " (not comparable)" : "") : "none the period before", good: null };
    tiles.under = { label: "Under goal", value: f0(S.under), sub: "of " + S.rated + " rated shifts", good: null };
    tiles.noreason = { label: "Under goal, no reason", value: f0(S.noreason), sub: S.noreason ? "see flags" : "every miss explained", good: S.noreason ? false : null };
    tiles.avgcoil = { label: "Avg coil weight", value: f0(S.avgCoil) + " lb", sub: "full coils", good: null };
    tiles.split = { label: "Coils split", value: f0(S.half + S.third), sub: S.half + (S.half === 1 ? " half, " : " halves, ") + S.third + (S.third === 1 ? " third" : " thirds"), good: null };
    tiles.goal = { label: "Goal", value: f0(S.goal) + " lb", sub: "for the " + S.goalShifts + " rated shift" + (S.goalShifts === 1 ? "" : "s"), good: null };
    tiles.util = { label: "Running vs down", value: fp(S.util), sub: "running share of run + down", good: null };
    // the comparison line
    var cmp;
    if (!P) cmp = { kind: "none", head: "Nothing to compare", text: M.prevRange ? "No shifts logged in the period before (" + rangeText(M.prevRange.from, M.prevRange.to) + "), so there is nothing to compare." : "No period before to compare." };
    else if (M.uneven) cmp = { kind: "uneven", head: "Previous period incomplete", text: P.shifts + " shifts logged then vs " + S.shifts + " now, so totals are not compared. Per shift, output went from " + f0(P.perShift) + " to " + f0(S.perShift) + " lb (" + sg(perCh, f1) + "%)." + (P.lbhr !== null && S.lbhr !== null ? " Lb/hr went from " + f0(P.lbhr) + " to " + f0(S.lbhr) + "." : "") };
    else cmp = { kind: "even", head: "Vs the period before", text: P.shifts + " shifts then vs " + S.shifts + " now. Output " + sg(ch(S.lbs, P.lbs), f1) + "%, lb/hr " + (P.lbhr !== null && S.lbhr !== null ? sg(S.lbhr - P.lbhr, f0) : "-") + ", % of goal " + (P.pct !== null && S.pct !== null ? sg(S.pct - P.pct, f1) + " pts" : "-") + ", downtime " + sg((S.downMin - P.downMin) / 60, f1) + " hr." };
    if (P && M.prevRange) cmp.range = rangeText(M.prevRange.from, M.prevRange.to);
    // top flags: duplicates, misses with no reason, shifts with no goal, then everything else
    var top = [];
    if (M.dups.length) top.push({ kind: "dup", title: M.dups.length === 1 ? "Possible duplicate" : M.dups.length + " possible duplicates", text: M.dups.slice(0, 2).map(function (d) { return dmid(d.a.shift_date) + ", " + (crewName(d.a.operator) || "Unknown") + " on Draw " + d.draws.join(", Draw ") + " sent twice (" + f0(num(d.a.total_lbs)) + " and " + f0(num(d.b.total_lbs)) + " lb)"; }).join("; ") + (M.dups.length > 2 ? "; and " + (M.dups.length - 2) + " more" : "") + ". Both count in every total. Delete one in Logs." });
    var nr = M.underList.filter(function (u) { return u.none; });
    if (nr.length) top.push({ kind: "noreason", title: nr.length + " under goal with no reason", text: nr.slice(0, 4).map(function (u) { return dmid(u.date) + " " + u.operator + (u.pct !== null ? " (" + Math.round(u.pct) + "%)" : ""); }).join(", ") + (nr.length > 4 ? ", and " + (nr.length - 4) + " more" : "") + "." });
    if (S.nogoal) top.push({ kind: "nogoal", title: S.nogoal + " of " + S.shifts + " shifts have no goal rate", text: "Mostly scanned sheets. They count in output and lb/hr but not in % of goal. Add a goal with Revisit This Shift to rate one." });
    var rest = M.flags.filter(function (f) { return !/^(Under goal with no reason|Possible duplicate|The previous period has)/.test(f.t); });
    rest.forEach(function (f) { top.push({ kind: "other", title: "", text: f.t }); });
    return { tiles: tiles, cmp: cmp, flags: top.slice(0, 3), moreFlags: Math.max(0, top.length - 3), allFlags: top, down: M.downReasons.slice(0, 5), moreDown: Math.max(0, M.downReasons.length - 5) };
  }

  /* ================= PDF ================= */
  var PAL = ["#2f5d8a", "#e08a2c", "#3a8f5c", "#c0504d", "#7b5ea7", "#3fa0b3", "#a89a2e", "#8c6d4f", "#d07aa8", "#6f7b86"];
  var INK = [33, 37, 41], DIM = [108, 117, 125], RULE = [206, 212, 218], HEAD = [34, 49, 63], GOOD = [58, 143, 92], BAD = [192, 80, 77], WARN = [201, 132, 30], ACC = [47, 93, 138], SOFT = [244, 246, 249];
  function rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function machColor(key) { return key === "none" || !/^\d+$/.test(key) ? "#6f7b86" : PAL[(+key - 1) % 8]; }
  /* the standard PDF fonts only have Latin-1: keep text inside it */
  function T(s) { return String(s === null || s === undefined ? "" : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/\u2192/g, "to").replace(/[^\n\x20-\x7e\xa0-\xff]/g, ""); }
  function f0(v) { return v === null || v === undefined || !isFinite(v) ? "-" : Math.round(v).toLocaleString("en-US"); }
  function f1(v) { return v === null || v === undefined || !isFinite(v) ? "-" : (Math.round(v * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function fp(v) { return v === null || v === undefined || !isFinite(v) ? "-" : f1(v) + "%"; }
  function fh(min) { return f1(min / 60); }
  function niceMax(v) { if (!(v > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p, st = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]; for (var i = 0; i < st.length; i++) if (n <= st[i] + 1e-9) return st[i] * p; return 10 * p; }
  function axisLbl(v) { return v >= 10000 ? f0(v / 1000) + "k" : v >= 1000 ? (Math.round(v / 100) / 10) + "k" : f0(v); }

  function buildPdf(M, L, info) {
    var J = root.jspdf.jsPDF, doc = new J({ unit: "pt", format: "letter", compress: true });
    var AT = root.jspdf_autotable && root.jspdf_autotable.autoTable ? function (o) { root.jspdf_autotable.autoTable(doc, o); } : function (o) { doc.autoTable(o); };
    var PW = 612, PH = 792, ML = 42, CW = PW - 2 * ML, TOP = 84, BOT = PH - 50, y = TOP, secN = 0, S = M.shop;
    doc.setProperties({ title: T(L.title + " " + M.from + " to " + M.to), creator: "Master Log" });
    function font(sz, st, col) { doc.setFont("helvetica", st || "normal"); doc.setFontSize(sz); doc.setTextColor.apply(doc, col || INK); }
    function page() { doc.addPage(); y = TOP; }
    function need(h) { if (y + h > BOT) page(); }
    function txt(s, x, yy, o) { doc.text(T(s), x, yy, o || {}); }
    function fit(s, w) { s = T(s); if (doc.getTextWidth(s) <= w) return s; while (s.length > 1 && doc.getTextWidth(s + "...") > w) s = s.slice(0, -1); return s + "..."; }
    function head(title, sub) {
      secN++; font(13, "bold", HEAD); txt(title, ML, y + 13);
      if (sub) { font(8.5, "normal", DIM); txt(fit(sub, CW / 2), ML + CW, y + 13, { align: "right" }); }
      doc.setDrawColor.apply(doc, ACC); doc.setLineWidth(1.4); doc.line(ML, y + 19, ML + CW, y + 19);
      y += 30;
    }
    /* small heading inside a section (or a column of one) */
    function sub(title, x, w, right) {
      font(9, "bold", HEAD); txt(title.toUpperCase(), x, y + 9);
      if (right) { font(8, "normal", DIM); txt(right, x + w, y + 9, { align: "right" }); }
      doc.setDrawColor.apply(doc, RULE); doc.setLineWidth(0.7); doc.line(x, y + 13, x + w, y + 13);
    }
    function wrap(s, w, max) { var ln = doc.splitTextToSize(T(s), w); if (max && ln.length > max) { ln = ln.slice(0, max); ln[max - 1] = fit(ln[max - 1] + " ...", w); } return ln; }
    function empty(msg) { need(22); font(9, "italic", DIM); txt(msg || "Nothing logged for this in the range.", ML + 4, y + 8); y += 22; }
    function note(s) { font(8, "normal", DIM); var ln = doc.splitTextToSize(T(s), CW - 8); need(ln.length * 10 + 4); doc.text(ln, ML + 4, y + 7); y += ln.length * 10 + 6; }
    function table(cols, rows, o) {
      o = o || {}; var cs = {}, fs = o.fs || 9;
      // short cells (numbers, names, dates) never wrap; long text columns take what is left
      doc.setFont("helvetica", "normal"); doc.setFontSize(fs);
      var mins = cols.map(function (c, i) { if (c.w) return 0; var w = doc.getTextWidth(T(c.h)) * 1.08; rows.forEach(function (r, ri) { var t = T(r[i]); if (o.bold && o.bold(ri)) { doc.setFont("helvetica", "bold"); w = Math.max(w, doc.getTextWidth(t) * 1.06); doc.setFont("helvetica", "normal"); } else w = Math.max(w, doc.getTextWidth(t)); }); w += 13; return w > 130 ? 0 : w; });
      var sum = mins.reduce(function (a, b) { return a + b; }, 0) + cols.reduce(function (a, c) { return a + (c.w || 0); }, 0), k = sum > CW * 0.95 ? CW * 0.95 / sum : 1;
      cols.forEach(function (c, i) { cs[i] = { halign: c.r ? "right" : "left" }; if (c.w) cs[i].cellWidth = c.w; else if (mins[i]) cs[i].minCellWidth = mins[i] * k; });
      need(44);
      AT({ startY: y, head: [cols.map(function (c) { return T(c.h); })], body: rows.map(function (r) { return r.map(T); }), theme: "plain",
        margin: { left: ML, right: ML, top: TOP, bottom: PH - BOT }, tableWidth: CW, rowPageBreak: "avoid", showHead: "everyPage",
        styles: { font: "helvetica", fontSize: fs, cellPadding: { top: o.pad || 4.2, bottom: o.pad || 4.2, left: 6, right: 6 }, textColor: INK, overflow: "linebreak", valign: "middle" },
        headStyles: { fillColor: HEAD, textColor: [255, 255, 255], fontStyle: "bold", fontSize: fs - 0.4 },
        alternateRowStyles: { fillColor: SOFT }, columnStyles: cs,
        didParseCell: function (d) { if (d.section === "head") d.cell.styles.halign = cols[d.column.index].r ? "right" : "left";
          if (d.section === "body" && o.bold && o.bold(d.row.index)) { d.cell.styles.fontStyle = "bold"; d.cell.styles.fillColor = [226, 232, 239]; }
          if (d.section === "body" && o.dim && o.dim(d.row.index, d.column.index)) d.cell.styles.textColor = DIM;
          if (d.section === "body" && o.flag && o.flag(d.row.index, d.column.index)) { d.cell.styles.textColor = BAD; d.cell.styles.fontStyle = "bold"; } },
        didDrawCell: function (d) { if (d.section !== "body") return; doc.setDrawColor(222, 226, 230); doc.setLineWidth(0.5); doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height); } });
      y = doc.lastAutoTable.finalY + 12;
    }
    function legend(items, x, yy) { font(8, "normal", INK); items.forEach(function (it) { doc.setFillColor.apply(doc, rgb(it.c)); doc.rect(x, yy - 6.5, 8, 8, "F"); txt(it.l, x + 12, yy); x += 12 + doc.getTextWidth(T(it.l)) + 14; }); }
    /* horizontal bars: items {label, v, txt, c} */
    function hbar(items, o) {
      o = o || {}; if (!items.length) return empty();
      var lw = o.lw || 150, vw = 112, bw = CW - lw - vw - 8, mx = o.max || Math.max.apply(null, items.map(function (i) { return i.v; }));
      font(8.8, "normal", INK);
      var LN = items.map(function (it) { return wrap(it.label, lw - 10, 3); }), H = LN.map(function (ln) { return Math.max(18, ln.length * 10.4 + 7.6); });
      need(Math.min(200, H.reduce(function (a, b) { return a + b; }, 0)) + (o.ref ? 12 : 0));
      if (o.ref && mx > 0) { var rx0 = ML + lw + bw * Math.min(1, o.ref / mx); font(7.5, "normal", DIM); txt(o.refLbl || "goal", rx0, y + 7, { align: "center" }); y += 10; }
      items.forEach(function (it, i) {
        need(H[i]); var h = H[i], ln = LN[i], ty = y + h / 2 - (ln.length - 1) * 5.2 + 3.2;
        font(8.8, "normal", INK); doc.text(ln, ML + lw - 8, ty, { align: "right" });
        var bh = 11, by = y + h / 2 - bh / 2;
        doc.setFillColor(238, 241, 244); doc.rect(ML + lw, by, bw, bh, "F");
        var w = mx > 0 ? Math.max(0, Math.min(1, it.v / mx)) * bw : 0; doc.setFillColor.apply(doc, rgb(it.c || PAL[0])); if (w > 0) doc.rect(ML + lw, by, w, bh, "F");
        font(8.8, "bold", INK); txt(it.txt, ML + lw + bw + 8, by + 8.6);
        if (o.ref && mx > 0) { var rx = ML + lw + bw * Math.min(1, o.ref / mx); doc.setDrawColor(60, 60, 60); doc.setLineWidth(0.8); doc.setLineDashPattern([2, 2], 0); doc.line(rx, y, rx, y + h); doc.setLineDashPattern([], 0); }
        y += h;
      });
      y += 10;
    }
    /* stacked bars: rows {label, parts:[{v, c}]}, all rows are 100% wide */
    function stack(rows, leg) {
      if (!rows.length) return empty();
      var rowH = 19, lw = 110, bw = CW - lw - 4, h = rows.length * rowH + 22; need(h);
      legend(leg, ML + lw, y + 8); var y0 = y + 16;
      rows.forEach(function (r, i) {
        var yy = y0 + i * rowH, tot = r.parts.reduce(function (a, p) { return a + p.v; }, 0), x = ML + lw;
        font(8.6, r.bold ? "bold" : "normal", INK); txt(fit(r.label, lw - 8), ML + lw - 8, yy + 12, { align: "right" });
        r.parts.forEach(function (p) { var w = tot > 0 ? p.v / tot * bw : 0; if (w <= 0) return; doc.setFillColor.apply(doc, rgb(p.c)); doc.rect(x, yy + 2.5, w, rowH - 6, "F");
          var pc = tot > 0 ? Math.round(p.v / tot * 100) : 0; if (w > 26) { font(7.5, "bold", [255, 255, 255]); txt(pc + "%", x + w / 2, yy + 12, { align: "center" }); } x += w; });
      });
      y += h + 8;
    }
    function pie(items, o) {
      o = o || {}; items = items.filter(function (i) { return i.v > 0; }); if (!items.length) return empty();
      if (items.length > 9) { var rest = items.slice(8), rv = rest.reduce(function (a, x) { return a + x.v; }, 0); items = items.slice(0, 8).concat([{ label: "All others", v: rv, txt: o.fmt ? o.fmt(rv) : "", c: "#adb5bd" }]); }
      var r = o.r || 72, h = Math.max(2 * r + 16, items.length * 16 + 16); need(h);
      var cx = ML + r + 14, cy = y + h / 2; items = slices(items, cx, cy, r);
      var lx = ML + 2 * r + 50, ly = cy - items.length * 16 / 2 + 10;
      items.forEach(function (it, i) {
        var yy = ly + i * 16; doc.setFillColor.apply(doc, rgb(it.c)); doc.rect(lx, yy - 7.5, 9, 9, "F");
        font(9, "normal", INK); txt(fit(it.label, 160), lx + 15, yy); font(9, "bold", INK); txt(it.txt || "", lx + 250, yy, { align: "right" }); font(9, "normal", DIM); txt(f1(it.p) + "%", lx + 300, yy, { align: "right" });
      });
      y += h + 10;
    }
    function slices(items, cx, cy, r) {
      var tot = items.reduce(function (a, i) { return a + i.v; }, 0), a0 = -Math.PI / 2, live = items.filter(function (i) { return i.v > 0; });
      live.forEach(function (it) {
        var a1 = a0 + it.v / tot * 2 * Math.PI, pts = [[cx, cy]], steps = Math.max(2, Math.ceil((a1 - a0) / 0.05));
        for (var k = 0; k <= steps; k++) { var a = a0 + (a1 - a0) * k / steps; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
        var seg = []; for (var j = 1; j < pts.length; j++) seg.push([pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]]);
        doc.setFillColor.apply(doc, rgb(it.c)); doc.setDrawColor(255, 255, 255); doc.setLineWidth(1.2); doc.lines(seg, cx, cy, [1, 1], live.length > 1 ? "FD" : "F", true);
        it.a = (a0 + a1) / 2; it.p = it.v / tot * 100; a0 = a1;
      });
      live.forEach(function (it) { if (it.p >= 6) { var rr = live.length === 1 ? 0 : r * 0.62; font(r < 50 ? 7.5 : 8, "bold", [255, 255, 255]); txt(Math.round(it.p) + "%", cx + rr * Math.cos(it.a), cy + rr * Math.sin(it.a) + 3, { align: "center" }); } });
      return live;
    }
    /* small pies, three to a row, one shared legend */
    function minis(groups, leg) {
      if (!groups.length) return empty();
      var per = 3, cw = CW / per, r = 38, rowH = 2 * r + 34;
      need(18 + rowH); legend(leg, ML + 4, y + 8); y += 18;
      for (var i = 0; i < groups.length; i += per) {
        need(rowH);
        groups.slice(i, i + per).forEach(function (g, j) {
          var cx = ML + cw * j + cw / 2; font(9, "bold", HEAD); txt(g.title, cx, y + 9, { align: "center" }); font(7.5, "normal", DIM); txt(g.sub, cx, y + 19, { align: "center" });
          slices(g.items, cx, y + 26 + r, r);
        });
        y += rowH;
      }
      y += 6;
    }
    /* trend: points {label, v, g (goal or null)}; kind "line" or "bar" */
    function trend(pts, kind, o) {
      o = o || {}; if (!pts.length) return empty();
      var h = o.h || 178, x0 = ML + 44, w = CW - 52, ph = h - 46 - (o.subs ? 10 : 0); need(h); var top = y + 18;
      var mx = niceMax(Math.max.apply(null, pts.map(function (p) { return Math.max(p.v || 0, p.g || 0); })) * 1.08);
      if (o.leg) legend(o.leg, x0, y + 8);
      for (var k = 0; k <= 4; k++) { var yy = top + ph - ph * k / 4; doc.setDrawColor(228, 231, 235); doc.setLineWidth(0.5); doc.line(x0, yy, x0 + w, yy); font(7.5, "normal", DIM); txt(axisLbl(mx * k / 4), x0 - 5, yy + 2.5, { align: "right" }); }
      var n = pts.length, step = w / n, every = Math.ceil(n / 16);
      function X(i) { return x0 + step * (i + 0.5); } function Y(v) { return top + ph - ph * Math.max(0, v) / mx; }
      if (kind === "bar") {
        var bw = Math.min(34, step * 0.62);
        pts.forEach(function (p, i) { doc.setFillColor.apply(doc, rgb(PAL[0])); doc.rect(X(i) - bw / 2, Y(p.v), bw, top + ph - Y(p.v), "F");
          if (p.g) { doc.setDrawColor(33, 37, 41); doc.setLineWidth(1.4); doc.line(X(i) - bw / 2 - 3, Y(p.g), X(i) + bw / 2 + 3, Y(p.g)); }
          if (n <= 16) { font(n <= 9 ? 8 : 7, "bold", INK); txt(axisLbl(p.v), X(i), Math.min(Y(p.v), p.g ? Y(p.g) : 1e9) - 4, { align: "center" }); } });
      } else {
        doc.setDrawColor(120, 120, 120); doc.setLineWidth(1); doc.setLineDashPattern([3, 2], 0);
        for (var i = 1; i < n; i++) if (pts[i].g && pts[i - 1].g) doc.line(X(i - 1), Y(pts[i - 1].g), X(i), Y(pts[i].g));
        doc.setLineDashPattern([], 0);
        doc.setDrawColor.apply(doc, rgb(PAL[0])); doc.setLineWidth(1.8);
        for (var j = 1; j < n; j++) doc.line(X(j - 1), Y(pts[j - 1].v), X(j), Y(pts[j].v));
        pts.forEach(function (p, i) { doc.setFillColor.apply(doc, rgb(PAL[0])); doc.circle(X(i), Y(p.v), 2.6, "F"); if (n <= 12) { font(7, "bold", INK); txt(axisLbl(p.v), X(i), Y(p.v) - 6, { align: "center" }); } });
      }
      doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.7); doc.line(x0, top + ph, x0 + w, top + ph);
      pts.forEach(function (p, i) { if (i % every) return; font(7.8, "bold", INK); txt(p.label, X(i), top + ph + 12, { align: "center" }); if (o.subs && p.sub) { font(7, "normal", DIM); txt(p.sub, X(i), top + ph + 21.5, { align: "center" }); } });
      y += h + 6;
    }
    function on(sec, col) { return !sec.cols || sec.cols[col] !== false; }
    function groupTable(G) {
      table([{ h: "" }, { h: "Shifts", r: 1 }, { h: "Output (lbs)", r: 1 }, { h: "Lbs/hr", r: 1 }, { h: "% of goal", r: 1 }, { h: "Downtime (hrs)", r: 1 }, { h: "Under goal", r: 1 }],
        G.map(function (g) { var x = g.x; return [g.label, f0(x.shifts), f0(x.lbs), f0(x.lbhr), fp(x.pct), fh(x.downMin), f0(x.under)]; }));
    }
    function groupSec(sec, G) {
      if (!G.length) return empty();
      if (sec.chart === "bar") hbar(G.map(function (g) { return { label: g.label, v: g.x.lbs, txt: f0(g.x.lbs) + " lb  " + fp(g.x.pct), c: PAL[0] }; }), { lw: 90 });
      else if (sec.chart === "pie") pie(G.map(function (g, i) { return { label: g.label, v: g.x.lbs, txt: f0(g.x.lbs) + " lb", c: PAL[i % PAL.length] }; }));
      if (sec.chart === "table" || sec.tbl) groupTable(G);
    }
    function distSec(sec, list, kh, unit, colorOf) {
      if (!list.length) return empty();
      var tot = list.reduce(function (a, x) { return a + x.v; }, 0), fmt = unit === "min" ? function (v) { return fh(v) + " hr"; } : function (v) { return f0(v) + (v === 1 ? " shift" : " shifts"); };
      if (sec.chart === "bar") hbar(list.map(function (x) { return { label: x.label, v: x.v, txt: fmt(x.v) + (unit === "min" ? "  " + Math.round(x.v / tot * 100) + "%" : ""), c: (colorOf && colorOf(x.label)) || PAL[0] }; }));
      else if (sec.chart === "pie") pie(list.map(function (x, i) { return { label: x.label, v: x.v, txt: fmt(x.v), c: (colorOf && colorOf(x.label)) || PAL[i % PAL.length] }; }), { fmt: fmt });
      if (sec.chart === "table" || sec.tbl) table([{ h: kh }, { h: unit === "min" ? "Hours" : "Shifts", r: 1 }, { h: "Share", r: 1 }], list.map(function (x) { return [x.label, unit === "min" ? fh(x.v) : f0(x.v), fp(x.v / tot * 100)]; }));
    }

    /* ---------- the sections, always drawn the same way ---------- */
    var DRAW = {
      /* page 1: tiles, the comparison line, needs a look + top downtime side by side, daily output */
      kpi: function (sec) {
        var Z = summarize(M), items = [];
        BYID.kpi.cols.forEach(function (c) { if (on(sec, c[0])) items.push(Z.tiles[c[0]]); });
        if (items.length) {
          var per = items.length % 4 === 0 && items.length % 3 !== 0 ? 4 : 3, gap = 10, tw = (CW - gap * (per - 1)) / per, th = 66;
          for (var i = 0; i < items.length; i += per) {
            need(th + gap);
            items.slice(i, i + per).forEach(function (it, j) {
              var x = ML + j * (tw + gap); doc.setFillColor.apply(doc, SOFT); doc.rect(x, y, tw, th, "F");
              doc.setFillColor.apply(doc, it.good === true ? GOOD : it.good === false ? BAD : ACC); doc.rect(x, y, 3.5, th, "F");
              font(7.6, "bold", DIM); txt(it.label.toUpperCase(), x + 12, y + 14);
              font(20, "bold", INK); txt(fit(it.value, tw - 20), x + 12, y + 37);
              font(7.8, "normal", DIM); doc.text(wrap(it.sub, tw - 20, 2), x + 12, y + 50);
            });
            y += th + gap;
          }
        }
        // the comparison with the period before
        font(8.8, "normal", INK); var cl = wrap(Z.cmp.text, CW - 24), ch = cl.length * 11 + 22; need(ch + 8);
        doc.setFillColor.apply(doc, Z.cmp.kind === "uneven" ? [253, 246, 232] : SOFT); doc.rect(ML, y, CW, ch, "F");
        doc.setFillColor.apply(doc, Z.cmp.kind === "uneven" ? WARN : ACC); doc.rect(ML, y, 3.5, ch, "F");
        font(7.6, "bold", Z.cmp.kind === "uneven" ? WARN : DIM); txt((Z.cmp.head + (Z.cmp.range ? " (" + Z.cmp.range + ")" : "")).toUpperCase(), ML + 12, y + 12);
        font(8.8, "normal", INK); doc.text(cl, ML + 12, y + 24); y += ch + 14;
        // two columns: what needs a look, and where the downtime went
        var gap2 = 20, cw2 = (CW - gap2) / 2, xL = ML, xR = ML + cw2 + gap2, y0 = y, yl, yr;
        // left
        sub("Needs a look", xL, cw2, Z.allFlags.length ? Z.allFlags.length + " flag" + (Z.allFlags.length === 1 ? "" : "s") : ""); yl = y0 + 22;
        if (!Z.flags.length) { font(9, "normal", GOOD); doc.text(wrap("Nothing flagged. No repeats, every miss has a reason, every shift has a goal.", cw2 - 4), xL, yl + 8); yl += 26; }
        Z.flags.forEach(function (f) {
          var col = f.kind === "dup" || f.kind === "noreason" ? BAD : f.kind === "nogoal" ? WARN : DIM;
          doc.setFillColor.apply(doc, col); doc.rect(xL, yl + 1.5, 6, 6, "F");
          var tl = f.title ? (font(9, "bold", INK), wrap(f.title, cw2 - 14)) : [];
          if (tl.length) { font(9, "bold", INK); doc.text(tl, xL + 12, yl + 7.5); yl += tl.length * 11; }
          font(8.4, "normal", f.title ? DIM : INK); var bl = wrap(f.text, cw2 - 14, 5); doc.text(bl, xL + 12, yl + (tl.length ? 6.5 : 7.5)); yl += bl.length * 10.2 + 10;
        });
        if (Z.moreFlags) { font(8, "italic", DIM); txt("+" + Z.moreFlags + " more: turn on All flags in the appendix.", xL + 12, yl + 4); yl += 14; }
        // right
        sub("Top downtime", xR, cw2, S.downMin > 0 ? fh(S.downMin) + " hr total" : ""); yr = y0 + 22;
        if (!Z.down.length) { font(9, "normal", DIM); txt("No downtime logged.", xR, yr + 8); yr += 22; }
        var dmax = Z.down.length ? Z.down[0].v : 1;
        Z.down.forEach(function (d, k) {
          var grey = d.label === "Not broken out" || d.label === "No reason given";
          font(9, "bold", DIM); txt((k + 1) + ".", xR, yr + 8);
          font(9, "bold", grey ? DIM : INK); var ll = wrap(grey && d.label === "Not broken out" ? "No reason written (logged as a shift total)" : d.label, cw2 - 86, 3); doc.text(ll, xR + 14, yr + 8);
          font(9, "bold", INK); txt(fh(d.v) + " hr", xR + cw2, yr + 8, { align: "right" }); font(7.6, "normal", DIM); txt(Math.round(d.v / S.downMin * 100) + "% of downtime", xR + cw2, yr + 18, { align: "right" });
          var by = yr + Math.max(ll.length * 10.4, 12) + 1; doc.setFillColor(238, 241, 244); doc.rect(xR + 14, by, cw2 - 86, 4, "F"); doc.setFillColor.apply(doc, grey ? [173, 181, 189] : BAD); doc.rect(xR + 14, by, (cw2 - 86) * d.v / dmax, 4, "F");
          yr = by + 14;
        });
        if (Z.moreDown) { font(8, "italic", DIM); txt("+" + Z.moreDown + " more: turn on Downtime by reason in the appendix.", xR + 14, yr + 2); yr += 12; }
        y = Math.max(yl, yr) + 8;
        // daily output
        if (M.daily.length) {
          var hh = 196; if (y + 24 + hh > BOT) hh = Math.max(140, BOT - y - 26);
          need(24 + hh); sub("Daily output", ML, CW, M.daily.length + " day" + (M.daily.length === 1 ? "" : "s") + " with logs"); y += 20;
          var anyG = M.daily.some(function (d) { return d.gs && d.gs === d.shifts; });
          trend(M.daily.map(function (d) { var dd = pd(d.key); return { label: M.daily.length <= 10 && dd ? DOW[dd.getDay()] + " " + (dd.getMonth() + 1) + "/" + dd.getDate() : dshort(d.key), v: d.lbs, g: d.gs && d.gs === d.shifts ? d.goal : null, sub: d.shifts + " shift" + (d.shifts === 1 ? "" : "s") }; }), "bar",
            { h: hh, subs: M.daily.length <= 16, leg: [{ l: "Output (lbs)", c: PAL[0] }].concat(anyG ? [{ l: "Goal (black tick, only on days where every shift had a goal)", c: "#212529" }] : []) });
        }
      },
      compare: function (sec) {
        var P = M.prev; if (!P) return empty(M.prevRange ? "No shifts were logged in the previous period (" + rangeText(M.prevRange.from, M.prevRange.to) + "), so there is nothing to compare." : "No previous period to compare.");
        var rows = [["Total output (lbs)", S.lbs, P.lbs, f0, 1], ["Output per shift (lbs)", S.perShift, P.perShift, f0, 1], ["Average lbs/hr", S.lbhr, P.lbhr, f0, 1], ["% of goal", S.pct, P.pct, f1, 1, "pts"], ["Total downtime (hrs)", S.downMin / 60, P.downMin / 60, f1, -1],
          ["Running vs down %", S.util, P.util, f1, 1, "pts"], ["Shifts logged", S.shifts, P.shifts, f0, 0], ["Shifts under goal", S.under, P.under, f0, -1], ["Under goal, no reason", S.noreason, P.noreason, f0, -1],
          ["Coils drawn", S.coils, P.coils, f0, 0], ["Average coil weight (lbs)", S.avgCoil, P.avgCoil, f0, 0]];
        note("This period: " + rangeText(M.from, M.to) + ".   Previous: " + rangeText(M.prevRange.from, M.prevRange.to) + ".");
        if (M.uneven) note("The two periods have different numbers of shifts logged (" + S.shifts + " vs " + P.shifts + "). Compare output per shift and lbs/hr, not the totals.");
        if (sec.chart === "bar") {
          var items = rows.filter(function (r) { return r[1] !== null && r[2] !== null && r[2] !== 0; }).map(function (r) {
            var ch = r[5] ? r[1] - r[2] : (r[1] - r[2]) / Math.abs(r[2]) * 100;
            return { label: r[0], v: Math.abs(ch), txt: (ch >= 0 ? "+" : "") + f1(ch) + (r[5] ? " pts" : "%"), c: r[4] === 0 || Math.abs(ch) < 0.05 ? "#6f7b86" : (ch >= 0) === (r[4] > 0) ? "#3a8f5c" : "#c0504d" }; });
          hbar(items, { lw: 160 }); note("Bar length is the size of the change (percent, or points for percentages). Green is better, red is worse, gray is neither.");
        } else {
          table([{ h: "Metric" }, { h: "This period", r: 1 }, { h: "Previous", r: 1 }, { h: "Change", r: 1 }], rows.map(function (r) {
            var ch = r[1] !== null && r[2] !== null ? r[1] - r[2] : null, pc = ch !== null && r[2] ? " (" + (ch >= 0 ? "+" : "") + f1(ch / Math.abs(r[2]) * 100) + "%)" : "";
            return [r[0], r[3](r[1]), r[3](r[2]), ch === null ? "-" : (ch >= 0 ? "+" : "") + r[3](ch) + (r[5] ? " " + r[5] : pc)]; }),
            { flag: function (ri, ci) { var r = rows[ri]; if (ci !== 3 || !r[4] || r[1] === null || r[2] === null) return false; return (r[1] - r[2]) * r[4] < -0.05; } });
        }
      },
      daily: function (sec) {
        if (!M.daily.length) return empty();
        if (sec.chart !== "table") trend(M.daily.map(function (d) { return { label: dshort(d.key), v: d.lbs, g: d.goal || null }; }), sec.chart, { leg: [{ l: "Output (lbs)", c: PAL[0] }, { l: (sec.chart === "bar" ? "Goal (black tick)" : "Goal (dashed)") + (S.goalShifts < S.shifts ? ", only the " + S.goalShifts + " of " + S.shifts + " shifts with a goal" : ""), c: "#6f7b86" }] });
        if (sec.chart === "table" || sec.tbl) table([{ h: "Day" }, { h: "Shifts", r: 1 }, { h: "Output (lbs)", r: 1 }, { h: "Goal (lbs)", r: 1 }, { h: "% of goal", r: 1 }, { h: "Lbs/hr", r: 1 }, { h: "Downtime (hrs)", r: 1 }, { h: "Under goal", r: 1 }],
          M.daily.map(function (d) { return [dmid(d.key), f0(d.shifts), f0(d.lbs), f0(d.goal), fp(d.pct), f0(d.lbhr), fh(d.downMin), f0(d.under)]; }));
      },
      machine: function (sec) {
        var ms = M.machines.filter(function (m) { return /^[1-9]$/.test(m.key); }), other = M.machines.filter(function (m) { return !/^[1-9]$/.test(m.key); });
        if (!ms.length) return empty();
        if (sec.chart === "bar") hbar(ms.filter(function (m) { return m.pct !== null; }).map(function (m) { return { label: m.label, v: m.pct, txt: fp(m.pct) + "  " + f0(m.lbhr) + " lb/hr", c: machColor(m.key) }; }),
          { max: Math.max(110, Math.max.apply(null, ms.map(function (m) { return (m.pct || 0) * 1.05; }))), ref: 100, refLbl: "100% of goal", lw: 90 });
        if (sec.chart === "table" || sec.tbl) {
          var defs = { shifts: ["Shifts", function (m) { return f0(m.shifts); }, 1], lbhr: ["Lb/hr", function (m) { return f0(m.lbhr); }, 1], goalrate: ["Goal lb/hr", function (m) { return m.goalRate ? f0(m.goalRate) : "no goal"; }, 1], lbs: ["Output (lbs)", function (m) { return f0(m.lbs); }, 1],
            pct: ["% of goal", function (m) { return m.pct !== null ? fp(m.pct) + (m.gShifts && m.gShifts < m.shifts ? " (" + m.gShifts + " of " + m.shifts + ")" : "") : "no goal"; }, 1], hrs: ["Run hr", function (m) { return f1(m.hrs); }, 1], down: ["Down hr", function (m) { return fh(m.downMin); }, 1], util: ["Running %", function (m) { return fp(m.util); }, 1],
            coils: ["Coils", function (m) { return f0(m.coils); }, 1], reasons: ["Top downtime reasons", function (m) { return m.reasonList.slice(0, 3).map(function (r) { return r.label + " (" + fh(r.v) + " hr)"; }).join("; ") || "-"; }, 0],
            ops: ["Operator time share", function (m) { return m.opList.map(function (o) { return o.label + " " + Math.round(o.share) + "%"; }).join(", ") || "-"; }, 0] };
          var C = [{ h: "Draw" }]; BYID.machine.cols.forEach(function (c) { if (on(sec, c[0])) C.push({ h: defs[c[0]][0], f: defs[c[0]][1], r: defs[c[0]][2] }); });
          function sumOf(k) { return ms.reduce(function (a, m) { return a + m[k]; }, 0); }
          var tot = { label: "All Draws", shifts: S.shifts, lbs: sumOf("lbs"), hrs: sumOf("hrs"), goal: sumOf("goal"), downMin: S.downMin, coils: S.coils, reasonList: M.downReasons.filter(function (r) { return r.label !== "Not broken out"; }), opList: [], gShifts: S.goalShifts };
          tot.lbhr = S.lbhr; tot.hrs = S.hrs; tot.goalRate = div(tot.goal, sumOf("ghrs")); tot.pct = tot.goal > 0 ? sumOf("glbs") / tot.goal * 100 : null; tot.util = S.util;
          var rows = ms.map(function (m) { return C.map(function (c) { return c.f ? c.f(m) : m.label; }); }); rows.push(C.map(function (c) { return c.f ? c.f(tot) : "All Draws"; }));
          table(C, rows, { bold: function (i) { return i === rows.length - 1; }, dim: function (r, c) { return /no goal/.test(rows[r][c]); }, fs: C.length > 8 ? 8 : 8.6, pad: 3.3 });
          var ol = other.reduce(function (a, m) { return a + m.lbs; }, 0);
          note("% of goal counts only shifts with a goal rate; (3 of 11) means 3 of that Draw's 11 shifts had one. Lb/hr is per machine, so Draws run together as a pair each show their own share." + (ol > 0 ? " " + f0(ol) + " lb not tied to one Draw are in the shop totals but not in these rows." : "") + " The All Draws row uses shift hours, so it matches the summary.");
        }
      },
      share: function (sec) {
        var it = M.machines.filter(function (m) { return m.lbs > 0 && /^[1-9]$/.test(m.key); }).map(function (m) { return { label: m.label, v: m.lbs, txt: f0(m.lbs) + " lb", c: machColor(m.key) }; });
        if (!it.length) return empty();
        var t = it.reduce(function (a, x) { return a + x.v; }, 0);
        if (sec.chart === "pie") pie(it, { fmt: function (v) { return f0(v) + " lb"; } });
        else if (sec.chart === "bar") hbar(it.map(function (x) { return { label: x.label, v: x.v, txt: f1(x.v / t * 100) + "%  " + x.txt, c: x.c }; }), { lw: 90 });
        if (sec.chart === "table" || sec.tbl) table([{ h: "Machine" }, { h: "Output (lbs)", r: 1 }, { h: "Share of total", r: 1 }], it.map(function (x) { return [x.label, f0(x.v), fp(x.v / t * 100)]; }).concat([["All Draws", f0(t), "100.0%"]]), { bold: function (i) { return i === it.length; } });
      },
      machops: function (sec) {
        var ms = M.machines.filter(function (m) { return m.opList.length && /^[1-9]$/.test(m.key); }); if (!ms.length) return empty();
        var names = []; ms.forEach(function (m) { m.opList.forEach(function (o) { if (names.indexOf(o.label) < 0) names.push(o.label); }); }); names.sort();
        function oc(n) { return PAL[names.indexOf(n) % PAL.length]; }
        if (sec.chart === "bar") stack(ms.map(function (m) { return { label: m.label, parts: names.map(function (n) { var o = m.opList.filter(function (x) { return x.label === n; })[0]; return { v: o ? o.v : 0, c: oc(n) }; }) }; }), names.map(function (n) { return { l: n, c: oc(n) }; }));
        else if (sec.chart === "pie") minis(ms.map(function (m) { return { title: m.label, sub: f1(m.hrs) + " run hrs", items: m.opList.map(function (o) { return { v: o.v, c: oc(o.label) }; }) }; }), names.map(function (n) { return { l: n, c: oc(n) }; }));
        if (sec.chart === "table" || sec.tbl) { var rows = []; ms.forEach(function (m) { m.opList.forEach(function (o, i) { rows.push([i ? "" : m.label, o.label, f1(o.v), fp(o.share)]); }); }); table([{ h: "Machine" }, { h: "Operator" }, { h: "Run hours", r: 1 }, { h: "Share of machine time", r: 1 }], rows); }
      },
      operator: function (sec) {
        if (!M.ops.length) return empty();
        if (sec.chart === "bar") hbar(M.ops.filter(function (o) { return o.pct !== null; }).map(function (o) { return { label: o.name, v: o.pct, txt: fp(o.pct) + "  " + f0(o.lbhr) + " lb/hr", c: PAL[0] }; }), { max: Math.max(110, Math.max.apply(null, M.ops.map(function (o) { return (o.pct || 0) * 1.05; }))), ref: 100, refLbl: "100% of goal" });
        if (sec.chart === "table" || sec.tbl) {
          var defs = { shifts: ["Shifts", function (o) { return f0(o.shifts); }, 1], lbs: ["Output (lbs)", function (o) { return f0(o.lbs); }, 1], hrs: ["Run hr", function (o) { return f1(o.hrs); }, 1], lbhr: ["Lb/hr", function (o) { return f0(o.lbhr); }, 1],
            pct: ["% of goal", function (o) { return o.pct !== null ? fp(o.pct) : "no goal"; }, 1], met: ["Goal met", function (o) { return o.rated ? o.met + " of " + o.rated : "no goal"; }, 1], down: ["Down hr", function (o) { return fh(o.downMin); }, 1],
            best: ["Best shift", function (o) { return o.best ? dshort(o.best.date) + ", " + Math.round(o.best.pct) + "%" : "-"; }, 0], worst: ["Worst shift", function (o) { return o.worst ? dshort(o.worst.date) + ", " + Math.round(o.worst.pct) + "%" : "-"; }, 0],
            steady: ["Consistency", function (o) { return o.steady + (o.sd !== null ? " (" + f1(o.sd) + ")" : ""); }, 0] };
          var C = [{ h: "Operator" }]; BYID.operator.cols.forEach(function (c) { if (on(sec, c[0])) C.push({ h: defs[c[0]][0], f: defs[c[0]][1], r: defs[c[0]][2] }); });
          var tot = { name: "All operators", shifts: S.shifts, lbs: S.lbs, hrs: S.hrs, lbhr: S.lbhr, pct: S.pct, met: S.met, rated: S.rated, downMin: S.downMin, best: null, worst: null, steady: "", sd: null };
          var list = M.ops.concat(M.ops.length > 1 ? [tot] : []);
          var rows = list.map(function (o) { return C.map(function (c) { return c.f ? c.f(o) : o.name; }); });
          table(C, rows, { fs: C.length > 8 ? 8 : 8.6, pad: 3.3, bold: function (i) { return M.ops.length > 1 && i === rows.length - 1; }, dim: function (r, c) { return /no goal/.test(rows[r][c]); } });
          note("Sorted by output. % of goal and Goal met count only shifts with a goal rate. A crew is one row in any name order." + (on(sec, "steady") ? " Consistency is how much % of goal moves from shift to shift (standard deviation, in points); under 5 is steady." : ""));
        }
      },
      shift: function (sec) { groupSec(sec, M.shifts.map(function (x) { return { label: x.key + (/^\d/.test(x.key) ? " shift" : ""), x: x }; })); },
      dow: function (sec) {
        var G = M.dow.map(function (x) { return { label: x.label, x: x }; });
        if (sec.chart !== "line") return groupSec(sec, G);
        if (!G.length) return empty();
        trend(M.dow.map(function (d) { return { label: d.label, v: d.lbs, g: d.goal || null }; }), "line", { leg: [{ l: "Output (lbs)", c: PAL[0] }, { l: "Goal (dashed)", c: "#6f7b86" }] });
        if (sec.tbl) groupTable(G);
      },
      downreason: function (sec) { distSec(sec, M.downReasons, "Reason", "min", function (l) { return l === "Not broken out" || l === "No reason given" ? "#adb5bd" : null; }); },
      downop: function (sec) { distSec(sec, M.downOps, "Operator", "min"); },
      downmach: function (sec) { distSec(sec, M.downMach, "Machine", "min", function (l) { var m = /^Draw (\d+)$/.exec(l); return m ? machColor(m[1]) : "#adb5bd"; }); },
      util: function (sec) {
        if (!M.machines.length && !S.hrs) return empty();
        var rows = M.machines.filter(function (m) { return /^[1-9]$/.test(m.key) && (m.hrs > 0 || m.downMin > 0); }).map(function (m) { return { label: m.label, run: m.hrs, down: m.downMin / 60 }; });
        var all = [{ label: "Whole shop", run: S.hrs, down: S.downMin / 60, bold: 1 }].concat(rows);
        if (sec.chart === "bar") stack(all.map(function (r) { return { label: r.label, bold: r.bold, parts: [{ v: r.run, c: "#3a8f5c" }, { v: r.down, c: "#c0504d" }] }; }), [{ l: "Running", c: "#3a8f5c" }, { l: "Down", c: "#c0504d" }]);
        else if (sec.chart === "pie") pie([{ label: "Running", v: S.hrs, txt: f1(S.hrs) + " hr", c: "#3a8f5c" }, { label: "Down", v: S.downMin / 60, txt: f1(S.downMin / 60) + " hr", c: "#c0504d" }]);
        if (sec.chart === "table" || sec.tbl) table([{ h: "" }, { h: "Running hrs", r: 1 }, { h: "Down hrs", r: 1 }, { h: "Running %", r: 1 }], all.map(function (r) { return [r.label, f1(r.run), f1(r.down), fp(r.run + r.down > 0 ? r.run / (r.run + r.down) * 100 : null)]; }), { bold: function (i) { return i === 0; } });
        note("Running hours are the shift hours left after breaks and downtime. Downtime not tied to one machine counts for the whole shop only.");
      },
      under: function (sec) {
        note(S.under + " of " + S.rated + " rated shifts were under goal (" + fp(S.underPct) + "). " + S.noreason + " had no reason at all. A shift with two picks counts under both.");
        distSec(sec, M.underReasons, "Reason", "shifts", function (l) { return l === "No reason given" ? "#c0504d" : /no pick|only/.test(l) ? "#adb5bd" : null; });
      },
      underlist: function () {
        if (!M.underList.length) return empty("No shifts under goal in this range.");
        table([{ h: "Day", w: 50 }, { h: "Operator", w: 80 }, { h: "Shift", w: 36 }, { h: "Draws", w: 60 }, { h: "% of goal", r: 1, w: 52 }, { h: "Reason", w: 120 }, { h: "Day notes" }],
          M.underList.map(function (u) { return [dmid(u.date).replace(/^(\w+) /, "$1\n"), u.operator, u.shift || "-", u.draws || "-", u.pct !== null ? Math.round(u.pct) + "%" : "no goal", u.why, u.notes.slice(0, 600) || "-"]; }), { fs: 8.2, flag: function (r, c) { return c === 5 && M.underList[r].none; } });
      },
      coils: function (sec) {
        var full = S.rows - S.half - S.third;
        if (sec.chart === "pie") pie([{ label: "Full coils", v: full, txt: f0(full) + " rows", c: PAL[0] }, { label: "Cut in half", v: S.half, txt: f0(S.half) + " rows", c: PAL[1] }, { label: "Cut in thirds", v: S.third, txt: f0(S.third) + " rows", c: PAL[2] }]);
        table([{ h: "Coils" }, { h: "Value", r: 1 }], [["Coils drawn (full coils)", f0(S.coils)], ["Average coil weight (full coils)", f0(S.avgCoil) + " lb"], ["Card rows cut in half", f0(S.half)], ["Card rows cut in thirds", f0(S.third)], ["Share of card rows split", fp(S.splitPct)], ["Average full coils per shift", f1(S.shifts ? S.coils / S.shifts : null)]]);
      },
      size: function (sec) {
        if (!M.sizes.length) return empty();
        if (sec.chart === "bar") hbar(M.sizes.map(function (x) { return { label: x.finish + (x.grade ? "  " + x.grade : ""), v: x.lbs, txt: f0(x.lbs) + " lb  " + Math.round(x.share) + "%", c: PAL[0] }; }), { lw: 130 });
        if (sec.chart === "table" || sec.tbl) table([{ h: "Finish size" }, { h: "Grade" }, { h: "Coils", r: 1 }, { h: "Output (lbs)", r: 1 }, { h: "Share", r: 1 }], M.sizes.map(function (x) { return [x.finish, x.grade, f0(x.coils), f0(x.lbs), fp(x.share)]; }));
      },
      notes: function () {
        var N = M.notes;
        need(40); sub("Maintenance notes", ML, CW, M.maint.length ? M.maint.length + " note" + (M.maint.length === 1 ? "" : "s") : ""); y += 20;
        if (M.maint.length) table([{ h: "Day", w: 50 }, { h: "Operator", w: 86 }, { h: "Draws", w: 60 }, { h: "Note" }], M.maint.map(function (m) { return [dmid(m.date).replace(/^(\w+) /, "$1\n"), m.operator, m.draws || "-", m.text.slice(0, 800)]; }), { fs: 8.4 });
        else { font(9, "italic", DIM); txt("No maintenance notes in this range.", ML + 2, y + 6); y += 20; }
        if (N.tips && N.tips.length) { need(60); sub("Job tips added", ML, CW, N.tips.length + (N.capped ? " or more" : "")); y += 20;
          table([{ h: "Day", w: 50 }, { h: "Operator", w: 80 }, { h: "Draw", w: 46 }, { h: "Job", w: 96 }, { h: "Tip" }], N.tips.map(function (t) { return [dshort(t.date), t.operator || "", t.machine || "", [t.start_size ? t.start_size + " to" : "", t.finish || "", t.grade || ""].filter(Boolean).join(" "), String(t.tip || "").slice(0, 600)]; }), { fs: 8.2 }); }
        note(N.dayNotes + " shift" + (N.dayNotes === 1 ? " has" : "s have") + " day notes (under-goal ones are in the list above), " + N.coilNotes + " coil note" + (N.coilNotes === 1 ? "" : "s") + (N.checked < N.total ? " (from " + N.checked + " of " + N.total + " shifts read)" : "") + ", " + (N.tips ? N.tips.length + (N.capped ? " or more" : "") + " job tip" + (N.tips.length === 1 ? "" : "s") + " added." : "job tips not read."));
      },
      flags: function () {
        var all = summarize(M).allFlags;
        if (!all.length) { need(22); font(9.5, "normal", GOOD); txt("Nothing flagged. Every miss has a reason and no issue repeated 3 or more times.", ML + 4, y + 8); y += 22; return; }
        all.forEach(function (f) {
          var col = f.kind === "dup" || f.kind === "noreason" ? BAD : f.kind === "nogoal" ? WARN : DIM, t = (f.title ? f.title + ". " : "") + f.text;
          font(9, "normal", INK); var ln = wrap(t, CW - 22); need(ln.length * 11.5 + 6); doc.setFillColor.apply(doc, col); doc.rect(ML + 4, y + 2, 6, 6, "F"); doc.text(ln, ML + 18, y + 8); y += ln.length * 11.5 + 6; });
        y += 6;
      }
    };
    var SUB = { kpi: S.shifts + " shifts logged", daily: M.daily.length + " days with logs", machine: M.machines.filter(function (m) { return /^[1-9]$/.test(m.key); }).length + " Draws ran", operator: M.ops.length + " operators and crews", underlist: M.underList.length + " shift" + (M.underList.length === 1 ? "" : "s"), flags: M.flags.length ? summarize(M).allFlags.length + " flagged" : "none" };

    font(8.5, "normal", DIM);
    txt((info && info.filter ? "Showing: " + info.filter : "All operators, all Draws") + "    Shifts in range: " + S.shifts + (info && info.partial ? "    " + info.partial : ""), ML, y - 6);
    y += 6;
    /* keep a section's heading on the same page as its first chart or table */
    function est(sec) {
      var c = sec.chart, n = { machine: M.machines.length, share: M.machines.length, machops: M.machines.length, operator: M.ops.length, shift: M.shifts.length, dow: M.dow.length,
        downreason: M.downReasons.length, downop: M.downOps.length, downmach: M.downMach.length, util: M.machines.length + 1, under: M.underReasons.length, size: M.sizes.length, compare: 10 }[sec.id] || 1;
      if (sec.id === "kpi") return 80; if (sec.id === "flags") return 30;
      var extra = sec.id === "under" || sec.id === "compare" ? 16 : 0;
      if (c === "line" || (c === "bar" && (sec.id === "daily" || sec.id === "dow"))) return 180;
      if (c === "pie") return sec.id === "machops" ? 140 : 170;
      if (c === "bar" && (sec.id === "machops" || sec.id === "util")) return Math.min(400, n * 19 + 30);
      if (c === "bar") return Math.min(200, n * 18 + 28) + extra;
      return 70 + extra;
    }
    /* page 1 summary, then page 2 Draws and operators, then the appendix, each group starting on a fresh page */
    var lastPg = null;
    groupSort(L.sections).forEach(function (sec) {
      if (!sec.on || !DRAW[sec.id]) return;
      var g = BYID[sec.id].pg;
      if (lastPg !== null && g !== lastPg) { page(); }
      if (g === "appendix" && lastPg !== "appendix") { font(8, "bold", DIM); txt("APPENDIX", ML, y + 2); y += 12; }
      lastPg = g;
      need(30 + est(sec));
      head(BYID[sec.id].title, SUB[sec.id] || "");
      DRAW[sec.id](sec);
      y += 12;
    });
    if (secN === 0) { font(11, "normal", DIM); txt("No sections picked. Turn some on in the report builder.", ML, y + 20); }

    // header and footer on every page, once the page count is known
    var n = doc.internal.getNumberOfPages(), gen = info && info.generated ? info.generated : new Date();
    var genTxt = "Generated " + dlong(ymd(gen)) + ", " + gen.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    for (var p = 1; p <= n; p++) {
      doc.setPage(p);
      font(15, "bold", HEAD); txt(fit(L.title || "Production Report", 300), ML, 42);
      if (L.plant) { font(9, "normal", DIM); txt(fit(L.plant, 300), ML, 56); }
      font(10, "bold", INK); txt(rangeText(M.from, M.to), ML + CW, 42, { align: "right" });
      font(8, "normal", DIM); txt(genTxt, ML + CW, 56, { align: "right" });
      doc.setDrawColor.apply(doc, HEAD); doc.setLineWidth(1.2); doc.line(ML, 64, ML + CW, 64);
      doc.setDrawColor.apply(doc, RULE); doc.setLineWidth(0.6); doc.line(ML, PH - 36, ML + CW, PH - 36);
      font(7.5, "normal", DIM); txt(fit((L.title || "Production Report") + "  |  " + (L.plant ? L.plant + "  |  " : "") + rangeText(M.from, M.to), CW - 90), ML, PH - 24);
      font(7.5, "bold", DIM); txt("Page " + p + " of " + n, ML + CW, PH - 24, { align: "right" });
    }
    return doc;
  }

  /* ================= UI ================= */
  var LKEY = "reportLayoutV1", NKEY = "reportLayoutsV1", RKEY = "reportRangeV1";
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsPut(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var C = null, host = null, LAY = null, R = null, built = null, busy = false, opsList = [], openCols = {}, narrow = { op: "", draw: "", open: false };
  function loadLibs() {
    if (root.jspdf && root.jspdf.jsPDF && (root.jspdf_autotable || root.jspdf.jsPDF.API.autoTable)) return Promise.resolve();
    function add(src) { return new Promise(function (ok, bad) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = function () { s.remove(); bad(new Error("Could not load the PDF maker. Check the connection and try again.")); }; document.head.appendChild(s); }); }
    return (root.jspdf ? Promise.resolve() : add("vendor/jspdf.umd.min.js?v=421")).then(function () { return add("vendor/jspdf.plugin.autotable.min.js?v=509"); });
  }
  function save() { lsPut(LKEY, LAY); }
  function show(el, ctx) {
    host = el; C = ctx; LAY = normLayout(lsGet(LKEY, null));
    var sr = lsGet(RKEY, null); R = LAY.range === "custom" && sr && pd(sr.from) && pd(sr.to) ? { from: sr.from, to: sr.to } : rangeOf(LAY.range);
    built = null; render();
    C.api("/logs?limit=1").then(function (j) { opsList = j.operators || []; if (host && host.querySelector("#rp-op")) render(); }).catch(function () {});
  }
  function esc(s) { return C.esc(s); }
  function render() {
    var savedL = lsGet(NKEY, {}), names = Object.keys(savedL).sort(), days = nDays(R.from, R.to);
    var h = '<h3 style="margin-top:16px">REPORT</h3><p class="muted rp-help">Pick the dates and what goes on the sheet, then MAKE PDF. Your picks stay on this device, so next week the report comes out the same.</p>';
    h += '<div class="panel"><span class="lbl">Date range</span><div class="quick rp-quick">' + RANGES.map(function (r) { return '<button type="button" data-q="' + r[0] + '" class="' + (LAY.range === r[0] ? "on" : "") + '">' + r[1] + '</button>'; }).join("") + '</div>' +
      '<div class="row2"><div class="field"><label class="lbl" for="rp-from">From</label><input class="in" type="date" id="rp-from" value="' + esc(R.from) + '"></div><div class="field"><label class="lbl" for="rp-to">To</label><input class="in" type="date" id="rp-to" value="' + esc(R.to) + '"></div></div>' +
      '<div class="muted rp-rtxt" id="rp-rtxt">' + esc(rangeText(R.from, R.to)) + ' (' + days + ' day' + (days === 1 ? "" : "s") + '). Compared with the ' + days + ' days before.</div>' +
      '<details class="filters rp-narrow"' + (narrow.open ? " open" : "") + '><summary>NARROW IT DOWN <span>' + (narrow.op || narrow.draw ? esc([narrow.op, narrow.draw ? "Draw " + narrow.draw : ""].filter(Boolean).join(", ")) : "optional") + '</span></summary><div class="row2"><div class="field"><label class="lbl" for="rp-op">Operator</label><select class="in" id="rp-op"><option value="">All operators</option>' +
      opsList.map(function (o) { return '<option' + (o === narrow.op ? " selected" : "") + '>' + esc(o) + '</option>'; }).join("") + '</select></div>' +
      '<div class="field"><label class="lbl" for="rp-draw">Draw #</label><input class="in" id="rp-draw" inputmode="numeric" placeholder="all" value="' + esc(narrow.draw) + '"></div></div></details></div>';
    h += '<div class="panel"><div class="rp-tp"><div class="field"><label class="lbl" for="rp-title">Report title</label><input class="in" id="rp-title" maxlength="80" value="' + esc(LAY.title) + '"></div>' +
      '<div class="field"><label class="lbl" for="rp-plant">Plant or area line</label><input class="in" id="rp-plant" maxlength="80" value="' + esc(LAY.plant) + '"></div></div></div>';
    h += '<div class="panel"><span class="lbl">Layouts</span><div class="rp-lay"><select class="in" id="rp-preset" aria-label="Preset">' + PRESETS.map(function (p) { return '<option value="' + p[0] + '">' + esc(p[1]) + '</option>'; }).join("") + '</select><button type="button" id="rp-loadpreset">USE</button></div>' +
      (names.length ? '<div class="rp-lay"><select class="in" id="rp-saved" aria-label="Saved layouts">' + names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join("") + '</select><button type="button" id="rp-loadsaved">LOAD</button><button type="button" class="warn" id="rp-delsaved">DELETE</button></div>' : "") +
      '<div class="rp-lay"><input class="in" id="rp-name" maxlength="40" placeholder="Weekly" aria-label="Layout name"><button type="button" id="rp-save">SAVE</button></div>' +
      '<div class="muted rp-small">Changes below save by themselves as your everyday layout. SAVE keeps a named copy you can switch back to.</div></div>';
    var pn = 0; LAY.sections = groupSort(LAY.sections);
    h += '<span class="lbl rp-seclbl">Sections, in the order they print</span><div id="rp-secs">' + LAY.sections.map(function (s, i) {
      var d = BYID[s.id], num = s.on ? ++pn + "." : "", prev = LAY.sections[i - 1], next = LAY.sections[i + 1];
      var first = !prev || BYID[prev.id].pg !== d.pg, last = !next || BYID[next.id].pg !== d.pg;
      var gl = first ? '<div class="rp-pg">' + esc(PAGES.filter(function (p) { return p[0] === d.pg; })[0][1]) + (d.pg === "appendix" ? ' <span>optional, off unless you turn them on</span>' : "") + '</div>' : "";
      return gl + rowHtml(s, i, d, num, first, last);
    }).join("") + '</div>';
    function rowHtml(s, i, d, num, first, last) {
      return '<div class="rp-sec' + (s.on ? "" : " off") + '" data-id="' + s.id + '"><div class="rp-top"><label class="rp-chk"><input type="checkbox" class="rp-on"' + (s.on ? " checked" : "") + '><span><b class="rp-n">' + num + '</b>' + esc(d.title) + '</span></label>' +
        '<span class="rp-mv"><button type="button" class="rp-up" aria-label="Move up"' + (first ? " disabled" : "") + '>&uarr;</button><button type="button" class="rp-down" aria-label="Move down"' + (last ? " disabled" : "") + '>&darr;</button></span></div>' +
        (s.on ? '<div class="rp-opts">' + (d.charts.length > 1 ? '<select class="in rp-chart" aria-label="Chart type">' + d.charts.map(function (c) { return '<option value="' + c + '"' + (s.chart === c ? " selected" : "") + '>' + CH[c] + '</option>'; }).join("") + '</select>' : '<span class="muted rp-fixed">' + CH[d.charts[0]] + '</span>') +
          ("tbl" in d && s.chart !== "table" ? '<label class="rp-chk sm"><input type="checkbox" class="rp-tbl"' + (s.tbl ? " checked" : "") + '><span>table under chart</span></label>' : "") + '</div>' +
          (d.cols ? '<details class="rp-cols"' + (openCols[s.id] ? " open" : "") + '><summary>' + (s.id === "kpi" ? "TILES" : "COLUMNS") + ' <span>' + d.cols.filter(function (c) { return s.cols[c[0]]; }).length + ' of ' + d.cols.length + '</span></summary><div class="rp-colgrid">' + d.cols.map(function (c) { return '<label class="rp-chk sm"><input type="checkbox" data-col="' + c[0] + '"' + (s.cols[c[0]] ? " checked" : "") + '><span>' + esc(c[1]) + '</span></label>'; }).join("") + '</div></details>' : "") : "") + '</div>';
    }
    h += '<div class="rp-allbtns"><button type="button" id="rp-all">ALL ON</button><button type="button" id="rp-none">ALL OFF</button><button type="button" id="rp-def">DEFAULT</button></div>';
    h += '<button type="button" class="big solid" id="rp-build">MAKE PDF</button><div id="rp-status" class="muted rp-status" role="status"></div><div id="rp-ready" hidden><div class="row2"><button type="button" class="big solid" id="rp-dl">DOWNLOAD PDF</button><button type="button" class="big" id="rp-open">OPEN / PRINT</button></div></div>';
    var sy = window.scrollY; host.innerHTML = h; wire(); window.scrollTo(0, sy);
  }
  function stale() { built = null; var r = host.querySelector("#rp-ready"); if (r) r.hidden = true; var s = host.querySelector("#rp-status"); if (s) s.textContent = ""; }
  function wire() {
    var q = function (s) { return host.querySelector(s); }, qa = function (s) { return Array.prototype.slice.call(host.querySelectorAll(s)); };
    qa(".rp-quick button").forEach(function (b) { b.onclick = function () { LAY.range = b.dataset.q; R = rangeOf(LAY.range); save(); stale(); render(); }; });
    ["#rp-from", "#rp-to"].forEach(function (id) { q(id).onchange = function () { var f = q("#rp-from").value, t = q("#rp-to").value; if (!pd(f) || !pd(t)) return; if (f > t) { var x = f; f = t; t = x; } R = { from: f, to: t }; LAY.range = "custom"; lsPut(RKEY, R); save(); stale(); render(); }; });
    q(".rp-narrow").ontoggle = function () { narrow.open = this.open; };
    q("#rp-op").onchange = function () { narrow.op = this.value; stale(); };
    q("#rp-draw").oninput = function () { narrow.draw = this.value.replace(/\D/g, ""); stale(); };
    q("#rp-title").oninput = function () { LAY.title = this.value; save(); stale(); };
    q("#rp-plant").oninput = function () { LAY.plant = this.value; save(); stale(); };
    q("#rp-loadpreset").onclick = function () { var keep = { title: LAY.title, plant: LAY.plant, range: LAY.range }; LAY = preset(q("#rp-preset").value); LAY.title = keep.title; LAY.plant = keep.plant; LAY.range = keep.range; save(); stale(); render(); C.toast("Layout set"); };
    if (q("#rp-loadsaved")) {
      q("#rp-loadsaved").onclick = function () { var all = lsGet(NKEY, {}), n = q("#rp-saved").value; if (!all[n]) return; LAY = normLayout(all[n], true); if (LAY.range !== "custom") R = rangeOf(LAY.range); save(); stale(); render(); C.toast("Loaded " + n); };
      q("#rp-delsaved").onclick = function () { var all = lsGet(NKEY, {}), n = q("#rp-saved").value; if (!all[n] || !window.confirm("Delete the layout \"" + n + "\"?")) return; delete all[n]; lsPut(NKEY, all); render(); C.toast("Deleted"); };
    }
    q("#rp-save").onclick = function () { var n = q("#rp-name").value.trim().slice(0, 40); if (!n) { q("#rp-name").focus(); C.toast("Type a name first"); return; } var all = lsGet(NKEY, {}); all[n] = JSON.parse(JSON.stringify(LAY)); lsPut(NKEY, all); render(); var s = q("#rp-saved"); if (s) s.value = n; C.toast("Saved \"" + n + "\""); };
    qa(".rp-sec").forEach(function (row) {
      var id = row.dataset.id, s = LAY.sections.filter(function (x) { return x.id === id; })[0];
      function mv(dir) { var i = LAY.sections.indexOf(s), j = i + dir; if (j < 0 || j >= LAY.sections.length || BYID[LAY.sections[j].id].pg !== BYID[s.id].pg) return; LAY.sections.splice(i, 1); LAY.sections.splice(j, 0, s); save(); stale(); render();
        var b = host.querySelector('.rp-sec[data-id="' + id + '"] .rp-' + (dir < 0 ? "up" : "down")); if (b && b.disabled) b = host.querySelector('.rp-sec[data-id="' + id + '"] .rp-' + (dir < 0 ? "down" : "up")); if (b) b.focus({ preventScroll: true }); }
      row.querySelector(".rp-on").onchange = function () { s.on = this.checked; save(); stale(); render(); };
      row.querySelector(".rp-up").onclick = function () { mv(-1); };
      row.querySelector(".rp-down").onclick = function () { mv(1); };
      var ch = row.querySelector(".rp-chart"); if (ch) ch.onchange = function () { s.chart = this.value; save(); stale(); render(); };
      var tb = row.querySelector(".rp-tbl"); if (tb) tb.onchange = function () { s.tbl = this.checked; save(); stale(); };
      var det = row.querySelector(".rp-cols"); if (det) det.ontoggle = function () { openCols[id] = det.open; };
      Array.prototype.forEach.call(row.querySelectorAll("input[data-col]"), function (cb) { cb.onchange = function () { s.cols[cb.dataset.col] = cb.checked; save(); stale(); var sp = row.querySelector(".rp-cols summary span"); if (sp) sp.textContent = BYID[id].cols.filter(function (c) { return s.cols[c[0]]; }).length + " of " + BYID[id].cols.length; }; });
    });
    q("#rp-all").onclick = function () { LAY.sections.forEach(function (s) { s.on = true; }); save(); stale(); render(); };
    q("#rp-def").onclick = function () { var keep = { title: LAY.title, plant: LAY.plant, range: LAY.range }; LAY = defaultLayout(); LAY.title = keep.title; LAY.plant = keep.plant; LAY.range = keep.range; save(); stale(); render(); C.toast("Back to the standard layout"); };
    q("#rp-none").onclick = function () { LAY.sections.forEach(function (s) { s.on = false; }); save(); stale(); render(); };
    q("#rp-build").onclick = build;
    q("#rp-dl").onclick = function () { if (built) built.doc.save(built.name); };
    q("#rp-open").onclick = function () { if (!built) return; var w = window.open(built.doc.output("bloburl"), "_blank"); if (!w) built.doc.save(built.name); };
  }
  function pool(items, n, fn, prog) {
    var i = 0, done = 0, out = {};
    return new Promise(function (ok) {
      if (!items.length) return ok(out);
      function next() { if (i >= items.length) return; var it = items[i++]; fn(it).then(function (r) { out[it] = r; }, function () {}).then(function () { done++; prog(done, items.length); if (done === items.length) ok(out); else next(); }); }
      for (var k = 0; k < Math.min(n, items.length); k++) next();
    });
  }
  function build() {
    if (busy) return; var st = host.querySelector("#rp-status"), btn = host.querySelector("#rp-build");
    var op = narrow.op, dr = narrow.draw;
    var on = {}; LAY.sections.forEach(function (s) { if (s.on) on[s.id] = s; });
    if (!Object.keys(on).length) { st.textContent = "Turn on at least one section."; return; }
    busy = true; btn.disabled = true; stale(); st.textContent = "Reading the logs\u2026";
    var len = nDays(R.from, R.to), pf = addDays(R.from, -len), pt = addDays(R.from, -1), from = R.from, to = R.to;
    function qs(f, t) { return "?from=" + f + "&to=" + t + (op ? "&operator=" + encodeURIComponent(op) : "") + (dr ? "&draw=" + dr : ""); }
    var needDet = on.machine || on.downreason || on.downmach || on.notes || on.flags || on.util, needPrev = on.compare || on.kpi, partial = "";
    var A, P = null, D = {};
    loadLibs().then(function () {
      return Promise.all([C.api("/analyze" + qs(from, to)), needPrev ? C.api("/analyze" + qs(pf, pt)).catch(function () { return null; }) : null]);
    }).then(function (r) {
      A = r[0]; P = r[1];
      var ids = (A.logs || []).map(function (l) { return l.id; }), cap = 300;
      if (needDet && ids.length > cap) partial = "Downtime reasons and coil notes come from the newest " + cap + " shifts; older shifts use their downtime lines.";
      return pool(needDet ? ids.slice(-cap) : [], 6, function (id) { return C.api("/logs/" + encodeURIComponent(id)); }, function (d, n) { st.textContent = "Reading shift details " + d + " of " + n + "\u2026"; });
    }).then(function (det) {
      D = det;
      if (!on.notes) return null;
      st.textContent = "Reading job tips\u2026";
      return Promise.all(["round", "shape"].map(function (s) { return C.api("/search?shape=" + s + "&limit=1").then(function (j) { return j.tips || []; }); }))
        .then(function (r) { var seen = {}, out = r[0].concat(r[1]).filter(function (t) { if (seen[t.id]) return false; seen[t.id] = 1; return true; });
          // the lookup answers the newest 50 tips per shape: if it was full and still inside the range, there may be more
          out.capped = r.some(function (x) { return x.length >= 50 && x.every(function (t) { return t.date >= from; }); }); return out; }).catch(function () { return null; });
    }).then(function (tips) {
      st.textContent = "Drawing the PDF\u2026";
      var M = compute(A, { from: from, to: to, details: D, tips: tips, prev: P, prevFrom: pf, prevTo: pt });
      var filt = [op ? "Operator: " + op : "", dr ? "Draw " + dr : ""].filter(Boolean).join(", ");
      var doc = buildPdf(M, LAY, { filter: filt, partial: partial, generated: new Date() });
      var name = ((LAY.title || "Production Report").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "report") + "-" + from + "-to-" + to + ".pdf";
      var pages = doc.internal.getNumberOfPages();
      built = { doc: doc, name: name, model: M }; root.Report.last = built;
      st.textContent = "Ready: " + pages + " page" + (pages === 1 ? "" : "s") + ", " + M.shop.shifts + " shifts, " + rangeText(from, to) + ".";
      host.querySelector("#rp-ready").hidden = false;
    }).catch(function (e) {
      if (e && e.message === "401") return;
      st.textContent = "Could not make the report: " + (e && e.message === "Failed to fetch" ? "no connection to the database." : (e && e.message) || e);
    }).then(function () { busy = false; var b = host.querySelector("#rp-build"); if (b) b.disabled = false; });
  }

  var api = { summarize: summarize, groupSort: groupSort, PAGES: PAGES, crewName: crewName, show: show, compute: compute, buildPdf: buildPdf, parseUnder: parseUnder, parseProblems: parseProblems, rangeOf: rangeOf, preset: preset, normLayout: normLayout, defaultLayout: defaultLayout, SECTIONS: SECTIONS, PRESETS: PRESETS, WHY: WHY };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Report = api;
})(typeof window !== "undefined" ? window : globalThis);
