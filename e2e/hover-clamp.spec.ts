import { expect, test } from "@playwright/test";

/** Near the window edge CodeMirror caps a hover tooltip's height (#2910). */
test("hover sections scroll inside a height-capped tooltip", async ({ page }) => {
  await page.goto("/");
  const r = await page.evaluate(async () => {
    const viewMod = await import("/node_modules/.vite/deps/@codemirror_view.js" as string);
    const stateMod = await import("/node_modules/.vite/deps/@codemirror_state.js" as string);
    const { lspTheme } = await import("/src/editor/lsp/theme.ts" as string);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:99999;background:white";
    document.body.append(host);
    const view = new viewMod.EditorView({
      state: stateMod.EditorState.create({ doc: "x", extensions: lspTheme }),
      parent: host,
    });
    const tip = document.createElement("div");
    tip.className = "cm-tooltip cm-tooltip-hover";
    tip.style.cssText = "position:absolute;top:10px;left:10px;height:200px";
    const sec = document.createElement("div");
    sec.className = "cm-tooltip-section cm-lsp-hover";
    sec.innerHTML = Array.from({ length: 40 }, (_, i) => `<p>line ${i}</p>`).join("");
    tip.append(sec);
    view.dom.append(tip);
    const t = tip.getBoundingClientRect(),
      s = sec.getBoundingClientRect();
    return {
      tip: Math.round(t.height),
      secBottom: Math.round(s.bottom),
      tipBottom: Math.round(t.bottom),
      scrolls: sec.scrollHeight > sec.clientHeight,
    };
  });
  expect(r.secBottom).toBeLessThanOrEqual(r.tipBottom);
  expect(r.scrolls).toBe(true);
});
