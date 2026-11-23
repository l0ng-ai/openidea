/**
 * The parts of the window a popup must stay out of: the device's safe-area insets (a
 * phone's status bar, notch and home indicator) and, at the bottom, the on-screen keyboard.
 * Zero on a desktop.
 */
let probe: HTMLDivElement | null = null;

export function screenInsets(win: Window = window): { top: number; right: number; bottom: number; left: number } {
  const doc = win.document;
  if (!probe || probe.ownerDocument !== doc || !probe.isConnected) {
    probe = doc.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;inset:0 auto auto 0;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    doc.body.appendChild(probe);
  }
  const s = win.getComputedStyle(probe);
  const px = (v: string) => parseFloat(v) || 0;
  const vv = win.visualViewport;
  const keyboard = vv ? Math.max(0, win.innerHeight - vv.height - vv.offsetTop) : 0;
  return {
    top: px(s.paddingTop),
    right: px(s.paddingRight),
    bottom: Math.max(px(s.paddingBottom), keyboard),
    left: px(s.paddingLeft),
  };
}
