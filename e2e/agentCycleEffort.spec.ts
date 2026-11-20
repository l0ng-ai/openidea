import type { Locator, Page } from "@playwright/test";
import type { AgentConfigOption, AgentEntry, AgentProvider, AgentTask } from "../src/bindings";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

type Placement = "editor" | "toolWindow";
const effortId = "deliberation-budget";
const modelId = "cortex";
const draft = "draft keep this unsent";
const rebound = "Control+Meta+Shift+J";
const option = (id: string, category: string, values: [string, string][], current: string): AgentConfigOption => ({
  id,
  category,
  name: category === "model" ? "Model" : "Reasoning",
  description: null,
  current,
  via: "option",
  values: values.map(([value, name]) => ({ value, name, description: null })),
});
const models = option(
  modelId,
  "model",
  [
    ["atlas", "Atlas"],
    ["swift", "Swift"],
    ["plain", "Plain"],
    ["solo", "Solo"],
  ],
  "atlas",
);
const atlas = option(
  effortId,
  "thought_level",
  [
    ["budget-7", "Gentle"],
    ["budget-23", "Balanced"],
    ["budget-91", "Deep"],
  ],
  "budget-7",
);
const swift = option(
  effortId,
  "thought_level",
  [
    ["quick", "Quick"],
    ["thorough", "Thorough"],
  ],
  "quick",
);
const solo = option(effortId, "thought_level", [["only", "Only"]], "only");
const provider: AgentProvider = {
  id: "acceptance-provider",
  name: "Acceptance Provider",
  command: "acceptance",
  program: "acceptance",
  args: [],
  defaultProgram: null,
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  installed: true,
  env: {},
  commands: [],
  source: { kind: "custom" },
  config: [models],
  thoughtLevels: { atlas: [atlas], swift: [swift], plain: [], solo: [solo] },
};
const firstTask: AgentTask = {
  id: "effort-first",
  title: "First effort task",
  provider: provider.id,
  status: "ready",
  isolation: "local",
  model: "atlas",
  cwd: "/dev/acme-api",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [models, atlas],
  commands: [],
  usage: null,
  queue: [],
};
const secondTask: AgentTask = { ...firstTask, id: "effort-second", title: "Second effort task" };
const subagent: AgentEntry = {
  type: "subagent",
  id: "effort-child",
  title: "Inspect the project",
  description: null,
  status: "done",
  error: null,
  prompt: null,
  reply: null,
  tools: 0,
  activity: null,
  startedMs: null,
  endedMs: null,
  cancellable: false,
};

async function seed(
  page: Page,
  placement: Placement,
  surface: "new" | "task" = "task",
  model = "atlas",
  status: AgentTask["status"] = "ready",
  catalogOnly = false,
  offered = provider,
) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ placement, surface, provider, firstTask, secondTask, subagent, model, status, modelId, catalogOnly }) => {
      // In-memory sample tasks belong to Vite's browser realm. Static Node imports create a different store and cannot seed the workbench.
      const storePath = "/src/features/agents/store.ts";
      const store = await import(storePath);
      const initialCatalog = {
        ...provider,
        config: provider.config.map((entry) => ({
          ...entry,
          values: entry.values.filter((value) => value.value !== "swift"),
        })),
      };
      const configFor = (model: string) => [
        { ...(catalogOnly && model !== "swift" ? initialCatalog : provider).config[0]!, current: model },
        ...(provider.thoughtLevels?.[model] ?? []),
      ];
      const tasks = new Map(
        [firstTask, secondTask].map((task) => [task.id, { ...task, status, model, config: configFor(model) }]),
      );
      const entries: AgentEntry[] = Array.from({ length: 24 }, (_, turn): AgentEntry[] => [
        { type: "user", text: `Request ${turn}`, attachments: [] },
        { type: "agent", text: `Reply ${turn}` },
      ]).flat();
      let channel: unknown;
      const handlers = window.__ipc.handlers;
      // Settings writes must update the browser's project store, just as the desktop response does.
      const projectPath = "/src/platform/project.ts";
      const { useProject } = await import(projectPath);
      handlers.settings_set = ({ key, value }) => {
        const next: Record<string, unknown> = structuredClone(useProject.getState().settings ?? {});
        const path = String(key).split(".");
        let node = next;
        for (const segment of path.slice(0, -1)) {
          node[segment] ??= {};
          node = node[segment] as Record<string, unknown>;
        }
        const last = path.at(-1)!;
        const parsed: unknown = JSON.parse(String(value));
        if (parsed === null) delete node[last];
        else node[last] = parsed;
        useProject.setState({ settings: next });
        return next;
      };
      handlers.agent_subscribe = ({ onEvent }) => {
        channel = onEvent;
        return [...tasks.values()];
      };
      handlers.agent_providers = () => [catalogOnly ? initialCatalog : provider];
      handlers.agent_refresh_models = ({ force }) => ({
        provider: provider.id,
        config: (catalogOnly && !force ? initialCatalog : provider).config,
        thoughtLevels: provider.thoughtLevels,
        refreshing: false,
        refreshedAtMs: Date.now(),
        retryAtMs: null,
        error: null,
      });
      handlers.agent_probe = () => null;
      handlers.agent_commands = () => [];
      handlers.agent_entries = ({ subagent: child }) =>
        child ? [{ type: "agent", text: "Subagent findings" }] : [...entries, subagent];
      handlers.agent_changes = () => [];
      handlers.agent_grouped_changes = () => ({ uncommitted: [], commits: [] });
      handlers.vcs_branch_info = () => ({ head: "main" });
      handlers.vcs_branches = () => [];
      handlers.agent_set_config = async ({ task: id, option, value }) => {
        const previous = tasks.get(String(id))!;
        const pendingModel = catalogOnly && option === modelId && value === "swift";
        if (pendingModel) {
          const { promise, resolve } = Promise.withResolvers<void>();
          document.addEventListener("test:chat-model-settings-ready", () => resolve(), { once: true });
          await promise;
        }
        const updated =
          option === modelId
            ? { ...previous, model: pendingModel ? previous.model : String(value), config: configFor(String(value)) }
            : {
                ...previous,
                config: previous.config.map((entry) =>
                  entry.id === option ? { ...entry, current: String(value) } : entry,
                ),
              };
        // Mirror the backend's optimistic task event; production's subscription reducer owns the UI update.
        tasks.set(updated.id, updated);
        window.__ipc.send(channel, { type: "task", task: updated });
        if (document.documentElement.dataset.holdConfig === "true") {
          delete document.documentElement.dataset.holdConfig;
          const { promise, resolve } = Promise.withResolvers<void>();
          document.addEventListener("release-config", () => resolve(), { once: true });
          await promise;
        }
        return null;
      };
      handlers.agent_prompt = () => null;
      handlers.agent_interrupt = () => null;
      await store.connect();
      store.useAgents.setState({
        composers: new Map(),
        unread: new Set(),
        docked: null,
        homeOpen: false,
        sessionLocation: placement,
        draft: store.savedDraft({ provider: provider.id, config: { [modelId]: model } }),
      });
      if (surface === "new") store.openHome();
      else store.openTask(firstTask.id);
    },
    { placement, surface, provider: offered, firstTask, secondTask, subagent, model, status, modelId, catalogOnly },
  );
  await expect(box(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

function box(page: Page) {
  return page.getByRole("textbox", { name: "Message", exact: true }).filter({ visible: true });
}
function history(page: Page) {
  return page.locator("[class*='_stream_']:visible");
}
function modelButton(page: Page) {
  return page.getByRole("button", { name: "Model", exact: true }).filter({ visible: true });
}
function effortLabel(page: Page) {
  return page.getByRole("button", { name: /^Model settings:/ }).filter({ visible: true });
}
async function expectEffort(page: Page, name: string) {
  await expect(effortLabel(page)).toHaveText(name);
}
async function selected(box: Locator) {
  return box.evaluate((element) => {
    const selection = window.getSelection();
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !element.contains(selection.anchorNode) ||
      !element.contains(selection.focusNode)
    )
      return null;
    const offset = (node: Node, at: number) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setEnd(node, at);
      return range.toString().length;
    };
    return {
      anchor: offset(selection.anchorNode, selection.anchorOffset),
      head: offset(selection.focusNode, selection.focusOffset),
      text: selection.toString(),
    };
  });
}
async function selectDraft(page: Page) {
  const input = box(page);
  await input.fill(draft);
  await input.press("Home");
  for (let i = 0; i < 6; i++) await input.press("ArrowRight");
  for (let i = 0; i < 4; i++) await input.press("Shift+ArrowRight");
  await expect.poll(() => selected(input)).toEqual({ anchor: 6, head: 10, text: "keep" });
}
async function chooseModel(page: Page, name: string) {
  await modelButton(page).click();
  // A model row also holds its Pin button, whose label joins the option's name.
  await page.getByRole("option", { name: new RegExp(`^${name}\\b`) }).click();
  await page.keyboard.press("Escape");
  await box(page).focus();
}
async function expectNoSubmission(page: Page) {
  expect(await ipcCalls(page, "agent_prompt")).toEqual([]);
  expect(await ipcCalls(page, "agent_interrupt")).toEqual([]);
  expect(await ipcCalls(page, "agent_create")).toEqual([]);
}

for (const surface of ["new", "task"] as const) {
  test(`${surface}: configure another model from its row, then edit its context from the composer`, async ({
    workbench: page,
  }) => {
    const context = option(
      "context_tier",
      "model_config",
      [
        ["default", "200K"],
        ["long_context", "1M"],
      ],
      "default",
    );
    const offered = {
      ...provider,
      thoughtLevels: { ...provider.thoughtLevels, atlas: [atlas, context], swift: [swift, context] },
    };
    await seed(page, "editor", surface, "atlas", "ready", false, offered);
    await box(page).fill("Review the project structure");
    await modelButton(page).click();
    const row = page.getByRole("option", { name: /^Swift\b/ });
    await row.hover();
    const configure = row.getByRole("button", { name: "Configure Swift…" });
    if (surface === "task") await configure.press("Enter");
    else await configure.click();
    await expect(modelButton(page)).toHaveText("Atlas");
    await expect(page.getByRole("radio", { name: "Gentle" })).toHaveCount(0);
    await page.getByRole("radio", { name: "Thorough" }).click();
    await expect(modelButton(page)).toHaveText("Swift");
    await expect(page.getByRole("radio", { name: "Thorough" })).toBeChecked();
    await page.keyboard.press("Escape");
    const settings = page.getByRole("button", { name: /^Model settings:/ });
    await expect(settings).toHaveText("Thorough · 200K");
    await settings.click();
    await page.getByRole("radio", { name: "1M" }).click();
    await expect(settings).toHaveText("Thorough · 1M");
    await page.getByRole("button", { name: "Back to models" }).click();
    await expect(page.getByRole("listbox", { name: "Model", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(box(page)).toHaveText("Review the project structure");
    await expectNoSubmission(page);
  });
}

for (const placement of ["editor", "toolWindow"] as const) {
  test(`${placement}: existing task cycles advertised values and wraps without editing, moving focus or scrolling`, async ({
    workbench: page,
  }) => {
    await seed(page, placement);
    const stream = history(page);
    await stream.click({ position: { x: 12, y: 20 } });
    await stream.press("Home");
    await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);
    await selectDraft(page);
    for (const [value, name] of [
      ["budget-23", "Balanced"],
      ["budget-91", "Deep"],
      ["budget-7", "Gentle"],
    ]) {
      await page.keyboard.press("Alt+t");
      await expectEffort(page, name!);
      await expect(box(page)).toBeFocused();
      await expect(box(page)).toHaveText(draft);
      await expect.poll(() => selected(box(page))).toEqual({ anchor: 6, head: 10, text: "keep" });
      await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);
      expect((await ipcCalls(page, "agent_set_config")).at(-1)).toEqual({
        task: firstTask.id,
        option: effortId,
        value,
      });
      await expect(page.getByRole("listbox", { name: "Reasoning", exact: true })).toHaveCount(0);
    }
    await expectNoSubmission(page);
    await stream.click({ position: { x: 12, y: 20 } });
    await page.keyboard.press("Alt+t");
    await expectEffort(page, "Balanced");
    await expect(stream).toBeFocused();
    await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);
  });

  test(`${placement}: New Task cycles effort without changing or submitting the draft`, async ({ workbench: page }) => {
    await seed(page, placement, "new");
    await selectDraft(page);
    // macOS Option+T may report † as key; the dispatcher's physical code must still resolve Alt+T.
    await box(page).dispatchEvent("keydown", { key: "†", code: "KeyT", altKey: true, bubbles: true, cancelable: true });
    await expectEffort(page, "Balanced");
    await expect(box(page)).toBeFocused();
    await expect(box(page)).toHaveText(draft);
    await expect.poll(() => selected(box(page))).toEqual({ anchor: 6, head: 10, text: "keep" });
    await expectNoSubmission(page);
  });
}

for (const [surface, model, status] of [
  ["new", "plain", "ready"],
  ["new", "solo", "ready"],
  ["task", "plain", "ready"],
  ["task", "solo", "ready"],
  ["task", "atlas", "archived"],
] as const) {
  test(`${surface} ${model} ${status}: unavailable effort leaves configuration untouched`, async ({
    workbench: page,
  }) => {
    await seed(page, "editor", surface, model, status);
    if (status === "archived") await history(page).click({ position: { x: 12, y: 20 } });
    else await box(page).focus();
    const before = await modelButton(page).textContent();
    await page.keyboard.press("Alt+t");
    await expect(modelButton(page)).toHaveText(before!);
    expect(await ipcCalls(page, "agent_set_config")).toEqual([]);
    await expectNoSubmission(page);
  });
}

test("subagent conversation never changes its hidden parent's effort", async ({ workbench: page }) => {
  await seed(page, "editor");
  await page.getByTitle("Open the subagent's conversation", { exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Subagent", exact: true })).toBeVisible();
  await history(page).click({ position: { x: 12, y: 20 } });
  await page.keyboard.press("Alt+t");
  expect(await ipcCalls(page, "agent_set_config")).toEqual([]);
  await page
    .getByRole("navigation", { name: "Subagent", exact: true })
    .getByRole("button", { name: firstTask.title, exact: true })
    .click();
  await expectEffort(page, "Gentle");
});

test("Settings and effort popup exclude the agent shortcut", async ({ workbench: page }) => {
  await seed(page, "editor");
  await box(page).fill(draft);
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings", exact: true });
  await search.fill("keymap");
  await page.keyboard.press("Alt+t");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("keymap");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await effortLabel(page).click();
  const popup = page.getByRole("radiogroup", { name: "Effort Level", exact: true });
  await expect(popup).toBeVisible();
  await page.keyboard.press("Alt+t");
  expect(await ipcCalls(page, "agent_set_config")).toEqual([]);
  await page.keyboard.press("Escape");
  await expectEffort(page, "Gentle");
  await expect(box(page)).toHaveText(draft);
});

test("code editor and terminal do not mutate the previously focused docked agent", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await seed(page, "toolWindow");
  await box(page).fill(draft);
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Alt+t");
  await expect(editor.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Alt+F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const input = terminal.getByRole("textbox", { name: "Terminal input" });
  await expect(input).toBeFocused();
  await page.keyboard.press("Alt+t");
  await expect(input).toBeFocused();
  expect(await ipcCalls(page, "agent_set_config")).toEqual([]);
  await expectNoSubmission(page);
});

test("hidden kept-alive editor tasks stay isolated", async ({ workbench: page }) => {
  await seed(page, "editor");
  await box(page).fill("first draft");
  await page.evaluate(async (id) => {
    // Open the existing browser store; a static Node import cannot reach the mounted workbench.
    const storePath = "/src/features/agents/store.ts";
    (await import(storePath)).openTask(id);
  }, secondTask.id);
  await box(page).fill("second draft");
  await page.keyboard.press("Alt+t");
  await expectEffort(page, "Balanced");
  await page.getByRole("tab", { name: firstTask.title, exact: true }).click();
  await expectEffort(page, "Gentle");
  await expect(box(page)).toHaveText("first draft");
  await box(page).focus();
  await page.keyboard.press("Alt+t");
  await expectEffort(page, "Balanced");
  expect(await ipcCalls(page, "agent_set_config")).toEqual([
    { task: secondTask.id, option: effortId, value: "budget-23" },
    { task: firstTask.id, option: effortId, value: "budget-23" },
  ]);
});

test("Settings → Keymap rebinds Cycle Agent Effort and removes Alt+T", async ({ workbench: page }) => {
  await seed(page, "editor");
  await selectDraft(page);
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
  await settings.getByRole("textbox", { name: "Search actions", exact: true }).fill("Cycle Agent Effort");
  const row = settings.getByRole("tree", { name: "Actions" }).getByRole("treeitem", { name: /Cycle Agent Effort/ });
  await row.dblclick();
  await page.getByRole("menuitem", { name: "Add Keyboard Shortcut", exact: true }).click();
  const recorder = page.getByRole("dialog", { name: "Keyboard Shortcut: Cycle Agent Effort", exact: true });
  await recorder.getByRole("textbox", { name: "First stroke" }).press(rebound);
  await recorder.getByRole("button", { name: "OK", exact: true }).click();
  await expect(recorder).toBeHidden();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove ⌥T", exact: true }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).toBeHidden();
  await box(page).focus();
  await page.keyboard.press("Alt+t");
  await expectEffort(page, "Gentle");
  expect(await ipcCalls(page, "agent_set_config")).toEqual([]);
  await page.keyboard.press(rebound);
  await expectEffort(page, "Balanced");
  expect(await ipcCalls(page, "agent_set_config")).toEqual([
    { task: firstTask.id, option: effortId, value: "budget-23" },
  ]);
  await expect(box(page)).toHaveText(draft);
});

test("Find Action executes Cycle Agent Effort after closing its popup", async ({ workbench: page }) => {
  await seed(page, "editor");
  await selectDraft(page);
  await page.keyboard.press("Meta+Shift+A");
  const search = page.getByRole("dialog", { name: "Search Everywhere", exact: true });
  await search.getByRole("combobox").fill("Cycle Agent Effort");
  await expect(search.getByRole("option", { name: /Cycle Agent Effort/ })).toBeVisible();
  await search.getByRole("combobox").press("Enter");
  await expect(search).toBeHidden();
  await expectEffort(page, "Balanced");
  await expect(box(page)).toHaveText(draft);
  expect(await ipcCalls(page, "agent_set_config")).toEqual([
    { task: firstTask.id, option: effortId, value: "budget-23" },
  ]);
});

test("compact docked composer shows the cycled effort visibly", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await seed(page, "toolWindow");
  await box(page).focus();
  await page.keyboard.press("Alt+t");
  await expect(page.getByText("Effort: Balanced", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(await ipcCalls(page, "agent_set_config")).toEqual([
    { task: firstTask.id, option: effortId, value: "budget-23" },
  ]);
});

for (const preset of [
  "intellij-macos",
  "intellij-windows",
  "vscode-macos",
  "vscode-windows",
  "eclipse-macos",
  "eclipse-windows",
]) {
  test(`${preset}: Alt+T cycles effort using the preset's default binding`, async ({ workbench: page }) => {
    await seed(page, "editor");
    await page.evaluate(async (preset) => {
      // The dispatcher lives in Vite's browser realm; a Node import cannot update its active keymap.
      const keymapPath = "/src/platform/keymap.ts";
      (await import(keymapPath)).applyKeymapSettings(preset, {});
    }, preset);
    await box(page).focus();
    await page.keyboard.press("Alt+t");
    await expectEffort(page, "Balanced");
    expect(await ipcCalls(page, "agent_set_config")).toEqual([
      { task: firstTask.id, option: effortId, value: "budget-23" },
    ]);
  });
}

for (const setting of ["effort", "model"] as const) {
  test(`pending ${setting} changes do not block Send or serialize shortcut presses`, async ({ workbench: page }) => {
    await seed(page, "editor");
    await box(page).fill(draft);
    await page.evaluate(() => {
      document.documentElement.dataset.holdConfig = "true";
    });
    if (setting === "effort") {
      await page.keyboard.press("Alt+t");
      await expectEffort(page, "Balanced");
      await page.keyboard.press("Alt+t");
      await expectEffort(page, "Deep");
    } else {
      await chooseModel(page, "Swift");
      await expectEffort(page, "Quick");
    }
    expect(await ipcCalls(page, "agent_set_config")).toEqual(
      setting === "effort"
        ? [
            { task: firstTask.id, option: effortId, value: "budget-23" },
            { task: firstTask.id, option: effortId, value: "budget-91" },
          ]
        : [{ task: firstTask.id, option: modelId, value: "swift" }],
    );
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await box(page).fill("send while configuration is pending");
    await box(page).press("Enter");
    await expect
      .poll(() => ipcCalls(page, "agent_prompt"))
      .toEqual([
        expect.objectContaining({
          task: firstTask.id,
          prompt: expect.objectContaining({ text: "send while configuration is pending" }),
        }),
      ]);
    await page.evaluate(() => document.dispatchEvent(new Event("release-config")));
  });
}

test("New Task discovers uncached model effort before the first prompt", async ({ workbench: page }, testInfo) => {
  await seed(page, "editor", "new");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        // The store must be loaded in the page's Vite realm, not Playwright's Node process.
        const storePath = "/src/features/agents/store.ts";
        const { useAgents } = await import(storePath);
        return useAgents.getState().modelRequests.size;
      }),
    )
    .toBe(0);
  await page.evaluate(
    async ({ provider, swift }) => {
      // Static Node imports cannot update the browser workbench's store.
      const storePath = "/src/features/agents/store.ts";
      const { useAgents } = await import(storePath);
      const thoughtLevels = { ...provider.thoughtLevels };
      delete thoughtLevels.swift;
      const cached = { ...provider, thoughtLevels };
      window.__ipc.handlers.agent_providers = () => [cached];
      window.__ipc.handlers.agent_refresh_models = async ({ model }) => {
        if (model === "swift") {
          const { promise, resolve } = Promise.withResolvers<void>();
          document.addEventListener("test:model-settings-ready", () => resolve(), { once: true });
          await promise;
          thoughtLevels.swift = [swift];
        }
        return {
          provider: cached.id,
          config: cached.config,
          thoughtLevels: { ...thoughtLevels },
          refreshing: false,
          refreshedAtMs: Date.now(),
          retryAtMs: null,
          error: null,
        };
      };
      useAgents.setState({ providers: [cached], modelCatalogs: new Map() });
    },
    { provider, swift },
  );
  await expectEffort(page, "Gentle");
  await box(page).fill("Keep this first task unsent");
  await chooseModel(page, "Swift");
  try {
    await expect
      .poll(async () => (await ipcCalls(page, "agent_refresh_models")).filter((call) => call.model === "swift"))
      .toEqual([{ provider: provider.id, force: false, model: "swift" }]);
    await expect(page.getByRole("status").filter({ hasText: "Loading model settings…" })).toBeVisible();
    await expect(effortLabel(page)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("model-settings-loading.png") });
    await page.evaluate(() => document.dispatchEvent(new Event("test:model-settings-ready")));
    await expectEffort(page, "Quick");
    await effortLabel(page).click();
    const efforts = page.getByRole("radiogroup", { name: "Effort Level", exact: true });
    await expect(efforts.getByRole("radio", { name: "Quick", exact: true })).toBeVisible();
    await expect(efforts.getByRole("radio", { name: "Thorough", exact: true })).toBeVisible();
    await expect(efforts.getByRole("radio", { name: "Gentle", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(box(page)).toHaveText("Keep this first task unsent");
    await expectNoSubmission(page);
    expect(await ipcCalls(page, "agent_set_config")).toEqual([]);
  } finally {
    await page.screenshot({ path: testInfo.outputPath("uncached-model-effort.png") });
  }
});

test("an existing chat can choose effort for a refreshed model before sending", async ({ workbench: page }) => {
  await seed(page, "editor", "task", "atlas", "ready", true);
  await box(page).fill(draft);
  await expectEffort(page, "Gentle");
  await modelButton(page).click();
  const swiftModel = page.getByRole("option", { name: /^Swift\b/ });
  await expect(swiftModel).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh models", exact: true }).click();
  await swiftModel.click();

  const loading = page.getByRole("status").filter({ hasText: "Loading model settings…" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(loading).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(modelButton(page)).toHaveAttribute("title", /^Model: Atlas\b/);
  await page.evaluate(() => document.dispatchEvent(new Event("test:chat-model-settings-ready")));
  await expect(loading).toHaveCount(0);
  await expect(modelButton(page)).toHaveAttribute("title", /^Model: Swift\b/);
  await expectEffort(page, "Quick");
  await effortLabel(page).click();
  const efforts = page.getByRole("radiogroup", { name: "Effort Level", exact: true });
  await expect(efforts.getByRole("radio", { name: "Gentle", exact: true })).toHaveCount(0);
  await efforts.getByRole("radio", { name: "Thorough", exact: true }).click();
  await page.keyboard.press("Escape");
  await expectEffort(page, "Thorough");
  await expect(send).toBeEnabled();
  await expect(box(page)).toHaveText(draft);
  await expectNoSubmission(page);
});
