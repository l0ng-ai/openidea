/**
 * Rails: Navigate › Related Symbol between controllers, actions, views, helpers, models and
 * migrations; Go to Declaration on callback method symbols and on routes' controller actions.
 */
import { Text } from "@codemirror/state";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { registerNavigationProvider } from "@/editor/navigationProviders";
import { registerRelatedProvider } from "@/editor/relatedProviders";
import { tx } from "@/platform/i18n";
import { call, commands, type Location } from "@/platform/ipc";
import { controllerName, defLine, railsTargets, type RailsFs, type RailsGroup } from "./conventions";
import { railsReferenceAt } from "./references";

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

/** The `def name` in `text` as a navigation target, at the method name. */
function method(path: string, text: string, name: string, label?: string): (Location & { name?: string }) | null {
  const line = defLine(text, name);
  if (line === undefined) return null;
  const doc = Text.of(text.split("\n"));
  const at = doc.line(line + 1);
  const col = at.text.indexOf(name, at.text.indexOf("def") + 3);
  return { path, range: offsetsToRange(doc, at.from + col, at.from + col + name.length), name: label };
}

const ROUTES = /\/config\/routes(?:\/[^/]+)?\.rb$/;

export function activate(): () => void {
  const unregisterRelated = registerRelatedProvider(async (ctx) => {
    const targets = await railsTargets(ctx.path, ctx.text, ctx.offset, fs);
    return targets.map((t) => ({ path: t.path, line: t.line, label: t.label, group: GROUPS[t.group]() }));
  });
  const unregisterNavigation = registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || !doc.path.endsWith(".rb")) return null;
    const routes = ROUTES.exec(doc.path);
    const text = view.state.doc.toString();
    const ref = railsReferenceAt(text, offset, !!routes);
    if (!ref) return null;
    if (ref.kind === "method") {
      const own = method(doc.path, text, ref.name);
      const app = doc.path.match(/^(.*)\/app\/(controllers|models)\//);
      const base =
        app && !own ? `${app[1]}/app/${app[2]}/application_${app[2] === "models" ? "record" : "controller"}.rb` : null;
      const baseText = base ? await fs.read(base) : null;
      const target = own ?? (base && baseText !== null ? method(base, baseText, ref.name) : null);
      return target ? { from: ref.from, to: ref.to, targets: [target] } : null;
    }
    const root = doc.path.slice(0, routes!.index);
    const path = `${root}/app/controllers/${ref.resource}_controller.rb`;
    const controller = await fs.read(path);
    if (controller === null) return null;
    const name = controllerName(ref.resource);
    const target = ref.action
      ? method(path, controller, ref.action, `${name}#${ref.action}`)
      : { path, range: offsetsToRange(Text.of([""]), 0, 0), name };
    return target ? { from: ref.from, to: ref.to, targets: [target] } : null;
  });
  return () => {
    unregisterNavigation();
    unregisterRelated();
  };
}
