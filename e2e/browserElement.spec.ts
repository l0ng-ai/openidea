import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const script = readFileSync(new URL("../src-tauri/src/browser_picker/element.js", import.meta.url), "utf8");
const element = {
  selector: "main:nth-of-type(1) > button:nth-of-type(2)",
  html: '<button aria-disabled="true">',
  styles: "display: inline-flex;\nposition: relative;\nvisibility: visible;\npointer-events: none;",
};

test("a trusted gesture captures structure without page text or form values", async ({ page }) => {
  await page.addInitScript({
    content: `window.ipc = { postMessage(value) { window.lastSignal = value; } };\n${script}`,
  });
  await page.route("http://localhost:3000/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main><input type="password" value="fixture-password"><button>First</button><button disabled data-note="fixture-note" style="display:inline-flex">Fixture customer</button></main><iframe srcdoc="<p>Frame</p>"></iframe>',
    }),
  );
  await page.goto("http://localhost:3000/sample?key=fixture-key");
  const button = page.getByRole("button", { name: "Fixture customer" });
  await button.dispatchEvent("pointerdown", { isPrimary: true, button: 0 });
  expect(await page.evaluate("window.__openideaPickedElement")).toBeNull();
  expect(await page.frames()[1]!.evaluate("window.__openideaPickedElement")).toBeUndefined();
  const rect = await button.boundingBox();
  await page.mouse.click(rect!.x + 4, rect!.y + 4);
  const picked = await page.evaluate<string>("window.__openideaPickedElement");
  expect(await page.evaluate("window.lastSignal")).toBe("picked");
  expect(JSON.parse(picked)).toMatchObject({
    path: [
      { tag: "html", index: 1 },
      { tag: "body", index: 1 },
      { tag: "main", index: 1 },
      { tag: "button", index: 2 },
    ],
    disabled: true,
    display: "inline-flex",
  });
  expect(picked).not.toMatch(/fixture-|Fixture customer|First/);
});

async function openBrowser(page: Page) {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(actions)).executeAction("web.inspectLocalPage");
  });
  await expect(page.getByRole("textbox", { name: "Local page URL" })).toBeVisible();
}

for (const key of ["home", "checkout-task"]) {
  test(`review appends to the ${key === "home" ? "new" : "active"} Codex task draft`, async ({
    workbench: page,
  }, info) => {
    await stubDesktop(page);
    await page.evaluate(
      async ({ snapshot, key }) => {
        const storePath = "/src/features/agents/store.ts";
        const store = await import(storePath);
        window.__ipc.handlers.web_inspect_element = () => snapshot;
        const task = {
          id: key,
          title: "Checkout review",
          provider: "codex",
          status: "ready",
          isolation: "local",
          model: null,
          cwd: "/dev/acme-api",
          branch: null,
          base: null,
          baseCommit: null,
          error: null,
          createdMs: 0,
          updatedMs: 0,
          config: [],
          commands: [],
          usage: null,
          queue: [],
        };
        store.useAgents.setState({
          loaded: true,
          sessionLocation: key === "home" ? "editor" : "toolWindow",
          ...(key === "home"
            ? {}
            : { tasks: new Map([[key, task]]), entries: new Map([[key, []]]), docked: key, homeOpen: false }),
          draft: { provider: "codex", config: {}, isolation: "local", base: null },
        });
        store.updateComposer(key, {
          text: "Why is the checkout button disabled?",
          files: [{ path: "/dev/acme-api/README.md", rel: "README.md", attached: true }],
        });
      },
      { snapshot: element, key },
    );
    await openBrowser(page);
    await page.getByLabel("Local page URL").fill("http://localhost:3000");
    await page.getByRole("button", { name: "Inspect Element", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Selected element" })).toBeVisible();
    await expect(page.getByText(element.html, { exact: false })).toBeVisible();
    await page.screenshot({ path: info.outputPath("preview.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Add to Agent Draft" }).click();
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(box).toBeVisible();
    const draft = await page.evaluate(async (key) => {
      const storePath = "/src/features/agents/store.ts";
      const store = await import(storePath);
      return {
        ...store.composerDraft(key),
        provider:
          key === "home"
            ? store.useAgents.getState().draft.provider
            : store.useAgents.getState().tasks.get(key)?.provider,
      };
    }, key);
    expect(draft).toMatchObject({
      text: expect.stringContaining("Why is the checkout button disabled?\n\n"),
      files: [{ path: "/dev/acme-api/README.md", rel: "README.md", attached: true }],
      provider: "codex",
    });
    expect(draft.text).toContain(element.selector);
    expect(draft.text).toContain(element.html);
    expect(draft.text).toContain(element.styles);
    await expect(box).toBeEditable();
    await page.screenshot({ path: info.outputPath("draft.png"), animations: "disabled" });
    expect(await ipcCalls(page, "agent_prompt")).toEqual([]);
    expect(await ipcCalls(page, "agent_create")).toEqual([]);
  });
}

test("cancelling or revoking trust discards a delayed selection", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate((snapshot) => {
    window.__ipc.handlers.web_inspect_element = () =>
      new Promise((resolve) => {
        document.addEventListener("test:picker-done", () => resolve(snapshot), { once: true });
      });
  }, element);
  await openBrowser(page);
  await page.getByLabel("Local page URL").fill("http://localhost:3000");
  const inspect = page.getByRole("button", { name: "Inspect Element", exact: true });
  await inspect.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => document.dispatchEvent(new Event("test:picker-done")));
  await expect(inspect).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add to Agent Draft" })).toHaveCount(0);
  await inspect.click();
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(projectPath);
    useProject.setState({ project: { ...useProject.getState().project, trusted: false } });
    document.dispatchEvent(new Event("test:picker-done"));
  });
  await expect(page.getByText("Element inspection requires a trusted local project.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to Agent Draft" })).toHaveCount(0);
  expect(await ipcCalls(page, "cancel_request")).toHaveLength(2);
});
