/**
 * The document of a view's `html` body. It runs in an `<iframe sandbox=
 * "allow-scripts">` (an opaque origin: no cookies, storage, IDE API or parent
 * access) under a CSP that allows only its own inline scripts and styles and
 * `data:` images — no network. `openidea.postMessage` / `openidea.onMessage`
 * are its only way to the plugin.
 */

export const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

/** Marks frame ↔ workbench messages. */
export const FRAME_TAG = "openidea-view";

const BRIDGE = `
(() => {
  const listeners = [];
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.tag !== "${FRAME_TAG}") return;
    for (const l of listeners) { try { l(String(e.data.text)); } catch (err) { console.error(err); } }
  });
  window.openidea = Object.freeze({
    postMessage: (text) => window.parent.postMessage({ tag: "${FRAME_TAG}", text: String(text) }, "*"),
    onMessage: (fn) => { if (typeof fn === "function") listeners.push(fn); },
  });
})();`;

/** `html` wrapped with the CSP, the message bridge and base styles. */
export function frameDocument(html: string, dark: boolean): string {
  const scheme = dark ? "dark" : "light";
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    `<style>:root{color-scheme:${scheme}}body{margin:8px;font:13px system-ui,sans-serif}</style>`,
    `<script>${BRIDGE}</script>`,
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}
