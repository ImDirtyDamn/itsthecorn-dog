/* ANALYZE tab for the Master Log.
   Data: GET /analyze (admin) -> logs + coil rows + machine rows + downtime rows.
   Everything is broken into "parts" = one coil/card row of one log. Each part carries its share of the
   log's lbs, hours and downtime (share = row weight / log's coil weight), so grade, finish size and Draw
   filters work at the row level and totals still add up to the logs. lb/hr is always total lb / total hr. */
(function (root) {
  "use strict";

  /* ================= pure engine (also tested in node) ================= */
  function opKey(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }
  function shiftKind(l) {
    var s = String(l.shift_label || "").toLowerCase();
    if (/night|nite|3rd|2nd|third|second|pm\s*-/.test(s)) return "Night";
    if (/day|1st|first|am\s*-/.test(s)) return "Day";
    var m = /^(\d{1,2}):/.exec(l.shift_start || "");
    if (m) { var h = +m[1]; return h >= 4 && h < 14 ? "Day" : "Night"; }
    return "Not given";
  }
  function coilCount(c) {
    if (c.coils_in !== null && c.coils_in !== undefined && c.coils_in !== "") return +c.coils_in || 0;
    if (c.coils_out !== null && c.coils_out !== undefined && c.coils_out !== "") return +c.coils_out || 0;
    var m = /^\s*(\d+(?:\.\d+)?)/.exec(c.coils_text || ""); return m ? +m[1] : 0;
  }
  function num(v) { return v === null || v === undefined || v === "" || isNaN(+v) ? null : +v; }
  function drawList(s) { return String(s || "").split(",").filter(Boolean); }

  function buildParts(data) {
    var by = function (rows) { var o = {}; (rows || []).forEach(function (r) { (o[r.log_id] = o[r.log_id] || []).push(r); }); return o; };
    var coils = by(data.coils), downs = by(data.downtime), parts = [];
    (data.logs || []).forEach(function (l) {
      var D = drawList(l.draws), cs = coils[l.id] || [];
      var base = { log_id: l.id, date: l.shift_date, op: String(l.operator || "").trim().replace(/\s+/g, " "), opKey: opKey(l.operator),
        shift: shiftKind(l), goal: num(l.goal_lbhr), submitted: l.submitted_at || "" };
      var raw = cs.length ? cs.map(function (c) {
        return { draw: c.draw !== null && c.draw !== undefined && c.draw !== "" ? String(c.draw) : "", grade: String(c.grade || "").trim(),
          finish: String(c.finish || "").trim(), w: Math.max(num(c.weight) || 0, 0), coils: coilCount(c) };
      }) : [{ draw: "", grade: "", finish: "", w: 0, coils: 0 }];
      var wsum = raw.reduce(function (a, r) { return a + r.w; }, 0);
      raw.forEach(function (r) { r.share = wsum > 0 ? r.w / wsum : 1 / raw.length; });
      var total = num(l.total_lbs); if (total === null && wsum > 0) total = wsum;
      var hours = num(l.net_hours); if (hours !== null && hours <= 0) hours = null;
      // downtime: rows naming a Draw go to that Draw's parts, the rest is spread over every part (by weight share)
      raw.forEach(function (r) { r.dt = 0; });
      var dts = downs[l.id] || [], dtRows = dts.reduce(function (a, d) { return a + (num(d.minutes) || 0); }, 0);
      var spread = function (min, list) { var s = list.reduce(function (a, r) { return a + r.share; }, 0); list.forEach(function (r) { r.dt += s > 0 ? min * r.share / s : min / list.length; }); };
      if (dts.length && dtRows > 0) dts.forEach(function (d) {
        var m = num(d.minutes) || 0; if (!m) return;
        var dd = d.draw !== null && d.draw !== undefined ? String(d.draw) : "";
        var on = dd ? raw.filter(function (r) { return r.draw === dd || (!r.draw && D.indexOf(dd) >= 0); }) : [];
        spread(m, on.length ? on : raw);
      });
      else if (num(l.downtime_minutes)) spread(num(l.downtime_minutes), raw);
      raw.forEach(function (r) {
        var targets = r.draw ? [r.draw] : (D.length ? D : [""]), k = targets.length;
        targets.forEach(function (d) {
          parts.push(Object.assign({}, base, { draw: d, grade: r.grade, finish: r.finish,
            lbs: total === null ? null : total * r.share / k, coils: r.coils / k, hours: hours === null ? null : hours * r.share / k,
            dt: r.dt / k, rated: total !== null && hours !== null }));
        });
      });
    });
    return parts;
  }

  function emptyF() { return { from: "", to: "", ops: [], draws: [], shifts: [], grades: [], finishes: [] }; }
  function inSet(list, v) { return !list || !list.length || list.indexOf(v) >= 0; }
  function filterParts(parts, f) {
    f = f || {};
    return parts.filter(function (p) {
      return (!f.from || p.date >= f.from) && (!f.to || p.date <= f.to) && inSet(f.ops, p.opKey) && inSet(f.draws, p.draw) &&
        inSet(f.shifts, p.shift) && inSet(f.grades, p.grade) && inSet(f.finishes, p.finish);
    });
  }
  function agg(parts) {
    var a = { lbs: 0, coils: 0, hours: 0, dt: 0, rlbs: 0, rhours: 0, logs: {} };
    parts.forEach(function (p) {
      a.lbs += p.lbs || 0; a.coils += p.coils || 0; a.hours += p.hours || 0; a.dt += p.dt || 0; a.logs[p.log_id] = 1;
      if (p.rated) { a.rlbs += p.lbs; a.rhours += p.hours; }
    });
    return { lbs: a.lbs, coils: a.coils, hours: a.hours, dt: a.dt, shifts: Object.keys(a.logs).length, lbhr: a.rhours > 0 ? a.rlbs / a.rhours : null };
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseYmd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function weekKey(s) { var d = parseYmd(s); if (!d) return s; d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }
  function dayNum(s) { var d = parseYmd(s); return d ? Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5) : 0; }
  var KEYS = {
    day: function (p) { return p.date; }, week: function (p) { return weekKey(p.date); }, operator: function (p) { return p.opKey; },
    draw: function (p) { return p.draw; }, grade: function (p) { return p.grade; }, finish: function (p) { return p.finish; }, shift: function (p) { return p.shift; }
  };
  function groupBy(parts, by) {
    var fn = KEYS[by], m = {}, order = [];
    parts.forEach(function (p) { var k = fn(p); if (!m[k]) { m[k] = []; order.push(k); } m[k].push(p); });
    return order.map(function (k) { var r = agg(m[k]); r.key = k; if (by === "operator") r.op = m[k][m[k].length - 1].op; return r; });
  }
  // one point per shift (log) in the parts
  function shiftPoints(parts) {
    return groupBy(parts, "day").length ? Object.values(parts.reduce(function (o, p) { (o[p.log_id] = o[p.log_id] || []).push(p); return o; }, {}))
      .map(function (ps) { var a = agg(ps); return { log_id: ps[0].log_id, date: ps[0].date, submitted: ps[0].submitted, op: ps[0].op, goal: ps[0].goal, lbs: a.lbs, hours: a.hours, lbhr: a.lbhr }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.submitted < b.submitted ? -1 : 1; }) : [];
  }
  function fitLine(pts) { // least squares y = a + b x
    var n = pts.length; if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(function (p) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; });
    var den = n * sxx - sx * sx; if (!den) return null;
    var b = (n * sxy - sx * sy) / den; return { b: b, a: (sy - b * sx) / n };
  }
  function progressStats(points, x0) {
    var rated = points.filter(function (p) { return p.lbhr !== null; });
    var tl = 0, th = 0; rated.forEach(function (p) { tl += p.lbs; th += p.hours; });
    var best = rated.reduce(function (b, p) { return !b || p.lbhr > b.lbhr ? p : b; }, null);
    var xy = rated.map(function (p) { return { x: dayNum(p.date) - x0, y: p.lbhr }; });
    var fit = fitLine(xy), change = null, pct = null, start = null;
    if (fit && xy.length) {
      var xa = Math.min.apply(null, xy.map(function (q) { return q.x; })), xb = Math.max.apply(null, xy.map(function (q) { return q.x; }));
      start = fit.a + fit.b * xa; change = fit.b * (xb - xa); pct = start > 0 ? change * 100 / start : null;
    }
    var goals = rated.filter(function (p) { return p.goal; });
    return { shifts: points.length, avg: th > 0 ? tl / th : null, best: best, fit: fit, change: change, pct: pct,
      goalN: goals.length, goalMet: goals.filter(function (p) { return p.lbhr >= p.goal; }).length };
  }
  function bucketSeries(parts, unit) {
    var rows = groupBy(parts, unit === "week" ? "week" : "day"), o = {};
    rows.forEach(function (r) { o[r.key] = r; }); return o;
  }
  function csvCell(v) {
    if (v === null || v === undefined) return ""; if (typeof v === "number") return String(v);
    var s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var engine = { opKey: opKey, shiftKind: shiftKind, coilCount: coilCount, buildParts: buildParts, filterParts: filterParts, agg: agg, groupBy: groupBy,
    shiftPoints: shiftPoints, fitLine: fitLine, progressStats: progressStats, bucketSeries: bucketSeries, weekKey: weekKey, dayNum: dayNum, ymd: ymd,
    parseYmd: parseYmd, emptyF: emptyF, csvCell: csvCell };
  if (typeof module !== "undefined" && module.exports) { module.exports = engine; return; }

  /* ================= UI ================= */
  var C, data = null, parts = [], opts = null, host = null, rerender = null;
  var LS = "analyzeSetupV1", PAL = ["#39ff6a", "#ffc23d", "#4dd0ff", "#ff6bd6", "#ff5f56", "#eaffea", "#b48cff", "#ff9a3d"];
  var METRICS = { lbs: "Total lb", coils: "Coils", hours: "Hours", lbhr: "Lb/hr", shifts: "Shifts", dt: "Downtime hr" };
  var BYS = { day: "Day", week: "Week", operator: "Operator", draw: "Draw", grade: "Grade", finish: "Finish size", shift: "Shift" };
  var S = { sub: "compare", unit: "day", metric: "lbs", series: [], seq: 0,
    group: { f: emptyF(), by: "operator", metric: "lbhr", sort: { col: "", dir: -1 } },
    prog: { op: "", from: "", to: "", cmp: "off", op2: "", from2: "", to2: "" } };
  var open = {};   // which panels are expanded

  function esc(s) { return C.esc(s); }
  function $(id) { return document.getElementById(id); }
  function mval(r, m) { return m === "dt" ? r.dt / 60 : r[m]; }
  function fmt(m, v) {
    if (v === null || v === undefined || isNaN(v)) return "\u2013";
    if (m === "lbhr" || m === "hours" || m === "dt") return C.n1(v);
    if (m === "coils") return Math.abs(v - Math.round(v)) < 0.05 ? C.n0(v) : C.n1(v);
    return C.n0(v);
  }
  function short(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "\u2026" : s; }
  function md(s) { var d = parseYmd(s); return d ? (d.getMonth() + 1) + "/" + d.getDate() : s; }
  function keyLabel(by, r) {
    if (by === "day") return C.day(r.key); if (by === "week") return "Wk of " + C.day(r.key);
    if (by === "operator") return r.op || r.key; if (by === "draw") return r.key ? "Draw " + r.key : "No Draw";
    return r.key || "(not written)";
  }
  function color(i) { if (i < PAL.length) return PAL[i]; var h = (i * 137) % 360; return "hsl(" + h + ",90%,62%)"; }
  function hexOk(c) { return /^#[0-9a-f]{6}$/i.test(c || "") ? c : null; }

  /* ---- persistence: localStorage + share link in the URL hash ---- */
  function cleanF(f) {
    var e = emptyF(), out = {}; f = f && typeof f === "object" ? f : {};
    Object.keys(e).forEach(function (k) {
      if (Array.isArray(e[k])) out[k] = Array.isArray(f[k]) ? f[k].filter(function (x) { return typeof x === "string"; }).slice(0, 200).map(function (x) { return x.slice(0, 80); }) : [];
      else out[k] = typeof f[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f[k]) ? f[k] : "";
    });
    return out;
  }
  function cleanSeries(list) {
    return (Array.isArray(list) ? list : []).slice(0, 100).map(function (s, i) {
      return { id: ++S.seq, name: String(s && s.name || "Series " + (i + 1)).slice(0, 40), color: hexOk(s && s.color) || color(i), hidden: !!(s && s.hidden), f: cleanF(s && s.f) };
    });
  }
  function enc(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function dec(s) { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))))); }
  function shareObj() { return { u: S.unit, m: S.metric, s: S.series.map(function (s) { return { name: s.name, color: s.color, hidden: s.hidden, f: s.f }; }) }; }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify({ sub: S.sub, cmp: shareObj(), group: S.group, prog: S.prog })); } catch (e) {}
  }
  function applyCmp(o) {
    if (!o || typeof o !== "object") return;
    if (o.u === "day" || o.u === "week") S.unit = o.u;
    if (["lbs", "coils", "hours", "lbhr"].indexOf(o.m) >= 0) S.metric = o.m;
    var ss = cleanSeries(o.s); if (ss.length) S.series = ss;
  }
  function restore() {
    try {
      var j = JSON.parse(localStorage.getItem(LS) || "null");
      if (j) {
        if (["compare", "group", "progress"].indexOf(j.sub) >= 0) S.sub = j.sub;
        applyCmp(j.cmp);
        if (j.group) { S.group.f = cleanF(j.group.f); if (BYS[j.group.by]) S.group.by = j.group.by; if (METRICS[j.group.metric]) S.group.metric = j.group.metric; }
        if (j.prog) Object.keys(S.prog).forEach(function (k) { if (typeof j.prog[k] === "string") S.prog[k] = j.prog[k].slice(0, 80); });
      }
    } catch (e) {}
    var m = /[#&]cmp=([A-Za-z0-9_-]+)/.exec(location.hash || "");
    if (m) { try { applyCmp(dec(m[1])); S.sub = "compare"; save(); } catch (e) {} }
    if (!S.series.length) S.series = [newSeries()];
  }
  function newSeries(copyF) { var i = S.series.length; return { id: ++S.seq, name: "Series " + (i + 1), color: color(i), hidden: false, f: copyF ? cleanF(JSON.parse(JSON.stringify(copyF))) : emptyF() }; }

  /* ---- options from the data ---- */
  function buildOpts() {
    var ops = {}, grades = {}, fins = {};
    parts.forEach(function (p) { ops[p.opKey] = p.op; if (p.grade) grades[p.grade] = 1; if (p.finish) fins[p.finish] = 1; });
    var srt = function (o) { return Object.keys(o).sort(function (a, b) { return a.localeCompare(b, "en", { numeric: true }); }); };
    opts = { ops: srt(ops).map(function (k) { return { v: k, t: ops[k] }; }), grades: srt(grades).map(function (g) { return { v: g, t: g }; }),
      finishes: srt(fins).map(function (g) { return { v: g, t: g }; }), draws: "123456789".split("").map(function (d) { return { v: d, t: d }; }),
      shifts: ["Day", "Night", "Not given"].map(function (s) { return { v: s, t: s }; }) };
  }

  /* ---- filter editor (shared by every series and the group builder) ---- */
  function fSummary(f) {
    var p = [];
    if (f.from || f.to) p.push((f.from ? md(f.from) : "start") + "\u2013" + (f.to ? md(f.to) : "now"));
    var nm = function (list, all, pre) { if (!list.length) return; p.push(list.length > 2 ? list.length + " " + pre : list.map(function (v) { var o = all.filter(function (x) { return x.v === v; })[0]; return (pre === "draws" ? "D" : "") + (o ? o.t : v); }).join(", ")); };
    nm(f.ops, opts.ops, "operators"); nm(f.draws, opts.draws, "draws"); nm(f.grades, opts.grades, "grades"); nm(f.finishes, opts.finishes, "sizes"); nm(f.shifts, opts.shifts, "shifts");
    return p.length ? p.join(" \u00b7 ") : "everything";
  }
  function chipRow(pfx, key, label, list, sel, prefix) {
    if (!list.length) return '<div class="field"><span class="lbl">' + label + '</span><p class="muted" style="margin:0;font-size:13px">None written on any log yet.</p></div>';
    return '<div class="field"><span class="lbl">' + label + ' <em class="muted">' + (sel.length ? sel.length + " picked" : "all") + '</em></span><div class="fchips">' +
      '<button type="button" data-fk="' + key + '" data-fv="" class="' + (sel.length ? "" : "on") + '">ALL</button>' +
      list.map(function (o) { return '<button type="button" data-fk="' + key + '" data-fv="' + esc(o.v) + '" class="' + (sel.indexOf(o.v) >= 0 ? "on" : "") + '">' + esc((prefix || "") + o.t) + '</button>'; }).join("") + '</div></div>';
  }
  function fEditor(pfx, f) {
    return '<div class="quick" data-quick="' + pfx + '"><button type="button" data-q="7">7 DAYS</button><button type="button" data-q="30">30 DAYS</button><button type="button" data-q="month">MONTH</button><button type="button" data-q="all">ALL</button></div>' +
      '<div class="row2"><div class="field"><label class="lbl" for="' + pfx + 'from">From</label><input class="in" type="date" data-fd="from" id="' + pfx + 'from" value="' + esc(f.from) + '"></div>' +
      '<div class="field"><label class="lbl" for="' + pfx + 'to">To</label><input class="in" type="date" data-fd="to" id="' + pfx + 'to" value="' + esc(f.to) + '"></div></div>' +
      chipRow(pfx, "ops", "Operators", opts.ops, f.ops) + chipRow(pfx, "draws", "Machines (Draw)", opts.draws, f.draws, "D") +
      chipRow(pfx, "grades", "Grades", opts.grades, f.grades) + chipRow(pfx, "finishes", "Finish sizes", opts.finishes, f.finishes) +
      chipRow(pfx, "shifts", "Shift", opts.shifts, f.shifts);
  }
  function wireEditor(box, f, onChange) {
    Array.prototype.forEach.call(box.querySelectorAll("[data-fk]"), function (b) {
      b.onclick = function () {
        var k = b.dataset.fk, v = b.dataset.fv;
        if (!v) f[k] = []; else { var i = f[k].indexOf(v); if (i >= 0) f[k].splice(i, 1); else f[k].push(v); }
        onChange();
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-fd]"), function (inp) { inp.onchange = function () { f[inp.dataset.fd] = inp.value; onChange(); }; });
    Array.prototype.forEach.call(box.querySelectorAll("[data-quick] button"), function (b) {
      b.onclick = function () {
        var q = b.dataset.q, d = new Date();
        if (q === "all") { f.from = ""; f.to = ""; }
        else if (q === "month") { f.from = ymd(new Date(d.getFullYear(), d.getMonth(), 1)); f.to = ""; }
        else { f.from = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (+q - 1))); f.to = ""; }
        onChange();
      };
    });
  }

  /* ---- SVG charts ---- */
  function niceMax(v) { if (!(v > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
  function yFmt(v) { return v >= 10000 ? Math.round(v / 1000) + "k" : v >= 1000 ? (Math.round(v / 100) / 10) + "k" : String(Math.round(v * 10) / 10); }
  /* series: [{color, pts:[{x,y,tip}], dash, dots, width}] ; xs: {min,max,label(x)} */
  function lineChart(el, series, xs, yLabel) {
    var W = Math.max(el.clientWidth || 320, 260), H = W < 480 ? 230 : 280, L = 44, R = 10, T = 14, B = 30;
    var ys = []; series.forEach(function (s) { s.pts.forEach(function (p) { if (p.y !== null) ys.push(p.y); }); });
    if (!ys.length) { el.innerHTML = '<div class="msg">Nothing to chart for these filters.</div>'; return; }
    var ymax = niceMax(Math.max.apply(null, ys) * 1.05), ymin = 0;
    var span = Math.max(xs.max - xs.min, 1), X = function (x) { return L + (xs.max === xs.min ? (W - L - R) / 2 : (x - xs.min) * (W - L - R) / span); },
      Y = function (y) { return T + (H - T - B) * (1 - (y - ymin) / (ymax - ymin)); };
    var g = '<svg class="chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(yLabel) + ' chart">';
    for (var i = 0; i <= 4; i++) { var yv = ymin + (ymax - ymin) * i / 4; g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '" class="grid"/><text x="' + (L - 5) + '" y="' + (Y(yv) + 4) + '" text-anchor="end" class="ax">' + yFmt(yv) + '</text>'; }
    var nT = Math.min(span + 1, Math.max(2, Math.floor((W - L - R) / 62))), seen = {};
    for (var t = 0; t < nT; t++) { var xv = Math.round(xs.min + (xs.max === xs.min ? 0 : span * t / Math.max(nT - 1, 1))); if (seen[xv]) continue; seen[xv] = 1;
      var xp = X(xv), anc = xp < L + 18 ? "start" : xp > W - R - 18 ? "end" : "middle";
      g += '<text x="' + (anc === "start" ? xp - 4 : anc === "end" ? W - 2 : xp) + '" y="' + (H - 9) + '" text-anchor="' + anc + '" class="ax">' + esc(xs.label(xv)) + '</text>'; }
    series.forEach(function (s) {
      var pts = s.pts.filter(function (p) { return p.y !== null; }); if (!pts.length) return;
      if (pts.length > 1 || s.line) g += '<polyline fill="none" stroke="' + s.color + '" stroke-width="' + (s.width || 2.5) + '"' + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : "") + ' points="' + pts.map(function (p) { return X(p.x).toFixed(1) + "," + Y(p.y).toFixed(1); }).join(" ") + '"/>';
      if (s.dots !== false) pts.forEach(function (p) { g += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="4" fill="' + s.color + '"><title>' + esc(p.tip || "") + '</title></circle>'; });
    });
    el.innerHTML = g + '</svg>';
  }
  function barChart(el, rows, m) {
    var W = Math.max(el.clientWidth || 320, 260), rh = 30, lw = Math.min(Math.round(W * 0.36), 170), vw = 70, H = rows.length * rh + 6;
    if (!rows.length) { el.innerHTML = '<div class="msg">Nothing to chart for these filters.</div>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.v || 0; })) || 1, cw = Math.floor(lw / 8.5);
    var g = '<svg class="chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
    rows.forEach(function (r, i) {
      var y = i * rh + 3, w = Math.max((r.v || 0) / max * (W - lw - vw - 8), r.v ? 2 : 0);
      g += '<text x="0" y="' + (y + 19) + '" class="bl"><title>' + esc(r.label) + '</title>' + esc(short(r.label, cw)) + '</text><rect x="' + lw + '" y="' + (y + 4) + '" width="' + w.toFixed(1) + '" height="' + (rh - 10) + '" fill="' + (r.color || "#39ff6a") + '"/>' +
        '<text x="' + (lw + w + 6).toFixed(1) + '" y="' + (y + 19) + '" class="bv">' + esc(fmt(m, r.v)) + '</text>';
    });
    el.innerHTML = g + '</svg>';
  }

  /* ---- shell ---- */
  function show(el, ctx) {
    C = ctx; host = el;
    if (data) return render();
    host.innerHTML = '<p class="muted" style="margin-top:24px">Loading\u2026</p>';
    load();
  }
  function load() {
    C.api("/analyze").then(function (j) { data = j; parts = buildParts(j); buildOpts(); if (!S.series.length) restore(); render(); }).catch(function (e) {
      if (e.message === "401") return;
      host.innerHTML = '<div class="msg bad" role="alert">Could not load data: ' + esc(e.message === "Failed to fetch" ? "no connection to the database." : e.message) + '</div><button class="big" id="aretry" type="button">TRY AGAIN</button>';
      $("aretry").onclick = load;
    });
  }
  function info(text) { return '<details class="info"><summary aria-label="How this is counted">\u24d8</summary><p>' + text + '</p></details>'; }
  function render() {
    save();
    var h = '<div class="subtabs">' + [["compare", "COMPARE"], ["group", "GROUP BY"], ["progress", "OPERATOR"]].map(function (t) {
      return '<button type="button" data-sub="' + t[0] + '" class="' + (S.sub === t[0] ? "on" : "") + '">' + t[1] + '</button>'; }).join("") + '</div><div id="asub"></div>' +
      '<div class="toolbar"><button type="button" id="areload" class="ghost">REFRESH DATA</button><span class="muted" style="font-size:12px;align-self:center">' + (data.logs || []).length + ' logs loaded</span></div>';
    host.innerHTML = h;
    Array.prototype.forEach.call(host.querySelectorAll("[data-sub]"), function (b) { b.onclick = function () { S.sub = b.dataset.sub; render(); }; });
    $("areload").onclick = function () { data = null; host.innerHTML = '<p class="muted" style="margin-top:24px">Loading\u2026</p>'; load(); };
    ({ compare: renderCompare, group: renderGroup, progress: renderProgress })[S.sub]();
  }

  /* ---- COMPARE: any number of filter-set series over time ---- */
  function renderCompare() {
    var box = $("asub");
    var h = '<div class="panel"><div class="seghdr"><span class="lbl" style="margin:0">Show</span>' + info("Each series is its own filter set. Grade, finish size and Draw are written per card row, so a series only counts the rows that match, using that row's weight. " +
      "Hours are split across a shift's rows by weight share (a row that is 40% of the shift's pounds gets 40% of its hours). So lb/hr for a grade or size is the shift rate of the shifts that ran it, weighted by how much of it they ran. " +
      "A row with no Draw on a two-machine log is split evenly between the two Draws. lb/hr is always total lb \u00f7 total hours, never an average of averages.") + '</div>' +
      '<div class="seg" id="cmetric">' + ["lbs", "coils", "hours", "lbhr"].map(function (m) { return '<button type="button" data-m="' + m + '" class="' + (S.metric === m ? "on" : "") + '">' + (m === "lbs" ? "VOLUME (LB)" : METRICS[m].toUpperCase()) + '</button>'; }).join("") + '</div>' +
      '<div class="seg two" id="cunit"><button type="button" data-u="day" class="' + (S.unit === "day" ? "on" : "") + '">BY DAY</button><button type="button" data-u="week" class="' + (S.unit === "week" ? "on" : "") + '">BY WEEK</button></div>' +
      '<div id="cchart" class="chartbox"></div><div class="legend" id="clegend"></div></div>';
    h += '<h3>Totals per series</h3><div class="tblwrap"><table class="tbl"><thead><tr><th>Series</th><th>Shifts</th><th>Lb</th><th>Coils</th><th>Hours</th><th>Lb/hr</th><th>Down hr</th></tr></thead><tbody id="ctable"></tbody></table></div>';
    h += '<h3>Series</h3><div id="clist"></div><button type="button" class="big" id="cadd">+ ADD SERIES</button>' +
      '<div class="toolbar"><button type="button" id="cshare">COPY SHARE LINK</button><button type="button" id="cclear" class="ghost">START OVER</button></div>';
    box.innerHTML = h;
    Array.prototype.forEach.call(box.querySelectorAll("#cmetric button"), function (b) { b.onclick = function () { S.metric = b.dataset.m; render(); }; });
    Array.prototype.forEach.call(box.querySelectorAll("#cunit button"), function (b) { b.onclick = function () { S.unit = b.dataset.u; render(); }; });
    drawCompare();
    var list = $("clist");
    S.series.forEach(function (s, i) {
      var d = document.createElement("details"); d.className = "panel series"; if (open[s.id]) d.open = true;
      d.innerHTML = '<summary><span class="sw" style="background:' + esc(s.color) + '"></span><span class="sname"><b>' + esc(s.name) + '</b><small>' + esc(fSummary(s.f)) + '</small></span>' +
        '<span class="sbtns"><button type="button" class="ghost" data-act="hide" aria-label="' + (s.hidden ? "Show" : "Hide") + ' series">' + (s.hidden ? "SHOW" : "HIDE") + '</button></span></summary>' +
        '<div class="sbody"><div class="row2"><div class="field"><label class="lbl" for="sn' + s.id + '">Label</label><input class="in" id="sn' + s.id + '" maxlength="40" placeholder="Series name" value="' + esc(s.name) + '"></div>' +
        '<div class="field"><label class="lbl" for="sc' + s.id + '">Color</label><input class="in color" type="color" id="sc' + s.id + '" value="' + esc(/^#/.test(s.color) ? s.color : "#39ff6a") + '"></div></div>' +
        fEditor("s" + s.id, s.f) + '<div class="toolbar"><button type="button" data-act="dup">DUPLICATE</button><button type="button" class="warn" data-act="del">REMOVE</button></div></div>';
      list.appendChild(d);
      d.addEventListener("toggle", function () { open[s.id] = d.open; });
      d.querySelector('[data-act="hide"]').onclick = function (e) { e.preventDefault(); s.hidden = !s.hidden; render(); };
      d.querySelector('[data-act="del"]').onclick = function () { S.series.splice(i, 1); if (!S.series.length) S.series.push(newSeries()); render(); };
      d.querySelector('[data-act="dup"]').onclick = function () { var n = newSeries(s.f); n.name = short(s.name + " copy", 40); S.series.splice(i + 1, 0, n); open[n.id] = true; render(); };
      $("sn" + s.id).onchange = function () { s.name = this.value.trim().slice(0, 40) || "Series " + (i + 1); render(); };
      $("sc" + s.id).onchange = function () { s.color = hexOk(this.value) || s.color; render(); };
      wireEditor(d.querySelector(".sbody"), s.f, function () { render(); });
    });
    $("cadd").onclick = function () { var n = newSeries(); S.series.push(n); open[n.id] = true; render(); setTimeout(function () { var el = $("sn" + n.id); if (el) el.scrollIntoView({ block: "center" }); }, 0); };
    $("cshare").onclick = function () {
      var url = location.href.split("#")[0] + "#cmp=" + enc(shareObj());
      try { history.replaceState(null, "", url); } catch (e) { location.hash = "cmp=" + enc(shareObj()); }
      var done = function () { C.toast("Link copied. It still needs the passcode."); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { C.toast("Link is in the address bar"); });
      else C.toast("Link is in the address bar");
    };
    $("cclear").onclick = function () { S.series = [newSeries()]; S.metric = "lbs"; S.unit = "day"; open = {}; try { history.replaceState(null, "", location.href.split("#")[0]); } catch (e) {} render(); };
    rerender = drawCompare;
  }
  function drawCompare() {
    var unit = S.unit, m = S.metric, all = {}, rows = [];
    var sets = S.series.map(function (s) { var ps = filterParts(parts, s.f); var b = bucketSeries(ps, unit); Object.keys(b).forEach(function (k) { all[k] = 1; }); return { s: s, ps: ps, b: b }; });
    var keys = Object.keys(all).sort();
    var vis = sets.filter(function (x) { return !x.s.hidden; }), visKeys = {};
    vis.forEach(function (x) { Object.keys(x.b).forEach(function (k) { visKeys[k] = 1; }); });
    var vk = Object.keys(visKeys).sort(), x0 = vk.length ? dayNum(vk[0]) : 0, x1 = vk.length ? dayNum(vk[vk.length - 1]) : 0, step = unit === "week" ? 7 : 1;
    var lab = function (x) { var d = new Date(Date.UTC(1970, 0, 1) + (x0 + x * step) * 864e5); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate(); };
    lineChart($("cchart"), vis.map(function (x) {
      return { color: x.s.color, pts: Object.keys(x.b).sort().map(function (k) { var v = mval(x.b[k], m); return { x: (dayNum(k) - x0) / step, y: v === null ? null : v, tip: x.s.name + " \u00b7 " + (unit === "week" ? "wk of " : "") + md(k) + ": " + fmt(m, v) }; }) };
    }), { min: 0, max: Math.round((x1 - x0) / step), label: lab }, METRICS[m]);
    $("clegend").innerHTML = sets.map(function (x) { return '<span class="' + (x.s.hidden ? "off" : "") + '"><i style="background:' + esc(x.s.color) + '"></i>' + esc(x.s.name) + '</span>'; }).join("");
    $("ctable").innerHTML = sets.map(function (x) {
      var a = agg(x.ps);
      return '<tr class="' + (x.s.hidden ? "off" : "") + '"><td><i class="sw" style="background:' + esc(x.s.color) + '"></i>' + esc(x.s.name) + '</td><td>' + a.shifts + '</td><td>' + fmt("lbs", a.lbs) + '</td><td>' + fmt("coils", a.coils) + '</td><td>' + fmt("hours", a.hours) + '</td><td>' + fmt("lbhr", a.lbhr) + '</td><td>' + fmt("dt", a.dt / 60) + '</td></tr>';
    }).join("");
    void keys; void rows;
  }

  /* ---- GROUP BY builder ---- */
  function groupRows() {
    var G = S.group, ps = filterParts(parts, G.f), rows = groupBy(ps, G.by);
    rows.forEach(function (r) { r.label = keyLabel(G.by, r); });
    var col = G.sort.col;
    if (col) rows.sort(function (a, b) { var va = col === "label" ? a.label : mval(a, col), vb = col === "label" ? b.label : mval(b, col);
      if (va === null) return 1; if (vb === null) return -1; return (va < vb ? -1 : va > vb ? 1 : 0) * G.sort.dir; });
    else if (G.by === "day" || G.by === "week" || G.by === "draw") rows.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    else rows.sort(function (a, b) { return (mval(b, G.metric) || 0) - (mval(a, G.metric) || 0); });
    return { rows: rows, total: agg(ps) };
  }
  function renderGroup() {
    var G = S.group, box = $("asub");
    var h = '<details class="filters panel"' + (open.gf ? " open" : "") + ' id="gfbox"><summary>FILTERS <span>' + esc(fSummary(G.f)) + '</span></summary><div style="margin-top:10px" id="gfed">' + fEditor("g", G.f) + '</div></details>' +
      '<div class="panel"><div class="seghdr"><span class="lbl" style="margin:0">Group by</span>' + info("Rows are counted by the shift date written on the log. Grade, finish size and Draw come from each card row, so one shift can land in several groups; its hours are split by the weight each row made, and its shift count shows in each group it touches (group shifts can add up to more than the total). " +
      "Draw 1 & 4 and Draw 2 & 6 are often run together: pounds go to the Draw written on each row, and a row with no Draw is split evenly. lb/hr = total lb \u00f7 total hours.") + '</div>' +
      '<div class="seg" id="gby">' + Object.keys(BYS).map(function (k) { return '<button type="button" data-by="' + k + '" class="' + (G.by === k ? "on" : "") + '">' + BYS[k].toUpperCase() + '</button>'; }).join("") + '</div>' +
      '<span class="lbl" style="margin-top:10px">Chart</span><div class="seg" id="gmet">' + Object.keys(METRICS).map(function (k) { return '<button type="button" data-m="' + k + '" class="' + (G.metric === k ? "on" : "") + '">' + METRICS[k].toUpperCase() + '</button>'; }).join("") + '</div>' +
      '<div id="gchart" class="chartbox"></div></div>';
    var cols = [["label", BYS[G.by]], ["shifts", "Shifts"], ["lbs", "Lb"], ["coils", "Coils"], ["hours", "Hours"], ["lbhr", "Lb/hr"], ["dt", "Down hr"]];
    h += '<div class="tblwrap"><table class="tbl"><thead><tr>' + cols.map(function (c) { return '<th><button type="button" data-sort="' + c[0] + '">' + esc(c[1]) + (G.sort.col === c[0] ? (G.sort.dir > 0 ? " \u25b2" : " \u25bc") : "") + '</button></th>'; }).join("") + '</tr></thead><tbody id="gtable"></tbody></table></div>' +
      '<div class="toolbar"><button type="button" id="gcsv">EXPORT THIS TABLE</button><button type="button" id="gunsort" class="ghost">DEFAULT ORDER</button></div>';
    box.innerHTML = h;
    $("gfbox").addEventListener("toggle", function () { open.gf = $("gfbox").open; });
    wireEditor($("gfed"), G.f, render);
    Array.prototype.forEach.call(box.querySelectorAll("#gby button"), function (b) { b.onclick = function () { G.by = b.dataset.by; G.sort = { col: "", dir: -1 }; render(); }; });
    Array.prototype.forEach.call(box.querySelectorAll("#gmet button"), function (b) { b.onclick = function () { G.metric = b.dataset.m; render(); }; });
    Array.prototype.forEach.call(box.querySelectorAll("[data-sort]"), function (b) { b.onclick = function () { var c = b.dataset.sort; G.sort = { col: c, dir: G.sort.col === c ? -G.sort.dir : (c === "label" ? 1 : -1) }; render(); }; });
    $("gunsort").onclick = function () { G.sort = { col: "", dir: -1 }; render(); };
    var R = groupRows(), t = R.total;
    $("gtable").innerHTML = (R.rows.length ? R.rows.map(function (r) {
      return '<tr><td>' + esc(r.label) + '</td><td>' + r.shifts + '</td><td>' + fmt("lbs", r.lbs) + '</td><td>' + fmt("coils", r.coils) + '</td><td>' + fmt("hours", r.hours) + '</td><td>' + fmt("lbhr", r.lbhr) + '</td><td>' + fmt("dt", r.dt / 60) + '</td></tr>';
    }).join("") : '<tr><td colspan="7" class="muted">No logs match these filters.</td></tr>') +
      '<tr class="tot"><td>ALL</td><td>' + t.shifts + '</td><td>' + fmt("lbs", t.lbs) + '</td><td>' + fmt("coils", t.coils) + '</td><td>' + fmt("hours", t.hours) + '</td><td>' + fmt("lbhr", t.lbhr) + '</td><td>' + fmt("dt", t.dt / 60) + '</td></tr>';
    $("gcsv").onclick = function () {
      var lines = [["group_by", BYS[G.by]].map(csvCell).join(","), ["filters", fSummary(G.f)].map(csvCell).join(","), cols.map(function (c) { return csvCell(c[1]); }).join(",")];
      var r1 = function (v, d) { return v === null || v === undefined ? "" : Math.round(v * d) / d; };
      R.rows.concat([Object.assign({ label: "ALL" }, t)]).forEach(function (r) { lines.push([r.label, r.shifts, r1(r.lbs, 1), r1(r.coils, 10), r1(r.hours, 100), r1(r.lbhr, 10), r1(r.dt / 60, 100)].map(csvCell).join(",")); });
      var blob = new Blob(["\uFEFF" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }), name = "analysis-by-" + G.by + "-" + ymd(new Date()) + ".csv";
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); C.toast("CSV saved: " + name);
    };
    rerender = function () { drawGroup(groupRows()); }; rerender();
  }
  function drawGroup(R) {
    var G = S.group, m = G.metric, el = $("gchart");
    if (G.by === "day" || G.by === "week") {
      var rows = R.rows.slice().sort(function (a, b) { return a.key < b.key ? -1 : 1; }); if (!rows.length) return barChart(el, [], m);
      var step = G.by === "week" ? 7 : 1, x0 = dayNum(rows[0].key);
      lineChart(el, [{ color: "#39ff6a", pts: rows.map(function (r) { return { x: (dayNum(r.key) - x0) / step, y: mval(r, m), tip: r.label + ": " + fmt(m, mval(r, m)) }; }) }],
        { min: 0, max: (dayNum(rows[rows.length - 1].key) - x0) / step, label: function (x) { var d = new Date((x0 + x * step) * 864e5); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate(); } }, METRICS[m]);
    } else barChart(el, R.rows.map(function (r) { return { label: r.label, v: mval(r, m) }; }), m);
  }

  /* ---- OPERATOR progress ---- */
  function opSeries(op, from, to) {
    var ps = filterParts(parts, { from: from, to: to, ops: op ? [op] : [] });
    return op ? shiftPoints(ps) : [];
  }
  function renderProgress() {
    var P = S.prog, box = $("asub");
    if (!P.op && opts.ops.length) P.op = opts.ops[0].v;
    var sel = function (id, v) { return '<select class="in" id="' + id + '">' + opts.ops.map(function (o) { return '<option value="' + esc(o.v) + '"' + (o.v === v ? " selected" : "") + '>' + esc(o.t) + '</option>'; }).join("") + '</select>'; };
    var h = '<div class="panel"><div class="field"><label class="lbl" for="pop">Operator</label>' + sel("pop", P.op) + '</div>' +
      '<div class="row2"><div class="field"><label class="lbl" for="pfrom">From</label><input class="in" type="date" id="pfrom" value="' + esc(P.from) + '"></div><div class="field"><label class="lbl" for="pto">To</label><input class="in" type="date" id="pto" value="' + esc(P.to) + '"></div></div>' +
      '<span class="lbl">Compare</span><div class="seg" id="pcmp">' + [["off", "OFF"], ["op", "2ND OPERATOR"], ["period", "2ND PERIOD"]].map(function (c) { return '<button type="button" data-c="' + c[0] + '" class="' + (P.cmp === c[0] ? "on" : "") + '">' + c[1] + '</button>'; }).join("") + '</div>';
    if (P.cmp === "op") h += '<div class="field" style="margin-top:10px"><label class="lbl" for="pop2">Second operator</label>' + sel("pop2", P.op2 || (opts.ops[1] || opts.ops[0] || {}).v) + '</div>';
    if (P.cmp === "period") h += '<div class="row2" style="margin-top:10px"><div class="field"><label class="lbl" for="pfrom2">2nd period from</label><input class="in" type="date" id="pfrom2" value="' + esc(P.from2) + '"></div><div class="field"><label class="lbl" for="pto2">2nd period to</label><input class="in" type="date" id="pto2" value="' + esc(P.to2) + '"></div></div>';
    h += '</div><div class="panel"><div class="seghdr"><span class="lbl" style="margin:0">Lb/hr per shift</span>' + info("Each dot is one shift: its total lb \u00f7 its hours. The dashed line is the trend (best straight fit). The dotted white line is the goal lb/hr written on each log. Average = all lb \u00f7 all hours. Change = how much the trend line rose or fell from the first shift to the last, so one great or bad night doesn't swing it. In 2nd period mode both periods are lined up from their first day.") +
      '</div><div id="pchart" class="chartbox"></div><div class="legend" id="plegend"></div></div><div id="pstats"></div>';
    box.innerHTML = h;
    var ch = function (k, id) { $(id).onchange = function () { P[k] = this.value; render(); }; };
    if (!opts.ops.length) { box.innerHTML = '<div class="msg">No logs yet.</div>'; return; }
    ch("op", "pop"); ch("from", "pfrom"); ch("to", "pto");
    if ($("pop2")) { if (!P.op2) P.op2 = $("pop2").value; ch("op2", "pop2"); }
    if ($("pfrom2")) { ch("from2", "pfrom2"); ch("to2", "pto2"); }
    Array.prototype.forEach.call(box.querySelectorAll("#pcmp button"), function (b) { b.onclick = function () { P.cmp = b.dataset.c; render(); }; });
    rerender = drawProgress; drawProgress();
  }
  function drawProgress() {
    var P = S.prog, name = function (k) { var o = opts.ops.filter(function (x) { return x.v === k; })[0]; return o ? o.t : k; };
    var A = { name: name(P.op), color: "#39ff6a", pts: opSeries(P.op, P.from, P.to) }, list = [A];
    if (P.cmp === "op" && P.op2) list.push({ name: name(P.op2), color: "#ffc23d", pts: opSeries(P.op2, P.from, P.to) });
    if (P.cmp === "period") { list[0].name += " (1st)"; list.push({ name: name(P.op) + " (2nd)", color: "#ffc23d", pts: opSeries(P.op, P.from2, P.to2), period: true }); }
    var sameAxis = P.cmp !== "period";
    // x origin: range start, or the first shift
    var firstDate = function (s, from) { return from || (s.pts[0] && s.pts[0].date) || ""; };
    var origin = sameAxis ? (P.from || list.reduce(function (m, s) { var d = s.pts[0] && s.pts[0].date; return d && (!m || d < m) ? d : m; }, "")) : null;
    var series = [], xmax = 0;
    list.forEach(function (s) {
      var o = dayNum(sameAxis ? origin : firstDate(s, s.period ? P.from2 : P.from)); s.x0 = o;
      var pts = s.pts.filter(function (p) { return p.lbhr !== null; }).map(function (p) { var x = dayNum(p.date) - o; xmax = Math.max(xmax, x); return { x: x, y: p.lbhr, tip: p.date + ": " + C.n1(p.lbhr) + " lb/hr", goal: p.goal }; });
      s.xy = pts; s.st = progressStats(s.pts, o);
      series.push({ color: s.color, pts: pts });
      if (s.st.fit && pts.length > 1) { var xa = pts[0].x, xb = pts[pts.length - 1].x; series.push({ color: s.color, dots: false, dash: "7 5", width: 1.6, pts: [{ x: xa, y: s.st.fit.a + s.st.fit.b * xa }, { x: xb, y: s.st.fit.a + s.st.fit.b * xb }] }); }
      var gp = pts.filter(function (p) { return p.goal; }).map(function (p) { return { x: p.x, y: p.goal }; });
      if (gp.length && (s === list[0] || P.cmp === "op")) series.push({ color: "#eaffea", dots: false, dash: "2 4", width: 1.4, line: true, pts: gp.length === 1 ? [gp[0], { x: gp[0].x + 0.001, y: gp[0].y }] : gp });
    });
    var lab = sameAxis && origin ? function (x) { var d = new Date((dayNum(origin) + x) * 864e5); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate(); } : function (x) { return "day " + (x + 1); };
    if (!list.some(function (s) { return s.xy.length; })) $("pchart").innerHTML = '<div class="msg">No shifts with hours for this pick.</div>';
    else lineChart($("pchart"), series, { min: 0, max: Math.max(xmax, 1), label: lab }, "Lb/hr");
    $("plegend").innerHTML = list.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join("") + '<span><i class="dash"></i>trend</span><span><i class="dot"></i>goal</span>';
    $("pstats").innerHTML = list.map(function (s) {
      var st = s.st, sign = st.change === null ? "" : st.change >= 0 ? "+" : "\u2212";
      return (list.length > 1 ? '<h3 style="color:' + s.color + '">' + esc(s.name) + '</h3>' : "") + '<div class="stats">' +
        '<div class="stat"><i>Average</i><b>' + C.n1(st.avg) + '</b><small>lb/hr \u00b7 ' + st.shifts + ' shift' + (st.shifts === 1 ? "" : "s") + '</small></div>' +
        '<div class="stat"><i>Best shift</i><b>' + (st.best ? C.n1(st.best.lbhr) : "\u2013") + '</b><small>' + (st.best ? esc(C.day(st.best.date)) : "\u2013") + '</small></div>' +
        '<div class="stat"><i>Change (trend)</i><b>' + (st.change === null ? "\u2013" : sign + C.n1(Math.abs(st.change))) + '</b><small>' + (st.change === null ? "needs 2+ shifts on different days" : "lb/hr" + (st.pct !== null ? " \u00b7 " + sign + Math.abs(Math.round(st.pct)) + "%" : "")) + '</small></div>' +
        '<div class="stat"><i>Goal hit</i><b>' + (st.goalN ? st.goalMet + " of " + st.goalN : "\u2013") + '</b><small>' + (st.goalN ? "shifts with a goal" : "no goal on these logs") + '</small></div></div>';
    }).join("");
  }

  var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { if (rerender && host && host.isConnected && document.getElementById("asub")) rerender(); }, 200); });
  root.Analyze = { show: show, reset: function () { data = null; parts = []; }, engine: engine };
})(typeof window !== "undefined" ? window : globalThis);
