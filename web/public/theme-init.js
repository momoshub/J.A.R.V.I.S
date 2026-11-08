// Resolves the dashboard theme before first paint, so a dark page never
// flashes light. Loaded as a blocking file from index.html because the
// dashboard's CSP (script-src 'self') refuses inline scripts.
// src/ui/theme.ts owns the theme after load; both use the "dashboard.theme" key.
(function () {
  var pref = "system";
  try {
    pref = localStorage.getItem("dashboard.theme") || "system";
  } catch (e) {}
  var dark = pref === "dark" || (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#262624" : "#faf9f5");
})();
