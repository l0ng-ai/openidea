/**
 * Appearance & Behavior pages, laid out like IntelliJ IDEA / PyCharm:
 * Appearance, System Settings (+ Language and Region, Date Formats, HTTP Proxy) and
 * Notifications. Every option is wired (see `appearanceRuntime`, workbench
 * theme / tool windows / notifications, app title / windows, `platform/dateFormat`).
 */

import { FontPicker } from "../components/FontPicker";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { shortcutLabel } from "@/platform/keymap";
import { usePlatform } from "@/platform/platformInfo";
import { call, commands, isTauri } from "@/platform/ipc";
import type { LocalDataInfo } from "@/bindings";
import { notifications } from "@/workbench/contributions";
import { ZOOM_LIMITS } from "@/platform/zoom";
import { SCHEMES as EDITOR_SCHEMES, listSchemes, customSchemes } from "@/platform/colorScheme";
import { formatTimestamp } from "@/platform/dateFormat";
import { Button, Checkbox, IconButton, Input, Popup, type SelectOption, T } from "@/ui";
import { NOTIFICATION_GROUPS } from "@/workbench/notificationStore";
import { ColorSwatches, FormGroup, NumberInput, Row, SearchLabel, Select, Toggle } from "../components/Form";
import { useLabelMatch, useSetting } from "../components/context";
import {
  IDLE_LIMITS,
  type Antialiasing,
  type ConcreteTheme,
  type DateFormatValid,
  type NotificationDisplay,
  type NotificationGroupValid,
  type NavigationBarPosition,
  type OpenProjectIn,
} from "../model/behaviorSchema";
import { ACCENT_PRESETS, LIMITS, type ThemeId } from "../model/schema";
import type { PageSpec } from "./spec";
import { HTTP_PROXY_PAGE } from "./httpProxy";
import styles from "./Behavior.module.css";
import { LOCALES, SUPPORTED_LOCALES, tx, useT } from "@/platform/i18n";
import { BUILTIN_THEMES, useContributedIconThemes } from "@/platform/themes";
import { currentThemeChoice, originDetail, previewTheme, themeSelectOptions, useThemeChoices } from "@/workbench/theme";
import { themePreview } from "@/workbench/quickSwitch";

const BUILTIN_THEME_LABELS = BUILTIN_THEMES.map((t) => t.label);

export const APPEARANCE_GROUP = "Appearance & Behavior";

/** Checkbox bound to a key, optionally disabled. */
function BoundToggle({ k, label, hint, disabled }: { k: string; label: string; hint?: ReactNode; disabled?: boolean }) {
  const [value, set] = useSetting<boolean>(k);
  return <Toggle label={label} checked={!!value} onChange={set} hint={hint} disabled={disabled} />;
}

function Indented({ children }: { children: ReactNode }) {
  return <FormGroup indented>{children}</FormGroup>;
}

// ---------------------------------------------------------------------------
// Appearance

/** Shows the theme picked in Settings in this window until Apply, or the selected one again. */
const showPicked = (id: ConcreteTheme) => previewTheme(id !== currentThemeChoice() ? id : null);

function ThemeRow() {
  const [theme, setTheme] = useSetting<ThemeId>("appearance.theme");
  const [sync, setSync] = useSetting<boolean>("appearance.syncWithOs");
  const [light, setLight] = useSetting<ConcreteTheme>("appearance.preferredLightTheme");
  const [dark, setDark] = useSetting<ConcreteTheme>("appearance.preferredDarkTheme");
  const [open, setOpen] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  const matched = useLabelMatch("Sync with OS");
  const choices = useThemeChoices();
  const shown: ConcreteTheme = theme === "system" ? "light" : theme;
  // The theme under the pointer shows as in Quick Switch; the one picked here shows until Apply or Cancel.
  const picker = useMemo(() => themePreview(), []);
  const previewed = useRef(false);
  useEffect(
    () => () => {
      if (previewed.current) previewTheme(null);
    },
    [],
  );
  // The staged theme can also change without the list, e.g. by Reset.
  useEffect(() => {
    if (previewed.current) showPicked(shown);
  }, [shown]);
  const preview = (id: ConcreteTheme | null) => {
    previewed.current = true;
    if (id !== null) return picker.preview(id);
    // The picker takes back only its own hover preview, not a theme picked here earlier.
    picker.restore();
    showPicked(shown);
  };
  return (
    <Row label="Theme">
      <Select<ConcreteTheme>
        value={shown}
        options={themeSelectOptions(choices, shown)}
        onChange={setTheme}
        onPreview={preview}
        aria-label="Theme"
        className={styles.themeSelect}
        disabled={sync}
      />
      <span className={clsx(styles.inline, matched && styles.matched)}>
        <Checkbox
          checked={sync}
          onChange={(on) => {
            setSync(on);
            // Legacy "system" theme: make the explicit choice concrete.
            if (!on && theme === "system") setTheme("light");
          }}
          label={<SearchLabel text="Sync with OS" />}
        />
        <IconButton
          ref={gear}
          icon="settings"
          size="small"
          title="Preferred themes for light and dark OS mode"
          aria-label="Preferred themes"
          disabled={!sync}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
      </span>
      <Popup
        open={open}
        onClose={() => setOpen(false)}
        anchor={gear}
        placement="bottom-start"
        offset={4}
        aria-label="Preferred themes"
      >
        <div className={styles.popupBody}>
          <Row label="Preferred theme for light OS mode">
            <Select<ConcreteTheme>
              value={light}
              options={themeSelectOptions(choices, light)}
              onChange={setLight}
              aria-label="Preferred light theme"
            />
          </Row>
          <Row label="Preferred theme for dark OS mode">
            <Select<ConcreteTheme>
              value={dark}
              options={themeSelectOptions(choices, dark)}
              onChange={setDark}
              aria-label="Preferred dark theme"
            />
          </Row>
        </div>
      </Popup>
    </Row>
  );
}

const SCHEMES: SelectOption[] = [
  { value: "theme-default", label: "Theme default" },
  ...EDITOR_SCHEMES.map((x) => ({ value: x.id, label: x.name })),
];

function ColorSchemeRow() {
  const [scheme, setScheme] = useSetting<string>("editor.colorScheme");
  const [customs] = useSetting<unknown>("editor.customSchemes", "global");
  const options = [SCHEMES[0]!, ...listSchemes(customSchemes(customs)).map((s) => ({ value: s.id, label: s.name }))];
  return (
    <Indented>
      <Row label="Editor color scheme">
        <Select value={scheme} options={options} onChange={setScheme} aria-label="Editor color scheme" />
      </Row>
    </Indented>
  );
}

/** Plugins' file icon themes; the row shows once one is installed (or still selected). */
function FileIconThemeRow() {
  const [value, setValue] = useSetting<string>("appearance.fileIconTheme");
  const themes = useContributedIconThemes((s) => s.themes);
  if (!themes.length && !value) return null;
  const options: SelectOption[] = [
    { value: "", label: "Default" },
    ...[...themes]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((t) => ({ value: t.id, label: t.label, detail: originDetail(t) })),
  ];
  if (value && !themes.some((t) => t.id === value))
    options.push({ value, label: value.slice(value.indexOf("/") + 1), detail: "Plugin not enabled" });
  return (
    <Indented>
      <Row label="File icon theme">
        <Select value={value ?? ""} options={options} onChange={setValue} aria-label="File icon theme" />
      </Row>
    </Indented>
  );
}

function AccentRow() {
  const [accent, setAccent] = useSetting<string>("appearance.accent");
  return (
    <Indented>
      <Row label="Accent colour">
        <ColorSwatches value={accent} presets={ACCENT_PRESETS} onChange={setAccent} aria-label="Accent colour" />
      </Row>
    </Indented>
  );
}

function ToolWindowBackgroundRow() {
  return (
    <Indented>
      <BoundToggle
        k="appearance.differentToolWindowBackground"
        label="Different tool window background"
        hint="Use lighter color in the dark theme and darker color in the light theme as a background"
      />
    </Indented>
  );
}

const ZOOMS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300].filter(
  (z) => z >= ZOOM_LIMITS.min && z <= ZOOM_LIMITS.max,
);

function ZoomRow() {
  const [zoom, setZoom] = useSetting<number>("appearance.zoom");
  const options = (ZOOMS.includes(zoom) ? ZOOMS : [...ZOOMS, zoom].sort((a, b) => a - b)).map((z) => ({
    value: String(z),
    label: `${z}%`,
  }));
  const t = useT();
  const key = (id: string, fallback: string) => shortcutLabel(id) ?? fallback;
  return (
    <Row label="Zoom">
      <Select value={String(zoom)} options={options} onChange={(v) => setZoom(Number(v))} aria-label="Zoom" />
      <span className={styles.note}>
        {t("settings.zoom.hint", {
          zoomIn: key("view.zoomIn", "⌃⌥="),
          zoomOut: key("view.zoomOut", "⌃⌥-"),
          reset: key("view.resetZoom", "⌃⌥0"),
        })}
      </span>
    </Row>
  );
}

function CustomFontRow() {
  const [on, setOn] = useSetting<boolean>("appearance.useCustomFont");
  const [family, setFamily] = useSetting<string>("appearance.uiFontFamily");
  const [fallback, setFallback] = useSetting<string>("appearance.uiFontFallback");
  const [size, setSize] = useSetting<number>("appearance.uiFontSize");
  const id = useId();
  const matched = useLabelMatch("Use custom font");
  // Labels share one column (IDEA Appearance): the UI font, fallback and Size
  // controls all start at the same x instead of drifting with flex wrapping.
  return (
    <div className={clsx(styles.customFontRow, matched && styles.matched)}>
      <span className={styles.fontCheck}>
        <Checkbox checked={on} onChange={setOn} label={<SearchLabel text="Use custom font:" />} />
      </span>
      <span className={styles.fontControl}>
        <FontPicker label="UI font" disabled={!on} value={family} onChange={setFamily} />
      </span>
      <label className={clsx(styles.fontLabel, !on && styles.disabled)} htmlFor={`${id}-fallback`}>
        <SearchLabel text="Fallback font:" />
      </label>
      <span className={styles.fontControl}>
        <FontPicker
          id={`${id}-fallback`}
          label="UI fallback font"
          disabled={!on}
          value={fallback}
          onChange={setFallback}
          allowEmpty
        />
      </span>
      <label className={clsx(styles.fontLabel, !on && styles.disabled)} htmlFor={`${id}-size`}>
        <SearchLabel text="Size:" />
      </label>
      <span className={styles.fontControl}>
        {on ? (
          <NumberInput
            id={`${id}-size`}
            value={size}
            onChange={setSize}
            {...LIMITS.uiFontSize}
            integer
            aria-label="UI font size"
          />
        ) : (
          <Input
            id={`${id}-size`}
            className={styles.sizeInput}
            value={String(size)}
            disabled
            aria-label="UI font size"
            readOnly
          />
        )}
      </span>
    </div>
  );
}

/** Two-column checkbox grid (IDEA "UI Options"). */
function Grid({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className={styles.grid}>
      <div className={styles.column}>{left}</div>
      <div className={styles.column}>{right}</div>
    </div>
  );
}

function MainMenuStyleRow() {
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const [mainMenuStyle, setMainMenuStyle] = useSetting<"hamburger" | "merged" | "toolbar">("appearance.mainMenuStyle");
  if (!frameless) return null;
  return (
    <Row label="Main menu">
      <Select
        value={mainMenuStyle ?? "hamburger"}
        options={[
          { value: "hamburger", label: "Hamburger button" },
          { value: "merged", label: "Merged with main toolbar" },
          { value: "toolbar", label: "Separate toolbar" },
        ]}
        onChange={setMainMenuStyle}
        aria-label="Main menu"
      />
    </Row>
  );
}

function UiOptionsGrid() {
  return (
    <Grid
      left={
        <>
          <BoundToggle k="appearance.compactMode" label="Compact mode" hint="UI elements take up less screen space" />
          <BoundToggle k="appearance.fullPathInTitle" label="Always show full path in window header" />
          <BoundToggle
            k="appearance.projectColorsInToolbar"
            label="Use project colors in main toolbar"
            hint="Distinguish projects with different colors in the main toolbar"
          />
        </>
      }
      right={
        <>
          <BoundToggle
            k="appearance.dndWithAltOnly"
            label="Drag-and-drop with Alt pressed only"
            hint="Applies to editor tabs and tool window buttons"
          />
          <BoundToggle
            k="appearance.smallTreeIndents"
            label="Use smaller indents in trees"
            hint="Project, Structure, Commit and other tool window trees indent less per level"
          />
          <BoundToggle k="appearance.menuIcons" label="Display icons in menu items" />
          <BoundToggle
            k="appearance.mainMenuAlt"
            label="Open main menu with a lone Alt press"
            hint="When off, Alt key combinations still work but pressing Alt alone does not focus the main menu"
          />
        </>
      }
    />
  );
}

const AA_OPTIONS: SelectOption<Antialiasing>[] = [
  { value: "subpixel", label: "Subpixel" },
  { value: "greyscale", label: "Greyscale" },
  { value: "none", label: "No antialiasing" },
];

const NAV_BAR_OPTIONS: SelectOption<NavigationBarPosition>[] = [
  { value: "top", label: "Top" },
  { value: "statusBar", label: "Status Bar" },
  { value: "hidden", label: "Don't show" },
];

function ToolWindowsGrid() {
  return (
    <Grid
      left={
        <>
          <BoundToggle k="appearance.showToolWindowBars" label="Show tool window bars" />
          <BoundToggle k="appearance.showToolWindowNames" label="Show tool window names" />
          <BoundToggle
            k="appearance.showToolWindowBadges"
            label="Show tool window badges"
            hint="Counts on the stripe icons, e.g. changed files or agent tasks needing input"
          />
        </>
      }
      right={
        <BoundToggle
          k="appearance.widescreenToolWindows"
          label="Widescreen tool window layout"
          hint="Side tool windows take the full height; the bottom ones fit between them"
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// System Settings

const OPEN_IN: Array<{ value: OpenProjectIn; label: string }> = [
  { value: "new", label: "New window" },
  { value: "same", label: "Current window" },
  { value: "ask", label: "Ask" },
];

function OpenProjectInRow() {
  const [value, set] = useSetting<OpenProjectIn>("general.openProjectIn");
  const name = useId();
  return (
    <Row label="Open project in">
      <div className={styles.radios} role="radiogroup" aria-label={tx("Open project in")}>
        {OPEN_IN.map((o) => (
          <label key={o.value} className={styles.radio}>
            <input type="radio" name={name} checked={value === o.value} onChange={() => set(o.value)} />
            <SearchLabel text={o.label} />
          </label>
        ))}
      </div>
    </Row>
  );
}

function DefaultDirectoryRow() {
  const [dir, setDir] = useSetting<string>("general.defaultProjectDirectory");
  const id = useId();
  const browse = async () => {
    const { open } = await import("@/platform/dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Default Directory",
      defaultPath: dir || undefined,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) setDir(path);
  };
  return (
    <Row
      label="Default directory"
      htmlFor={id}
      hint={'This directory is preselected in "Open…" and "New Window" dialogs.'}
    >
      <Input
        id={id}
        className={styles.pathInput}
        value={dir}
        placeholder="System default"
        onChange={(e) => setDir(e.target.value)}
      />
      <IconButton
        icon="folder-open"
        size="small"
        title="Browse…"
        aria-label="Browse"
        disabled={!isTauri()}
        onClick={() => void browse()}
      />
    </Row>
  );
}

/**
 * Settings › System Settings › Caches: where tools, language servers, indexes
 * and caches live (the C: problem of #1722). A custom directory takes effect
 * after a restart; the previous tree moves along when asked.
 */
function LocalDataDirRow() {
  const [info, setInfo] = useState<LocalDataInfo | null>(null);
  const [root, setRoot] = useState("");
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void call(commands.cachesLocalDataInfo()).then(
      (v) => {
        if (!live) return;
        setInfo(v);
        setRoot(v.customRoot ?? "");
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const browse = async () => {
    const { open } = await import("@/platform/dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Local data directory",
      defaultPath: root || undefined,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) setRoot(path);
  };
  const apply = async (next: string | null) => {
    setBusy(true);
    try {
      await call(commands.cachesSetLocalDataDir(next, move));
      await commands.appRestart();
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Could not change the local data directory",
        body: e instanceof Error ? e.message : String(e),
        key: "app.localDataDir",
      });
    } finally {
      setBusy(false);
    }
  };
  if (!isTauri()) {
    return (
      <p className={styles.note}>
        <T>Restart is only available in the desktop app</T>
      </p>
    );
  }
  const locked = busy || info?.envOverride === true;
  return (
    <>
      <Row label="Current location">
        <Input className={styles.pathInput} value={info?.current ?? ""} readOnly />
      </Row>
      <Row
        label="Custom directory"
        htmlFor={id}
        hint="Tools, language servers, indexes and caches live here. Empty means the OS default. Changing it restarts the IDE."
      >
        <Input
          id={id}
          className={styles.pathInput}
          value={root}
          placeholder="System default"
          disabled={locked}
          onChange={(e) => setRoot(e.target.value)}
        />
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          aria-label="Browse"
          disabled={locked}
          onClick={() => void browse()}
        />
      </Row>
      {info?.envOverride === true && (
        <p role="note" className={styles.note}>
          <T>The OPENIDEA_LOCAL_DATA_DIR environment variable is set and takes precedence.</T>
        </p>
      )}
      <div className={styles.fontRow}>
        <Button
          variant="primary"
          size="small"
          disabled={locked}
          onClick={() => void apply(root.trim() ? root.trim() : null)}
        >
          Apply and Restart
        </Button>
        <Button
          size="small"
          disabled={locked || (!root && !info?.customRoot)}
          onClick={() => {
            setRoot("");
            void apply(null);
          }}
        >
          Reset to default
        </Button>
        <Checkbox label="Move existing data to the new location" checked={move} onChange={setMove} disabled={locked} />
      </div>
    </>
  );
}

function IdleSaveRow() {
  const [on, setOn] = useSetting<boolean>("general.saveOnIdle");
  const [seconds, setSeconds] = useSetting<number>("general.idleSeconds");
  const matched = useLabelMatch("Save files if the IDE is idle for");
  return (
    <div className={clsx(styles.fontRow, matched && styles.matched)}>
      <Checkbox checked={on} onChange={setOn} label={<SearchLabel text="Save files if the IDE is idle for" />} />
      <NumberInput value={seconds} onChange={setSeconds} {...IDLE_LIMITS} integer aria-label="Idle seconds" />
      <span className={clsx(!on && styles.disabled)}>
        <T>seconds</T>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date Formats

function DateFormatRows() {
  const [f, setF] = useSetting<DateFormatValid>("general.dateFormat");
  const set = (patch: Partial<DateFormatValid>) => setF({ ...f, ...patch });
  const id = useId();
  const [now] = useState(() => Date.now());
  return (
    <>
      <Toggle
        label="Override system date and time format"
        checked={f.overrideSystem}
        onChange={(v) => set({ overrideSystem: v })}
      />
      <Indented>
        <Row label="Date format" htmlFor={id} hint="Placeholders: yyyy, yy, MMMM, MMM, MM, M, dd, d">
          <Input
            id={id}
            className={styles.patternInput}
            mono
            disabled={!f.overrideSystem}
            value={f.pattern}
            onChange={(e) => e.target.value.trim() && set({ pattern: e.target.value })}
          />
        </Row>
        <Toggle
          label="Use 24-hour time format"
          checked={f.use24Hour}
          disabled={!f.overrideSystem}
          onChange={(v) => set({ use24Hour: v })}
        />
      </Indented>
      <Toggle
        label="Use pretty formatting"
        hint={'Show "Today", "Yesterday" and "N min ago" for recent dates'}
        checked={f.pretty}
        onChange={(v) => set({ pretty: v })}
      />
      <Row label="Preview">
        <span className={styles.preview}>
          {formatTimestamp(now - 2 * 3_600_000, now, f)} · {formatTimestamp(now - 3 * 86_400_000, now, f)}
        </span>
      </Row>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notifications

const DISPLAY_OPTIONS: SelectOption<NotificationDisplay>[] = [
  { value: "balloon", label: "Balloon" },
  { value: "sticky", label: "Sticky balloon" },
  { value: "none", label: "No popup" },
];

function NotificationGroupsTable() {
  const [groups, setGroups] = useSetting<Record<string, NotificationGroupValid>>("notifications.groups");
  const update = (id: string, patch: Partial<NotificationGroupValid>) => {
    const next = { ...(groups[id] ?? { display: "balloon", log: true }), ...patch };
    const all = { ...groups };
    // Defaults are not stored.
    if (next.display === "balloon" && next.log) delete all[id];
    else all[id] = next;
    setGroups(all);
  };
  return (
    <table className={styles.table} aria-label={tx("Notification groups")}>
      <thead>
        <tr>
          <th>
            <T>Group</T>
          </th>
          <th>
            <T>Popup type</T>
          </th>
          <th>
            <T>Show in tool window</T>
          </th>
        </tr>
      </thead>
      <tbody>
        {NOTIFICATION_GROUPS.map((g) => {
          const v = groups[g.id] ?? { display: "balloon", log: true };
          return (
            <tr key={g.id}>
              <td>
                <SearchLabel text={g.title} />
              </td>
              <td>
                <Select<NotificationDisplay>
                  value={v.display}
                  options={DISPLAY_OPTIONS}
                  onChange={(display) => update(g.id, { display })}
                  aria-label={tx`${g.title} popup type`}
                />
              </td>
              <td className={styles.center}>
                <Checkbox
                  checked={v.log}
                  onChange={(log) => update(g.id, { log })}
                  aria-label={tx`Show ${g.title} in tool window`}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------

export const BEHAVIOR_PAGES: PageSpec[] = [
  {
    id: "appearance",
    title: "Appearance",
    group: APPEARANCE_GROUP,
    order: 0,
    keywords: ["theme", "colour", "color", "dark", "light", "zoom", "font", "compact"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Theme",
            keywords: ["Sync with OS", ...BUILTIN_THEME_LABELS, "preferred theme"],
            component: ThemeRow,
          },
          {
            kind: "custom",
            label: "Editor color scheme",
            keywords: ["Theme default", "scheme"],
            component: ColorSchemeRow,
          },
          {
            kind: "custom",
            label: "File icon theme",
            keywords: ["icons", "file icons", "icon theme"],
            component: FileIconThemeRow,
          },
          { kind: "custom", label: "Accent colour", keywords: ["accent color", "highlight"], component: AccentRow },
          { kind: "custom", label: "Different tool window background", component: ToolWindowBackgroundRow },
        ],
      },
      {
        title: "Accessibility",
        options: [
          { kind: "custom", label: "Zoom", keywords: ["scale", "zoom ide"], component: ZoomRow },
          {
            kind: "custom",
            label: "Use custom font",
            keywords: ["UI font size", "Size", "font family", "fallback font"],
            component: CustomFontRow,
          },
          { kind: "toggle", key: "appearance.contrastScrollbars", label: "Use contrast scrollbars" },
          {
            kind: "toggle",
            key: "appearance.redGreenVision",
            label: "Adjust colors for red-green vision deficiency",
            hint: "For protanopia and deuteranopia.",
          },
        ],
      },
      {
        title: "UI Options",
        options: [
          { kind: "toggle", key: "appearance.showMainToolbar", label: "Show main toolbar" },
          { kind: "toggle", key: "appearance.showStatusBar", label: "Show status bar" },
          { kind: "select", key: "appearance.navigationBar", label: "Navigation bar", options: NAV_BAR_OPTIONS },
          {
            kind: "custom",
            label: "Main menu",
            keywords: ["Hamburger button", "Merged with main toolbar"],
            component: MainMenuStyleRow,
          },
          {
            kind: "custom",
            label: "Compact mode",
            keywords: [
              "Always show full path in window header",
              "Use project colors in main toolbar",
              "Drag-and-drop with Alt pressed only",
              "Display icons in menu items",
              "Use smaller indents in trees",
              "tree indent",
            ],
            component: UiOptionsGrid,
          },
        ],
      },
      {
        title: "Antialiasing",
        options: [
          { kind: "select", key: "appearance.ideAntialiasing", label: "IDE", options: AA_OPTIONS },
          { kind: "select", key: "appearance.editorAntialiasing", label: "Editor", options: AA_OPTIONS },
        ],
      },
      {
        title: "Tool Windows",
        options: [
          {
            kind: "custom",
            label: "Show tool window bars",
            keywords: ["Show tool window names", "Widescreen tool window layout", "stripes"],
            component: ToolWindowsGrid,
          },
        ],
      },
    ],
  },
  {
    id: "general",
    title: "System Settings",
    group: APPEARANCE_GROUP,
    order: 1,
    keywords: ["general", "startup", "exit", "quit", "autosave", "save", "local history", "welcome", "editor tabs"],
    sections: [
      {
        title: "Project",
        options: [
          { kind: "toggle", key: "general.reopenLastProject", label: "Reopen projects on startup" },
          {
            kind: "custom",
            label: "Open project in",
            keywords: ["New window", "Current window", "Ask"],
            component: OpenProjectInRow,
          },
          { kind: "custom", label: "Default directory", component: DefaultDirectoryRow },
        ],
      },
      {
        title: "Caches",
        options: [
          {
            kind: "custom",
            label: "Local data directory",
            keywords: ["cache", "local data", "data directory", "C盘", "缓存", "目录"],
            component: LocalDataDirRow,
          },
        ],
      },
      {
        title: "Autosave",
        options: [
          {
            kind: "custom",
            label: "Save files if the IDE is idle for",
            keywords: ["idle", "seconds"],
            component: IdleSaveRow,
          },
          {
            kind: "toggle",
            key: "files.autoSave",
            label: "Save files when switching to a different application or a built-in terminal",
          },
          {
            kind: "toggle",
            key: "files.syncOnFocus",
            label: "Synchronize external changes when switching to the IDE window",
          },
        ],
      },
      {
        title: "Local History",
        options: [
          {
            kind: "number",
            key: "files.localHistoryDays",
            label: "Keep local history for",
            ...LIMITS.localHistoryDays,
            integer: true,
            unit: "working days",
            hint: "Days on which files changed; older revisions are removed when a project opens.",
          },
          {
            kind: "number",
            key: "files.localHistoryMaxMb",
            label: "Maximum local history size per project",
            ...LIMITS.localHistoryMaxMb,
            integer: true,
            step: 64,
            unit: "MB",
          },
        ],
      },
      {
        title: "Exit",
        options: [
          { kind: "toggle", key: "general.confirmExit", label: "Confirm before exiting the IDE" },
          {
            kind: "toggle",
            key: "general.closeWithoutWelcome",
            label: "Close the window instead of showing the Welcome screen",
            hint: "When this is the only window, closing a project or a file closes the window. On macOS, the app stays in the Dock.",
          },
          {
            kind: "toggle",
            key: "general.closeTabsWithWindow",
            label: "Close all editor tabs when the window closes",
            hint: "Files left open are not restored the next time that project or a standalone file is opened.",
          },
        ],
      },
    ],
  },
  {
    id: "general.language",
    title: "Language and Region",
    order: 0,
    keywords: ["locale", "translation", ...SUPPORTED_LOCALES.map((locale) => LOCALES[locale].name)],
    sections: [
      {
        options: [
          {
            kind: "select",
            key: "appearance.locale",
            label: "Language",
            hint: "Language of menus and dialogs; untranslated text stays in English.",
            options: SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: LOCALES[locale].name })),
          },
        ],
      },
    ],
  },
  {
    id: "general.dateFormats",
    title: "Date Formats",
    order: 1,
    keywords: ["date", "time", "pretty", "24-hour"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Override system date and time format",
            keywords: ["Date format", "Use 24-hour time format", "Use pretty formatting"],
            component: DateFormatRows,
          },
        ],
      },
    ],
  },
  HTTP_PROXY_PAGE,
  {
    id: "notifications",
    title: "Notifications",
    group: APPEARANCE_GROUP,
    order: 2,
    keywords: ["balloon", "popup", "sound", "alerts"],
    sections: [
      {
        options: [
          { kind: "toggle", key: "notifications.balloons", label: "Display balloon notifications" },
          { kind: "toggle", key: "notifications.sound", label: "Play sound" },
        ],
      },
      {
        title: "Groups",
        options: [
          {
            kind: "custom",
            label: "Popup type",
            keywords: [...NOTIFICATION_GROUPS.map((g) => g.title), "Sticky balloon", "No popup", "Show in tool window"],
            component: NotificationGroupsTable,
          },
        ],
      },
    ],
  },
];
