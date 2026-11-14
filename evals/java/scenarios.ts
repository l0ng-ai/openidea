/**
 * Java code intelligence with jdtls: the steps users take most, timed as they see them and
 * checked against `golden/<id>.json`. On `fixtures/java-app` (small, every case visible) and
 * on Spring PetClinic (`evals/projects.json`: a real Spring Boot / Maven project).
 */
import { join } from "node:path";
import { track } from "../lib/measure.ts";
import { normalizePath, type EvalScenario, type Measured } from "../lib/scenario.ts";
import type { Session } from "../lib/session.ts";

const SRC = "src/main/java/com/example/orders";
const TEST = "src/test/java/com/example/orders";
const PET = "src/main/java/org/springframework/samples/petclinic";
const TIMEOUT = 30_000;
/** Results a whole file's worth of server requests make up. */
const LONG_TIMEOUT = 60_000;

interface ProbeWindow {
  __openideaPerf: {
    editorState(): { path: string; head: number; line: number; word: string } | null;
    editorText(): string | null;
    setCursor(offset: number): void;
    insertAfter(after: string, text: string): number;
    completions(): string[];
    completionPending(): boolean;
    diagnostics(): Array<{ line: number; severity: string; message: string }>;
    lineAtY(y: number): number;
  };
}

/** The visible editor hint, unless it only says a request is pending. */
async function finalHint(s: Session): Promise<string | null> {
  return s.page.evaluate(() => {
    const el = document.querySelector(".cm-lsp-hint:not([data-pending])") as HTMLElement | null;
    return el && el.getClientRects().length ? el.textContent : null;
  });
}

/** Where the caret is: `path:line` in the project, `uri#word` in a library class (its line depends on the JDK build). */
async function caretLocation(s: Session): Promise<string | null> {
  const st = await s.page.evaluate(() => (window as unknown as ProbeWindow).__openideaPerf.editorState());
  if (!st) return null;
  const path = normalizePath(s.root, st.path);
  return path.includes("://") ? `${path}#${st.word}` : `${path}:${st.line + 1}`;
}

/**
 * Where a step starts: inside `word` on the first line containing `line` of `file`, or of the
 * library class reached from `file` by going to the declaration of each `via` in turn. `edit`
 * changes `file` first; `typed` changes the file reached right before the step, with no time
 * for the server to catch up.
 */
interface Place {
  file: string;
  edit?: Insertion;
  via?: Array<[line: string, word: string]>;
  typed?: Insertion;
  line: string;
  word: string;
}

interface Insertion {
  after: string;
  text: string;
}

async function reach(s: Session, at: Place) {
  await s.openFile(at.file);
  if (at.edit) await s.edit(at.edit.after, at.edit.text);
  for (const [line, word] of at.via ?? []) await s.declarationOf(line, word);
  if (!at.typed) await s.caretAt(at.line, at.word);
}

/** What a step does first when its place is `typed`. */
async function type(s: Session, at: Place) {
  if (!at.typed) return;
  await s.edit(at.typed.after, at.typed.text);
  await s.caretAt(at.line, at.word);
}

/** Text that marks an answer from syntax instead of the language server. */
const SYNTAX = /based on syntax|language server not ready/i;

function declaration(
  project: string,
  id: string,
  title: string,
  at: Place,
  conditions: EvalScenario["conditions"] = ["warm"],
): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions,
    setup: (s) => reach(s, at),
    async step(s): Promise<Measured> {
      await type(s, at);
      // Moved to the declaration, or a hint saying why not (not one saying it is still looking).
      const answered = (_: null, before: { path: string; head: number } | null) => {
        const st = (window as unknown as ProbeWindow).__openideaPerf.editorState();
        if (st && before && (st.path !== before.path || st.head !== before.head)) return true;
        return !!document.querySelector(".cm-lsp-hint:not([data-pending])");
      };
      const timing = await track(s.page, {
        action: "navigate.declaration",
        arg: null,
        first: answered,
        done: answered,
        timeoutMs: TIMEOUT,
      });
      // A note that the answer came from syntax follows the navigation.
      await s.page.waitForTimeout(300);
      const hint = await finalHint(s);
      const landed = await caretLocation(s);
      return {
        timing,
        results: { declaration: landed ? [landed] : [] },
        degraded: hint && SYNTAX.test(hint) ? hint : null,
      };
    },
  };
}

/** Every usage row of the popup, scrolling its virtual list through. */
async function usageRows(s: Session): Promise<string[]> {
  const rows = await s.page.evaluate(async () => {
    const popup = document.querySelector('[data-testid="usages-popup"]');
    if (!popup) return [];
    const found = new Set<string>();
    const collect = () => {
      for (const r of popup.querySelectorAll<HTMLElement>('[data-testid="usage-row"]'))
        found.add(`${r.dataset.path}\u0000${Number(r.dataset.line) + 1}`);
    };
    const scroller = [...popup.querySelectorAll<HTMLElement>("*")].find((el) => el.scrollHeight > el.clientHeight + 1);
    collect();
    if (scroller) {
      for (let top = 0; top < scroller.scrollHeight; top += scroller.clientHeight / 2) {
        scroller.scrollTop = top;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        collect();
      }
    }
    return [...found];
  });
  return rows.map((r) => {
    const [path, line] = r.split("\u0000") as [string, string];
    return `${normalizePath(s.root, path)}:${line}`;
  });
}

/**
 * Show Usages at `at`. `widen`: in Project and Libraries, as invoking it again while the popup
 * or its hint offers to widen a Project Files search does (the step is that second invocation).
 */
function showUsages(project: string, id: string, title: string, at: Place, widen = false): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    async setup(s) {
      await reach(s, at);
      if (!widen) return;
      await s.runAction("find.showUsages");
      await s.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="usages-popup"][data-loading="false"][data-scope="project"]') ||
          document.querySelector(".cm-lsp-hint[data-usages]"),
        undefined,
        { timeout: TIMEOUT },
      );
    },
    async step(s): Promise<Measured> {
      await type(s, at);
      const timing = await track(s.page, {
        action: "find.showUsages",
        arg: widen,
        // A single usage is jumped to; none says so in a hint.
        first: (widen, before) => {
          const popup = document.querySelector<HTMLElement>('[data-testid="usages-popup"]');
          if (popup)
            return (
              (!widen || popup.dataset.scope === "libraries") && !!popup.querySelector('[data-testid="usage-row"]')
            );
          const st = (window as unknown as ProbeWindow).__openideaPerf.editorState();
          if (st && before && (st.path !== before.path || st.head !== before.head)) return true;
          return !!document.querySelector(widen ? '.cm-lsp-hint[data-scope="libraries"]' : ".cm-lsp-hint[data-usages]");
        },
        done: (widen, before) => {
          const popup = document.querySelector<HTMLElement>('[data-testid="usages-popup"]');
          if (popup) return (!widen || popup.dataset.scope === "libraries") && popup.dataset.loading === "false";
          const st = (window as unknown as ProbeWindow).__openideaPerf.editorState();
          if (st && before && (st.path !== before.path || st.head !== before.head)) return true;
          return !!document.querySelector(widen ? '.cm-lsp-hint[data-scope="libraries"]' : ".cm-lsp-hint[data-usages]");
        },
        timeoutMs: TIMEOUT,
      });
      const popup = await s.page.$('[data-testid="usages-popup"]');
      const rows = popup ? await usageRows(s) : [];
      // Without a popup the hint gives the count: the only usage was jumped to (or the caret is on it).
      const count = await s.page.evaluate(
        () => (document.querySelector(".cm-lsp-hint[data-usages]") as HTMLElement | null)?.dataset.usages ?? null,
      );
      const single = !popup && count === "1" ? await caretLocation(s) : null;
      const note = await s.page.evaluate(
        () => document.querySelector('[data-testid="usages-note"]')?.textContent ?? null,
      );
      const hint = await finalHint(s);
      return {
        timing,
        results: { usages: single ? [single] : rows },
        degraded: note ?? (hint && SYNTAX.test(hint) ? hint : null),
      };
    },
  };
}

/** Every row of the targets chooser (`path:line`), scrolling its virtual list through. */
async function chooserRows(s: Session): Promise<string[]> {
  const rows = await s.page.evaluate(async () => {
    const popup = document.querySelector('[data-testid="list-popup"]');
    if (!popup) return [];
    const found = new Set<string>();
    const collect = () => {
      for (const r of popup.querySelectorAll<HTMLElement>('[data-testid="list-popup-item"]'))
        if (r.dataset.path) found.add(`${r.dataset.path}\u0000${Number(r.dataset.line) + 1}`);
    };
    const scroller = [...popup.querySelectorAll<HTMLElement>("*")].find((el) => el.scrollHeight > el.clientHeight + 1);
    collect();
    if (scroller) {
      for (let top = 0; top < scroller.scrollHeight; top += scroller.clientHeight / 2) {
        scroller.scrollTop = top;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        collect();
      }
    }
    return [...found];
  });
  return rows.map((r) => {
    const [path, line] = r.split("\u0000") as [string, string];
    return `${normalizePath(s.root, path)}:${line}`;
  });
}

/** Go to Implementation: the chooser's rows once it stops searching, or the only target. */
function implementation(project: string, id: string, title: string, at: Place): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    setup: (s) => reach(s, at),
    async step(s): Promise<Measured> {
      const before = await caretLocation(s);
      // The chooser (busy while the server looks on), the only target, or a hint.
      const answered = (searching: boolean, before: { path: string; head: number } | null) => {
        const popup = document.querySelector<HTMLElement>('[data-testid="list-popup"]');
        if (popup) return searching || popup.getAttribute("aria-busy") !== "true";
        const st = (window as unknown as ProbeWindow).__openideaPerf.editorState();
        if (st && before && (st.path !== before.path || st.head !== before.head)) return true;
        return !!document.querySelector(".cm-lsp-hint:not([data-pending])");
      };
      // Checks run in the page from their source, so the shared one goes in as the argument's source.
      const timing = await track(s.page, {
        action: "navigate.implementation",
        arg: answered.toString(),
        first: (src, before) => (new Function(`return ${src}`)() as typeof answered)(true, before),
        done: (src, before) => (new Function(`return ${src}`)() as typeof answered)(false, before),
        timeoutMs: TIMEOUT,
      });
      const popup = await s.page.$('[data-testid="list-popup"]');
      const rows = popup ? await chooserRows(s) : [];
      const at = await caretLocation(s);
      const hint = await finalHint(s);
      return {
        timing,
        results: { implementations: popup ? rows : at && at !== before ? [at] : [] },
        degraded: hint && SYNTAX.test(hint) ? hint : null,
      };
    },
  };
}

/**
 * What opening `file`, or the library class reached from it through `via` (see `Place`), brings
 * up beside its text: every `selector` with its line, as `L<line>:<its kind or text>`.
 */
function onOpen(
  project: string,
  id: string,
  title: string,
  file: string,
  via: NonNullable<Place["via"]>,
  group: string,
  selector: string,
): EvalScenario {
  const last = via[via.length - 1];
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    async setup(s) {
      if (!last) return;
      await s.openFile(file);
      for (const [line, word] of via.slice(0, -1)) await s.declarationOf(line, word);
      await s.caretAt(last[0], last[1]);
    },
    async step(s): Promise<Measured> {
      const items = (selector: string) => {
        const probe = (window as unknown as ProbeWindow).__openideaPerf;
        const out: string[] = [];
        for (const m of document.querySelectorAll<HTMLElement>(selector)) {
          // A lens is a row of its own above the line it is about.
          const r = (m.closest(".cm-openidea-lens")?.nextElementSibling ?? m).getBoundingClientRect();
          out.push(`L${probe.lineAtY(r.top + r.height / 2) + 1}:${m.dataset.kind ?? m.textContent}`);
        }
        return out.sort();
      };
      const timing = await track(s.page, {
        // A library class has no path to open: it is reached the way users do, which also shows its declaration.
        ...(last ? { action: "navigate.declaration" } : { openFile: join(s.root, file) }),
        arg: selector,
        first: (selector, before) =>
          (window as unknown as ProbeWindow).__openideaPerf.editorState()?.path !== before?.path &&
          !!document.querySelector(selector),
        done: () => true,
        signature: items,
        settleMs: 2000,
        timeoutMs: LONG_TIMEOUT,
      });
      return { timing, results: { [group]: await s.page.evaluate(items, selector) } };
    },
  };
}

const GUTTER = '.cm-editor [class*="cm-openidea-lineMarker-"]';

function gutterOnOpen(project: string, id: string, title: string, file: string, via: Place["via"] = []): EvalScenario {
  return onOpen(project, id, title, file, via, "markers", GUTTER);
}

function lensOnOpen(project: string, id: string, title: string, file: string, via: Place["via"] = []): EvalScenario {
  return onOpen(project, id, title, file, via, "lenses", ".cm-editor .cm-openidea-lensAction");
}

/** Errors and warnings in the active editor: hints and notes come and go with the server's settings. */
const problems = () =>
  (window as unknown as ProbeWindow).__openideaPerf
    .diagnostics()
    .filter((d) => d.severity === "error" || d.severity === "warning")
    .map((d) => `L${d.line + 1}:${d.severity}:${d.message}`)
    .sort();

/** Waits for what the previous run left in the active editor to go. */
async function noErrors(s: Session) {
  await s.page.waitForFunction(() => !document.querySelector(".cm-lintRange-error"), undefined, { timeout: TIMEOUT });
}

/** Opening a correct `file`: nothing is reported in it, once the server has had its say. */
function diagnosticsOnOpen(project: string, id: string, title: string, file: string): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    async setup() {},
    async step(s): Promise<Measured> {
      const timing = await track(s.page, {
        openFile: join(s.root, file),
        arg: null,
        first: () => !!document.querySelector(".cm-content .cm-line"),
        done: () => true,
        signature: problems,
        settleMs: 3000,
        timeoutMs: TIMEOUT,
      });
      return { timing, results: { problems: await s.page.evaluate(problems) } };
    },
  };
}

/** Typing `edit` into a correct file: the error shows under it. */
function diagnosticsAfterEdit(project: string, id: string, title: string, at: Place, edit: Insertion): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    async setup(s) {
      await reach(s, at);
      await noErrors(s);
      await s.keepText();
    },
    async step(s): Promise<Measured> {
      const timing = await track(s.page, {
        run: (edit) => (window as unknown as ProbeWindow).__openideaPerf.insertAfter(edit.after, edit.text),
        arg: edit,
        // The typed text answers the keystroke; the error is the result.
        feedback: () => true,
        first: () => !!document.querySelector(".cm-lintRange-error"),
        done: () => true,
        signature: problems,
        settleMs: 2000,
        timeoutMs: TIMEOUT,
      });
      return { timing, results: { problems: await s.page.evaluate(problems) } };
    },
  };
}

/** Typing `fix` elsewhere repairs the mistake `edit` made: only the server can clear its error. */
function diagnosticsAfterFix(
  project: string,
  id: string,
  title: string,
  at: Place,
  edit: Insertion,
  fix: Insertion,
): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    async setup(s) {
      await reach(s, at);
      await noErrors(s);
      await s.edit(edit.after, edit.text);
      await s.page.waitForSelector(".cm-lintRange-error", { timeout: TIMEOUT });
    },
    async step(s): Promise<Measured> {
      const timing = await track(s.page, {
        run: (fix) => (window as unknown as ProbeWindow).__openideaPerf.insertAfter(fix.after, fix.text),
        arg: fix,
        feedback: () => true,
        first: () => !document.querySelector(".cm-lintRange-error"),
        done: () => true,
        signature: problems,
        settleMs: 2000,
        timeoutMs: TIMEOUT,
      });
      return { timing, results: { problems: await s.page.evaluate(problems) } };
    },
  };
}

/** Code Completion right after typing `edit`: the lookup's labels. */
function completion(project: string, id: string, title: string, file: string, edit: Insertion): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    setup: (s) => s.openFile(file),
    async step(s): Promise<Measured> {
      const end = await s.edit(edit.after, edit.text);
      await s.page.evaluate((o) => (window as unknown as ProbeWindow).__openideaPerf.setCursor(o), end);
      const timing = await track(s.page, {
        action: "code.completion",
        arg: null,
        first: () => (window as unknown as ProbeWindow).__openideaPerf.completions().length > 0,
        // Quicker sources show first: every source has answered once it stops being pending.
        done: () => !(window as unknown as ProbeWindow).__openideaPerf.completionPending(),
        timeoutMs: TIMEOUT,
      });
      const labels = await s.page.evaluate(() => (window as unknown as ProbeWindow).__openideaPerf.completions());
      return { timing, results: { completions: labels } };
    },
  };
}

/** Quick Documentation: the start of what the popup says. */
function quickDoc(project: string, id: string, title: string, at: Place): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    setup: (s) => reach(s, at),
    async step(s): Promise<Measured> {
      const shown = () => !!document.querySelector('[data-testid="doc-popup"], .cm-lsp-hint:not([data-pending])');
      const text = () =>
        document.querySelector('[data-testid="doc-popup"]')?.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) ??
        "";
      const timing = await track(s.page, {
        action: "code.quickDocumentation",
        arg: null,
        feedback: () => !!document.querySelector('[data-testid="doc-popup"]'),
        first: shown,
        done: shown,
        signature: text,
        settleMs: 500,
        timeoutMs: TIMEOUT,
      });
      const doc = await s.page.evaluate(text);
      const hint = await finalHint(s);
      return {
        timing,
        results: { documentation: doc ? [doc] : [] },
        degraded: hint && SYNTAX.test(hint) ? hint : null,
      };
    },
  };
}

interface RenameAnswer {
  edit: { files: Array<{ path?: string; edits?: Array<{ range: { start: { line: number } }; new_text: string }> }> };
}

/** Rename in place to `newName`, then ↵: every edit it makes (a preview is left unapplied). */
function rename(project: string, id: string, title: string, at: Place, newName: string): EvalScenario {
  return {
    id,
    title,
    fixture: project,
    server: "jdtls",
    conditions: ["warm"],
    async setup(s) {
      await reach(s, at);
      await s.keepText();
      await s.runAction("refactor.rename");
      await s.page.waitForSelector(".cm-lsp-inplace-primary", { timeout: TIMEOUT });
      await s.page.keyboard.type(newName);
    },
    async step(s): Promise<Measured> {
      const answered = (newName: string) => {
        if (document.querySelector('[data-testid="refactor-preview"]')) return true;
        if (document.querySelector(".cm-lsp-hint:not([data-pending]):not(.cm-lsp-inplace-hint)")) return true;
        return (
          !document.querySelector(".cm-lsp-inplace") &&
          !!(window as unknown as ProbeWindow).__openideaPerf.editorText()?.includes(newName)
        );
      };
      const timing = await track(s.page, {
        run: () =>
          document.querySelector(".cm-content")?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              bubbles: true,
              cancelable: true,
            }),
          ),
        arg: newName,
        first: answered,
        done: answered,
        timeoutMs: TIMEOUT,
      });
      // The preview only counts per file: where the name lands is in the answer it shows. A server
      // may merge nearby occurrences into one edit, so every line of its new text counts.
      const answer = s.lastAnswer.get("lsp_rename") as RenameAnswer | undefined;
      const changes = (answer?.edit.files ?? []).flatMap((f) =>
        (f.edits ?? []).flatMap((e) =>
          e.new_text
            .split("\n")
            .flatMap((l, i) =>
              l.includes(newName) ? [`${normalizePath(s.root, f.path!)}:${e.range.start.line + i + 1}`] : [],
            ),
        ),
      );
      return { timing, results: { changes } };
    },
  };
}

const APP = "java-app";
const PETCLINIC = "spring-petclinic";

/** From `OrderBook` into the JDK's `ArrayList` / `Collection` sources. */
const BOOK = `${SRC}/OrderBook.java`;
const TO_ARRAYLIST: [string, string] = ["private final List<Order> orders = new ArrayList<>();", "ArrayList"];
/** A new method above the rest of `OrderBook`, calling `revenueCents`. */
const TWICE = "\n    public long twice() {\n        return revenueCents();\n    }\n";
const TYPE_ERROR: Insertion = { after: "public int size() {", text: '\n        int broken = "text";' };
const TO_STREAM: [string, string] = ["return orders.stream().mapToLong(Order::totalCents).sum();", "stream"];

export const JAVA_SCENARIOS: EvalScenario[] = [
  declaration(
    APP,
    "java.app.declaration.project",
    "Go to declaration: project method",
    { file: `${SRC}/App.java`, line: "long revenue = book.revenueCents();", word: "revenueCents" },
    ["warm", "cold"],
  ),
  declaration(APP, "java.app.declaration.jdk", "Go to declaration: JDK class", {
    file: BOOK,
    line: TO_ARRAYLIST[0],
    word: TO_ARRAYLIST[1],
  }),
  declaration(APP, "java.app.declaration.dependency", "Go to declaration: dependency method (JUnit)", {
    file: `${TEST}/OrderBookTest.java`,
    line: "assertEquals(2500, book.revenueCents());",
    word: "assertEquals",
  }),
  showUsages(APP, "java.app.usages.record", "Show Usages: record used across files", {
    file: `${SRC}/Order.java`,
    line: "public record Order(",
    word: "Order",
  }),
  showUsages(APP, "java.app.usages.method", "Show Usages: method used through calls and method references", {
    file: `${SRC}/Order.java`,
    line: "public long totalCents() {",
    word: "totalCents",
  }),
  gutterOnOpen(APP, "java.app.gutter.interface", "Gutter markers: open an interface", `${SRC}/PricingRule.java`),
  gutterOnOpen(
    APP,
    "java.app.gutter.subclass",
    "Gutter markers: open an overriding subclass",
    `${SRC}/BulkDiscount.java`,
  ),

  // The JDK's sources: their lines depend on its build (`java` in .github/tool-versions.env).
  declaration(APP, "java.app.declaration.jdkMethod", "Go to declaration: JDK static method", {
    file: BOOK,
    line: "return orders.stream().max(Comparator.comparingLong(Order::totalCents));",
    word: "comparingLong",
  }),
  declaration(APP, "java.app.declaration.inJdkSource", "Go to declaration from a JDK class: its superclass", {
    file: BOOK,
    via: [TO_ARRAYLIST],
    line: "extends AbstractList<E>",
    word: "AbstractList",
  }),
  showUsages(
    APP,
    "java.app.usages.jdkMethodLibraries",
    "Show Usages in Project and Libraries: JDK method called once in the project",
    {
      file: BOOK,
      line: "return orders.stream().max(Comparator.comparingLong(Order::totalCents));",
      word: "comparingLong",
    },
    true,
  ),
  showUsages(APP, "java.app.usages.inJdkSource", "Show Usages from a JDK class: a default method the project calls", {
    file: BOOK,
    via: [TO_STREAM],
    line: "default Stream<E> stream() {",
    word: "stream",
  }),
  implementation(APP, "java.app.implementation.jdkInterface", "Go to Implementation: JDK interface", {
    file: BOOK,
    line: TO_ARRAYLIST[0],
    word: "List",
  }),
  // From the import: `new ArrayList<>()` lands on a constructor, with no markers in view.
  gutterOnOpen(APP, "java.app.gutter.jdkClass", "Gutter markers: open a JDK class", BOOK, [
    ["import java.util.ArrayList;", "ArrayList"],
  ]),
  lensOnOpen(APP, "java.app.lens.project", "Usage lenses: open a project class", `${SRC}/Order.java`),
  lensOnOpen(APP, "java.app.lens.jdkClass", "Usage lenses: open a JDK class", BOOK, [
    ["public Optional<Order> largest() {", "Optional"],
  ]),

  implementation(APP, "java.app.implementation.projectInterface", "Go to Implementation: project interface", {
    file: `${SRC}/PricingRule.java`,
    line: "public interface PricingRule {",
    word: "PricingRule",
  }),
  implementation(APP, "java.app.implementation.interfaceMethod", "Go to Implementation: interface method", {
    file: `${SRC}/PricingRule.java`,
    line: "long price(Order order);",
    word: "price",
  }),

  // Right after an edit: results follow the new text, unsaved and with its lines moved.
  declaration(APP, "java.app.edit.declaration", "Go to declaration right after typing above the target", {
    file: BOOK,
    typed: { after: "public class OrderBook {", text: TWICE },
    line: "return revenueCents();",
    word: "revenueCents",
  }),
  showUsages(APP, "java.app.edit.usagesSameFile", "Show Usages right after typing a call in the same file", {
    file: BOOK,
    typed: { after: "public class OrderBook {", text: TWICE },
    line: "public long revenueCents() {",
    word: "revenueCents",
  }),
  showUsages(APP, "java.app.edit.usagesOtherFile", "Show Usages after typing a call in another file", {
    file: BOOK,
    edit: {
      after: "public class OrderBook {",
      text: "\n    public long firstTotal() {\n        return orders.get(0).totalCents();\n    }\n",
    },
    via: [["return orders.get(0).totalCents();", "totalCents"]],
    line: "public long totalCents() {",
    word: "totalCents",
  }),

  diagnosticsAfterEdit(
    APP,
    "java.app.diagnostics.afterError",
    "Diagnostics: type a type error",
    { file: BOOK, line: "public class OrderBook {", word: "OrderBook" },
    TYPE_ERROR,
  ),
  diagnosticsAfterFix(
    APP,
    "java.app.diagnostics.afterFix",
    "Diagnostics: declare the missing variable",
    { file: BOOK, line: "public class OrderBook {", word: "OrderBook" },
    { after: "public int size() {", text: "\n        int used = missing;" },
    { after: "public class OrderBook {", text: "\n    private final int missing = 0;" },
  ),

  completion(APP, "java.app.completion.jdkMember", "Code Completion: members of a JDK type", BOOK, {
    after: "public int size() {",
    text: "\n        orders.",
  }),
  completion(
    APP,
    "java.app.completion.projectMember",
    "Code Completion: members of a project class",
    `${SRC}/App.java`,
    {
      after: "long revenue = book.revenueCents();",
      text: "\n        book.",
    },
  ),

  quickDoc(APP, "java.app.doc.project", "Quick Documentation: project method", {
    file: BOOK,
    line: "public Order place(String customer, String product, int quantity, long unitPriceCents) {",
    word: "place",
  }),
  quickDoc(APP, "java.app.doc.jdk", "Quick Documentation: JDK class", {
    file: BOOK,
    line: TO_ARRAYLIST[0],
    word: TO_ARRAYLIST[1],
  }),

  rename(
    APP,
    "java.app.rename.acrossFiles",
    "Rename: method used across files",
    { file: `${SRC}/Order.java`, line: "public long totalCents() {", word: "totalCents" },
    "orderTotalCents",
  ),
  rename(
    APP,
    "java.app.rename.local",
    "Rename: local variable",
    { file: BOOK, line: "Order order = new Order(customer, product, quantity, unitPriceCents);", word: "order" },
    "placedOrder",
  ),

  declaration(
    PETCLINIC,
    "java.petclinic.declaration.project",
    "Go to declaration: Spring Data query method in the project",
    {
      file: `${PET}/owner/OwnerController.java`,
      line: "return owners.findByLastNameStartingWith(lastname, pageable);",
      word: "findByLastNameStartingWith",
    },
    ["warm", "cold"],
  ),
  declaration(
    PETCLINIC,
    "java.petclinic.declaration.inheritedLibrary",
    "Go to declaration: method inherited from a Spring Data interface",
    { file: `${PET}/owner/OwnerController.java`, line: "this.owners.save(owner);", word: "save" },
  ),
  declaration(PETCLINIC, "java.petclinic.declaration.libraryClass", "Go to declaration: Spring Data class", {
    file: `${PET}/owner/OwnerController.java`,
    line: "Pageable pageable = PageRequest.of(validatedPage - 1, pageSize);",
    word: "PageRequest",
  }),
  showUsages(
    PETCLINIC,
    "java.petclinic.usages.entity",
    "Show Usages: entity class used across controllers, repositories and tests",
    { file: `${PET}/owner/Owner.java`, line: "public class Owner extends Person {", word: "Owner" },
  ),
  showUsages(
    PETCLINIC,
    "java.petclinic.usages.inheritedMethod",
    "Show Usages: base-class getter called through subclasses",
    {
      file: `${PET}/model/BaseEntity.java`,
      line: "public Integer getId() {",
      word: "getId",
    },
  ),
  gutterOnOpen(
    PETCLINIC,
    "java.petclinic.gutter.baseClass",
    "Gutter markers: open a base entity",
    `${PET}/model/BaseEntity.java`,
  ),
  gutterOnOpen(
    PETCLINIC,
    "java.petclinic.gutter.midClass",
    "Gutter markers: open a mid-hierarchy entity",
    `${PET}/model/Person.java`,
  ),
  lensOnOpen(PETCLINIC, "java.petclinic.lens.entity", "Usage lenses: open an entity", `${PET}/owner/Owner.java`),
  implementation(PETCLINIC, "java.petclinic.implementation.baseClass", "Go to Implementation: base entity", {
    file: `${PET}/model/BaseEntity.java`,
    line: "public class BaseEntity implements Serializable {",
    word: "BaseEntity",
  }),
  diagnosticsOnOpen(
    PETCLINIC,
    "java.petclinic.diagnostics.cleanFile",
    "Diagnostics: open a controller that compiles",
    `${PET}/owner/OwnerController.java`,
  ),
  completion(
    PETCLINIC,
    "java.petclinic.completion.libraryClass",
    "Code Completion: class from a dependency, not imported",
    `${PET}/owner/PetValidator.java`,
    { after: "public class PetValidator implements Validator {", text: "\n    private Pageab" },
  ),
  quickDoc(PETCLINIC, "java.petclinic.doc.library", "Quick Documentation: Spring Data class", {
    file: `${PET}/owner/OwnerController.java`,
    line: "Pageable pageable = PageRequest.of(validatedPage - 1, pageSize);",
    word: "PageRequest",
  }),
  rename(
    PETCLINIC,
    "java.petclinic.rename.acrossFiles",
    "Rename: entity method used across controllers and tests",
    { file: `${PET}/owner/Owner.java`, line: "public void addVisit(Integer petId, Visit visit) {", word: "addVisit" },
    "recordVisit",
  ),
];
