/**
 * The phone's page never zooms or scrolls as a whole. iOS zooms in on a focused field whose
 * text is under 16px (the editor's input) and scrolls the page to keep the field above the
 * keyboard; instead the page takes the visible height, so the workbench lays out above it.
 */
export function installPhoneViewport(win: Window = window): () => void {
  const meta = win.document.querySelector('meta[name="viewport"]');
  meta?.setAttribute(
    "content",
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
  );
  const root = win.document.documentElement;
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const fit = () => {
    root.style.height = `${Math.round(vv.height)}px`;
    // Fixed layers (dialogs) size to the layout viewport, which the keyboard does not shrink.
    root.style.setProperty("--visible-height", `${Math.round(vv.height)}px`);
    // The on-screen keyboard takes the bottom: bars there (the tab bar) step aside.
    const full = Math.max(win.innerHeight, win.screen?.height ?? 0);
    root.toggleAttribute("data-keyboard", full - vv.height > 120);
    if (win.scrollX || win.scrollY) win.scrollTo(0, 0);
  };
  fit();
  // The keyboard's resize can arrive mid-animation: measure again once it has settled.
  let settle = 0;
  const refit = () => {
    fit();
    win.clearTimeout(settle);
    settle = win.setTimeout(fit, 350);
  };
  vv.addEventListener("resize", fit);
  win.document.addEventListener("focusin", refit);
  win.document.addEventListener("focusout", refit);
  vv.addEventListener("scroll", fit);
  win.addEventListener("scroll", fit);
  return () => {
    win.clearTimeout(settle);
    win.document.removeEventListener("focusin", refit);
    win.document.removeEventListener("focusout", refit);
    vv.removeEventListener("resize", fit);
    vv.removeEventListener("scroll", fit);
    win.removeEventListener("scroll", fit);
    root.style.height = "";
    root.style.removeProperty("--visible-height");
    root.removeAttribute("data-keyboard");
  };
}
