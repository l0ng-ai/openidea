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
  await page.addInitScript({ content: script });
  await page.route("http://localhost:3000/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main><input type="password" value="fixture-password"><button>First</button><button disabled data-note="fixture-note" style="display:inline-flex">Fixture customer</button></main><iframe srcdoc="<p>Frame</p>"></iframe>',
    }),
  );
  await page.goto("http://localhost:3000/sample?key=fixture-key");
  const button = page.getByRole("button", { name: "Fixture customer" });
  await page.getByRole("button", { name: "First" }).click();
  expect(await page.evaluate("window.__openideaPickedElement")).toBeNull();
  await page.evaluate("window.__openideaInspect(true)");
  await button.dispatchEvent("pointerdown", { isPrimary: true, button: 0 });
  expect(await page.evaluate("window.__openideaPickedElement")).toBeNull();
  expect(await page.frames()[1]!.evaluate("window.__openideaPickedElement")).toBeUndefined();
  const rect = await button.boundingBox();
  await page.mouse.click(rect!.x + 4, rect!.y + 4);
  const picked = await page.evaluate(() => String(Reflect.get(window, "__openideaPickedElement")));
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
  await page.evaluate("window.__openideaInspect(true)");
  await page.keyboard.press("Escape");
  expect(await page.evaluate("window.__openideaPickedElement")).toBe("cancel");
});

async function openBrowser(page: Page) {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(actions)).executeAction("web.openLocalBrowser");
  });
  await expect(page.getByRole("textbox", { name: "Local page URL" })).toBeVisible();
}

async function stubBrowser(page: Page) {
  await page.evaluate((snapshot) => {
    let history: string[] = [],
      index = 0,
      inspecting = false;
    window.__ipc.handlers.cancel_request = () => null;
    window.__ipc.handlers.web_browser_open = ({ url }) => {
      history = [String(url)];
      index = 0;
    };
    window.__ipc.handlers.web_browser_control = ({ action }) => {
      const command = action as { type: string; url: string };
      let element = null;
      switch (command.type) {
        case "navigate":
          history.splice(++index, Infinity, command.url);
          break;
        case "back":
          index--;
          break;
        case "forward":
          index++;
          break;
        case "inspect":
          inspecting = true;
          break;
        case "cancel":
          inspecting = false;
          break;
        case "status":
          if (inspecting && !document.body.hasAttribute("data-hold-pick")) {
            inspecting = false;
            element = snapshot;
          }
      }
      return { url: history[index], canBack: index > 0, canForward: index + 1 < history.length, inspecting, element };
    };
  }, element);
}

async function visit(page: Page, url: string) {
  await page.getByLabel("Local page URL").fill(url);
  await page.getByLabel("Local page URL").press("Enter");
}

for (const key of ["home", "checkout-task"]) {
  test(`review appends to the ${key === "home" ? "new" : "active"} Codex task draft`, async ({
    workbench: page,
  }, info) => {
    await stubDesktop(page);
    await stubBrowser(page);
    await page.evaluate(async (key) => {
      const storePath = "/src/features/agents/store.ts";
      const store = await import(storePath);
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
    }, key);
    await openBrowser(page);
    await visit(page, "http://localhost:3000");
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
  await stubBrowser(page);
  await page.evaluate(() => document.body.setAttribute("data-hold-pick", ""));
  await openBrowser(page);
  await visit(page, "http://localhost:3000");
  const inspect = page.getByRole("button", { name: "Inspect Element", exact: true });
  await inspect.click();
  await expect(inspect).toHaveAttribute("aria-pressed", "true");
  await inspect.click();
  await expect(inspect).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Add to Agent Draft" })).toHaveCount(0);
  await inspect.click();
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(projectPath);
    useProject.setState({ project: { ...useProject.getState().project, trusted: false } });
  });
  await expect(page.getByText("Element inspection requires a trusted local project.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to Agent Draft" })).toHaveCount(0);
  expect(await ipcCalls(page, "cancel_request")).toHaveLength(1);
});

test("navigates the same session and keeps native history until Close", async ({ workbench: page }) => {
  await stubDesktop(page);
  await stubBrowser(page);
  await openBrowser(page);
  const panel = page.getByRole("region", { name: "Browser" });
  const address = panel.getByLabel("Local page URL");
  await visit(page, "http://localhost:3000/first");
  await expect(panel.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
  await visit(page, "http://localhost:3000/next");
  await page.evaluate(async () => {
    const path = "/src/workbench/contributions.ts";
    (await import(path)).toolWindowService().hide("browser");
  });

  await expect(panel).toBeHidden();
  await openBrowser(page);
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/first");
  await panel.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/next");
  await panel.getByRole("button", { name: "Reload", exact: true }).click();
  expect(await ipcCalls(page, "web_browser_open")).toHaveLength(1);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Reload", exact: true })).toHaveCount(0);
  expect(await ipcCalls(page, "cancel_request")).toHaveLength(1);
});

test("localhost console links offer the Browser in their context menu; a plain click stays external", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await stubBrowser(page);
  const routed = await page.evaluate(async () => {
    const path = "/src/features/run/navigate.ts";
    const { consoleLinkMenu, debugConsoleUrl } = await import(path);
    const click = { metaKey: false, ctrlKey: false, shiftKey: false };
    const urls = ["https://localhost.example.org/", "http://guest@localhost:3000/", "http://127.0.0.1:3000/app"];
    const menus = urls.map((url) => {
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.textContent = url;
      return consoleLinkMenu(link);
    });
    menus[2][0].run();
    return { plain: urls.map((url) => debugConsoleUrl(click, url)), offered: menus.map((m) => m.length > 0) };
  });
  expect(routed).toEqual({ plain: [false, false, false], offered: [false, false, true] });
  await expect(page.getByLabel("Local page URL")).toHaveValue("http://127.0.0.1:3000/app");
  expect(await ipcCalls(page, "web_browser_open")).toHaveLength(1);
});
