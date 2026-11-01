/**
 * ⌥↵ intentions for Java mapper interfaces, offered synchronously from the
 * document text (plus the already-resolved project index snapshot): @Param
 * generation (method / whole interface), creating the mapper.xml, generating
 * one XML statement, and jumping to it. The runs re-check the document
 * version before dispatching edits; creating a file asks for confirmation
 * first (`askCreateXml`).
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorsFor, type ContributedIntention, type EditorDocContext } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { showHint } from "@/editor/lsp/hint";
import { locationItems, navigateTo } from "@/editor/lsp/navigation";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { notifyFileOperation } from "@/platform/fileOps";
import { tx } from "@/platform/i18n";
import { call, commands, type Location } from "@/platform/ipc";
import { dirname, useProject } from "@/platform/project";
import { currentRoots } from "@/platform/projectRoots";
import { editorService } from "@/workbench/contributions";
import { askCreateXml } from "./dialogs";
import { appendStatementEdit, importEdit, mapperXmlContent, paramAnnotationEdits, statementXml } from "./generate";
import { inType, methodAt, parseMapperInterface, type MapperInterface, type MapperMethod } from "./javaParse";
import { parseMapperXml } from "./xmlParse";
import {
  configuredXmlDirs,
  ensureMapperIndex,
  ensureMapperScanPackages,
  mapperIndexSnapshot,
  mapperScanCovers,
  mapperScanPackagesSnapshot,
  patchMapperIndex,
  resetMapperIndex,
  type XmlEntry,
} from "./xmlIndex";
import { refreshMybatisGutters } from "./gutter";

// ---------------------------------------------------------------------------
// Targets

/** The resources root (absolute), else the project root; null without a project. */
function resourcesBase(): string | null {
  const root = useProject.getState().project?.root ?? null;
  if (!root) return null;
  const res = currentRoots().find((r) => r.kind === "resources");
  return res ? (res.path ? `${root}/${res.path}` : root) : null;
}

function entryFrom(path: string, text: string): XmlEntry {
  const xml = parseMapperXml(text);
  const statements = new Map<
    string,
    { tag: "select" | "insert" | "update" | "delete"; id: string; line: number; col: number }[]
  >();
  for (const s of xml.statements) {
    const list = statements.get(s.id);
    if (list) list.push(s);
    else statements.set(s.id, [s]);
  }
  return { path, statements };
}

/**
 * Where the interface's XML lives / would be created: the index first, then
 * the configured `mapper-locations` directories, the mirrored resources
 * path, and finally next to the Java file. Existing files are checked by
 * namespace (never overwritten; the backend refuses to truncate anyway).
 */
async function xmlTargets(
  iface: MapperInterface,
  javaPath: string,
): Promise<{ existing: XmlEntry[]; createPath: string | null }> {
  const root = useProject.getState().project?.root ?? null;
  const index = await ensureMapperIndex(root);
  const existing = index.xmls.get(iface.fqn) ?? [];
  if (existing.length) return { existing, createPath: null };
  const base = resourcesBase();
  const dirs = await configuredXmlDirs();
  const rel = iface.pkg ? `${iface.pkg.replace(/\./g, "/")}/` : "";
  const candidates: string[] = [];
  for (const d of dirs) {
    const dirBase = base ?? root;
    candidates.push(d ? `${dirBase}/${d}/${iface.name}.xml` : `${dirBase}/${iface.name}.xml`);
  }
  if (base) candidates.push(`${base}/${rel}${iface.name}.xml`);
  candidates.push(`${dirname(javaPath)}/${iface.name}.xml`);
  for (const c of [...new Set(candidates)]) {
    const text = await call(commands.fsReadText(c)).catch(() => null);
    if (text === null) return { existing: [], createPath: c };
    if (parseMapperXml(text).namespace === iface.fqn) return { existing: [entryFrom(c, text)], createPath: null };
  }
  return { existing: [], createPath: null };
}

/** Mapper-ness: annotation signals, an XML namespace, or a @MapperScan package. */
async function mapperKnown(iface: MapperInterface): Promise<boolean> {
  if (iface.hasMapperAnnotation || iface.methods.some((m) => m.sqlAnnotation)) return true;
  const root = useProject.getState().project?.root ?? null;
  const index = await ensureMapperIndex(root);
  if (index.xmls.has(iface.fqn)) return true;
  return mapperScanCovers(await ensureMapperScanPackages(root), iface.pkg);
}

// ---------------------------------------------------------------------------
// Runs

/** Applies the @Param plan (and the import) to the live document; no-op when it changed. */
function runParams(view: EditorView, iface: MapperInterface, scope: MapperMethod | null) {
  const text = view.state.doc.toString();
  if (parseMapperInterface(text)?.fqn !== iface.fqn) {
    showHint(view, tx("The document changed; retry"), { tone: "error" });
    return;
  }
  const edits = paramAnnotationEdits(iface, scope);
  if (!edits.length) return;
  const ie = importEdit(text);
  if (ie) edits.push(ie);
  view.dispatch({ changes: edits, userEvent: "input" });
}

/** Needs the @Param intention: an empty `@Param()` to fill, or a multi-parameter method with missing annotations. */
const needsParams = (m: MapperMethod) =>
  m.params.some((p) => p.emptyParamAt) || (m.params.length >= 2 && m.params.some((p) => !p.hasParam));

/** @Param for freshly generated multi-parameter statements, so their `#{…}` refs bind. */
function paramsForMissing(
  view: EditorView,
  iface: MapperInterface,
  scope: MapperMethod | null,
  methods: MapperMethod[],
) {
  if (methods.some(needsParams)) runParams(view, iface, scope);
}

/** Opens the XML (or opens it and appends), caret on the first TODO. */
async function appendStatement(path: string, stmt: string): Promise<boolean> {
  await editorService().openFile(path, { focus: true });
  const ed = editorsFor(path)[0];
  if (!ed) return false;
  const view = ed.view;
  const edit = appendStatementEdit(view.state.doc.toString(), stmt);
  const caret = edit.from + Math.max(0, edit.insert.indexOf("<!-- TODO"));
  view.dispatch({
    changes: [edit],
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
    userEvent: "input",
  });
  // The edit may be unsaved: merge it into the cached index and refresh the
  // gutters, so the Java mapper picks the new statement up at once.
  patchMapperIndex(path, view.state.doc.toString());
  refreshMybatisGutters();
  return true;
}

async function createMapperXml(path: string, iface: MapperInterface): Promise<void> {
  const content = mapperXmlContent(iface);
  await call(commands.fsCreateFileBytes(path, Array.from(new TextEncoder().encode(content))));
  notifyFileOperation({ kind: "created", paths: [path] });
  resetMapperIndex();
  refreshMybatisGutters();
  await editorService().openFile(path, { focus: true });
}

/** Create the mapper.xml (all eligible methods), or append the statement(s) it lacks. */
async function generateStatementOrCreate(
  view: EditorView,
  ctx: EditorDocContext,
  iface: MapperInterface,
  scope: MapperMethod | null,
) {
  if (!(await mapperKnown(iface))) {
    showHint(view, tx("Not a MyBatis mapper"));
    return;
  }
  const { existing, createPath } = await xmlTargets(iface, ctx.path);
  if (existing.length) {
    const have = new Set(existing.flatMap((e) => [...e.statements.keys()]));
    if (scope && have.has(scope.name)) {
      showHint(view, tx("The XML statement already exists"));
      return;
    }
    const missing = scope ? [scope] : iface.methods.filter((m) => m.kind && !m.defaultMethod && !have.has(m.name));
    if (!missing.length) {
      showHint(view, tx("All methods already have statements"));
      return;
    }
    // Several files may share the namespace; appending to the first is fine —
    // MyBatis loads statements from all of them.
    const entry = existing[0]!;
    const stmts = missing.map((m) => statementXml(m, iface)).join("\n\n");
    if (await appendStatement(entry.path, stmts)) paramsForMissing(view, iface, scope, missing);
    return;
  }
  if (!createPath) {
    showHint(view, tx("No target location for the mapper XML"), { tone: "error" });
    return;
  }
  if (!(await askCreateXml(createPath))) return;
  await createMapperXml(createPath, iface);
  paramsForMissing(
    view,
    iface,
    scope,
    iface.methods.filter((m) => m.kind && !m.defaultMethod),
  );
}

async function jumpToStatement(view: EditorView, iface: MapperInterface, m: MapperMethod) {
  const root = useProject.getState().project?.root ?? null;
  const index = await ensureMapperIndex(root);
  const entries = index.xmls.get(iface.fqn) ?? [];
  const targets: Location[] = [];
  for (const e of entries) {
    for (const s of e.statements.get(m.name) ?? [])
      targets.push({
        path: e.path,
        range: { start: { line: s.line, col: s.col }, end: { line: s.line, col: s.col + 1 } },
      });
  }
  if (!targets.length) {
    showHint(view, tx("No MyBatis statement for this method"));
    return;
  }
  if (targets.length === 1) {
    await navigateTo(targets[0]!);
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, view.state.selection.main.head),
    title: tx("Choose MyBatis Statement"),
    items: await locationItems(targets),
  });
}

// ---------------------------------------------------------------------------
// Provider

export function mybatisIntentions(view: EditorView): ContributedIntention[] {
  const ctx = docOf(view);
  if (!ctx || ctx.language !== "java") return [];
  const iface = parseMapperInterface(view.state.doc.toString());
  if (!iface) return [];
  const caret = view.state.selection.main.head;
  const m = methodAt(iface, caret);
  const inTypeAt = inType(iface, caret);

  // Mapper signals: annotations (sync), or the already-resolved index /
  // @MapperScan snapshot. Before the first index pass resolves, only the
  // annotation-signal mappers get intentions (the gutter pass loads the index).
  const signals = iface.hasMapperAnnotation || iface.methods.some((x) => x.sqlAnnotation);
  const root = useProject.getState().project?.root ?? null;
  const index = mapperIndexSnapshot(root);
  const scanPackages = mapperScanPackagesSnapshot(root);
  const known =
    signals || index?.xmls.has(iface.fqn) || (scanPackages !== null && mapperScanCovers(scanPackages, iface.pkg));

  const out: ContributedIntention[] = [];

  if (m && needsParams(m))
    out.push({
      id: "mybatis.params.method",
      label: tx("Generate @Param Annotations"),
      run: () => runParams(view, iface, m),
    });
  else if (inTypeAt && iface.methods.some(needsParams))
    out.push({
      id: "mybatis.params.all",
      label: tx("Generate @Param Annotations"),
      run: () => runParams(view, iface, null),
    });

  if (known && inTypeAt)
    out.push({
      id: "mybatis.createXml",
      label: tx("Create Mapper XML…"),
      run: () => void generateStatementOrCreate(view, ctx, iface, null),
    });

  if (known && m && m.kind && !m.defaultMethod) {
    out.push({
      id: "mybatis.jump",
      label: tx("Jump to MyBatis Statement"),
      run: () => void jumpToStatement(view, iface, m),
    });
    out.push({
      id: "mybatis.statement",
      label: tx("Generate XML Statement"),
      run: () => void generateStatementOrCreate(view, ctx, iface, m),
    });
  }
  return out;
}
