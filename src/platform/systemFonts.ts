/** Shared suggestions only: editor, UI and terminal preferences remain independent. */
import { useEffect } from "react";
import { detectCandidateFonts } from "./candidateFonts";
import { BUNDLED_MONO_FAMILY, BUNDLED_UI_FAMILY } from "./fonts";
import { create } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { call, commands, type FontFamily } from "@/platform/ipc";

export type FontStatus = "idle" | "loading" | "ready" | "empty" | "error" | "browser";
export const bundledFonts: FontFamily[] = [
  { name: BUNDLED_MONO_FAMILY, monospaced: true },
  { name: BUNDLED_UI_FAMILY, monospaced: false },
];
export function mergeFontFamilies(fonts: FontFamily[]): FontFamily[] {
  const unique = new Map<string, FontFamily>();
  for (const font of [...fonts, ...bundledFonts]) {
    if (font.name.trim()) unique.set(font.name.toLocaleLowerCase(), font);
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export type FontSource = "bundled" | "limited" | "native";
export const useSystemFontStore = create<{ fonts: FontFamily[]; status: FontStatus; source: FontSource }>(() => ({
  fonts: bundledFonts,
  status: "idle",
  source: "bundled",
}));
let pending: Promise<void> | null = null;
function fallback(status: "error" | "browser") {
  // Even an empty successful native catalog is authoritative. A failed refresh
  // must never replace it with the old, necessarily incomplete candidate list.
  if (useSystemFontStore.getState().source === "native") {
    useSystemFontStore.setState({ status });
    return;
  }
  let candidates: FontFamily[] = [];
  try {
    candidates = detectCandidateFonts();
  } catch {
    // A failing detector must not break settings or discard manual preferences.
  }
  useSystemFontStore.setState({ fonts: mergeFontFamilies(candidates), source: "limited", status });
}
export function loadSystemFonts(refresh = false): Promise<void> {
  if (pending) return pending;
  if (!refresh && useSystemFontStore.getState().status !== "idle") return Promise.resolve();
  if (!isTauri()) {
    fallback("browser");
    return Promise.resolve();
  }
  useSystemFontStore.setState({ status: "loading" });
  pending = Promise.resolve()
    .then(() => call(commands.systemFontFamilies(refresh)))
    .then((fonts) =>
      useSystemFontStore.setState({
        fonts: mergeFontFamilies(fonts),
        status: fonts.length ? "ready" : "empty",
        source: "native",
      }),
    )
    .catch(() => fallback("error"))
    .finally(() => {
      pending = null;
    });
  return pending;
}
export function useSystemFonts() {
  const state = useSystemFontStore();
  useEffect(() => {
    void loadSystemFonts();
  }, []);
  return state;
}
