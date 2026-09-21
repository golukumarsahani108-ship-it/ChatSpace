/* Settings screen. Profile talks to the ChatSpace server; appearance
   preferences live on this device (localStorage) via prefs.js. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var prefs = window.CS.prefs;
  var installEvent = null;
  var toastTimer = null;

  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function toast(t) {
    var x = $("toast"); x.textContent = t; x.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { x.classList.remove("show"); }, 2600);
  }
  async function api(url, opt) {
    var r = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (r.status === 401) { location.href = "/"; throw new Error("AUTH"); }
    if (!r.ok) throw new Error(d.message || d.error || "Request failed");
    return d;
  }

  /* ---------- Profile ---------- */
  function paintAvatar(u) {
    var initial = ((u.displayName || u.username || "?")[0] || "?").toUpperCase();
    $("avatarBtn").innerHTML = (u.avatarUrl ? '<img src="' + esc(u.avatarUrl) + '" alt="">' : esc(initial)) + '<span class="cam">Change</span>';
  }
  function paintProfile(u) {
    paintAvatar(u);
    $("setName").textContent = u.displayName || u.username;
    $("setEmail").textContent = u.email ? u.email + "  ·  @" + u.username : "@" + u.username;
    if (u.createdAt) {
      $("setSince").textContent = "Member since " +
        new Date(u.createdAt).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
    }
    $("displayName").value = u.displayName || "";
    $("username").value = u.username || "";
  }

  $("avatarBtn").addEventListener("click", function () { $("avatarInput").click(); });
  $("avatarInput").addEventListener("change", async function (e) {
    var f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast("Profile picture must be under 5 MB.");
    var fd = new FormData(); fd.append("avatar", f);
    try {
      var d = await api("/api/profile/avatar", { method: "POST", body: fd });
      paintAvatar(d.user); toast("Profile picture updated.");
    } catch (err) { if (err.message !== "AUTH") toast(err.message); }
  });
  $("saveProfile").addEventListener("click", async function () {
    var msg = $("saveMsg"); msg.textContent = "";
    try {
      var d = await api("/api/profile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: $("displayName").value, username: $("username").value })
      });
      $("setName").textContent = d.user.displayName;
      $("username").value = d.user.username;
      msg.textContent = "Saved."; toast("Profile updated.");
    } catch (err) { if (err.message !== "AUTH") { msg.textContent = err.message; toast(err.message); } }
  });

  /* ---------- Appearance ---------- */
  function paintPrefs() {
    var p = prefs.get();
    document.querySelectorAll("#themeGroup button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.theme === p.theme)); });
    document.querySelectorAll("#densityGroup button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.density === p.density)); });
    $("glassSwitch").setAttribute("aria-checked", String(p.glass !== false));
  }
  $("themeGroup").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-theme]"); if (!b) return;
    prefs.save({ theme: b.dataset.theme }); paintPrefs();
  });
  $("densityGroup").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-density]"); if (!b) return;
    prefs.save({ density: b.dataset.density }); paintPrefs();
  });
  $("glassSwitch").addEventListener("click", function () {
    prefs.save({ glass: prefs.get().glass === false }); paintPrefs();
  });

  /* ---------- Notifications ---------- */
  var notifSupported = "Notification" in window;
  function notifOn() { return notifSupported && Notification.permission === "granted" && localStorage.getItem("cs_notify") === "1"; }
  function paintNotif() {
    var btn = $("notifBtn"), note = $("notifNote");
    if (!notifSupported) { btn.disabled = true; btn.textContent = "Unavailable"; note.textContent = "This browser does not support notifications."; return; }
    if (Notification.permission === "denied") {
      btn.disabled = true; btn.textContent = "Blocked";
      note.textContent = "Notifications are blocked for this site. Allow them in your browser's site settings, then reload.";
      return;
    }
    btn.disabled = false;
    btn.textContent = notifOn() ? "Turn off" : "Turn on";
    note.textContent = notifOn()
      ? "On. You'll get a notification for messages that arrive while ChatSpace is open in the background."
      : "Get a system notification when a message arrives while ChatSpace is open in the background.";
  }
  $("notifBtn").addEventListener("click", async function () {
    if (notifOn()) { localStorage.setItem("cs_notify", "0"); toast("Notifications turned off."); }
    else {
      var p = await Notification.requestPermission();
      if (p === "granted") { localStorage.setItem("cs_notify", "1"); toast("Notifications are on."); }
      else if (p === "denied") toast("Your browser blocked notifications for this site.");
    }
    paintNotif();
  });

  /* ---------- Install app ---------- */
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function paintInstall() {
    var btn = $("installBtn"), note = $("installNote");
    if (standalone) { btn.disabled = true; btn.textContent = "Installed"; note.textContent = "You're using ChatSpace as an installed app."; return; }
    btn.disabled = false;
    btn.textContent = installEvent ? "Install app" : "How to install";
  }
  window.addEventListener("beforeinstallprompt", function (ev) { ev.preventDefault(); installEvent = ev; paintInstall(); });
  window.addEventListener("appinstalled", function () { installEvent = null; toast("ChatSpace installed."); paintInstall(); });
  $("installBtn").addEventListener("click", async function () {
    if (installEvent) {
      installEvent.prompt();
      try { await installEvent.userChoice; } catch (e) {}
      installEvent = null; paintInstall(); return;
    }
    $("installNote").textContent = isIOS
      ? "On iPhone / iPad: open this page in Safari, tap the Share button, then choose “Add to Home Screen”."
      : "Open your browser menu (⋮ or the install icon in the address bar) and choose “Install ChatSpace” or “Add to Home screen”. Install works on https:// sites and on localhost.";
  });

  /* ---------- Account ---------- */
  $("logoutBtn").addEventListener("click", async function () {
    try { await api("/auth/logout", { method: "POST" }); } catch (e) {}
    location.href = "/";
  });

  /* ---------- Start ---------- */
  (async function start() {
    paintPrefs(); paintNotif(); paintInstall();
    try {
      var d = await api("/api/me");
      paintProfile(d.user);
    } catch (e) { if (e.message !== "AUTH") toast(e.message); return; }
    try {
      var s = await (await fetch("/api/stats")).json();
      $("seatValue").textContent = s.users + " / " + s.maxUsers;
      $("seatNote").textContent = s.users + " of " + s.maxUsers + " seats are taken. Registration closes at " + s.maxUsers + ".";
    } catch (e) {}
    // stay "online" for friends while you browse settings
    if (window.io) { try { window.io({ withCredentials: true }); } catch (e) {} }
  })();
})();
