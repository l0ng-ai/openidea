import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTheme } from "@/bindings";
import { STARTUP_THEME_KEY, syncWindowBackground } from "@/workbench/theme";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import {
  applyPluginTheme,
  PLUGIN_THEME_CACHE_KEY,
  PLUGIN_THEME_STYLE_ID,
  trackPluginTheme,
  type CachedPluginTheme,
} from "../bridge";
import { usePlugins } from "../store";

const BOOT_JS = readFileSync("public/boot.js", "utf8");
/** Runs public/boot.js as the next window would, before any app code. */
const boot = () => new Function(BOOT_JS)();

const ONE_DARK: ActiveTheme = {
  pluginId: "theme-one",
  theme: {
    id: "one-dark",
    name: "One Dark",
    kind: "dark",
    tokens: {
      "--bg-frame": "hsl(220, 13%, 15%)",
      "--fg-muted": "hsl(220, 9%, 55%)",
      "--accent": "hsl(220, 100%, 66%)",
    },
  },
};
const SOLARIZED_LIGHT: ActiveTheme = {
  pluginId: "theme-solarized",
  theme: { id: "solarized-light", name: "Solarized Light", kind: "light", tokens: { "--bg-frame": "#eee8d5" } },
};

/** Computed style as a browser would resolve the active plugin theme. */
function computedColors(values: Record<string, string>) {
  return vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => values[name] ?? "",
        color: "",
      }) as unknown as CSSStyleDeclaration,
  );
}

function resetRoot() {
  const root = document.documentElement;
  for (const key of Object.keys(root.dataset)) delete root.dataset[key];
  document.getElementById(PLUGIN_THEME_STYLE_ID)?.remove();
  document.getElementById("openidea-boot-colors")?.remove();
}

let backend: PluginsBackend;

beforeEach(() => {
  localStorage.clear();
  resetRoot();
  backend = createMemoryPluginsBackend();
  setPluginsBackend(backend);
  usePlugins.setState({ plugins: [], activeTheme: null, loaded: false, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  applyPluginTheme(null);
  setPluginsBackend(null);
  localStorage.clear();
  resetRoot();
});

describe("plugin theme at start-up", () => {
  it("restores the last plugin theme and splash colours before the app loads", () => {
    const style = computedColors({ "--bg-frame": "#21252b", "--fg-muted": "#828997", "--accent": "#5c8aff" });
    const stop = trackPluginTheme();
    usePlugins.setState({ loaded: true, activeTheme: ONE_DARK });
    syncWindowBackground();
    stop();
    style.mockRestore();
    resetRoot();

    boot();
    const root = document.documentElement;
    expect(root.dataset.pluginTheme).toBe("theme-one/one-dark");
    expect(root.dataset.pluginThemeKind).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(document.getElementById(PLUGIN_THEME_STYLE_ID)?.textContent).toContain("--bg-frame: hsl(220, 13%, 15%);");
    expect(document.getElementById("openidea-boot-colors")?.textContent).toBe(
      ":root { --boot-frame: #21252b; --boot-fg: #828997; --boot-accent: #5c8aff; }",
    );
  });

  it("keeps the restored theme until the plugin list arrives, then follows it", () => {
    const cached: CachedPluginTheme = {
      id: "theme-one/one-dark",
      kind: "dark",
      css: ':root[data-plugin-theme]:not([data-plugin-theme=""]) {\n  --bg-frame: #21252b;\n}\n',
    };
    localStorage.setItem(PLUGIN_THEME_CACHE_KEY, JSON.stringify(cached));
    boot();
    const root = document.documentElement;
    const stop = trackPluginTheme();
    // Nothing listed yet: the boot theme stays.
    expect(root.dataset.pluginTheme).toBe("theme-one/one-dark");
    expect(document.getElementById(PLUGIN_THEME_STYLE_ID)).not.toBeNull();
    // A failed listing doesn't drop it either.
    usePlugins.setState({ loaded: true, error: "backend unavailable" });
    expect(root.dataset.pluginTheme).toBe("theme-one/one-dark");

    usePlugins.setState({ error: null, activeTheme: SOLARIZED_LIGHT });
    expect(root.dataset.pluginTheme).toBe("theme-solarized/solarized-light");
    expect(root.dataset.theme).toBe("light");
    expect(JSON.parse(localStorage.getItem(PLUGIN_THEME_CACHE_KEY)!)).toMatchObject({
      id: "theme-solarized/solarized-light",
      kind: "light",
    });

    // The plugin was disabled or uninstalled meanwhile.
    usePlugins.setState({ activeTheme: null });
    expect(root.dataset.pluginTheme).toBeUndefined();
    expect(document.getElementById(PLUGIN_THEME_STYLE_ID)).toBeNull();
    expect(localStorage.getItem(PLUGIN_THEME_CACHE_KEY)).toBeNull();
    stop();
  });

  it("ignores a cached stylesheet that could load resources", () => {
    localStorage.setItem(
      PLUGIN_THEME_CACHE_KEY,
      JSON.stringify({ id: "p/t", kind: "dark", css: ":root { --bg-app: url(https://example.com/x) }" }),
    );
    localStorage.setItem(STARTUP_THEME_KEY, JSON.stringify({ theme: "light", frame: "red; color: blue" }));
    boot();
    expect(document.documentElement.dataset.pluginTheme).toBeUndefined();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.getElementById(PLUGIN_THEME_STYLE_ID)).toBeNull();
    expect(document.getElementById("openidea-boot-colors")).toBeNull();
  });

  it("reports the resolved frame colour once per selected theme", () => {
    const setFrame = vi.spyOn(backend, "setThemeFrame");
    computedColors({ "--bg-frame": "rgb(33, 37, 43)" });
    const stop = trackPluginTheme();
    usePlugins.setState({ loaded: true, activeTheme: ONE_DARK });
    usePlugins.setState({ activeTheme: { ...ONE_DARK } });
    expect(setFrame.mock.calls).toEqual([["#21252b"]]);
    // Selecting it again after the default theme reports it again: the backend forgot it.
    usePlugins.setState({ activeTheme: null });
    usePlugins.setState({ activeTheme: ONE_DARK });
    expect(setFrame).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps the stylesheet when the same theme is applied again", () => {
    applyPluginTheme(ONE_DARK);
    const style = document.getElementById(PLUGIN_THEME_STYLE_ID);
    applyPluginTheme(structuredClone(ONE_DARK));
    expect(document.getElementById(PLUGIN_THEME_STYLE_ID)).toBe(style);
    applyPluginTheme(SOLARIZED_LIGHT);
    expect(document.getElementById(PLUGIN_THEME_STYLE_ID)).not.toBe(style);
    expect(document.documentElement.dataset.pluginTheme).toBe("theme-solarized/solarized-light");
  });
});
