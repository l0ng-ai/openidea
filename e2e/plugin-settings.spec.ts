import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import type { SettingSchema } from "../src/features/plugins/settings";

type SchemaField = Omit<SettingSchema, "key" | "title" | "default" | "items" | "properties"> & {
  title?: string;
  default?: unknown;
  enum?: string[];
  items?: SchemaField;
  properties?: Record<string, SchemaField>;
};

const fixture = "crates/ide-plugin/tests/fixtures/settings-pages/";
const fields = (name: string) =>
  Object.entries(
    (JSON.parse(readFileSync(`${fixture}${name}.json`, "utf8")) as { properties: Record<string, SchemaField> })
      .properties,
  ).map(([key, value]) => {
    const convert = (key: string, value: SchemaField): SettingSchema => ({
      ...value,
      key,
      options: value.enum,
      title: value.title ?? key,
      default:
        value.default ??
        (value.type === "array"
          ? []
          : value.type === "object"
            ? Object.fromEntries(Object.entries(value.properties ?? {}).map(([k, v]) => [k, convert(k, v).default]))
            : value.type === "boolean"
              ? false
              : value.type === "string"
                ? ""
                : 0),
      items: value.items ? convert("item", value.items) : undefined,
      properties: value.properties ? Object.entries(value.properties ?? {}).map(([k, v]) => convert(k, v)) : undefined,
    });
    return convert(key, value);
  });

test("plugin settings pages stage edits, apply before actions and discard on Cancel", async ({ workbench: page }) => {
  const templates = fields("templates");
  const llm = fields("llm");
  await page.evaluate(
    async ({ templates, llm }) => {
      const module = "/src/features/plugins/projection.ts";
      const { uiPoint } = await import(/* @vite-ignore */ module);
      const decl = {
        title: "Model Profiles",
        properties: [...templates, ...llm],
        pages: [
          { id: "templates", title: "Commit Template", properties: templates },
          { id: "llm", title: "LLM Settings", properties: llm, actions: [{ title: "Test", command: "test" }] },
        ],
      };
      uiPoint("settings").project({ pluginId: "settings-pages", point: "settings", key: "settings", decl }, {});
      {
        const backendModule = "/src/features/plugins/backend.ts";
        const { pluginsBackend } = await import(/* @vite-ignore */ backendModule);
        pluginsBackend().runCommand = async () => {
          throw new Error("Example provider unavailable");
        };
      }
    },
    { templates, llm },
  );
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("LLM Settings");
  await dialog.getByRole("treeitem", { name: "LLM Settings", exact: true }).click();
  await search.clear();
  await dialog.getByRole("treeitem", { name: "Plugins", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await dialog.getByRole("treeitem", { name: "Model Profiles", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await dialog.getByRole("treeitem", { name: "LLM Settings", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const name = dialog.getByRole("textbox", { name: "Model profiles: Name 1", exact: true });
  await name.fill("Cloud");
  if (process.env.SETTINGS_EVIDENCE)
    await page.screenshot({ path: `${process.env.SETTINGS_EVIDENCE}/after-1.png`, animations: "disabled" });
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Example provider unavailable");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  if (process.env.SETTINGS_EVIDENCE)
    await page.screenshot({ path: `${process.env.SETTINGS_EVIDENCE}/after-2.png`, animations: "disabled" });
  await name.fill("Discard me");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Meta+,");
  await expect(name).toHaveValue("Cloud");
  await search.fill("Commit Template");
  await dialog.getByRole("treeitem", { name: "Commit Template", exact: true }).click();
  await search.clear();
  await expect(dialog.getByRole("table", { name: "Allowed commit types" })).toBeVisible();
  if (process.env.SETTINGS_EVIDENCE)
    await page.screenshot({ path: `${process.env.SETTINGS_EVIDENCE}/after-3.png`, animations: "disabled" });
  const types = dialog.getByRole("table", { name: "Allowed commit types" }).getByRole("textbox");
  await types.first().fill("docs");
  await search.fill("LLM Settings");
  await dialog.getByRole("treeitem", { name: "LLM Settings", exact: true }).click();
  await search.clear();
  await name.fill("Reset only this page");
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(name).toHaveValue("Cloud");
  await search.fill("Commit Template");
  await dialog.getByRole("treeitem", { name: "Commit Template", exact: true }).click();
  await search.clear();
  await expect(types.first()).toHaveValue("docs");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
});
