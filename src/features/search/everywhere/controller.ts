/**
 * Runs the Search Everywhere sources for a query. Every source streams into
 * its own section independently (first results render as soon as any source
 * answers); a new query supersedes the old one, cancelling backend requests
 * that support it. Sections whose inputs didn't change are not re-fetched
 * (e.g. "Show more" on one section).
 */
import type { Action } from "@/platform/actions";
import type {
  FileMatch,
  FileMatches,
  ProjectFileSet,
  RequestId,
  SearchQuery,
  SymbolFilter,
  SymbolMatch,
  WorkspaceSymbol,
} from "@/platform/ipc";
import type { EndpointEntry, SettingsSearchEntry } from "@/workbench/contributions";
import { parseLocationQuery } from "../common/query";
import { matchRoutes } from "./routes";
import { passesFilter, type ResolvedFilter } from "./filters";
import {
  ALL_TAB_LIMIT,
  RECENT_LIMIT,
  TAB_LIMIT,
  actionItem,
  fileItem,
  matchActions,
  matchSettings,
  mergeActionResults,
  mergeSymbols,
  sectionsFor,
  textItems,
  type SeItem,
  type SeTab,
  type SectionId,
  type SectionState,
} from "./model";

export interface SeDeps {
  findFiles(query: string, limit: number): Promise<FileMatch[]>;
  findSymbols(query: string, filter: SymbolFilter, limit: number): Promise<SymbolMatch[]>;
  /** Optional language-server symbols; rejects with `unavailable` when no server. */
  workspaceSymbols?(request: RequestId, query: string): Promise<WorkspaceSymbol[]>;
  /** Streams text matches; resolves when the search finished or was cancelled. */
  searchText(request: RequestId, query: SearchQuery, onFile: (f: FileMatches) => void): Promise<void>;
  cancel(request: RequestId): void;
  nextRequestId(): RequestId;
  actions(): readonly Action[];
  isEnabled(a: Action): boolean;
  recentFiles(): Promise<string[]>;
  recentActions(): readonly string[];
  /** Settings pages / options listed with actions ("Settings: …"). */
  settings?(): Promise<SettingsSearchEntry[]>;
  root(): string | null;
  now(): number;
  /** Whether `path` is in a root-based named scope ("Project Test Files" …). */
  inFileSet?(set: ProjectFileSet, path: string): boolean;
  /** Endpoints of the project, for request-path matches. */
  routes?(): Promise<EndpointEntry[]>;
}

export interface SeRequest {
  query: string;
  tab: SeTab;
  includeNonProject: boolean;
  /** "Project Production Files" / "Project Test Files"; unset or `all` = every project file. */
  fileSet?: ProjectFileSet | null;
  /** The tab's funnel filter (file types, languages, kinds, file mask). */
  filter?: ResolvedFilter | null;
  /** Actions: list disabled ones too (unset = include them). */
  includeDisabled?: boolean;
  /** Per-section extra rows requested via "Show more". */
  extra: Partial<Record<SectionId, number>>;
}

export interface SeSnapshot {
  gen: number;
  sections: ReadonlyMap<SectionId, SectionState>;
  /** Milliseconds from query start to the latest result, null while nothing arrived. */
  elapsed: number | null;
  /** True while any section is still loading. */
  loading: boolean;
  /** The query / scope these sections answer (results of an older query may still be shown). */
  query: string;
  tab: SeTab | null;
}

export const TEXT_MIN_QUERY = 2;

export function sectionLimit(tab: SeTab, section: SectionId, extra: number): number {
  if (section === "recent" || section === "recentActions") return RECENT_LIMIT + extra;
  return (tab === "all" ? ALL_TAB_LIMIT : TAB_LIMIT) + extra;
}

export class SeController {
  private gen = 0;
  private sections = new Map<SectionId, SectionState>();
  private signatures = new Map<SectionId, string>();
  private live = new Map<SectionId, number>();
  private requests = new Map<SectionId, RequestId[]>();
  private started = 0;
  private req: { query: string; tab: SeTab | null } = { query: "", tab: null };
  private elapsed: number | null = null;
  private notifyQueued = false;
  private disposed = false;

  constructor(
    private readonly deps: SeDeps,
    private readonly onChange: (s: SeSnapshot) => void,
  ) {}

  run(req: SeRequest) {
    const gen = ++this.gen;
    this.disposed = false;
    this.req = { query: req.query, tab: req.tab };
    const parsed = parseLocationQuery(req.query, this.deps.root());
    const text = parsed.text.trim();
    const wanted = sectionsFor(req.tab, !text);
    this.started = this.deps.now();
    this.elapsed = null;

    for (const id of [...this.sections.keys()]) {
      if (!wanted.includes(id)) {
        this.cancelSection(id);
        this.sections.delete(id);
        this.signatures.delete(id);
      }
    }
    for (const id of wanted) {
      const limit = sectionLimit(req.tab, id, req.extra[id] ?? 0);
      const sig = JSON.stringify([
        req.query,
        req.tab,
        req.includeNonProject,
        req.fileSet ?? "all",
        req.filter ?? null,
        req.includeDisabled ?? null,
        limit,
      ]);
      if (this.signatures.get(id) === sig && this.sections.has(id)) continue;
      this.signatures.set(id, sig);
      this.cancelSection(id);
      const prev = this.sections.get(id);
      this.sections.set(id, { items: prev?.items ?? [], hasMore: prev?.hasMore ?? false, loading: true });
      this.live.set(id, gen);
      void this.start(id, gen, { text, line: parsed.line, col: parsed.col, req, limit });
    }
    this.notify();
  }

  /** Cancels everything in flight; a later `run()` starts afresh. */
  dispose() {
    this.disposed = true;
    for (const id of this.sections.keys()) this.cancelSection(id);
    this.sections.clear();
    this.signatures.clear();
  }

  snapshot(): SeSnapshot {
    return {
      gen: this.gen,
      sections: new Map(this.sections),
      elapsed: this.elapsed,
      loading: [...this.sections.values()].some((s) => s.loading),
      query: this.req.query,
      tab: this.req.tab,
    };
  }

  private cancelSection(id: SectionId) {
    this.live.delete(id);
    for (const r of this.requests.get(id) ?? []) this.deps.cancel(r);
    this.requests.delete(id);
  }

  private isLive(id: SectionId, gen: number) {
    return !this.disposed && this.live.get(id) === gen;
  }

  private set(id: SectionId, gen: number, items: SeItem[], hasMore: boolean, loading: boolean) {
    if (!this.isLive(id, gen)) return;
    this.sections.set(id, { items, hasMore, loading });
    if (items.length) this.elapsed = Math.max(0, Math.round(this.deps.now() - this.started));
    if (!loading) {
      this.live.delete(id);
      this.requests.delete(id);
    }
    this.notify();
  }

  private notify() {
    if (this.notifyQueued || this.disposed) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      if (!this.disposed) this.onChange(this.snapshot());
    });
  }

  private track(id: SectionId): RequestId {
    const r = this.deps.nextRequestId();
    this.requests.set(id, [...(this.requests.get(id) ?? []), r]);
    return r;
  }

  private async start(
    id: SectionId,
    gen: number,
    q: { text: string; line: number | null; col: number | null; req: SeRequest; limit: number },
  ) {
    const { text, limit, req } = q;
    try {
      switch (id) {
        case "recent": {
          const paths = await this.deps.recentFiles();
          const root = this.deps.root();
          const items = paths.slice(0, limit).map((p) =>
            fileItem({
              path: p,
              relPath: root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p,
              indices: [],
            }),
          );
          this.set(id, gen, items, paths.length > limit, false);
          break;
        }
        case "recentActions": {
          const byId = new Map(this.deps.actions().map((a) => [a.id, a]));
          const items = this.deps
            .recentActions()
            .map((aid) => byId.get(aid))
            .filter((a): a is Action => !!a && !a.hidden)
            .slice(0, limit)
            .map((a) => actionItem(a, this.deps.isEnabled(a)));
          this.set(id, gen, items, false, false);
          break;
        }
        case "files": {
          const scope = this.scopeFilter(req);
          const filter = req.filter;
          const keep =
            scope || filter
              ? (path: string) => (!scope || scope(path)) && (!filter || passesFilter(filter, path))
              : null;
          // Over-fetch so a narrowed scope still fills the section.
          const fetched = await this.deps.findFiles(text, keep ? limit * 4 + 1 : limit + 1);
          const matches = keep ? fetched.filter((m) => keep(m.path)) : fetched;
          this.set(
            id,
            gen,
            matches.slice(0, limit).map((m) => fileItem(m, q.line, q.col)),
            matches.length > limit,
            false,
          );
          break;
        }
        case "classes":
        case "symbols":
          await this.startSymbols(id, gen, text, limit, req);
          break;
        case "endpoints":
          await this.startEndpoints(id, gen, text, limit, req);
          break;
        case "actions": {
          const hits = matchActions(this.deps.actions(), text, {
            isEnabled: (a) => this.deps.isEnabled(a),
            recent: this.deps.recentActions(),
            includeDisabled: req.includeDisabled,
          });
          if (!this.deps.settings || !text) {
            this.set(id, gen, hits.slice(0, limit), hits.length > limit, false);
            break;
          }
          // Actions answer at once; settings follow when their index has loaded.
          this.set(id, gen, hits.slice(0, limit), hits.length > limit, true);
          const settings = matchSettings(await this.deps.settings().catch(() => []), text);
          const all = mergeActionResults(hits, settings);
          this.set(id, gen, all.slice(0, limit), all.length > limit, false);
          break;
        }
        case "text":
          await this.startText(id, gen, text, limit, req);
          break;
      }
    } catch {
      // Unavailable sources (no project, no index yet) simply contribute nothing.
      this.set(id, gen, [], false, false);
    }
  }

  /** Project endpoints by request path (`/menu/search`), ranked in memory. */
  private async startEndpoints(id: SectionId, gen: number, text: string, limit: number, req: SeRequest) {
    const routes = (await this.deps.routes?.().catch((): EndpointEntry[] => [])) ?? [];
    const { items, hasMore } = matchRoutes(routes, text, limit);
    const keep = this.scopeFilter(req);
    this.set(id, gen, keep ? items.filter((i) => keep(i.path)) : items, hasMore, false);
  }

  private async startSymbols(id: "classes" | "symbols", gen: number, text: string, limit: number, req: SeRequest) {
    const typesOnly = id === "classes";
    const opts = {
      root: this.deps.root(),
      includeNonProject: req.includeNonProject,
      typesOnly,
      excludeTypes: !typesOnly && req.tab === "all",
      limit,
    };
    const filter = req.filter;
    // Over-fetch in the All tab (types are filtered out of Symbols there) and under a filter.
    const fetch = filter ? limit * 4 + 1 : opts.excludeTypes ? limit * 2 + 1 : limit + 1;
    let index: SymbolMatch[] = [];
    let lsp: WorkspaceSymbol[] = [];
    let indexDone = false;
    let lspDone = !this.deps.workspaceSymbols;
    const keep = this.scopeFilter(req);
    const publish = () => {
      const merged = mergeSymbols(index, lsp, text, { ...opts, limit: filter ? fetch : limit });
      const passed = merged.items.filter(
        (i) => (!keep || keep(i.path)) && (!filter || passesFilter(filter, i.path, i.symbolKind)),
      );
      const items = filter ? passed.slice(0, limit) : passed;
      this.set(
        id,
        gen,
        items,
        merged.hasMore || index.length >= fetch || passed.length > items.length,
        !(indexDone && lspDone),
      );
    };
    const lspPromise = this.deps.workspaceSymbols
      ? this.deps
          .workspaceSymbols(this.track(id), text)
          .then((r) => {
            lsp = r;
          })
          .catch(() => {
            /* no language server / cancelled */
          })
          .finally(() => {
            lspDone = true;
            if (indexDone) publish();
          })
      : Promise.resolve();
    try {
      index = await this.deps.findSymbols(text, typesOnly ? "types" : "all", fetch);
    } catch {
      index = [];
    }
    indexDone = true;
    publish();
    await lspPromise;
  }

  /** Path filter of a root-based scope, or null when every project file counts. */
  private scopeFilter(req: SeRequest): ((path: string) => boolean) | null {
    const set = req.fileSet;
    const inSet = this.deps.inFileSet;
    if (!set || set === "all" || req.includeNonProject || !inSet) return null;
    return (path) => inSet(set, path);
  }

  private async startText(id: SectionId, gen: number, text: string, limit: number, req?: SeRequest) {
    if (text.length < TEXT_MIN_QUERY) {
      this.set(id, gen, [], false, false);
      return;
    }
    const items: SeItem[] = [];
    let hasMore = false;
    const request = this.track(id);
    const query: SearchQuery = {
      pattern: text,
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      include: req?.filter?.mask ? [req.filter.mask] : [],
      exclude: [],
      scope: req?.fileSet && req.fileSet !== "all" ? { kind: "fileSet", set: req.fileSet } : { kind: "project" },
      maxMatches: limit + 1,
    };
    await this.deps.searchText(request, query, (f) => {
      if (!this.isLive(id, gen) || hasMore) return;
      for (const t of textItems(f.path, f.relPath, f.matches)) {
        if (items.length >= limit) {
          hasMore = true;
          break;
        }
        items.push(t);
      }
      this.set(id, gen, [...items], hasMore, true);
    });
    this.set(id, gen, items, hasMore, false);
  }
}
