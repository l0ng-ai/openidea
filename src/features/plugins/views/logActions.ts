import { registerActions } from "@/platform/actions";
import { editorService } from "@/workbench/contributions";

export interface LogControls {
  key: string;
  find(): void;
  clear(): void;
  wrap(): void;
  toggle(id: string, checked: boolean): void;
}

const controls = new Map<string, LogControls>();

export function bindLogControls(id: string, value: LogControls): () => void {
  controls.set(id, value);
  return () => {
    controls.delete(id);
  };
}

/** Toolbar actions address their own tab; user keybindings address the active input. */
export function registerLogActions(): () => void {
  const target = (arg: unknown) => {
    if (typeof arg === "string") return controls.get(arg);
    const input = editorService().activeInput?.();
    return input?.kind === "pluginLog" ? [...controls.values()].find((c) => c.key === input.key) : undefined;
  };
  return registerActions([
    ...(
      [
        ["find", "Find in Logs"],
        ["clear", "Clear"],
        ["wrap", "Soft-wrap"],
      ] as const
    ).map(([operation, title]) => ({
      id: `plugins.log.${operation}`,
      title,
      category: "Plugins",
      hidden: true,
      run: ({ arg }: { arg?: unknown }) => target(arg)?.[operation](),
    })),
    {
      id: "plugins.log.toggleArgument",
      title: "Toggle Log Option",
      category: "Plugins",
      hidden: true,
      run: ({ arg }) => {
        const m = arg as { target?: string; id?: string; checked?: boolean } | undefined;
        if (m && typeof m.id === "string" && typeof m.checked === "boolean") target(m.target)?.toggle(m.id, m.checked);
      },
    },
  ]);
}
