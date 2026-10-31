// Replay actual JDT LS results through the real UI; this is not a desktop E2E test.
import { chromium } from "@playwright/test";
import fs from "node:fs";
const evidence = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const source = evidence.source.split("\n");
const groups = [
  {
    path: "/Bean.java",
    usages: evidence.cases.count.map(({ location, kind, access }) => ({
      path: "/Bean.java",
      line: location.range.start.line,
      col: location.range.start.character,
      endCol: location.range.end.character,
      text: source[location.range.start.line],
      kind,
      access,
      sourceLocation: {
        path: "/Bean.java",
        range: {
          start: { line: location.range.start.line, col: location.range.start.character },
          end: { line: location.range.end.line, col: location.range.end.character },
        },
      },
    })),
  },
];
const output = process.argv[3] ?? "/tmp";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto(process.env.OPENIDEA_TEST_URL ?? "http://localhost:1451");
await page.getByRole("tree", { name: "Project" }).waitFor();
await page.evaluate(async (groups) => {
  const { useUsagesPopup } = await import("/src/features/code-insight/usages.ts");
  useUsagesPopup.setState({ open: true, anchor: { x: 940, y: 600 }, symbol: "count", groups, note: null });
}, groups);
const dialog = page.getByRole("dialog", { name: "Usages", exact: true });
await dialog.waitFor();
const read = dialog.getByRole("button", { name: "Show read accesses", exact: true });
const write = dialog.getByRole("button", { name: "Show write accesses", exact: true });
async function pressed(button, value) {
  if ((await button.getAttribute("aria-pressed")) !== String(value)) throw new Error("Incorrect toggle state");
}
await pressed(read, true);
await pressed(write, true);
if (await dialog.getByRole("combobox").count()) throw new Error("Unexpected category dropdown");
// Independent-review regression: focused toolbar Escape must clear speed search.
await dialog.locator("[data-autofocus]").focus();
await page.keyboard.type("setCount");
await dialog.getByRole("status").filter({ hasText: "setCount" }).waitFor();
await write.click();
await write.press("Escape");
if (!(await dialog.isVisible()) || (await dialog.getByRole("status").count()))
  throw new Error("Focused-button Escape did not clear search");
await write.click();
const total = groups[0].usages.length;
for (const [button, hidden, filename] of [
  [write, "write", "read"],
  [read, "read", "write"],
]) {
  await button.click();
  await pressed(read, hidden === "write");
  await pressed(write, hidden === "read");
  const shown = groups[0].usages.filter((u) => u.access !== hidden).length;
  await dialog.getByText(`${shown} of ${total} found`, { exact: true }).waitFor();
  const box = await dialog.boundingBox();
  if (box.x < 0 || box.x + box.width > 1001 || box.y < 0 || box.y + box.height > 701)
    throw new Error(`Overflow ${JSON.stringify(box)}`);
  await page.screenshot({ path: `${output}/usages-${filename}.png` });
}
await dialog.getByRole("button", { name: /Open in Find Window/ }).click();
await page.getByRole("toolbar", { name: "Usage access filters" }).waitFor();
await pressed(page.getByRole("button", { name: "Show read accesses", exact: true }), false);
await pressed(page.getByRole("button", { name: "Show write accesses", exact: true }), true);
const transferred = await page.evaluate(async () => {
  const { useUsages } = await import("/src/features/code-insight/usages.ts");
  return useUsages
    .getState()
    .tabs.flatMap((t) => t.groups.flatMap((g) => g.usages))
    .map((u) => JSON.stringify([u.line, u.col, u.endCol, u.kind, u.access]))
    .sort();
});
if (
  JSON.stringify(transferred) !==
  JSON.stringify(groups[0].usages.map((u) => JSON.stringify([u.line, u.col, u.endCol, u.kind, u.access])).sort())
)
  throw new Error("Transfer lost access metadata");
// Browser demo mode has no filesystem. Replay the same source document for
// display only, after independently checking the transfer metadata above.
await page.evaluate(async (source) => {
  const { useUsages } = await import("/src/features/code-insight/usages.ts");
  useUsages.setState((s) => ({
    tabs: s.tabs.map((t) => ({
      ...t,
      groups: t.groups.map((g) => ({ ...g, usages: g.usages.map((u) => ({ ...u, text: source[u.line] })) })),
    })),
  }));
}, source);
await page.screenshot({ path: `${output}/usages-find.png` });
await page.reload();
await page.getByRole("tree", { name: "Project" }).waitFor();
const restored = await page.evaluate(async () =>
  (await import("/src/features/code-insight/UsageAccessFilter.tsx")).useUsageAccessOptions.getState(),
);
if (restored.read || !restored.write) throw new Error("Filter persistence failed");
console.log(
  "PASS Chromium: focused-button Escape, real-response read/write counts, auto-enable last toggle, unknown/readWrite retention, viewport, Find metadata, persisted filter",
);
await browser.close();
