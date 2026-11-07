/**
 * Import Settings… with a JetBrains `settings.zip`: maps the archive's colour
 * schemes and the editor / general options OpenIDEA has to settings writes, after
 * a confirmation listing them. Only keys present in the archive are written
 * (JetBrains leaves defaults out). Keymaps, code styles and the rest are listed
 * as not imported.
 */
import { Fragment } from "react";
import type { JetBrainsSettings } from "@/bindings";
import { customSchemes } from "@/platform/colorScheme";
import { tx } from "@/platform/i18n";
import { importScheme, parseIcls } from "@/platform/icls";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import styles from "./app.module.css";

export interface JetBrainsImportPlan {
  /** Settings writes, in order: `settingsSet("global", key, JSON.stringify(value))`. */
  writes: [key: string, value: unknown][];
  /** What the confirmation lists (translated): the setting and its imported value. */
  rows: { label: string; value: string }[];
  /** Categories present in the archive that are not imported (translated). */
  skipped: string[];
  /** `.icls` files that could not be read. */
  invalid: string[];
}

interface EditorState {
  fontSize: number | null;
  customSchemes: unknown;
  colorOverrides: Record<string, unknown>;
}

const USER_PREFIX = "_@user_";

/**
 * `<option name value>` of `<component name>`; empty when the file or component is
 * absent. With `tag`, the `name` of that child element instead, under key "".
 */
function options(xml: string | undefined, component: string, tag?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml) return out;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return out;
  for (const c of Array.from(doc.documentElement.children))
    if (c.tagName === "component" && c.getAttribute("name") === component)
      for (const o of Array.from(c.children)) {
        const name = o.getAttribute("name");
        const value = o.getAttribute("value");
        if (tag && o.tagName === tag && name !== null) out.set("", name);
        else if (!tag && o.tagName === "option" && name && value !== null) out.set(name, value);
      }
  return out;
}

const bool = (v: string | undefined) => (v === undefined ? undefined : v === "true");
const num = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const onOff = (v: boolean) => (v ? tx("On") : tx("Off"));

export function planJetBrainsImport(bundle: JetBrainsSettings, editor: EditorState): JetBrainsImportPlan {
  const plan: JetBrainsImportPlan = { writes: [], rows: [], skipped: [], invalid: [] };
  const add = (key: string, value: string | number | boolean | undefined, label: string, shown?: string) => {
    if (value === undefined) return;
    plan.writes.push([key, value]);
    plan.rows.push({ label, value: shown ?? (typeof value === "boolean" ? onOff(value) : String(value)) });
  };

  let customs = customSchemes(editor.customSchemes);
  let overrides = editor.colorOverrides;
  const imported = new Map<string, string>(); // name in the .icls → scheme id
  for (const [file, text] of Object.entries(bundle.files)) {
    if (!file.startsWith("colors/")) continue;
    let parsed;
    try {
      parsed = parseIcls(text);
    } catch {
      plan.invalid.push(file.slice("colors/".length));
      continue;
    }
    const original = parsed.scheme.name;
    const name = original.startsWith(USER_PREFIX) ? original.slice(USER_PREFIX.length) : original;
    // Overwrites an earlier import of the same scheme instead of adding "Name (2)".
    const next = importScheme(customs, { ...parsed.scheme, name }, true);
    customs = next.customs;
    if (overrides[next.id]) overrides = Object.fromEntries(Object.entries(overrides).filter(([id]) => id !== next.id));
    imported.set(original, next.id);
    plan.rows.push({ label: tx("Color Scheme"), value: customs[next.id]?.name ?? name });
  }
  if (imported.size) {
    plan.writes.push(["editor.customSchemes", customs]);
    if (overrides !== editor.colorOverrides) plan.writes.push(["editor.colorOverrides", overrides]);
    const global = options(bundle.files["options/colors.scheme.xml"], "EditorColorsManagerImpl", "global_color_scheme");
    const id = imported.get(global.get("") ?? "");
    if (id) add("editor.colorScheme", id, tx("Current color scheme"), customs[id]?.name);
  }

  const font = options(bundle.files["options/editor-font.xml"], "DefaultFont");
  add("editor.fontFamily", font.get("FONT_FAMILY")?.trim() || undefined, tx("Font"));
  const size = num(font.get("FONT_SIZE"));
  add("editor.fontSize", size, tx("Size"));
  const spacing = num(font.get("LINE_SPACING"));
  const base = size ?? editor.fontSize;
  add("editor.lineHeight", spacing && base ? Math.round(base * spacing) : undefined, tx("Line height"));
  add("editor.ligatures", bool(font.get("USE_LIGATURES")), tx("Enable ligatures"));

  const ed = options(bundle.files["options/editor.xml"], "EditorSettings");
  const strip = ed.get("STRIP_TRAILING_SPACES"); // None | Changed | Whole
  if (strip === "Changed" || strip === "Whole") {
    const scope = strip === "Whole" ? "all" : "modified";
    plan.writes.push(["files.trimTrailingWhitespace", true]);
    add(
      "editor.general.stripTrailingScope",
      scope,
      tx("Remove trailing spaces on:"),
      tx(strip === "Whole" ? "All lines" : "Modified lines"),
    );
  } else if (strip === "None") add("files.trimTrailingWhitespace", false, tx("Remove trailing spaces on:"));
  add(
    "files.ensureFinalNewline",
    bool(ed.get("IS_ENSURE_NEWLINE_AT_EOF")),
    tx("Ensure every saved file ends with a line break"),
  );
  add("editor.stickyScroll", bool(ed.get("SHOW_STICKY_LINES")), tx("Show sticky lines while scrolling"));
  add("editor.showWhitespace", bool(ed.get("IS_WHITESPACES_SHOWN")), tx("Show whitespaces"));
  // A comma-separated list of places: MAIN_EDITOR, CONSOLE, PREVIEW.
  const wraps = ed.get("USE_SOFT_WRAPS");
  add(
    "editor.softWrap",
    wraps === undefined ? undefined : wraps.split(",").includes("MAIN_EDITOR"),
    tx("Soft-wrap files"),
  );

  const general = options(bundle.files["options/ide.general.xml"], "GeneralSettings");
  add("general.confirmExit", bool(general.get("confirmExit")), tx("Confirm before exiting the IDE"));

  const has = (prefix: string) => bundle.entries.some((e) => e.startsWith(prefix));
  if (has("keymaps/")) plan.skipped.push(tx("Keymap"));
  if (has("codestyles/")) plan.skipped.push(tx("Code Style"));
  if (has("templates/")) plan.skipped.push(tx("Live templates"));
  if (has("inspection/")) plan.skipped.push(tx("Inspections"));
  if (has("installed.txt")) plan.skipped.push(tx("Plugins"));
  return plan;
}

function Summary({ plan }: { plan: JetBrainsImportPlan }) {
  const left = [...plan.skipped, ...plan.invalid];
  return (
    <div className={styles.importSummary}>
      <div>{tx("These settings will be imported:")}</div>
      <dl className={styles.importList}>
        {plan.rows.map((row, i) => (
          <Fragment key={i}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      {left.length > 0 && (
        <div>
          {tx("Not imported:")} {left.join(", ")}
        </div>
      )}
    </div>
  );
}

/** Reads `path`, asks, then writes the mapped settings to the global layer. */
export async function importJetBrainsSettings(path: string) {
  const bundle = await call(commands.settingsReadJetbrains(path));
  const { editor } = await commands.settingsGetGlobal();
  const plan = planJetBrainsImport(bundle, editor);
  if (!plan.writes.length) {
    notifications().notify({
      level: "warning",
      title: "No settings OpenIDEA can import were found in this archive",
      key: "app.settingsImport",
    });
    return;
  }
  const { button } = await ask({
    title: tx("Import JetBrains Settings"),
    body: <Summary plan={plan} />,
    buttons: [{ id: "import", label: tx("Import"), primary: true }],
    width: 520,
  });
  if (button !== "import") return;
  let settings = useProject.getState().settings;
  for (const [key, value] of plan.writes)
    settings = await call(commands.settingsSet("global", key, JSON.stringify(value)));
  useProject.setState({ settings });
  notifications().notify({ level: "info", title: "Settings imported", body: path, key: "app.settingsImport" });
}
