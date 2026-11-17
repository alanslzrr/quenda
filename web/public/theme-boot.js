// Applies the stored theme before the first paint, so a dark preference does not flash light while the bundle loads.
// A classic same-origin script because the CSP forbids inline ones. It reads "quenda.preferences", the key
// preferences.ts already writes (listed in storage-keys.ts); ThemeProvider takes over once the app renders.
(() => {
  try {
    const root = document.documentElement;
    let theme = null;
    try {
      theme = JSON.parse(localStorage.getItem("quenda.preferences") ?? "{}")?.theme;
    } catch {
      /* Blocked or unreadable storage keeps the default theme. */
    }
    if (theme === "system") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    // The browser hints follow the resolved preference. The colours are the
    // foundation.css backgrounds that paint before the app applies the municipal palette.
    const mode = root.dataset.theme === "dark" ? "dark" : "light";
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", mode);
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.removeAttribute("media");
      meta.setAttribute("content", mode === "dark" ? "#141414" : "#ffffff");
    }
  } catch {
    /* The static defaults in index.html still apply. */
  }
})();
