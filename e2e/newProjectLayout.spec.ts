import type { GeneratorInfo } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const java: GeneratorInfo = {
  id: "java",
  name: "Java",
  group: "Java",
  icon: "project-java",
  order: 1,
  description: "A plain Java application built with Maven or Gradle.",
  git: true,
  dynamic: false,
  fields: [
    {
      id: "build",
      label: "Build system:",
      default: "maven",
      hint: "",
      visible: {},
      kind: {
        type: "choice",
        segmented: true,
        options: [
          { value: "maven", label: "Maven" },
          { value: "gradle", label: "Gradle" },
        ],
      },
    },
    {
      id: "jdk",
      label: "JDK:",
      default: "",
      hint: "",
      visible: {},
      kind: { type: "sdk", sdk: "jdk" },
    },
  ],
};

const empty: GeneratorInfo = {
  ...java,
  id: "empty",
  name: "Empty Project",
  group: "Project",
  description: "",
  fields: [],
};

test("New Project fits the template form in a narrow window and preserves edits when resized", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.setViewportSize({ width: 490, height: 570 });
  await page.evaluate(
    async (catalog) => {
      const handlers = window.__ipc.handlers;
      handlers.scaffold_catalog = () => catalog;
      handlers.sdk_detect = () => [];
      handlers.scaffold_requirements = () => [];
      handlers.scaffold_create = () => new Promise(() => {});
      handlers["plugin:dialog|open"] = () => "/dev/workspaces";
      const actionsPath = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actionsPath);
      await executeAction("file.newProject");
    },
    [empty, java],
  );

  const dialog = page.getByRole("dialog", { name: "New Project" });
  const generators = dialog.getByRole("listbox", { name: "Generators" });
  await generators.getByRole("option", { name: "Java", exact: true }).click();

  const form = dialog.locator("form");
  const hasNoHorizontalOverflow = (el: Element) => el.scrollWidth === el.clientWidth;
  expect(await form.evaluate(hasNoHorizontalOverflow)).toBe(true);
  await expect(dialog.getByRole("separator", { name: "Generators" })).toHaveAttribute("aria-orientation", "horizontal");

  await dialog.getByRole("textbox", { name: "Name:" }).fill("Billing Service");
  await dialog.getByRole("button", { name: "Browse…" }).click();
  await expect(dialog.getByRole("textbox", { name: "Location:" })).toHaveValue("/dev/workspaces");
  const gradle = dialog.getByRole("button", { name: "Gradle" });
  await gradle.click();
  await expect(gradle).toHaveAttribute("aria-pressed", "true");

  await page.setViewportSize({ width: 1040, height: 750 });
  const handle = dialog.getByRole("separator", { name: "Generators" });
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  const originalWidth = (await generators.boundingBox())!.width;
  await handle.press("ArrowRight");
  await expect.poll(async () => (await generators.boundingBox())!.width).toBeGreaterThan(originalWidth);
  await expect(generators.getByRole("option", { name: "Java", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("textbox", { name: "Name:" })).toHaveValue("Billing Service");
  await expect(gradle).toHaveAttribute("aria-pressed", "true");

  await page.setViewportSize({ width: 490, height: 570 });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "scaffold_create"))
    .toEqual([
      expect.objectContaining({
        req: {
          generator: "java",
          location: "/dev/workspaces",
          name: "Billing Service",
          git: true,
          values: { build: "gradle", jdk: "" },
        },
      }),
    ]);
});
