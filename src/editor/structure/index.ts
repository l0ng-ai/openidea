/**
 * Structure service client: tree-sitter answers from the backend (`ide-syntax`)
 * that editor features fall back to when the language server cannot answer —
 * IDEA's "dumb mode" parser.
 *
 * Contract for features:
 *  - LSP first. Call the server; use `withFallback` to switch to these queries
 *    only when it is not usable (`notReady`: no server / not running /
 *    starting), fails (`error`), answers nothing (`empty`, e.g. a refactoring
 *    over code with syntax errors) or, opt-in, is too slow (`slow`).
 *  - Answers are syntactic and only claim what is certain: names in member
 *    position are never locals, references never cross a shadowing
 *    declaration, ambiguity is flagged (`certain: false`, `exact: false`,
 *    candidate lists) instead of guessed. Respect those flags (e.g. ask before
 *    a rename that is not `certain`).
 *  - Positions are 0-based lines / UTF-16 columns (`@/editor/lsp/positions`
 *    converts to CodeMirror offsets). Queries read the backend document, so
 *    `await whenSynced(view)` first after local edits.
 *  - Languages without a grammar reject with `unavailable` (check `support`).
 *    Pass `signal` to cancel a query.
 */
import type {
  DocId,
  ExpressionAt,
  FileIdentifiers,
  IdeError,
  IdentifierOccurrence,
  Locals,
  NodeAt,
  Pos,
  Range,
  RequestId,
  StructuralRanges,
  StructureSupport,
  SyntaxErrors,
} from "@/bindings";
import { IpcError, call, commands, isCancelled, nextRequestId } from "@/platform/ipc";

export type {
  ExpressionAt,
  FileIdentifiers,
  IdentifierOccurrence,
  Locals,
  LocalSymbol,
  NodeAt,
  StructuralRanges,
  StructureSupport,
  SyntaxErrors,
} from "@/bindings";

export interface QueryOptions {
  /** Aborting cancels the backend query (it rejects with `cancelled`). */
  signal?: AbortSignal;
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: IdeError };

async function query<T>(run: (request: RequestId | null) => Promise<Result<T>>, opts?: QueryOptions): Promise<T> {
  const signal = opts?.signal;
  if (!signal) return call(run(null));
  if (signal.aborted) throw new IpcError({ kind: "cancelled", message: "cancelled" });
  const id = nextRequestId();
  const onAbort = () => void commands.cancelRequest(id);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await call(run(id));
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const supportCache = new Map<string, Promise<StructureSupport>>();

export const structure = {
  /** What the service can answer for a language id (cached). */
  support(language: string): Promise<StructureSupport> {
    let p = supportCache.get(language);
    if (!p) {
      p = call(commands.syntaxSupport(language)).catch((e: unknown) => {
        supportCache.delete(language);
        throw e;
      });
      supportCache.set(language, p);
    }
    return p;
  },
  /** Smallest named node covering `range`, ancestors parent-first. */
  nodeAt: (doc: DocId, range: Range, opts?: QueryOptions): Promise<NodeAt | null> =>
    query((r) => commands.syntaxNodeAt(doc, range, r), opts),
  /** Expression for a selection (exact / enclosing / caret candidates), with statement and block. */
  expressionAt: (doc: DocId, range: Range, opts?: QueryOptions): Promise<ExpressionAt> =>
    query((r) => commands.syntaxExpressionAt(doc, range, r), opts),
  /** ERROR / MISSING nodes, document order. */
  syntaxErrors: (doc: DocId, opts?: QueryOptions): Promise<SyntaxErrors> =>
    query((r) => commands.syntaxErrors(doc, r), opts),
  /** Local definition + references of the identifier at `pos`, or why it is not a local. */
  locals: (doc: DocId, pos: Pos, opts?: QueryOptions): Promise<Locals> =>
    query((r) => commands.syntaxLocals(doc, pos, r), opts),
  /** Identifier tokens spelled `name` (comments and string contents excluded). */
  identifiers: (doc: DocId, name: string, opts?: QueryOptions): Promise<IdentifierOccurrence[]> =>
    query((r) => commands.syntaxIdentifiers(doc, name, r), opts),
  /** `identifiers` over files (open buffers preferred); files without hits are omitted. */
  identifiersInFiles: (paths: string[], name: string, opts?: QueryOptions): Promise<FileIdentifiers[]> =>
    query((r) => commands.syntaxIdentifiersInFiles(paths, name, r ?? nextRequestId()), opts),
  /** Selection chain + statement / declaration ranges at `pos`. */
  structuralRanges: (doc: DocId, pos: Pos, opts?: QueryOptions): Promise<StructuralRanges> =>
    query((r) => commands.syntaxStructuralRanges(doc, pos, r), opts),
};

/** When `withFallback` switches from the language server to the structure service. */
export type FallbackWhen = "notReady" | "error" | "empty" | "slow";

export interface FallbackOptions<T> {
  /** Default `["notReady", "error", "empty"]`. */
  when?: FallbackWhen[];
  /** Default: `null` / `undefined` / empty array. */
  isEmpty?: (value: T) => boolean;
  /** With `"slow"`: ask the fallback once the server has not answered within this time (default 1500 ms). */
  slowMs?: number;
  /** Skip the server (e.g. a back-off after recent `unavailable` errors). */
  skipLsp?: boolean;
}

export interface Answer<T> {
  value: T;
  source: "lsp" | "syntax";
}

const defaultEmpty = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0);

function lspFailure(e: unknown): FallbackWhen {
  return e instanceof IpcError && e.kind === "unavailable" ? "notReady" : "error";
}

/**
 * LSP-first: returns the server's answer unless a `when` condition holds, then
 * the fallback's. Cancellation is never a reason to fall back. If the fallback
 * fails too, the server's outcome stands (its error, or its empty answer).
 */
export async function withFallback<T>(
  lsp: () => Promise<T>,
  fallback: () => Promise<T>,
  opts: FallbackOptions<T> = {},
): Promise<Answer<T>> {
  const when = new Set(opts.when ?? ["notReady", "error", "empty"]);
  const isEmpty = opts.isEmpty ?? defaultEmpty;
  const useFallback = async (): Promise<Answer<T> | null> => {
    try {
      const value = await fallback();
      return isEmpty(value) ? null : { value, source: "syntax" };
    } catch (e) {
      if (isCancelled(e)) throw e;
      return null;
    }
  };
  if (opts.skipLsp) return { value: await fallback(), source: "syntax" };

  const fromLsp: Promise<Answer<T>> = (async () => {
    let value: T;
    try {
      value = await lsp();
    } catch (e) {
      if (isCancelled(e) || !when.has(lspFailure(e))) throw e;
      // oxlint-disable-next-line react-hooks/rules-of-hooks -- a plain async helper, not a hook
      const fb = await useFallback();
      if (fb) return fb;
      throw e;
    }
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- a plain async helper, not a hook
    if (when.has("empty") && isEmpty(value)) return (await useFallback()) ?? { value, source: "lsp" };
    return { value, source: "lsp" };
  })();
  if (!when.has("slow")) return fromLsp;
  // The server may still fail after the fallback answered; nobody awaits it then.
  fromLsp.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<Answer<T> | null>((resolve) => {
    timer = setTimeout(() => void useFallback().then(resolve, () => resolve(null)), opts.slowMs ?? 1500);
  });
  try {
    const first = await Promise.race([fromLsp, slow]);
    return first ?? (await fromLsp);
  } finally {
    clearTimeout(timer);
  }
}
