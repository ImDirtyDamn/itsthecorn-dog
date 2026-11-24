/* GRANULAR ANALYSIS (a sub-tab of ANALYZE): Excel-style custom tables.
   Each block is one table: pick the row level (coil rows or shifts), tick the columns to show, filter any column
   (tick values like Excel, or a min/max range), group by one or more fields, and draw a chart under it.
   Blocks stack (+ ADD TABLE), and the set is kept in localStorage, with named saved views.
   Data: the same GET /analyze answer as the rest of ANALYZE (logs + coil rows + machine + downtime rows). Read only.
   Hours on a coil row are the shift's run hours split by weight share, so a coil row's lb/hr is its shift's lb/hr. */
(function (root) {
  "use strict";
  var LS = "granularV1", LSV = "granularViewsV1", MAXROWS = 300;
  var PAL = ["#39ff6a", "#ffc23d", "#4fc3f7", "#ff5f56", "#c792ea", "#eaffea", "#7fdbca", "#ff8c42", "#a3be8c", "#8fa8ff"];
  var C, E, host, data = null, rowsBy = null, blocks = [], seq = 1, sheetState = null;

  /* ================= fields ================= */
  function n(v) { return v === null || v === undefined || v === "" || isNaN(+v) ? null : +v; }
  function sizeTxt(v) { if (v === null) return ""; var t = v.toFixed(3); return t.charAt(0) === "0" ? t.slice(1) : t; }
  function fc(v) { return root.Report && root.Report.fc ? root.Report.fc(v) : C.n1(v); }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  var FMT = {
    size: function (v) { return sizeTxt(v) + '"'; }, pct: function (v) { return f1(v) + "%"; }, lbs: function (v) { return C.n0(v); }, hrs: function (v) { return C.n1(v); },
    coils: function (v) { return fc(v); }, int: function (v) { return String(Math.round(v)); }, rate: function (v) { return C.n0(v); }, min: function (v) { return C.n0(v); }
  };
  /* t: cat (one value), multi (a list), num, date. lv: c = coil rows, s = shifts. sum: adds up in a totals row */
  var FIELDS = [
    { k: "date", l: "Date", t: "date", lv: "cs" },
    { k: "week", l: "Week of", t: "date", lv: "cs" },
    { k: "dow", l: "Day of week", t: "cat", lv: "cs", order: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
    { k: "op", l: "Operator", t: "cat", lv: "cs" },
    { k: "shift", l: "Shift", t: "cat", lv: "cs" },
    { k: "draw", l: "Draw", t: "cat", lv: "c" },
    { k: "draws", l: "Draws", t: "multi", lv: "s" },
    { k: "src", l: "Source", t: "cat", lv: "cs" },
    { k: "card", l: "Card #", t: "num", lv: "c", f: "int" },
    { k: "part", l: "Part #", t: "cat", lv: "c" },
    { k: "grade", l: "Grade", t: "cat", lv: "c" },
    { k: "grades", l: "Grades", t: "multi", lv: "s" },
    { k: "series", l: "Grade series", t: "cat", lv: "c" },
    { k: "carbon", l: "Carbon points", t: "num", lv: "c", f: "int" },
    { k: "boron", l: "Boron", t: "cat", lv: "c" },
    { k: "start", l: "Start size", t: "num", lv: "c", f: "size" },
    { k: "finish", l: "Finish size", t: "num", lv: "c", f: "size" },
    { k: "finishes", l: "Finish sizes", t: "multi", lv: "s" },
    { k: "shape", l: "Shape", t: "cat", lv: "c" },
    { k: "draftA", l: "Draft % (area)", t: "num", lv: "c", f: "pct" },
    { k: "draftD", l: "Draft % (diameter)", t: "num", lv: "c", f: "pct" },
    { k: "conds", l: "Condition", t: "multi", lv: "cs" },
    { k: "coils", l: "Coils", t: "num", lv: "cs", f: "coils", sum: 1 },
    { k: "weight", l: "Coil weight (lbs)", t: "num", lv: "c", f: "lbs", sum: 1 },
    { k: "lbs", l: "Lbs", t: "num", lv: "cs", f: "lbs", sum: 1 },
    { k: "hrs", l: "Run hrs", t: "num", lv: "cs", f: "hrs", sum: 1 },
    { k: "lbhr", l: "Lb/hr", t: "num", lv: "cs", f: "rate" },
    { k: "goalRate", l: "Goal lb/hr", t: "num", lv: "cs", f: "rate" },
    { k: "goalLbs", l: "Goal lbs", t: "num", lv: "cs", f: "lbs", sum: 1 },
    { k: "pct", l: "% of goal", t: "num", lv: "cs", f: "pct" },
    { k: "met", l: "Goal met", t: "cat", lv: "cs" },
    { k: "dt", l: "Down hr", t: "num", lv: "cs", f: "hrs", sum: 1 },
    { k: "brk", l: "Break min", t: "num", lv: "s", f: "min", sum: 1 },
    { k: "nrows", l: "Card rows", t: "num", lv: "s", f: "int", sum: 1 },
    { k: "why", l: "Under-goal reason", t: "multi", lv: "cs" }
  ];
  var FB = {}; FIELDS.forEach(function (f) { FB[f.k] = f; });
  function fieldsOf(lv) { return FIELDS.filter(function (f) { return f.lv.indexOf(lv) >= 0; }); }
  var AGGS = [["count", "Rows"], ["shifts", "Shifts"], ["coils", "Coils"], ["lbs", "Lbs"], ["hrs", "Run hrs"], ["lbhr", "Lb/hr"], ["avgcoil", "Avg coil (lbs)"], ["pct", "% of goal"], ["dt", "Down hr"]];
  var AGF = { count: "int", shifts: "int", coils: "coils", lbs: "lbs", hrs: "hrs", lbhr: "rate", avgcoil: "lbs", pct: "pct", dt: "hrs" };
  var DEF_COLS = { c: ["date", "op", "draw", "grade", "start", "finish", "draftA", "draftD", "conds", "coils", "lbs", "hrs", "lbhr"], s: ["date", "op", "shift", "draws", "coils", "lbs", "hrs", "lbhr", "pct", "dt"] };
  var DEF_AGGS = ["shifts", "coils", "lbs", "hrs", "lbhr", "avgcoil", "pct"];
  var UNK = "(unknown)", NONE = "(none)";

  /* ================= rows ================= */
  function grParts(g) {
    var m = /^(\d\d)([A-Z])?(\d\d)([A-Z])?$/.exec(g || ""); if (!m) return null; // 10B21, 1022B: the B is boron
    return { series: m[1] + "xx", carbon: +m[3], boron: m[2] === "B" || m[4] === "B" ? "Yes" : "No" };
  }
  function weekOf(d) { var x = E.parseYmd(d); if (!x) return null; x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return E.ymd(x); }
  function buildRows(j) {
    var by = function (rows) { var o = {}; (rows || []).forEach(function (r) { (o[r.log_id] = o[r.log_id] || []).push(r); }); return o; };
    var coils = by(j.coils), out = { c: [], s: [] }, coilsOf = root.Report && root.Report.coilsOf ? root.Report.coilsOf : E.coilCount;
    var gN = root.Fields && root.Fields.grade ? root.Fields.grade : function (g) { return String(g || "").toUpperCase().trim(); };
    (j.logs || []).forEach(function (l) {
      var cs = coils[l.id] || [], dd = E.parseYmd(l.shift_date);
      var total = n(l.total_lbs), hours = n(l.net_hours); if (hours !== null && hours <= 0) hours = null;
      var goalL = n(l.goal_lbs), dtm = n(l.downtime_minutes) || 0;
      var draws = E.drawList ? E.drawList(l.draws) : String(l.draws || "").split(",").filter(Boolean);
      var base = { log_id: l.id, date: l.shift_date || null, week: weekOf(l.shift_date), dow: dd ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dd.getDay()] : null,
        op: E.crewName(l.operator) || null, shift: E.shiftKind(l), src: /^(scan|sheet)/i.test(l.id) ? "Scanned sheet" : "Tracker",
        lbhr: total !== null && hours ? total / hours : null, goalRate: n(l.goal_lbhr) > 0 ? n(l.goal_lbhr) : null,
        pct: goalL > 0 && total !== null ? total / goalL * 100 : null, met: l.goal_met === 1 ? "Met" : l.goal_met === 0 ? "Under" : "Not rated",
        rated: l.goal_met === 0 || l.goal_met === 1, why: E.reasonKeys(l) };
      var wsum = cs.reduce(function (a, c) { return a + Math.max(n(c.weight) || 0, 0); }, 0);
      if (total === null && wsum > 0) total = wsum;
      var sh = Object.assign({}, base, { draws: draws.map(function (d) { return "Draw " + d; }), grades: [], finishes: [], conds: [], coils: 0, lbs: total, hrs: hours,
        goalLbs: goalL > 0 ? goalL : null, dt: dtm / 60, brk: n(l.break_minutes), nrows: cs.length, wsum: wsum });
      var list = cs.length ? cs : [null];
      list.forEach(function (c) {
        var w = c ? Math.max(n(c.weight) || 0, 0) : 0, share = wsum > 0 ? w / wsum : 1 / list.length;
        var g = c ? gN(c.grade) : "", gp = grParts(g);
        var fin = c ? (n(c.finish_in) !== null ? n(c.finish_in) : E.sizeNum(c.finish)) : null, st = c ? (n(c.start_in) !== null ? n(c.start_in) : E.sizeNum(c.start_size)) : null;
        var ok = fin !== null && st !== null && st > 0 && fin <= st;
        var tags = c ? E.tagList(c.tags) : [], dr = c && c.draw !== null && c.draw !== undefined && c.draw !== "" ? "Draw " + c.draw : draws.length === 1 ? "Draw " + draws[0] : null;
        var r = Object.assign({}, base, { draw: dr, card: c ? n(String(c.work_order || "").replace(/\D/g, "") || null) : null, part: c && String(c.part || "").trim() ? String(c.part).trim().replace(/\s+/g, " ") : null,
          grade: g || null, series: gp ? gp.series : null, carbon: gp ? gp.carbon : null, boron: gp ? gp.boron : null, start: st, finish: fin,
          shape: c && c.shape ? String(c.shape) : null, draftA: ok ? (n(c.reduction) !== null ? n(c.reduction) : (1 - (fin * fin) / (st * st)) * 100) : null,
          draftD: ok ? (1 - fin / st) * 100 : null, conds: tags, coils: c ? coilsOf(c) : 0, weight: c ? n(c.weight) : null,
          lbs: total === null ? null : total * share, hrs: hours === null ? null : hours * share, goalLbs: goalL > 0 ? goalL * share : null, dt: dtm / 60 * share, w: w, shift_ref: sh });
        out.c.push(r);
        sh.coils += r.coils;
        if (r.grade && sh.grades.indexOf(r.grade) < 0) sh.grades.push(r.grade);
        if (fin !== null && sh.finishes.indexOf(sizeTxt(fin) + '"') < 0) sh.finishes.push(sizeTxt(fin) + '"');
        tags.forEach(function (t) { if (sh.conds.indexOf(t) < 0) sh.conds.push(t); });
      });
      out.s.push(sh);
    });
    return out;
  }

  /* ================= values, filters ================= */
  function vals(r, f) { // filter / group keys of a row for one field (strings)
    var v = r[f.k];
    if (f.t === "multi") { var a = (v || []).filter(function (x) { return x !== null && x !== ""; }); return a.length ? a.map(String) : [f.k === "conds" || f.k === "why" ? NONE : UNK]; }
    if (v === null || v === undefined || v === "") return [UNK];
    return [String(v)];
  }
  function show(f, v) { // display text of a raw value
    if (v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v))) return "\u2013";
    if (f.t === "multi") return v.length ? v.join(", ") : (f.k === "conds" || f.k === "why" ? NONE : "\u2013");
    if (f.t === "date") return f.k === "week" ? "wk of " + C.day(v, true) : C.day(v, true);
    if (f.t === "num") return FMT[f.f || "lbs"](v);
    return String(v);
  }
  function keyShow(f, k) { if (k === UNK || k === NONE) return k; if (f.t === "num") return show(f, +k); if (f.t === "date") return show(f, k); return k; }
  function isOn(fl) { if (!fl) return false; if (fl.x) return fl.x.length > 0; return fl.min !== undefined && fl.min !== "" || fl.max !== undefined && fl.max !== "" || fl.from || fl.to || fl.blank === false; }
  function pass(r, flt, lv) {
    for (var k in flt) {
      var f = FB[k], fl = flt[k]; if (!f || f.lv.indexOf(lv) < 0 || !isOn(fl)) continue;
      if (fl.x) { var vs = vals(r, f); for (var i = 0; i < vs.length; i++) if (fl.x.indexOf(vs[i]) >= 0) return false; continue; }
      var v = r[k];
      if (v === null || v === undefined || v === "") { var rng = fl.min !== undefined && fl.min !== "" || fl.max !== undefined && fl.max !== "" || fl.from || fl.to; if (fl.blank === false || (fl.blank !== true && rng)) return false; continue; }
      if (f.t === "date") { if (fl.from && v < fl.from) return false; if (fl.to && v > fl.to) return false; continue; }
      var lo = n(fl.min), hi = n(fl.max);
      if (lo !== null && !(v >= lo - 1e-9)) return false; if (hi !== null && !(v <= hi + 1e-9)) return false;
    }
    return true;
  }
  function blockById(id) { for (var i = 0; i < blocks.length; i++) if (blocks[i].id === id) return blocks[i]; return null; }
  /* the rows a block keeps: its filters, then "single-spec shifts only", then minus another table's rows */
  function rowsOf(b, seen) {
    seen = seen || {}; seen[b.id] = 1;
    var all = rowsBy[b.lv], rs = all.filter(function (r) { return pass(r, b.f, b.lv); });
    if (b.lv === "c" && b.single) {
      var hit = {}; rs.forEach(function (r) { hit[r.log_id] = (hit[r.log_id] || 0) + r.w; });
      rs = rs.filter(function (r) { var t = r.shift_ref.wsum; return t > 0 ? hit[r.log_id] / t >= 0.9 : true; });
    }
    var mb = b.minus && blockById(b.minus);
    if (mb && mb.lv === b.lv && !seen[mb.id]) { var o = rowsOf(mb, seen), set = new Set(o); rs = rs.filter(function (r) { return !set.has(r); }); }
    return rs;
  }

  /* ================= aggregate, group ================= */
  function agg(rs) {
    var a = { count: rs.length, coils: 0, lbs: 0, hrs: 0, hl: 0, w: 0, rl: 0, rg: 0, dt: 0, logs: {} };
    rs.forEach(function (r) {
      a.coils += r.coils || 0; a.lbs += r.lbs || 0; a.dt += r.dt || 0; a.logs[r.log_id] = 1;
      if (r.hrs > 0) { a.hrs += r.hrs; a.hl += r.lbs || 0; }
      a.w += r.weight !== undefined ? (r.weight || 0) : (r.wsum || 0);
      if (r.rated && r.goalLbs > 0) { a.rl += r.lbs || 0; a.rg += r.goalLbs; }
    });
    return { count: a.count, shifts: Object.keys(a.logs).length, coils: a.coils, lbs: a.lbs, hrs: a.hrs, lbhr: a.hrs > 0 ? a.hl / a.hrs : null,
      avgcoil: a.coils > 0 ? (a.w > 0 ? a.w : a.lbs) / a.coils : null, pct: a.rg > 0 ? a.rl / a.rg * 100 : null, dt: a.dt };
  }
  function groups(rs, keys) {
    var m = new Map();
    rs.forEach(function (r) {
      var combos = [[]];
      keys.forEach(function (k) { var vs = vals(r, FB[k]), nx = []; combos.forEach(function (c) { vs.forEach(function (v) { nx.push(c.concat([v])); }); }); combos = nx; });
      combos.forEach(function (c) { var id = JSON.stringify(c), g = m.get(id); if (!g) m.set(id, g = { keys: c, rows: [] }); g.rows.push(r); });
    });
    return Array.from(m.values());
  }
  function cmpKey(f, a, b) {
    var ua = a === UNK || a === NONE, ub = b === UNK || b === NONE; if (ua || ub) return ua - ub;
    if (f.t === "num") return +a - +b; if (f.order) return f.order.indexOf(a) - f.order.indexOf(b);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function cmpVal(a, b) { var na = a === null || a === undefined || a === "", nb = b === null || b === undefined || b === ""; if (na || nb) return na - nb; if (Array.isArray(a)) a = a.join(","); if (Array.isArray(b)) b = b.join(","); return typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; }

  /* table model: { head: [{k, l, num}], rows: [[cell text]], raw: [[value]], total: [..], n } */
  function model(b) {
    var rs = rowsOf(b), cols = b.cols[b.lv].filter(function (k) { return FB[k] && FB[k].lv.indexOf(b.lv) >= 0; });
    var by = (b.by || []).filter(function (k) { return FB[k] && FB[k].lv.indexOf(b.lv) >= 0; }), M = { n: rs.length, rows: [], raw: [], grouped: !!by.length };
    if (by.length) {
      var ag = b.aggs.length ? b.aggs : ["count"];
      M.head = by.map(function (k) { return { k: k, l: FB[k].l }; }).concat(ag.map(function (k) { return { k: "a:" + k, l: AGGS.filter(function (x) { return x[0] === k; })[0][1], num: 1 }; }));
      var gs = groups(rs, by).map(function (g) { return { keys: g.keys, a: agg(g.rows) }; });
      var s = b.sort || {}, si = M.head.map(function (h) { return h.k; }).indexOf(s.k);
      gs.sort(function (x, y) {
        if (si >= by.length) { var k = s.k.slice(2); return cmpVal(x.a[k], y.a[k]) * (s.dir || 1); }
        if (si >= 0) return cmpKey(FB[by[si]], x.keys[si], y.keys[si]) * (s.dir || 1);
        for (var i = 0; i < by.length; i++) { var c = cmpKey(FB[by[i]], x.keys[i], y.keys[i]); if (c) return c; } return 0;
      });
      gs.forEach(function (g) {
        M.raw.push(g.keys.map(function (k, i) { return keyShow(FB[by[i]], k); }).concat(ag.map(function (k) { return g.a[k]; })));
        M.rows.push(g.keys.map(function (k, i) { return keyShow(FB[by[i]], k); }).concat(ag.map(function (k) { var v = g.a[k]; return v === null ? "\u2013" : FMT[AGF[k]](v); })));
      });
      var t = agg(rs); M.total = ["All " + rs.length + " rows"].concat(by.slice(1).map(function () { return ""; })).concat(ag.map(function (k) { var v = t[k]; return v === null ? "\u2013" : FMT[AGF[k]](v); }));
    } else {
      if (!cols.length) cols = ["date"];
      M.head = cols.map(function (k) { return { k: k, l: FB[k].l, num: FB[k].t === "num" }; });
      var s2 = b.sort || {}, list = rs.slice();
      if (s2.k && FB[s2.k]) list.sort(function (x, y) { return cmpVal(x[s2.k], y[s2.k]) * (s2.dir || 1); });
      else list.sort(function (x, y) { return cmpVal(x.date, y.date) || cmpVal(x.log_id, y.log_id); });
      list.forEach(function (r) { M.raw.push(cols.map(function (k) { var v = r[k]; return Array.isArray(v) ? v.join("; ") : v; })); M.rows.push(cols.map(function (k) { return show(FB[k], r[k]); })); });
      var a = agg(rs);
      M.total = cols.map(function (k, i) {
        if (k === "lbhr") return a.lbhr === null ? "" : FMT.rate(a.lbhr);
        if (k === "pct") return a.pct === null ? "" : FMT.pct(a.pct);
        if (FB[k].sum) { var sm = rs.reduce(function (z, r) { return z + (r[k] || 0); }, 0); return FMT[FB[k].f](sm); }
        return i === 0 ? "All " + rs.length : "";
      });
    }
    M.rs = rs;
    return M;
  }

  /* ================= state ================= */
  function newBlock(o) {
    o = o || {};
    return { id: "t" + (seq++), name: o.name || "", lv: o.lv === "s" ? "s" : "c", f: o.f || {}, single: !!o.single, minus: o.minus || "", by: o.by || [],
      aggs: o.aggs || DEF_AGGS.slice(), cols: o.cols || { c: DEF_COLS.c.slice(), s: DEF_COLS.s.slice() }, sort: o.sort || {}, chart: o.chart || { type: "none", x: "", y: "lbs", s: "" }, open: !!o.open };
  }
  function clean(b) {
    var x = newBlock(b); x.id = typeof b.id === "string" && /^t\d+$/.test(b.id) ? b.id : x.id;
    var m = /^t(\d+)$/.exec(x.id); if (m && +m[1] >= seq) seq = +m[1] + 1;
    x.cols = { c: (b.cols && Array.isArray(b.cols.c) ? b.cols.c : DEF_COLS.c).filter(function (k) { return FB[k]; }), s: (b.cols && Array.isArray(b.cols.s) ? b.cols.s : DEF_COLS.s).filter(function (k) { return FB[k]; }) };
    x.by = (Array.isArray(b.by) ? b.by : []).filter(function (k) { return FB[k]; }); x.aggs = (Array.isArray(b.aggs) ? b.aggs : DEF_AGGS).filter(function (k) { return AGF[k]; });
    var f = {}; Object.keys(b.f || {}).forEach(function (k) { if (FB[k] && b.f[k] && typeof b.f[k] === "object") f[k] = b.f[k]; }); x.f = f;
    return x;
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(blocks)); } catch (e) {} }
  function restore() {
    try { var j = JSON.parse(localStorage.getItem(LS) || "null"); if (Array.isArray(j) && j.length) blocks = j.map(clean); } catch (e) {}
    if (!blocks.length) blocks = [newBlock({ name: "", open: true })];
  }
  function views() { try { var v = JSON.parse(localStorage.getItem(LSV) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }

  /* ================= UI ================= */
  function esc(s) { return C.esc(s); }
  function $(id) { return document.getElementById(id); }
  function info(t) { return '<details class="info"><summary aria-label="How this is counted">\u24d8</summary><p>' + t + '</p></details>'; }
  function fShort(b, k) {
    var f = FB[k], fl = b.f[k]; if (!isOn(fl)) return "";
    if (fl.x) {
      var all = {}; rowsBy[b.lv].forEach(function (r) { vals(r, f).forEach(function (v) { all[v] = 1; }); });
      var kept = Object.keys(all).filter(function (v) { return fl.x.indexOf(v) < 0; }).sort(function (a, c) { return cmpKey(f, a, c); });
      if (kept.length <= fl.x.length) return kept.length ? "only " + kept.slice(0, 3).map(function (v) { return keyShow(f, v); }).join(", ") + (kept.length > 3 ? " +" + (kept.length - 3) : "") : "nothing ticked";
      return "not " + fl.x.slice(0, 2).map(function (v) { return keyShow(f, v); }).join(", ") + (fl.x.length > 2 ? " +" + (fl.x.length - 2) : ""); }
    if (f.t === "date") return (fl.from ? "from " + C.day(fl.from, true) : "") + (fl.from && fl.to ? " " : "") + (fl.to ? "to " + C.day(fl.to, true) : "") || "no blanks";
    var lo = n(fl.min), hi = n(fl.max), fm = function (v) { return f.f === "size" ? sizeTxt(v) : String(v); };
    return (lo !== null && hi !== null ? fm(lo) + "\u2013" + fm(hi) : lo !== null ? "\u2265 " + fm(lo) : hi !== null ? "\u2264 " + fm(hi) : "no blanks") + (fl.blank === true ? " + blanks" : "");
  }
  function blockHtml(b, i) {
    var M = model(b), lv = b.lv, fs = fieldsOf(lv), nf = fs.filter(function (f) { return isOn(b.f[f.k]); });
    var h = '<section class="gblk panel" data-b="' + b.id + '">';
    h += '<div class="ghead"><span class="gnum">' + (i + 1) + '</span><input class="in gname" data-act="name" value="' + esc(b.name) + '" placeholder="Table ' + (i + 1) + ', e.g. Dan small wire" aria-label="Table name"></div>';
    h += '<div class="seg two"><button type="button" data-act="lv" data-v="c" class="' + (lv === "c" ? "on" : "") + '">COIL ROWS</button><button type="button" data-act="lv" data-v="s" class="' + (lv === "s" ? "on" : "") + '">SHIFTS</button></div>';
    // active filters
    h += '<div class="gfl">' + (nf.length ? nf.map(function (f) { return '<button type="button" class="gchip gf" data-act="sheet" data-k="' + f.k + '">' + esc(f.l) + ': ' + esc(fShort(b, f.k)) + '</button>'; }).join("") +
      '<button type="button" class="gchip ghostc" data-act="clearf">CLEAR FILTERS</button>' : '<span class="muted">No filters: every ' + (lv === "c" ? "coil row" : "shift") + ' counts.</span>') + '</div>';
    // columns and filters list
    h += '<details class="gcols"' + (b.open ? " open" : "") + ' data-act="cols"><summary>COLUMNS &amp; FILTERS <span>' + b.cols[lv].filter(function (k) { return FB[k] && FB[k].lv.indexOf(lv) >= 0; }).length + ' shown \u00b7 ' + nf.length + ' filtered</span></summary><div class="gclist">' +
      fs.map(function (f) { var on = b.cols[lv].indexOf(f.k) >= 0, fo = isOn(b.f[f.k]);
        return '<div class="gcrow"><label><input type="checkbox" data-act="col" data-k="' + f.k + '"' + (on ? " checked" : "") + '> ' + esc(f.l) + '</label><button type="button" class="gfbtn' + (fo ? " on" : "") + '" data-act="sheet" data-k="' + f.k + '">' + (fo ? "FILTERED" : "FILTER") + '</button></div>'; }).join("") +
      '</div></details>';
    // group by + aggregates
    var gopts = fs.filter(function (f) { return b.by.indexOf(f.k) < 0; });
    h += '<div class="grow2"><div class="field"><label class="lbl" for="gby-' + b.id + '">Group by</label><select class="in" id="gby-' + b.id + '" data-act="addby"><option value="">' + (b.by.length ? "+ another field" : "No grouping (every row)") + '</option>' +
      gopts.map(function (f) { return '<option value="' + f.k + '">' + esc(f.l) + '</option>'; }).join("") + '</select></div>' +
      '<div class="field"><label class="lbl" for="gmin-' + b.id + '">Leave out rows of</label><select class="in" id="gmin-' + b.id + '" data-act="minus"><option value="">Nothing (all matching rows)</option>' +
      blocks.filter(function (o) { return o.id !== b.id && o.lv === b.lv; }).map(function (o) { return '<option value="' + o.id + '"' + (b.minus === o.id ? " selected" : "") + '>Table ' + (blocks.indexOf(o) + 1) + (o.name ? ": " + esc(o.name) : "") + '</option>'; }).join("") + '</select></div></div>';
    if (b.by.length) h += '<div class="gfl">' + b.by.map(function (k, j) { return '<button type="button" class="gchip gf" data-act="rmby" data-k="' + k + '">' + (j ? "then " : "") + esc(FB[k].l) + ' \u2715</button>'; }).join("") + '</div>' +
      '<div class="gfl"><span class="lbl" style="margin:0 6px 0 0;align-self:center">Show</span>' + AGGS.map(function (a) { return '<button type="button" class="gchip' + (b.aggs.indexOf(a[0]) >= 0 ? " on" : "") + '" data-act="agg" data-k="' + a[0] + '">' + esc(a[1]) + '</button>'; }).join("") + '</div>';
    if (lv === "c") h += '<label class="gtog"><input type="checkbox" data-act="single"' + (b.single ? " checked" : "") + '> Single-spec shifts only (\u2265 90% of the shift\u2019s coil weight matches)</label>';
    // the table
    var sh = M.rows.length > MAXROWS ? MAXROWS : M.rows.length;
    h += '<div class="gsum">' + M.n + ' ' + (lv === "c" ? "coil row" : "shift") + (M.n === 1 ? "" : "s") + (M.grouped ? ' in ' + M.rows.length + ' group' + (M.rows.length === 1 ? "" : "s") : "") + (b.minus && blockById(b.minus) ? ' \u00b7 minus Table ' + (blocks.indexOf(blockById(b.minus)) + 1) : "") + '</div>';
    h += '<div class="tblwrap gtw"><table class="tbl gtbl"><thead><tr>' + M.head.map(function (c, j) {
      var s = b.sort && b.sort.k === c.k ? (b.sort.dir > 0 ? " \u25b2" : " \u25bc") : "", fk = c.k.indexOf("a:") === 0 ? "" : c.k;
      return '<th' + (j === 0 ? ' class="l"' : "") + '><button type="button" data-act="sort" data-k="' + c.k + '">' + esc(c.l) + s + '</button>' + (fk ? '<button type="button" class="gth-f' + (isOn(b.f[fk]) ? " on" : "") + '" data-act="sheet" data-k="' + fk + '" aria-label="Filter ' + esc(c.l) + '">\u25be</button>' : "") + '</th>'; }).join("") + '</tr></thead><tbody>' +
      (M.rows.length ? M.rows.slice(0, sh).map(function (r) { return '<tr>' + r.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join("") + '</tr>'; }).join("") : '<tr><td colspan="' + M.head.length + '" class="muted">No rows match these filters.</td></tr>') +
      (M.rows.length ? '<tr class="tot">' + M.total.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join("") + '</tr>' : "") + '</tbody></table></div>';
    if (M.rows.length > sh) h += '<p class="muted gnote">Showing the first ' + sh + ' of ' + M.rows.length + ' rows. EXPORT CSV has them all, or group the rows.</p>';
    // chart
    var ch = b.chart, xo = fs, yo = AGGS;
    h += '<div class="gchart"><div class="grow4"><div class="field"><label class="lbl" for="gct-' + b.id + '">Chart</label><select class="in" id="gct-' + b.id + '" data-act="ct">' +
      [["none", "None"], ["bar", "Bar"], ["hbar", "Horizontal bar"], ["line", "Line"], ["pie", "Pie"], ["scatter", "Scatter"], ["stack", "Stacked bar"]].map(function (t) { return '<option value="' + t[0] + '"' + (ch.type === t[0] ? " selected" : "") + '>' + t[1] + '</option>'; }).join("") + '</select></div>';
    if (ch.type !== "none") {
      var sc = ch.type === "scatter", nums = fs.filter(function (f) { return f.t === "num"; });
      h += '<div class="field"><label class="lbl" for="gcx-' + b.id + '">X</label><select class="in" id="gcx-' + b.id + '" data-act="cx">' + (sc ? nums : xo).map(function (f) { return '<option value="' + f.k + '"' + (chartX(b) === f.k ? " selected" : "") + '>' + esc(f.l) + '</option>'; }).join("") + '</select></div>' +
        '<div class="field"><label class="lbl" for="gcy-' + b.id + '">Y</label><select class="in" id="gcy-' + b.id + '" data-act="cy">' + (sc ? nums.map(function (f) { return [f.k, f.l]; }) : yo).map(function (a) { return '<option value="' + a[0] + '"' + (chartY(b) === a[0] ? " selected" : "") + '>' + esc(a[1]) + '</option>'; }).join("") + '</select></div>' +
        (ch.type !== "pie" ? '<div class="field"><label class="lbl" for="gcs-' + b.id + '">Series</label><select class="in" id="gcs-' + b.id + '" data-act="cs"><option value="">None</option>' + fs.filter(function (f) { return f.t !== "num"; }).map(function (f) { return '<option value="' + f.k + '"' + (ch.s === f.k ? " selected" : "") + '>' + esc(f.l) + '</option>'; }).join("") + '</select></div>' : "");
    }
    h += '</div><div class="chartbox gcbox" id="gc-' + b.id + '"' + (ch.type === "none" ? " hidden" : "") + '></div></div>';
    h += '<div class="gbtns"><button type="button" data-act="csv">EXPORT CSV</button><button type="button" data-act="dup" class="ghost">DUPLICATE</button><button type="button" data-act="up" class="ghost"' + (i ? "" : " disabled") + '>MOVE UP</button><button type="button" data-act="rm" class="ghost">REMOVE</button></div>';
    return h + '</section>';
  }
  function chartX(b) { var x = b.chart.x; var ok = x && FB[x] && FB[x].lv.indexOf(b.lv) >= 0 && (b.chart.type !== "scatter" || FB[x].t === "num"); return ok ? x : b.chart.type === "scatter" ? (b.lv === "c" ? "finish" : "hrs") : (b.by[0] || "date"); }
  function chartY(b) { var y = b.chart.y; if (b.chart.type === "scatter") return y && FB[y] && FB[y].t === "num" && FB[y].lv.indexOf(b.lv) >= 0 ? y : "lbhr"; return AGF[y] ? y : "lbs"; }

  function render() {
    save();
    var vs = views(), names = Object.keys(vs).sort();
    var h = '<div class="panel"><div class="seghdr"><span class="lbl" style="margin:0">Granular analysis</span>' + info("Build your own tables, like filters in Excel. COIL ROWS = one line per card row (grade, sizes, draft and condition are written per row); SHIFTS = one line per log. " +
      "Tick the columns to show; FILTER (or \u25be on a column) to tick values or set a min/max. Blank cells are \u201c(unknown)\u201d so missing specs stay visible; a range filter leaves blanks out unless you tick them in. " +
      "Lbs and run hours on a coil row are the shift\u2019s, split by coil weight, so by-spec lb/hr on a shift that ran several specs is that shift\u2019s average. Use \u201cSingle-spec shifts only\u201d for a cleaner rate. " +
      "Draft % (area) = (start\u00b2 \u2212 finish\u00b2) \u00f7 start\u00b2; Draft % (diameter) = (start \u2212 finish) \u00f7 start. Carbon points: 1010 = 10, 10B21 = 21. Coils: a half counts 1/2. " +
      "\u201cLeave out rows of\u201d another table makes an \u201ceverything else\u201d table.") + '</div>' +
      '<details class="gcols gviews"><summary>SAVED VIEWS <span>' + (names.length ? names.length + " saved" : "none yet") + '</span></summary>' +
      '<div class="grow2"><div class="field"><label class="lbl" for="gview">Saved views</label><select class="in" id="gview"><option value="">' + (names.length ? "Pick a saved view" : "None saved yet") + '</option>' + names.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("") + '</select></div>' +
      '<div class="field"><label class="lbl" for="gvname">Save these tables as</label><input class="in" id="gvname" placeholder="e.g. Dan small wire vs rest" autocomplete="off"></div></div>' +
      '<div class="gbtns"><button type="button" id="gvload" class="ghost">OPEN VIEW</button><button type="button" id="gvdel" class="ghost">DELETE VIEW</button><button type="button" id="gvsave">SAVE VIEW</button></div><div style="height:8px"></div></details></div>';
    h += blocks.map(blockHtml).join("");
    h += '<button type="button" class="big" id="gadd">+ ADD TABLE</button>';
    host.innerHTML = h;
    wire();
    drawCharts();
  }
  function drawCharts() { blocks.forEach(function (b) { var el = $("gc-" + b.id); if (el) chart(el, b); }); }
  function rerenderKeepScroll() { var y = window.scrollY; render(); window.scrollTo(0, y); }
  function wire() {
    Array.prototype.forEach.call(host.querySelectorAll(".gblk"), function (sec) {
      var b = blockById(sec.dataset.b); if (!b) return;
      Array.prototype.forEach.call(sec.querySelectorAll("[data-act]"), function (el) {
        var act = el.dataset.act, k = el.dataset.k;
        if (act === "name") { el.onchange = function () { b.name = el.value.trim().slice(0, 60); save(); rerenderKeepScroll(); }; return; }
        if (act === "cols") { el.addEventListener("toggle", function () { b.open = el.open; save(); }); return; }
        if (act === "col") { el.onchange = function () { var c = b.cols[b.lv], i = c.indexOf(k); if (el.checked && i < 0) { c.push(k); c.sort(function (x, y) { return FIELDS.indexOf(FB[x]) - FIELDS.indexOf(FB[y]); }); } else if (!el.checked && i >= 0) c.splice(i, 1); rerenderKeepScroll(); }; return; }
        if (act === "single") { el.onchange = function () { b.single = el.checked; rerenderKeepScroll(); }; return; }
        if (act === "addby") { el.onchange = function () { if (el.value && b.by.indexOf(el.value) < 0) b.by.push(el.value); b.sort = {}; rerenderKeepScroll(); }; return; }
        if (act === "minus") { el.onchange = function () { b.minus = el.value; rerenderKeepScroll(); }; return; }
        if (act === "ct" || act === "cx" || act === "cy" || act === "cs") { el.onchange = function () { var m = { ct: "type", cx: "x", cy: "y", cs: "s" }[act]; b.chart[m] = el.value; rerenderKeepScroll(); }; return; }
        el.onclick = function () {
          if (act === "lv") { b.lv = el.dataset.v; b.sort = {}; b.by = b.by.filter(function (x) { return FB[x].lv.indexOf(b.lv) >= 0; }); if (b.minus && (blockById(b.minus) || {}).lv !== b.lv) b.minus = ""; }
          else if (act === "clearf") b.f = {};
          else if (act === "rmby") { b.by = b.by.filter(function (x) { return x !== k; }); b.sort = {}; }
          else if (act === "agg") { var i = b.aggs.indexOf(k); if (i >= 0) b.aggs.splice(i, 1); else { b.aggs.push(k); b.aggs.sort(function (x, y) { return AGGS.map(function (a) { return a[0]; }).indexOf(x) - AGGS.map(function (a) { return a[0]; }).indexOf(y); }); } }
          else if (act === "sort") { b.sort = b.sort && b.sort.k === k ? { k: k, dir: -(b.sort.dir || 1) } : { k: k, dir: FB[k] && FB[k].t !== "num" ? 1 : -1 }; }
          else if (act === "sheet") return openSheet(b, k);
          else if (act === "csv") return csv(b);
          else if (act === "dup") { var c = clean(JSON.parse(JSON.stringify(b))); c.id = "t" + (seq++); c.name = (b.name || "Table " + (blocks.indexOf(b) + 1)) + " (copy)"; blocks.splice(blocks.indexOf(b) + 1, 0, c); }
          else if (act === "up") { var j = blocks.indexOf(b); if (j > 0) { blocks.splice(j, 1); blocks.splice(j - 1, 0, b); } }
          else if (act === "rm") { if (!confirm("Remove " + (b.name || "Table " + (blocks.indexOf(b) + 1)) + "?")) return; blocks = blocks.filter(function (x) { return x !== b; }); blocks.forEach(function (x) { if (x.minus === b.id) x.minus = ""; }); if (!blocks.length) blocks = [newBlock({ open: true })]; }
          rerenderKeepScroll();
        };
      });
    });
    $("gadd").onclick = function () { blocks.push(newBlock({ open: true })); render(); var l = host.querySelectorAll(".gblk"); if (l.length) l[l.length - 1].scrollIntoView({ block: "start" }); };
    $("gvsave").onclick = function () { var nm = $("gvname").value.trim().slice(0, 60); if (!nm) { $("gvname").focus(); C.toast("Type a name for the view first."); return; } var v = views(); v[nm] = blocks; try { localStorage.setItem(LSV, JSON.stringify(v)); } catch (e) {} C.toast("Saved view: " + nm); render(); };
    $("gvload").onclick = function () { var nm = $("gview").value, v = views(); if (!nm || !v[nm]) { C.toast("Pick a saved view first."); return; } seq = 1; blocks = v[nm].map(clean); render(); C.toast("Opened: " + nm); };
    $("gvdel").onclick = function () { var nm = $("gview").value, v = views(); if (!nm || !v[nm]) { C.toast("Pick a saved view first."); return; } if (!confirm("Delete the saved view \u201c" + nm + "\u201d?")) return; delete v[nm]; try { localStorage.setItem(LSV, JSON.stringify(v)); } catch (e) {} render(); };
  }

  /* ================= filter sheet ================= */
  function closeSheet() { var s = $("gsheet"); if (s) s.remove(); document.body.classList.remove("noscroll"); sheetState = null; }
  function openSheet(b, k) {
    closeSheet(); var f = FB[k]; if (!f) return;
    var fl = b.f[k] ? JSON.parse(JSON.stringify(b.f[k])) : {}; sheetState = { b: b, k: k, fl: fl };
    var el = document.createElement("div"); el.id = "gsheet"; el.className = "gsheet";
    var h = '<div class="gsh-bg" data-x="1"></div><div class="gsh" role="dialog" aria-modal="true" aria-label="Filter ' + esc(f.l) + '"><div class="gsh-h"><b>FILTER: ' + esc(f.l.toUpperCase()) + '</b><button type="button" class="ghost" id="gshx">CLOSE</button></div>';
    if (f.t === "cat" || f.t === "multi") {
      var cnt = {}; rowsBy[b.lv].forEach(function (r) { vals(r, f).forEach(function (v) { cnt[v] = (cnt[v] || 0) + 1; }); });
      var keys = Object.keys(cnt).sort(function (a, c) { return cmpKey(f, a, c); }); fl.x = fl.x || [];
      sheetState.keys = keys;
      h += '<input class="in" id="gshq" placeholder="Search, e.g. ' + esc(keys[0] && keys[0] !== UNK ? keyShow(f, keys[0]) : "Grease") + '" autocomplete="off">' +
        '<div class="gbtns"><button type="button" id="gshall" class="ghost">SELECT ALL</button><button type="button" id="gshnone" class="ghost">SELECT NONE</button></div>' +
        '<div class="gshl" id="gshl">' + keys.map(function (v) { return '<label data-v="' + esc(v) + '"><input type="checkbox" value="' + esc(v) + '"' + (fl.x.indexOf(v) < 0 ? " checked" : "") + '> <span>' + esc(keyShow(f, v)) + '</span><i>' + cnt[v] + '</i></label>'; }).join("") + '</div>' +
        (f.t === "multi" ? '<p class="muted gnote">A row with several values is left out when any of them is unticked.</p>' : "");
    } else {
      var hint = { size: ".375", pct: "10", lbs: "4000", hrs: "8", coils: "2", int: f.k === "card" ? "336000" : "18", rate: "2500", min: "30" }[f.f || "lbs"];
      h += f.t === "date" ? '<div class="grow2"><div class="field"><label class="lbl" for="gshmin">From</label><input class="in" type="date" id="gshmin" value="' + esc(fl.from || "") + '"></div><div class="field"><label class="lbl" for="gshmax">To</label><input class="in" type="date" id="gshmax" value="' + esc(fl.to || "") + '"></div></div>'
        : '<div class="grow2"><div class="field"><label class="lbl" for="gshmin">At least</label><input class="in" id="gshmin" inputmode="decimal" autocomplete="off" placeholder="e.g. ' + hint + '" value="' + esc(fl.min !== undefined ? fl.min : "") + '"></div><div class="field"><label class="lbl" for="gshmax">At most</label><input class="in" id="gshmax" inputmode="decimal" autocomplete="off" placeholder="e.g. ' + hint + '" value="' + esc(fl.max !== undefined ? fl.max : "") + '"></div></div>' +
          (f.f === "size" ? '<p class="muted gnote">Inches. \u201cUnder .375\u201d: at most .374.</p>' : f.f === "pct" ? '<p class="muted gnote">Percent. \u201cUnder 10%\u201d: at most 9.99.</p>' : "");
      var blanks = rowsBy[b.lv].filter(function (r) { var v = r[k]; return v === null || v === undefined || v === ""; }).length;
      h += '<label class="gtog"><input type="checkbox" id="gshblank"' + (fl.blank === true || (fl.blank === undefined && !isOn(fl)) ? " checked" : "") + '> Keep blanks (unknown): ' + blanks + ' row' + (blanks === 1 ? "" : "s") + '</label>';
    }
    h += '<div class="gbtns"><button type="button" id="gshclr" class="ghost">CLEAR</button><button type="button" id="gshok">APPLY</button></div></div>';
    el.innerHTML = h; document.body.appendChild(el); document.body.classList.add("noscroll");
    var done = function (apply) {
      if (apply) {
        if (f.t === "cat" || f.t === "multi") { var x = []; Array.prototype.forEach.call(el.querySelectorAll("#gshl input"), function (c) { if (!c.checked) x.push(c.value); }); fl.x = x; if (!x.length) delete b.f[k]; else b.f[k] = { x: x }; }
        else {
          var a = $("gshmin").value.trim(), z = $("gshmax").value.trim(), bl = $("gshblank").checked, o = {};
          if (f.t === "date") { if (a) o.from = a; if (z) o.to = z; } else {
            if (a && n(a) === null) { C.toast("At least: type a number."); return; } if (z && n(z) === null) { C.toast("At most: type a number."); return; }
            if (a) o.min = a; if (z) o.max = z; }
          var rng = Object.keys(o).length; if (rng && bl) o.blank = true; if (!rng && !bl) o.blank = false;
          if (Object.keys(o).length) b.f[k] = o; else delete b.f[k];
        }
      }
      closeSheet(); rerenderKeepScroll();
    };
    el.querySelector(".gsh-bg").onclick = function () { closeSheet(); };
    $("gshx").onclick = function () { closeSheet(); };
    $("gshok").onclick = function () { done(true); };
    $("gshclr").onclick = function () { delete b.f[k]; closeSheet(); rerenderKeepScroll(); };
    if ($("gshq")) {
      $("gshq").oninput = function () { var q = $("gshq").value.trim().toLowerCase(); Array.prototype.forEach.call(el.querySelectorAll("#gshl label"), function (l) { l.hidden = q && l.textContent.toLowerCase().indexOf(q) < 0; }); };
      var setAll = function (on) { Array.prototype.forEach.call(el.querySelectorAll("#gshl label"), function (l) { if (!l.hidden) l.querySelector("input").checked = on; }); };
      $("gshall").onclick = function () { setAll(true); }; $("gshnone").onclick = function () { setAll(false); };
    }
    document.addEventListener("keydown", function kd(e) { if (e.key === "Escape") { closeSheet(); document.removeEventListener("keydown", kd); } });
    var first = el.querySelector("input,button"); if (first) first.focus();
  }

  /* ================= CSV ================= */
  function csv(b) {
    var M = model(b), cell = E.csvCell, lines = [M.head.map(function (h) { return cell(h.l); }).join(",")];
    M.raw.forEach(function (r) { lines.push(r.map(function (v) { return cell(v === null || v === undefined ? "" : typeof v === "number" ? Math.round(v * 1000) / 1000 : v); }).join(",")); });
    var nm = (b.name || "table-" + (blocks.indexOf(b) + 1)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";
    var name = "granular-" + nm + "-" + E.ymd(new Date()) + ".csv", blob = new Blob(["\uFEFF" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); C.toast("CSV saved: " + name);
  }

  /* ================= charts (SVG) ================= */
  function niceMax(v) { if (!(v > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), q = v / p; return (q <= 1 ? 1 : q <= 2 ? 2 : q <= 2.5 ? 2.5 : q <= 5 ? 5 : 10) * p; }
  function yF(v) { var a = Math.abs(v); return a >= 10000 ? Math.round(v / 1000) + "k" : a >= 1000 ? (Math.round(v / 100) / 10) + "k" : String(Math.round(v * 100) / 100); }
  function short(s, n2) { s = String(s); return s.length > n2 ? s.slice(0, Math.max(n2 - 1, 1)) + "\u2026" : s; }
  function chart(el, b) {
    var ty = b.chart.type; if (ty === "none") { el.innerHTML = ""; return; }
    var rs = rowsOf(b), W = Math.max(el.clientWidth || 320, 260), xk = chartX(b), yk = chartY(b), sk = ty === "pie" ? "" : (b.chart.s && FB[b.chart.s] && FB[b.chart.s].lv.indexOf(b.lv) >= 0 ? b.chart.s : "");
    if (!rs.length) { el.innerHTML = '<div class="msg">Nothing to chart: no rows match.</div>'; return; }
    var svg = '<svg class="chart" width="' + W + '" height="__H__" viewBox="0 0 ' + W + ' __H__" role="img" aria-label="Chart">', H = 0, g = "";
    var leg = function (names) { return names.length > 1 || sk ? '<div class="legend gleg">' + names.map(function (s, i) { return '<span><i style="background:' + PAL[i % PAL.length] + '"></i>' + esc(s) + '</span>'; }).join("") + '</div>' : ""; };
    if (ty === "scatter") {
      var fx = FB[xk], fy = FB[yk], ser = sk ? [] : [""];
      var pts = rs.filter(function (r) { return r[xk] !== null && r[xk] !== undefined && r[yk] !== null && r[yk] !== undefined; }).map(function (r) { var s = sk ? keyShow(FB[sk], vals(r, FB[sk])[0]) : ""; if (ser.indexOf(s) < 0) ser.push(s); return { x: r[xk], y: r[yk], s: s, t: show(fx, r[xk]) + ", " + show(fy, r[yk]) + (r.op ? " \u00b7 " + r.op : "") + (r.date ? " \u00b7 " + C.day(r.date, true) : "") }; });
      if (!pts.length) { el.innerHTML = '<div class="msg">No rows have both ' + esc(fx.l) + ' and ' + esc(fy.l) + '.</div>'; return; }
      H = W < 480 ? 240 : 300; var L = 48, R = 12, T = 12, B = 32;
      var x0 = Math.min.apply(null, pts.map(function (p) { return p.x; })), x1 = Math.max.apply(null, pts.map(function (p) { return p.x; })), y1 = niceMax(Math.max.apply(null, pts.map(function (p) { return p.y; })) * 1.05);
      var y0 = Math.min(0, Math.min.apply(null, pts.map(function (p) { return p.y; }))); if (x1 === x0) { x0 -= 1; x1 += 1; } var pad = (x1 - x0) * 0.05; x0 -= pad; x1 += pad;
      var X = function (v) { return L + (v - x0) / (x1 - x0) * (W - L - R); }, Y = function (v) { return T + (H - T - B) * (1 - (v - y0) / (y1 - y0)); };
      for (var i = 0; i <= 4; i++) { var yv = y0 + (y1 - y0) * i / 4; g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '" class="grid"/><text x="' + (L - 5) + '" y="' + (Y(yv) + 4) + '" text-anchor="end" class="ax">' + yF(yv) + '</text>'; }
      for (var t = 0; t <= 4; t++) { var xv = x0 + (x1 - x0) * t / 4; g += '<text x="' + X(xv) + '" y="' + (H - 12) + '" text-anchor="middle" class="ax">' + esc(fx.f === "size" ? sizeTxt(xv) : yF(xv)) + '</text>'; }
      g += '<text x="' + (W - R) + '" y="' + (H - 1) + '" text-anchor="end" class="ax">' + esc(fx.l) + ' \u2192</text>';
      pts.forEach(function (p) { g += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="4" fill="' + PAL[ser.indexOf(p.s) % PAL.length] + '" fill-opacity=".8"><title>' + esc(p.t) + '</title></circle>'; });
      el.innerHTML = svg.replace(/__H__/g, H).replace('aria-label="Chart"', 'aria-label="' + esc(fy.l + " by " + fx.l) + '"') + g + '</svg>' + (sk ? leg(ser) : ""); return;
    }
    // categories on X, Y = an aggregate, optional series
    var fxk = FB[xk], gs = groups(rs, sk ? [xk, sk] : [xk]), cats = [], sers = [], cell = {};
    gs.forEach(function (q) { var c = q.keys[0], s = sk ? q.keys[1] : ""; if (cats.indexOf(c) < 0) cats.push(c); if (sers.indexOf(s) < 0) sers.push(s); cell[c + "\u0001" + s] = agg(q.rows)[yk]; });
    cats.sort(function (a, c) { return cmpKey(fxk, a, c); }); if (sk) sers.sort(function (a, c) { return cmpKey(FB[sk], a, c); });
    var labels = cats.map(function (c) { return keyShow(fxk, c); }), snames = sers.map(function (s) { return sk ? keyShow(FB[sk], s) : AGGS.filter(function (a) { return a[0] === yk; })[0][1]; });
    var val = function (c, s) { var v = cell[c + "\u0001" + s]; return v === null || v === undefined ? null : v; }, fy2 = function (v) { return v === null ? "\u2013" : FMT[AGF[yk]](v); };
    if (ty === "pie") {
      var it = cats.map(function (c, i) { return { l: labels[i], v: Math.max(val(c, "") || 0, 0) }; }).filter(function (x) { return x.v > 0; }), tot = it.reduce(function (a, x) { return a + x.v; }, 0);
      if (!tot) { el.innerHTML = '<div class="msg">Nothing above zero to chart.</div>'; return; }
      var r0 = Math.min(W * 0.32, 110), cx = r0 + 6, cy = r0 + 6, a0 = -Math.PI / 2; H = r0 * 2 + 12;
      it.forEach(function (x, i) { var a1 = a0 + x.v / tot * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0, col = PAL[i % PAL.length];
        g += it.length === 1 ? '<circle cx="' + cx + '" cy="' + cy + '" r="' + r0 + '" fill="' + col + '"/>' : '<path d="M' + cx + ',' + cy + ' L' + (cx + r0 * Math.cos(a0)).toFixed(1) + ',' + (cy + r0 * Math.sin(a0)).toFixed(1) + ' A' + r0 + ',' + r0 + ' 0 ' + big + ' 1 ' + (cx + r0 * Math.cos(a1)).toFixed(1) + ',' + (cy + r0 * Math.sin(a1)).toFixed(1) + ' Z" fill="' + col + '" stroke="#030a03" stroke-width="1.5"><title>' + esc(x.l + ": " + fy2(x.v)) + '</title></path>'; a0 = a1; });
      var lx = cx * 2 + 14, cw = Math.max(Math.floor((W - lx) / 8), 6);
      it.slice(0, Math.floor(H / 20)).forEach(function (x, i) { g += '<rect x="' + lx + '" y="' + (8 + i * 20) + '" width="10" height="10" fill="' + PAL[i % PAL.length] + '"/><text x="' + (lx + 15) + '" y="' + (17 + i * 20) + '" class="ax"><title>' + esc(x.l) + '</title>' + esc(short(x.l + " " + Math.round(x.v / tot * 100) + "%", cw)) + '</text>'; });
      el.innerHTML = svg.replace(/__H__/g, H) + g + '</svg>'; return;
    }
    if (ty === "hbar") {
      var rh = Math.max(16, 26 / Math.max(1, Math.min(sers.length, 3))) * sers.length + 8, lw = Math.min(Math.round(W * 0.34), 160), vw = 64, cwl = Math.floor(lw / 8);
      var mx = Math.max.apply(null, cats.map(function (c) { return Math.max.apply(null, sers.map(function (s) { return val(c, s) || 0; })); })) || 1; H = cats.length * rh + 4;
      var bh = (rh - 8) / sers.length;
      cats.forEach(function (c, i) { var y = i * rh + 2; g += '<text x="0" y="' + (y + rh / 2 + 4) + '" class="bl"><title>' + esc(labels[i]) + '</title>' + esc(short(labels[i], cwl)) + '</text>';
        sers.forEach(function (s, j) { var v = val(c, s) || 0, w = Math.max(v / mx * (W - lw - vw - 8), v ? 2 : 0), yy = y + 4 + j * bh;
          g += '<rect x="' + lw + '" y="' + yy.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(bh - 2, 2).toFixed(1) + '" fill="' + PAL[j % PAL.length] + '"><title>' + esc(labels[i] + (sk ? " \u00b7 " + snames[j] : "") + ": " + fy2(val(c, s))) + '</title></rect>' +
            (sers.length <= 3 ? '<text x="' + (lw + w + 5).toFixed(1) + '" y="' + (yy + bh / 2 + 3).toFixed(1) + '" class="ax">' + esc(fy2(val(c, s))) + '</text>' : ""); }); });
      el.innerHTML = svg.replace(/__H__/g, H) + g + '</svg>' + leg(snames); return;
    }
    // vertical: bar (clustered), stack, line
    H = W < 480 ? 240 : 290; var L2 = 46, R2 = 8, T2 = 12, B2 = 46, pw = W - L2 - R2, ph = H - T2 - B2, nC = cats.length;
    var tops = cats.map(function (c) { return ty === "stack" ? sers.reduce(function (a, s) { return a + Math.max(val(c, s) || 0, 0); }, 0) : Math.max.apply(null, sers.map(function (s) { return val(c, s) || 0; })); });
    var ymx = niceMax(Math.max.apply(null, tops) * 1.05), Yv = function (v) { return T2 + ph * (1 - v / ymx); };
    for (var k2 = 0; k2 <= 4; k2++) { var yy2 = ymx * k2 / 4; g += '<line x1="' + L2 + '" x2="' + (W - R2) + '" y1="' + Yv(yy2) + '" y2="' + Yv(yy2) + '" class="grid"/><text x="' + (L2 - 5) + '" y="' + (Yv(yy2) + 4) + '" text-anchor="end" class="ax">' + yF(yy2) + '</text>'; }
    var step = pw / Math.max(nC, 1), every = Math.ceil(nC / Math.max(1, Math.floor(pw / 46))), cwv = Math.max(Math.floor(step * every / 7), 3);
    cats.forEach(function (c, i) { if (i % every) return; var xc = L2 + step * (i + 0.5); g += '<text x="' + xc.toFixed(1) + '" y="' + (H - B2 + 14) + '" text-anchor="middle" class="ax"><title>' + esc(labels[i]) + '</title>' + esc(short(labels[i], cwv)) + '</text>'; });
    if (ty === "line") {
      sers.forEach(function (s, j) { var p = cats.map(function (c, i) { var v = val(c, s); return v === null ? null : [L2 + step * (i + 0.5), Yv(v), labels[i] + (sk ? " \u00b7 " + snames[j] : "") + ": " + fy2(v)]; }).filter(Boolean);
        if (p.length > 1) g += '<polyline fill="none" stroke="' + PAL[j % PAL.length] + '" stroke-width="2.5" points="' + p.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ") + '"/>';
        p.forEach(function (q) { g += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="4" fill="' + PAL[j % PAL.length] + '"><title>' + esc(q[2]) + '</title></circle>'; }); });
    } else {
      var bw = step * 0.78, nS = ty === "stack" ? 1 : sers.length;
      cats.forEach(function (c, i) { var x0b = L2 + step * i + (step - bw) / 2, acc = 0;
        sers.forEach(function (s, j) { var v = Math.max(val(c, s) || 0, 0); if (!v) return; var w = bw / nS, x = ty === "stack" ? x0b : x0b + j * w, yb = ty === "stack" ? Yv(acc + v) : Yv(v), hb = ty === "stack" ? Yv(acc) - Yv(acc + v) : Yv(0) - Yv(v); acc += v;
          g += '<rect x="' + x.toFixed(1) + '" y="' + yb.toFixed(1) + '" width="' + Math.max(w - (nS > 1 ? 1 : 0), 1).toFixed(1) + '" height="' + Math.max(hb, 0).toFixed(1) + '" fill="' + PAL[j % PAL.length] + '"><title>' + esc(labels[i] + (sk ? " \u00b7 " + snames[j] : "") + ": " + fy2(val(c, s))) + '</title></rect>'; });
        if (nC <= 12 && (ty === "stack" || nS === 1)) g += '<text x="' + (x0b + bw / 2).toFixed(1) + '" y="' + (Yv(tops[i]) - 4).toFixed(1) + '" text-anchor="middle" class="ax">' + esc(yF(tops[i])) + '</text>'; });
    }
    el.innerHTML = svg.replace(/__H__/g, H) + g + '</svg>' + leg(snames);
  }

  /* ================= shell ================= */
  function showIn(el, ctx, j, engine) {
    C = ctx; E = engine; host = el;
    if (data !== j) { data = j; rowsBy = buildRows(j); }
    if (!blocks.length) restore();
    render();
  }
  var rt; if (typeof window !== "undefined") window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { if (host && host.isConnected && rowsBy) drawCharts(); }, 200); });
  var api = { show: showIn, _test: { buildRows: buildRows, pass: pass, agg: agg, groups: groups, model: model, set: function (b) { blocks = b.map(clean); return blocks; }, rowsOf: rowsOf, init: function (ctx, engine, j) { C = ctx; E = engine; data = j; rowsBy = buildRows(j); } } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Granular = api;
})(typeof window !== "undefined" ? window : globalThis);
