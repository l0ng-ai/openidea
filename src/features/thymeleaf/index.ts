/**
 * Thymeleaf navigation: Go to Declaration (⌘-click, ⌘B) on a fragment expression's template
 * name opens the template, on its selector the `th:fragment` defining it, and on a message
 * expression's key that key in each of the message bundle's `.properties` files.
 */
import { Text } from "@codemirror/state";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { registerNavigationProvider } from "@/editor/navigationProviders";
import { call, commands, type Location } from "@/platform/ipc";
import {
  fragmentDefinition,
  inBundle,
  messageBasenames,
  propertyDefinition,
  templatesRoot,
  thymeleafReferenceAt,
} from "./references";

const TEMPLATE_FILE = /\.html?$/i;

async function read(path: string): Promise<string | null> {
  try {
    return await call(commands.fsReadText(path));
  } catch {
    return null;
  }
}

function location(path: string, text: string, from: number, to: number, name?: string): Location & { name?: string } {
  return { path, range: offsetsToRange(Text.of(text.split("\n")), from, to), name };
}

function templatePath(root: string, template: string): string {
  return `${root}/${template}${/\.\w+$/.test(template) ? "" : ".html"}`;
}

/** The definitions of `key` in the message bundles next to the templates `root`. */
async function messageTargets(root: string, key: string): Promise<Array<Location & { name?: string }>> {
  const resources = root.slice(0, root.lastIndexOf("/"));
  let application = "";
  for (const name of ["application.properties", "application.yml", "application.yaml"])
    application += `${(await read(`${resources}/${name}`)) ?? ""}\n`;
  const targets: Array<Location & { name?: string }> = [];
  for (const base of messageBasenames(application)) {
    const dir = base.includes("/") ? `${resources}/${base.slice(0, base.lastIndexOf("/"))}` : resources;
    let entries;
    try {
      entries = await call(commands.fsReadDir(dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.kind !== "file" || !inBundle(entry.name, base)) continue;
      const text = await read(entry.path);
      const at = text === null ? -1 : propertyDefinition(text, key);
      if (text !== null && at >= 0) targets.push(location(entry.path, text, at, at + key.length, entry.name));
    }
  }
  return targets;
}

export function activate(): () => void {
  return registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || !TEMPLATE_FILE.test(doc.path)) return null;
    const text = view.state.doc.toString();
    if (!text.includes("th:") && !text.includes("data-th-")) return null;
    const ref = thymeleafReferenceAt(text, offset);
    if (!ref) return null;
    const root = templatesRoot(doc.path);
    const match = (targets: Array<Location & { name?: string }>) =>
      targets.length ? { from: ref.from, to: ref.to, targets } : null;
    if (ref.kind === "message") return root ? match(await messageTargets(root, ref.key)) : null;
    const path = ref.template ? (root ? templatePath(root, ref.template) : null) : doc.path;
    if (!path) return null;
    const target = path === doc.path ? text : await read(path);
    if (target === null) return null;
    if (ref.kind === "template") return match([location(path, target, 0, 0)]);
    const at = fragmentDefinition(target, ref.fragment);
    return at < 0 ? null : match([location(path, target, at, at + ref.fragment.length)]);
  });
}
