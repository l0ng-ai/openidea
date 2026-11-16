/** Rails: Navigate › Related Symbol between controllers, actions, views, helpers, models and migrations. */
import { registerRelatedProvider } from "@/editor/relatedProviders";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { railsTargets, type RailsFs, type RailsGroup } from "./conventions";

const fs: RailsFs = {
  list: async (dir) => {
    try {
      return (await call(commands.fsReadDir(dir))).filter((e) => e.kind !== "dir").map((e) => e.name);
    } catch {
      return null;
    }
  },
  read: async (path) => {
    try {
      return await call(commands.fsReadText(path));
    } catch {
      return null;
    }
  },
};

const GROUPS: Record<RailsGroup, () => string> = {
  view: () => tx("View"),
  controller: () => tx("Controller"),
  helper: () => tx("Helper"),
  model: () => tx("Model"),
  migration: () => tx("Migration"),
};

export function activate(): () => void {
  return registerRelatedProvider(async (ctx) => {
    const targets = await railsTargets(ctx.path, ctx.text, ctx.offset, fs);
    return targets.map((t) => ({ path: t.path, line: t.line, label: t.label, group: GROUPS[t.group]() }));
  });
}
