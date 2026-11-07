import { registerActions } from "@/platform/actions";
import { editorService } from "@/workbench/contributions";
import { PLUGIN_CONTENT_EDITOR_KIND } from "./contentTab";

export interface ContentControls {
  key: string;
  find(replace?: boolean): void;
  runAction(id: string): void;
}

const controls = new Map<string, ContentControls>();

export function bindContentControls(id: string, value: ContentControls): () => void {
  controls.set(id, value);
  return () => {
    controls.delete(id);
  };
}

/** Toolbar actions address their own tab; user keybindings address the active input. */
export function registerContentActions(): () => void {
  const target = (arg: unknown) => {
    if (typeof arg === "string") return controls.get(arg);
    const input = editorService().activeInput?.();
    return input?.kind === PLUGIN_CONTENT_EDITOR_KIND
      ? [...controls.values()].find((c) => c.key === input.key)
      : undefined;
  };
  return registerActions([
    {
      id: "plugins.content.find",
      title: "Find in Editor",
      category: "Plugins",
      hidden: true,
      run: ({ arg }) => target(arg)?.find(false),
    },
    {
      id: "plugins.content.action",
      title: "Run Content Editor Action",
      category: "Plugins",
      hidden: true,
      run: ({ arg }) => {
        const m = arg as { target?: string; id?: string } | undefined;
        if (m && typeof m.id === "string") target(m.target)?.runAction(m.id);
      },
    },
  ]);
}
