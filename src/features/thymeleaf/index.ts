/**
 * Thymeleaf navigation: Go to Declaration (⌘-click, ⌘B) on a fragment expression's template
 * name opens the template, on its selector the `th:fragment` defining it, and on a message
 * expression's key that key in each of the message bundle's `.properties` files; and a warning on
 * template and fragment names that resolve to nothing.
 */
import { Text, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  offsetsToRange,
  registerEditorContribution,
  registerNavigationProvider,
  type EditorDocContext,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { docOf } from "@/editor/lsp/lsp";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent, type Location } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  fragmentDefinition,
  inBundle,
  messageBasenames,
  propertyDefinition,
  templatePath,
  templatesRoot,
  thymeleafReferenceAt,
  unresolvedThymeleafReferences,
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

/** The Spring Boot `application.properties` / `.yml` text in the `resources` folder. */
async function applicationConfig(resources: string): Promise<string> {
  const configs = await Promise.all(
    ["application.properties", "application.yml", "application.yaml"].map((name) => read(`${resources}/${name}`)),
  );
  return configs.map((text) => `${text ?? ""}\n`).join("");
}

/** The definitions of `key` in the message bundles next to the templates `root`. */
async function messageTargets(root: string, key: string): Promise<Array<Location & { name?: string }>> {
  const resources = root.slice(0, root.lastIndexOf("/"));
  const bases = messageBasenames(await applicationConfig(resources));
  const listings = await Promise.all(
    bases.map((base) =>
      call(
        commands.fsReadDir(base.includes("/") ? `${resources}/${base.slice(0, base.lastIndexOf("/"))}` : resources),
      ).catch(() => null),
    ),
  );
  const groups = await Promise.all(
    bases.map(async (base, i) => {
      const entries = listings[i];
      if (!entries) return [];
      const files = entries.filter((entry) => entry.kind === "file" && inBundle(entry.name, base));
      const texts = await Promise.all(files.map((entry) => read(entry.path)));
      const targets: Array<Location & { name?: string }> = [];
      files.forEach((entry, j) => {
        const text = texts[j] ?? null;
        const at = text === null ? -1 : propertyDefinition(text, key);
        if (text !== null && at >= 0) targets.push(location(entry.path, text, at, at + key.length, entry.name));
      });
      return targets;
    }),
  );
  return groups.flat();
}

const SOURCE = "thymeleaf-references";
const INSPECT_DELAY = 600;

/** Warns about template and fragment references that resolve to nothing; re-checked on edits and file changes. */
function unresolvedReferences(ctx: EditorDocContext): Extension {
  return ViewPlugin.define((view: EditorView) => {
    const { path } = ctx;
    const spring = path.lastIndexOf("/src/main/resources/templates/");
    if (ctx.virtual || !TEMPLATE_FILE.test(path) || spring < 0 || !isTauri()) return {};
    const resources = path.slice(0, spring + "/src/main/resources".length);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    const run = async () => {
      const mine = ++seq;
      const doc = view.state.doc;
      const text = doc.toString();
      const refs =
        text.includes("th:") || text.includes("data-th-")
          ? await unresolvedThymeleafReferences(
              path,
              text,
              await applicationConfig(resources),
              useProject.getState().project?.root ?? null,
              read,
            )
          : [];
      if (mine !== seq) return;
      setFileDiagnostics(
        path,
        SOURCE,
        refs.map((r) => ({
          range: offsetsToRange(doc, r.from, r.to),
          severity: "warning",
          message:
            r.kind === "fragment"
              ? tx`Cannot resolve fragment '${r.fragment}'`
              : tx`Cannot resolve template '${r.template}'`,
          source: "Thymeleaf",
          code: null,
        })),
      );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), INSPECT_DELAY);
    };
    schedule();
    const offFs = onIdeEvent("fsChanged", (e) => {
      if (e.created.length || e.removed.length || e.modified.some((p) => p !== path && p.startsWith(resources)))
        schedule();
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        offFs();
        seq++;
        setFileDiagnostics(path, SOURCE, []);
      },
    };
  });
}

export function activate(): () => void {
  const offUnresolved = registerEditorContribution({ id: "thymeleaf.unresolved", extensions: unresolvedReferences });
  const offNavigation = registerNavigationProvider(async (view, offset) => {
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
  return () => {
    offUnresolved();
    offNavigation();
  };
}
