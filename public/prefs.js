/* Per-device appearance preferences + service worker registration.
   Loaded in <head> on every page so the theme is applied before first paint. */
(function () {
  "use strict";
  var KEY = "cs_prefs";
  var DEFAULTS = { theme: "space", glass: true, density: "comfortable" };

  function read() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || "{}")); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function apply(p) {
    var d = document.documentElement;
    d.setAttribute("data-theme", p.theme === "light" ? "light" : "space");
    d.setAttribute("data-glass", p.glass === false ? "off" : "on");
    d.setAttribute("data-density", p.density === "compact" ? "compact" : "comfortable");
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", p.theme === "light" ? "#e6f1ff" : "#07162f");
  }
  function save(patch) {
    var p = Object.assign(read(), patch);
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {}
    apply(p);
    return p;
  }

  window.CS = window.CS || {};
  window.CS.prefs = { get: read, save: save, apply: function () { apply(read()); } };
  apply(read());

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }
})();
