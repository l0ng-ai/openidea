/**
 * Appearance & Behavior pages, laid out like IntelliJ IDEA / PyCharm:
 * Appearance, System Settings (+ Language and Region, Date Formats, HTTP Proxy) and
 * Notifications. Every option is wired (see `appearanceRuntime`, workbench
 * theme / tool windows / notifications, app title / windows, `platform/dateFormat`).
 */

import { FontPicker } from "../components/FontPicker";
import { useId, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { shortcutLabel } from "@/platform/keymap";
import { isTauri } from "@/platform/ipc";
import { SCHEMES as EDITOR_SCHEMES } from "@/platform/colorScheme";
import { formatTimestamp } from "@/platform/dateFormat";
import { Checkbox, IconButton, Input, Popup, type SelectOption, T } from "@/ui";
import { NOTIFICATION_GROUPS } from "@/workbench/notificationStore";
import { ColorSwatches, NumberInput, Row, SearchLabel, Select, Toggle } from "../components/Form";
import { useLabelMatch, useSetting } from "../components/context";
import {
  ZOOM_LIMITS,
  IDLE_LIMITS,
  type Antialiasing,
  type ConcreteTheme,
  type DateFormatValid,
  type NotificationDisplay,
  type NotificationGroupValid,
  type OpenProjectIn,
} from "../model/behaviorSchema";
import { ACCENT_PRESETS, LIMITS, type ThemeId } from "../model/schema";
import type { PageSpec } from "./spec";
import { HTTP_PROXY_PAGE } from "./httpProxy";
import styles from "./Behavior.module.css";
import { tx, useT } from "@/platform/i18n";

import { BUILTIN_THEMES } from "@/platform/themes";

export const APPEARANCE_GROUP = "Appearance & Behavior";

const THEMES: SelectOption<ConcreteTheme>[] = BUILTIN_THEMES.map((t) => ({ value: t.id, label: t.label }));

/** Checkbox bound to a key, optionally disabled. */
function BoundToggle({ k, label, hint, disabled }: { k: string; label: string; hint?: ReactNode; disabled?: boolean }) {
  const [value, set] = useSetting<boolean>(k);
  return <Toggle label={label} checked={!!value} onChange={set} hint={hint} disabled={disabled} />;
}

function Indented({ children }: { children: ReactNode }) {
  return <div className={styles.indented}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Appearance

function ThemeRow() {
  const [theme, setTheme] = useSetting<ThemeId>("appearance.theme");
  const [sync, setSync] = useSetting<boolean>("appearance.syncWithOs");
  const [light, setLight] = useSetting<ConcreteTheme>("appearance.preferredLightTheme");
  const [dark, setDark] = useSetting<ConcreteTheme>("appearance.preferredDarkTheme");
  const [open, setOpen] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  const matched = useLabelMatch("Sync with OS");
  const shown: ConcreteTheme = theme === "system" ? "light" : theme;
  return (
    <Row label="Theme">
      <Select<ConcreteTheme> value={shown} options={THEMES} onChange={setTheme} aria-label="Theme" disabled={sync} />
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
      </span>
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
              options={THEMES}
              onChange={setLight}
              aria-label="Preferred light theme"
            />
          </Row>
          <Row label="Preferred theme for dark OS mode">
            <Select<ConcreteTheme> value={dark} options={THEMES} onChange={setDark} aria-label="Preferred dark theme" />
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
  const options = SCHEMES.some((s) => s.value === scheme) ? SCHEMES : [...SCHEMES, { value: scheme, label: scheme }];
  return (
    <Indented>
      <Row label="Editor color scheme">
        <Select value={scheme} options={options} onChange={setScheme} aria-label="Editor color scheme" />
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
  const [size, setSize] = useSetting<number>("appearance.uiFontSize");
  const id = useId();
  const matched = useLabelMatch("Use custom font");
  return (
    <div className={clsx(styles.fontRow, matched && styles.matched)}>
      <Checkbox checked={on} onChange={setOn} label={<SearchLabel text="Use custom font:" />} />
      <FontPicker label="UI font" disabled={!on} value={family} onChange={setFamily} />
      <label className={clsx(styles.sizeLabel, !on && styles.disabled)} htmlFor={`${id}-size`}>
        <SearchLabel text="Size:" />
      </label>
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
          <BoundToggle k="appearance.menuIcons" label="Display icons in menu items" />
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

function ToolWindowsGrid() {
  return (
    <Grid
      left={
        <>
          <BoundToggle k="appearance.showToolWindowBars" label="Show tool window bars" />
          <BoundToggle k="appearance.showToolWindowNames" label="Show tool window names" />
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
    const { open } = await import("@tauri-apps/plugin-dialog");
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
            keywords: ["Sync with OS", ...BUILTIN_THEMES.map((t) => t.label), "preferred theme"],
            component: ThemeRow,
          },
          {
            kind: "custom",
            label: "Editor color scheme",
            keywords: ["Theme default", "scheme"],
            component: ColorSchemeRow,
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
            keywords: ["UI font size", "Size", "font family"],
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
          {
            kind: "custom",
            label: "Compact mode",
            keywords: [
              "Always show full path in window header",
              "Use project colors in main toolbar",
              "Drag-and-drop with Alt pressed only",
              "Display icons in menu items",
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
    keywords: ["general", "startup", "exit", "quit", "autosave", "save", "local history"],
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
        options: [{ kind: "toggle", key: "general.confirmExit", label: "Confirm before exiting the IDE" }],
      },
    ],
  },
  {
    id: "general.language",
    title: "Language and Region",
    order: 0,
    keywords: ["locale", "chinese", "中文", "translation"],
    sections: [
      {
        options: [
          {
            kind: "select",
            key: "appearance.locale",
            label: "Language",
            hint: "Language of menus and dialogs; untranslated text stays in English.",
            options: [
              { value: "en", label: "English" },
              { value: "zh", label: "简体中文 (Chinese, Simplified)" },
            ],
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
