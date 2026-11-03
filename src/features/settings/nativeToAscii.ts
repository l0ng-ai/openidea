import type { Action } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { stage, type Scope } from "./model/staging";

export const NATIVE_TO_ASCII_ACTION = "editor.encodings.toggleNativeToAscii";
const KEY = "editor.encodings.nativeToAscii";

export function nativeToAsciiAction(): Action {
  return {
    id: NATIVE_TO_ASCII_ACTION,
    title: "Transparent native-to-ascii conversion",
    category: "Editor",
    keywords: ["properties", "encoding", "Unicode"],
    run: async ({ arg }) => {
      const staged = arg as { pageId?: string; scope?: Scope; value?: boolean } | undefined;
      if (staged?.pageId && staged.scope && typeof staged.value === "boolean") {
        stage(staged.pageId, staged.scope, KEY, staged.value);
        return;
      }
      const { settings, project } = useProject.getState();
      await call(
        commands.settingsSet(
          project ? "project" : "global",
          KEY,
          JSON.stringify(!settings?.editor?.encodings?.nativeToAscii),
        ),
      );
      await loadSettings();
    },
  };
}
