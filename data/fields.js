/* Shared input helpers for the tracker app, the calculators, the scan review and /data/.
   1) TIME BOXES. Every duration is typed in two boxes, "hrs" and "mins" (number keypad; mins 0 to 59).
      Mark the original input with data-hm="min" (it holds total minutes), "hm" ("h:mm" text, like "7:30"),
      or "dec" (decimal hours, like "7.5"). The original stays in the page, hidden, and keeps its stored
      format, ids and listeners: the two boxes write into it and fire its input/change events. Values saved
      before load into the two boxes ("90" min -> 1 hrs 30 mins, "7:30" or "7.5" -> 7 hrs 30 mins,
      "15 30" min -> 0 hrs 45 mins). Inputs are found by themselves when they appear in the page.
      Call input._hmSync() after setting the original's value from code.
   2) SIZES. Anything typed with a decimal point is kept as typed. A whole number of 10 or more with no point
      ("600", "1250") isn't guessed: Fields.sizePick shows ".600 in / 6.00 in / Keep 600" and waits for a tap.
   3) COMPOUND. A text input marked data-compound gets a dropdown in front of it: 4392, 3814, TN5, 1360, Drawsol,
      Salvia, Other. The input stays the stored value (a plain string) and keeps its listeners; it only shows
      when Other is picked, for typing the compound. A saved known value picks it; anything else picks Other.
   4) DATES. Fields.niceDate("2026-11-13") -> "Fri Nov 13, 2026"; niceDate(v, true) -> "Fri Nov 13". Display only. */
(function () {
  "use strict";
  if (window.Fields) return;
  var css = ".hm{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0}.hm-c{display:flex;align-items:center;gap:6px;min-width:0}" +
    ".hm-c input{flex:1 1 auto;min-width:0;width:100%}.hm-u{flex:0 0 auto;font-size:14px;letter-spacing:.04em;color:var(--fg-dim,#7fbf8f);text-transform:none;margin:0}" +
    ".hm-err{grid-column:1/-1;color:var(--red,#ff5c5c);font-size:14px;margin:2px 0 0}.hm-err:empty{display:none}" +
    ".sz-pick{border:2px solid var(--amber,#ffb000);color:var(--amber,#ffb000);padding:8px 10px;margin:6px 0 4px;font-size:15px;line-height:1.35}" +
    ".cp-other{margin-top:8px}" +
    ".sz-pick button{display:block;width:100%;min-height:48px;margin-top:6px;background:#000;color:var(--fg,#39ff6a);border:2px solid var(--fg,#39ff6a);font:inherit;font-weight:700;cursor:pointer}";
  function addCss() { if (document.getElementById("fields-css")) return; var s = document.createElement("style"); s.id = "fields-css"; s.textContent = css; (document.head || document.documentElement).appendChild(s); }

  /* ---- time boxes ---- */
  function hmSplit(v, kind) {
    var t = String(v == null ? "" : v).trim();
    if (!t) return null;
    var m = /^(\d{1,3}):(\d{1,2})$/.exec(t);
    if (m) return kind === "min" ? { h: +m[1], m: +m[2] } : { h: +m[1], m: +m[2] };
    if (kind === "min") {
      var parts = t.replace(/,/g, " ").split(/[\s+]+/).filter(Boolean), sum = 0;
      for (var i = 0; i < parts.length; i++) { var n = Number(parts[i]); if (!isFinite(n) || n < 0) return null; sum += n; }
      sum = Math.round(sum);
      return { h: Math.floor(sum / 60), m: sum % 60 };
    }
    var x = Number(t);
    if (!isFinite(x) || x < 0) return null;
    var tot = Math.round(x * 60);
    return { h: Math.floor(tot / 60), m: tot % 60 };
  }
  function hmJoin(h, m, kind) {
    if (h === "" && m === "") return "";
    var H = h === "" ? 0 : +h, M = m === "" ? 0 : +m;
    if (kind === "min") return String(H * 60 + M);
    if (kind === "hm") return M ? H + ":" + (M < 10 ? "0" : "") + M : String(H);
    return String(Math.round((H + M / 60) * 100) / 100);
  }
  function enhance(orig) {
    if (orig._hm || !orig.id) return;
    var kind = orig.getAttribute("data-hm") || "min";
    orig._hm = true;
    addCss();
    var w = document.createElement("div"); w.className = "hm"; w.setAttribute("role", "group");
    var lab = document.querySelector('label[for="' + orig.id + '"]'), name = (lab ? lab.textContent : orig.getAttribute("aria-label") || "Time").trim();
    if (lab) lab.setAttribute("for", orig.id + "-h");
    w.setAttribute("aria-label", name);
    var mk = function (suf, unit, max) {
      var c = document.createElement("div"); c.className = "hm-c";
      var i = document.createElement("input");
      i.className = orig.className.replace(/\bscan-(unclear|check)\b/g, "").trim() || "in";
      i.type = "text"; i.id = orig.id + suf;
      i.setAttribute("inputmode", "numeric"); i.setAttribute("pattern", "[0-9]*"); i.setAttribute("autocomplete", "off");
      i.setAttribute("maxlength", String(max)); i.setAttribute("placeholder", unit); i.setAttribute("aria-label", name + ", " + (unit === "hrs" ? "hours" : "minutes"));
      if (orig.getAttribute("enterkeyhint")) i.setAttribute("enterkeyhint", orig.getAttribute("enterkeyhint"));
      var u = document.createElement("span"); u.className = "hm-u"; u.textContent = unit;
      c.appendChild(i); c.appendChild(u); w.appendChild(c);
      return i;
    };
    var hi = mk("-h", "hrs", 3), mi = mk("-m", "mins", 2);
    var err = document.createElement("p"); err.className = "hm-err"; err.id = orig.id + "-hmerr"; err.setAttribute("role", "alert"); w.appendChild(err);
    var sync = function () {
      var s = hmSplit(orig.value, kind);
      hi.value = s ? String(s.h) : ""; mi.value = s ? String(s.m) : "";
      hi.readOnly = mi.readOnly = !!orig.readOnly; err.textContent = "";
    };
    var put = function () {
      [hi, mi].forEach(function (x) { var d = x.value.replace(/\D/g, ""); if (d !== x.value) x.value = d; });
      var bad = mi.value !== "" && +mi.value > 59;
      err.textContent = bad ? "Minutes go 0 to 59. Put whole hours in the hrs box." : "";
      mi.setAttribute("aria-invalid", bad ? "true" : "false");
      // a bad time counts as blank, so a half-typed value is never saved or used in the math
      var v = bad ? "" : hmJoin(hi.value, mi.value, kind);
      if (v === orig.value) return;
      orig.value = v;
      orig.dispatchEvent(new Event("input", { bubbles: true }));
      orig.dispatchEvent(new Event("change", { bubbles: true }));
    };
    hi.addEventListener("input", put); mi.addEventListener("input", put);
    orig.parentNode.insertBefore(w, orig);
    orig.style.display = "none"; orig.setAttribute("aria-hidden", "true"); orig.tabIndex = -1;
    w.appendChild(orig);
    orig._hmSync = sync;
    sync();
    // two boxes need the full width: if the field sits in a 2-column grid, give it the whole row
    for (var n = w.parentNode, k = 0; n && n.parentNode && k < 3; n = n.parentNode, k++) {
      var g = window.getComputedStyle ? getComputedStyle(n.parentNode) : null;
      if (g && g.display === "grid" && g.gridTemplateColumns.split(" ").length > 1) { n.style.gridColumn = "1 / -1"; break; }
    }
  }
  /* ---- compound ---- */
  var COMPOUNDS = ["4392", "3814", "TN5", "1360", "Drawsol", "Salvia"], OTHER = "__other";
  function compoundKnown(v) {
    var t = String(v == null ? "" : v).trim().toLowerCase();
    for (var i = 0; i < COMPOUNDS.length; i++) if (COMPOUNDS[i].toLowerCase() === t) return COMPOUNDS[i];
    return null;
  }
  function compound(orig) {
    if (orig._cp || !orig.id) return;
    orig._cp = true;
    addCss();
    var sel = document.createElement("select");
    sel.id = orig.id + "-pick";
    sel.className = orig.className.replace(/\bscan-(unclear|check)\b/g, "").trim() || "in";
    var opts = [["", "Pick a compound"]].concat(COMPOUNDS.map(function (c) { return [c, c]; }), [[OTHER, "Other"]]);
    opts.forEach(function (o) { var e = document.createElement("option"); e.value = o[0]; e.textContent = o[1]; sel.appendChild(e); });
    var lab = document.querySelector('label[for="' + orig.id + '"]');
    if (lab) lab.setAttribute("for", sel.id);
    orig.classList.add("cp-other");
    orig.setAttribute("placeholder", "type the compound");
    orig.setAttribute("aria-label", ((lab ? lab.textContent : "Compound") || "Compound").trim() + ", other");
    var show = function (b) { orig.style.display = b ? "" : "none"; };
    var sync = function () {
      var v = String(orig.value || "").trim(), k = compoundKnown(v);
      if (!v && sel.value !== OTHER) { sel.value = ""; show(false); }
      else if (k) { sel.value = k; show(false); }
      else if (v) { sel.value = OTHER; show(true); }
    };
    var put = function (v) {
      if (orig.value === v) return;
      orig.value = v;
      orig.dispatchEvent(new Event("input", { bubbles: true }));
      orig.dispatchEvent(new Event("change", { bubbles: true }));
    };
    sel.addEventListener("change", function () {
      if (sel.value === OTHER) {
        show(true);
        if (compoundKnown(orig.value)) put("");
        try { orig.focus(); } catch (e) {}
      } else { show(false); put(sel.value); }
    });
    orig.parentNode.insertBefore(sel, orig);
    orig._cpSync = sync;
    sync();
  }
  function niceDate(v, short) {
    var t = String(v == null ? "" : v).trim(), m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t), d;
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t))) d = new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
    else return t;
    if (isNaN(d.getTime())) return t;
    var DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return DN[d.getDay()] + " " + MN[d.getMonth()] + " " + d.getDate() + (short ? "" : ", " + d.getFullYear());
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches("input[data-hm]")) enhance(root);
    Array.prototype.forEach.call(root.querySelectorAll("input[data-hm]"), enhance);
    if (root.matches && root.matches("input[data-compound]")) compound(root);
    Array.prototype.forEach.call(root.querySelectorAll("input[data-compound]"), compound);
  }
  function watch() {
    scan(document.body);
    new MutationObserver(function (list) {
      list.forEach(function (r) { Array.prototype.forEach.call(r.addedNodes, function (n) { if (n.nodeType === 1) scan(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) watch(); else document.addEventListener("DOMContentLoaded", watch);

  /* ---- sizes ---- */
  function sizeBare(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/\s*(?:"|''|in\.?|inch(?:es)?)$/, ""); }
  function sizeAmbig(v) { var t = sizeBare(v); return /^\d+$/.test(t) && +t >= 10; }
  function sizeChoices(v) {
    var t = sizeBare(v), n = +t, out = [];
    out.push(t.length >= 3 ? (n / 1000).toFixed(3).replace(/^0\./, ".") : "." + t);
    if (n >= 100) out.push((n / 100).toFixed(2));
    return out;
  }
  /* show the choice right under input el; done(value) after a tap (the box is updated and fires "input") */
  function sizePick(el, what, done) {
    addCss();
    var v = el.value.trim(), old = el.parentNode.querySelector(".sz-pick");
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement("div"); box.className = "sz-pick"; box.setAttribute("role", "alert");
    box.appendChild(document.createTextNode((what || "Size") + " " + v + " has no decimal point. Which did you mean?"));
    sizeChoices(v).map(function (x) { return [x + " in", x]; }).concat([["Keep " + v, null]]).forEach(function (o, i) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = o[0]; b.className = "sz-pick-" + i;
      b.onclick = function () {
        if (o[1] !== null) { el.value = o[1]; el.dispatchEvent(new Event("input", { bubbles: true })); }
        el._sizeKeep = el.value.trim();
        if (box.parentNode) box.parentNode.removeChild(box);
        if (done) done(el.value.trim());
      };
      box.appendChild(b);
    });
    el.parentNode.insertBefore(box, el.nextSibling);
    for (var d = box.parentNode; d; d = d.parentNode) if (d.tagName === "DETAILS") d.open = true;
    try { box.scrollIntoView({ block: "center" }); } catch (e) {}
    return box;
  }
  /* first box in the list with a size that still needs a pick, or null */
  function sizeNeedsPick(els) {
    for (var i = 0; i < els.length; i++) { var e = els[i], v = e.value.trim(); if (v && sizeAmbig(v) && e._sizeKeep !== v) return e; }
    return null;
  }
  window.Fields = { hmSplit: hmSplit, hmJoin: hmJoin, enhance: enhance, scan: scan, sizeAmbig: sizeAmbig, sizeChoices: sizeChoices, sizePick: sizePick, sizeNeedsPick: sizeNeedsPick,
    compound: compound, compoundKnown: compoundKnown, COMPOUNDS: COMPOUNDS, niceDate: niceDate };
})();
