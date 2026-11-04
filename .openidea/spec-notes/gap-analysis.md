# OpenIDEA ↔ IntelliJ-IDEA reverse-engineered spec — exploration & gap analysis

Scope of this read: `spec/` (23 docs, esp. `00`, `01`, `02`, and §1/§5 of `03`–`20`) and the
OpenIDEA Rust 2024 + Tauri 2 codebase at `C:/Users/Lenovo/Desktop/aaa/`. Read-only on the repo;
no builds/tests run (parent runs the baseline). Paths below are repo-relative unless absolute.

**The single most important finding:** this is NOT a scaffold. It is a large, working IDE clone —
~40 `crates/ide-*` domain crates, a `src-tauri/src/commands/` adapter per domain, ~44 frontend
features each with `activate()`, `wit/` plugin ABI, `sdk/rust/openidea-plugin`, 14 official plugins,
33 Playwright specs, and per-language fixtures. `ide-lsp/src/lib.rs` alone is ~2941 lines,
`ide-vcs/src/lib.rs` ~1414, `ide-agent/src/lib.rs` ~1834. So almost nothing is "MISSING"; the real
gaps are **architectural/invariant divergences** from the spec, plus a few whole subsystems that
were deliberately re-designed (plugin ABI = Wasm instead of JAR/JVM, concurrency = async Rust
instead of a read/write lock permit model) or omitted (licensing/telemetry, browser remote form,
PSI stubs). Tickets must therefore *extend real subsystems*, not build them.

Classification rule used: **IMPLEMENTED** = the doc's user-visible capabilities are wired end-to-end
with concrete types (internal invariants may differ — noted); **PARTIAL** = a real subset exists but
named capabilities/invariants are absent; **MISSING** = no meaningful implementation.

---

## 1. Coverage matrix: spec `03`–`20`

| Doc | Verdict | Concrete pointers (crate/file → key types) | What is actually missing / different |
|---|---|---|---|
| **03** Runtime & concurrency | **PARTIAL** | `crates/ide-core` (`CancellationToken`, `RequestId`, `IdeEvent`/`EventSink`), `src-tauri/src/events.rs`, `src/platform/ipc.ts` (`nextRequestId`, `cancel_request`), `crates/ide-index` (`IndexStatus.indexing` = dumb mode), `ide-syntax` doc-comment ("IDEA's dumb-mode PSI"), `AGENTS.md` (`spawn_blocking`/rayon, honour `CancellationToken`) | No formal single-writer/multi-reader subsystem: no `acquireRead`/`acquireWriteIntent`/write-generation/permit-owner model, no thread-role enforcement, no lock-upgrade prohibition. Cancellation + backgrounding + dumb mode exist as *patterns*, enforced by convention (`AGENTS.md`) not by a container. INV-1..15 of §5 are not a subsystem. |
| **04** Virtual file system | **IMPLEMENTED** (caveats) | `crates/ide-vfs`: `lib.rs` (`read_dir`, `load_text`, `save_text`, `walk_files`, `LoadedText`, `LARGE_FILE_THRESHOLD`/`MAX_OPEN_SIZE`/`READ_ONLY_THRESHOLD`), `encoding.rs` (BOM/chardetng/properties escapes/`write_atomic`), `archive.rs` (`!<entry>` zip/jar paths), `watch.rs` (`Watcher`, debounced `FsBatch`, `.git` filtering), `rules.rs` (`GitignoreStack`, `ExcludeMatcher`), `ops.rs` (atomic rename/trash delete), `compare.rs` | Paths (`IpcPath`) are the identity, not a stable `VirtualFile` object — spec INV-1/INV-2 (one VF per physical file, id stable across rename, dead VF never revived) have no analogue. No unified tree mixing local+archive+remote+container FS families; remote FS (`ide-ssh`, `ide-remote`) is a separate SFTP/deploy surface. No content-level dedup. |
| **05** Document & editor | **IMPLEMENTED** (caveats) | `crates/ide-text/src/lib.rs` (`Document` ropey, `apply(base_version, ChangeSet)` → `OutOfSync`/stale, `apply_edits`, `ByteEdit` for incremental tree-sitter, UTF-16 coords, `LineEnding`), `crates/ide-workspace/src/documents.rs` (`Documents`, `TextSnapshot`), `src/editor/core/` (CodeMirror), plugin SDK `transform_selections`; e2e `editor.spec.ts`, `diff.spec.ts`, `mergeEditor.spec.ts`, `conflictMarkers.spec.ts` | Undo/redo is per-editor (CodeMirror) + bespoke file-move undo (`ide-workspace/file_moves.rs`); no cross-file single-undo-unit group (INV-10/11), no immutable-snapshot formal model, no formal client/server state split (§4.7). Multi-caret/folding/inlay hints exist via CodeMirror + `ide-syntax::ExternalFold` + LSP. |
| **06** Parsing & PSI | **PARTIAL** | `crates/ide-language` (`LanguageRegistry`, `LanguageConfig`, `Syntax`/`SyntaxCache`/`ParsedTree`, `queries/`, `plugin_point.rs`), `crates/ide-syntax/src/lib.rs` (`StructureService`: `node_at`, `expression_at`, `syntax_errors`, `locals`, `identifiers_named`, `structural_ranges`), `crates/ide-lsp` (full LSP client, 2941-line `LspManager`) | No PSI: no stub tree/index, no reference-contributor framework, no PSI-based reference resolution, no general language-injection model (only hard-coded Angular/JSP grammars), no dialects, no versioned trees. Semantic truth comes from tree-sitter + external LSP, not a platform-owned reference graph. |
| **07** Indexing & search | **IMPLEMENTED** (caveats) | `crates/ide-index/src/lib.rs` (`ProjectIndex`, persistent `store::Store` (redb), background `worker`, content-hash skip, `update(changed, removed)`, `languages_changed`, `set_scope`, `find_files`/`find_dirs`/`find_symbols` with CamelHump, `IndexStatus`, `mark_recent`, fingerprint invalidation), `crates/ide-search` (`SearchQuery`, ripgrep engine, `replace`/preview, file masks, `SearchContext`) | One bespoke file+symbol index, not the spec's pluggable index-kind registry / forward+input two-map consistency / shared cross-project indexes / WAL / generation-stamped query results. Regenerability is approximated by content-hash + fingerprint, not a versioned rebuild protocol. |
| **08** Analysis & inspections | **PARTIAL** | `crates/ide-analysis` (`find_duplicates` CPD, `search_structurally` SSR, `validate_structural`), `ide-lsp/src/inspect.rs` (`FileInspection`, `InspectOptions`), `src/platform/inspections.ts`, `localDiagnostics.ts`, `inspectionControls.ts`, `ide-spell`, `wit/io.wit::diagnostics.publish`, `src/features/analysis/` | No daemon analysis session/pass model with debounce + version binding; no first-party `LocalInspection` registry with severity/suppression (project/dir/file) and quick-fix/batch-fix; diagnostics are aggregated from LSP + plugin publishers, not a unified pipeline. §5 invariants (result bound to input version, cancel leaves no residue, batch fix idempotent) are not enforced centrally. |
| **09** Completion & navigation | **IMPLEMENTED** (caveats) | `ide-lsp` (`lsp_completion`, `lsp_inline_completion`, `lsp_resolve_completion`, signature help, definition/references/implementation/hierarchy), `wit/providers.wit` (plugin completion + inline + definition + line-markers), `ide-host/src/ops/nav.rs`, `src/features/search/` (Search Everywhere), `ide-index` recent files, `ide-syntax` outline, e2e `search.spec.ts`, `codeInsight.spec.ts` | No explicit `beginCompletion` session with per-contributor weighting vectors, "why no popup / why this order / slow source" observability (§9), no formal `documentVersion` binding on every candidate. Ranking is LSP `sortText` + `ide-index` fuzzy score. |
| **10** Refactoring & generation | **PARTIAL** | `src-tauri/src/commands/refactor.rs` + `ide-host/src/ops/refactor.rs` (`refactor_file_move_edits` = `workspace/willRenameFiles`, `refactor_move_files`, `refactor_undo_file_move`, `refactor_file_move_text_edits`, `WorkspaceEdit`), LSP rename/code actions, `src/features/templates/`, `wit` `[[contributes.fileTemplates]]`, e2e `hierarchyRefactor.spec.ts` | Only file-move refactoring is first-party; rename/extract/inline/change-signature are delegated to whatever LSP server is installed. No `RefactoringSession` state machine, no impact-set computation with conflict classification, no atomic all-or-nothing cross-file execution + preview, no "code still parses" check. |
| **11** Project model & build | **PARTIAL** | `crates/ide-build` (`BuildModel`, `MavenModel`/`GradleModel`, `sync_maven`/`sync_gradle`, `compile`, `dependency_coordinates`, `Omission`/conflict, `gradle_source_roots`), `crates/ide-workspace/src/roots.rs` (`ProjectRoots`, `SourceFolder`, `RootKind`), `dependencies/`, `crates/ide-sdk` (JDK/interpreter discovery), `src/features/{build-tools,build,libraries,dependencies}/` | No single immutable versioned "workspace model" as the one truth source (INV-1/2): roots, build model, dependencies, SDKs, run configs are parallel models assembled ad hoc. Model↔build-system two-way sync and dependency-conflict explainability are partial. |
| **12** Execution & debugging | **IMPLEMENTED** (caveats) | `crates/ide-run` (`RunConfig`/`RunExtras`, `ProcessManager`, `StartOptions`, `detect`, `.openidea/run.toml`, `.vscode`/JetBrains import, `emulate_terminal`, `target`), `crates/ide-dap` (`DebugManager`, `Breakpoint`/`FunctionBreakpoint`/`DataBreakpoint`, `StepKind`, `ExceptionFilter`, `HotSwapResult`, JDWP/kotlin/java-debug adapters), `crates/ide-coverage` (lcov/JaCoCo/Go cover), `crates/ide-profiler` (call tree), `ide-terminal` (PTY), e2e `run.spec.ts`, `debug.spec.ts` | Hot-swap only for `java-debug`; "run to cursor"/smart-step-in depend on adapter caps; execution-location abstraction is `RunExtras.target` (SSH) rather than the spec's first-class `ExecutionTarget`. Debugger↔VM decoupling is DAP-based (correct in spirit). |
| **13** UI architecture | **IMPLEMENTED** (caveats) | `src/platform/actions.ts` (`Action` registry, stable dotted ids, `when` clauses), `src/platform/keymaps/` (IntelliJ/VSCode/Eclipse maps), `src/platform/context.ts`, `src/workbench/contributions.ts` (tool windows, status items, overlays, editor kinds), `src/features/index.ts` (44 `activate()`s), `src/ui/`, `src/styles/tokens.css`, `src/platform/locales/text/{en,zh}.json` + `textCatalog.test.ts`, e2e `toolwindows.spec.ts`, `settings.spec.ts`, `themes.spec.ts` | No formal two-phase action registration / data-context derivation engine with uniqueness diagnostics; layout persistence & multi-instance tool windows are simpler. But the "everything is an action" invariant is genuinely implemented. |
| **14** Settings & persistence | **PARTIAL** | `crates/ide-workspace/src/settings.rs` (`SettingsStore`: defaults→global→project `.openidea/settings.toml` layered, `toml_edit` comment-preserving writes, `SettingsScope`), `ide-core/src/settings.rs`, `src/features/settings/`, `ide-extension/src/ledger.rs`, `ide-host/src/data_dirs.rs` (migration), `crates/ide-workspace/src/caches.rs` | No declared state units with schema version + migration chain, no per-key provenance query, no `perClient`/exportable registry-key model, no Settings Sync/import-export, no atomic temp+rename on the settings file itself, no enterprise force/override precedence. |
| **15** Plugin & extension model | **PARTIAL** (a **different, working** ABI) | `wit/*.wit` (`openidea:plugin@1.0.0`), `crates/ide-plugin` (`PluginEngine`, `Runtime`, `Actor`, `HostApi`, wasmtime component model + WASI p2, fuel/deadline/memory cap, per-plugin `Store`), `crates/ide-extension` (`Manifest`, `Capability`/`Risk`, `ExtensionPoint`/`ExtensionRegistry::prepare/commit`, `UiStore`, `ledger`, `package`), `ide-host/src/plugins/` (`PluginHost`, `points.rs::register_builtin_points`, `market.rs`, `install.rs`, `intellij.rs`), `plugins/README.md`, `sdk/rust/openidea-plugin`, `crates/ide-plugin/tests/fixtures/` | See §2. Genuinely implemented: sandboxed plugins, declarative contribution points, activation events, capability grants + ledger, dynamic enable/disable + idle reclaim + grant revocation, marketplace index, project plugins, all-or-nothing contribution commit. What is absent is *everything IntelliJ-specific*: JAR/`plugin.xml` descriptors, 3235 named EPs, application/project/module services, per-plugin classloaders with parent graph/visibility/shadowing, dependency-topology solving, `ExclusionReason`, restart-required flags, JVM 25. |
| **16** Licensing & distribution | **MISSING** (core) | Only adjacent pieces: `src/features/app/__tests__/updates.test.ts` (Tauri auto-update), `ide-host/src/plugins/market.rs` (marketplace index), `crates/ide-build/src/application_update.rs` (this is *build resource processing*, not app update), `.github/workflows/release.yml`, `ide-host/src/plugins/intellij.rs` (theme import), `crates/ide-workspace/src/caches.rs` | No product identity/build-number gating, no license/activation/trial/evaluation, no feature-tier capability shrinking, no telemetry with consent+allowlist+egress declaration, no offline activation, no crash-report redaction, no atomic install-tree replacement. §5 INV-1..13 are entirely unimplemented. An open-source IDE has no commercial licensing layer — this is a real, honest gap. |
| **17** Remote development | **PARTIAL** | `crates/ide-host/src/rpc.rs` (`Peer`, `Invoke`, `ChannelMessage`, `EventMessage`, `ServerInfo`), `crates/ide-host/src/bin/server.rs` (`openidea-server`), `crates/ide-host/src/plugins/{remote.rs,remote_host.rs}`, `src-tauri/src/remote_dev.rs` (`Connection`, `remote_bootstrap_list`, `remote_invoke`, per-version `~/.openidea/server/<version>` install over SSH), `src/features/remote-dev/`, `src/platform/remote.ts`, `crates/ide-remote` (SFTP deploy + run targets), CI `server` job (linux musl static binary), `pnpm smoke ... openidea-server` | No browser/Web form (spec §4.7), no `resumeToken`/epoch/generation entity versioning, no client-generated idempotency keys, no capability negotiation + rejection list, no offline input buffering / incremental patch replay, no port-forward whitelist enforcement, no session-level structured events. Reconnect is a re-connect, not a consistent-state resume. |
| **18** VCS integration | **IMPLEMENTED** (caveats) | `crates/ide-vcs/src/lib.rs` ~1414 lines: `ChangeKind`/`FileStatus`, `BranchInfo`, `LineHunk`, `BlameLine`, `BlockHistory`, `Commit`/`LogQuery`/`LogOrder`, `CommitOptions`/`PartialCommitFile` (partial commit via temp index), `shelf.rs`, `changelists.rs`, `diff.rs`, `blame.rs`, `remotes.rs`, `ignore.rs`, `index_writes.rs`; reads via `gix` in-process, writes shell out to `git` for hooks/signing; `ide-github`, `src/features/vcs/`, e2e `commit.spec.ts`, `gitIgnore.spec.ts`, `diff-navigation.spec.ts` | No pluggable VCS abstraction layer (it is Git-only, despite IDEA being VCS-agnostic), no merge-request review UI beyond `ide-github`, no three-way conflict resolver beyond editor conflict markers (`conflictMarkers.spec.ts`). |
| **19** Database & data tools | **IMPLEMENTED** (caveats) | `crates/ide-db/src/lib.rs` (`DbManager`, `DataSource`/`DbDriver`/`DbSsh`/`DbSslMode`, `Pool`/`QueryResult`, `CompletionModel` for SQL completion, `TablePage`/`DbRowEdit`, `plan.rs`/`PlanNode`, `history.rs`, `split.rs`, SSH tunnels, SQLite/Postgres/MySQL/ClickHouse, `tiberius` for MSSQL), `src/features/database/`, `graphql/`, e2e `clickhouse-source.spec.ts` | No L1/L2/L3 introspection levels, no interceptor-chain conflict resolution, no extensible JDBC-driver registry; drivers are compiled-in. Data-grid editing + generated change statements exist. |
| **20** AI & integrations | **PARTIAL** | `crates/ide-agent` (ACP client: Claude/Codex/Gemini over newline JSON-RPC, `AgentManager`, worktrees, timeline, permissions, `session/load` resume, provider registry), `ide-lsp`, `ide-dap`, `ide-terminal`, `ide-http` (`.http` client + env + history), `ide-docker`, `plugins/official/ai-completion` (inline completion over `net`), `wit/io.wit::net`, `src/features/{agents,http-client,deployment}/`, e2e `agentsDock.spec.ts`, `agentMarkdown.spec.ts` | No **Tool Server** (IDE exposing its own capabilities as MCP/ACP *server* tools) — the IDE is only an ACP *client*. No context-provider budget/dedup/redaction framework, no unified "all external integrations declare data-egress + kill switch" enforcement, no integrated model-proxy. |

Not separately classified (out of `03`–`20`): `00` (92 user stories, decisions), `01` (capability map),
`02` (module graph / service container / startup phases — **PARTIAL**: no DAG module container, no
service container with `required`/`optional` resolution, no 4 named startup phases; there is a
`Host` + `Project` assembly and a `Startup` timing struct), `21` (test strategy — see §3), `22` (evidence).

---

## 2. Plugin ABI analysis

**What exists today.** A plugin is a **Wasm component** (wasmtime, component model, WASI preview 2),
described by `plugin.toml` (`wasm`, `activation`, `[capabilities]`, `[[contributes.*]]`). Package:
`plugins/official/*/` (14), SDK `sdk/rust/openidea-plugin/` (`Plugin` trait, `register_plugin!`, mock
host), CLI `openidea-plugin` (`ide-host/src/bin/openidea-plugin/`), fixtures
`crates/ide-plugin/tests/fixtures/{hello,jobs,language-toy,misbehave}/`, docs `plugins/README.md`.

- **Worlds** (`wit/plugin.wit`): `plugin` (imports `log, ui, storage, workspace, editor, invocation,
  vcs, events, tasks, diagnostics, net, secrets, process, views, settings`; exports `lifecycle,
  commands, event-handler`), `plugin-syntax` (+`syntax-provider`), `plugin-providers` (+`providers`),
  `plugin-views` (+`view-provider`), plus `syntax`/`editor-providers`/`views-provider`.
- **Host functions** (WIT imports): `log.log`; `ui.show-notification|set-status-item|remove-status-item`;
  `storage.get|set|delete|keys`; `workspace.project.root|read-file|find-files`, `workspace.projects`;
  `editor.text-editor.path|language|document|selections|apply-edits`; `invocation.project|editor`;
  `vcs.status|fetch`; `events.subscribe|unsubscribe` + 7 event kinds; `tasks.begin` →
  `task.report|is-cancelled`; `diagnostics.publish`; `net.fetch`; `secrets.is-set`; `process.run`;
  `views.refresh|post-message|open-terminal`; `settings.get`. Coordinates: 0-based lines, **UTF-16**
  columns (`wit/types.wit`), matching `AGENTS.md`. Errors: `denied|stale|not-found|invalid|cancelled|failed`.
- **Guest exports**: `lifecycle.activate|deactivate`, `commands.run`, `event-handler.handle`,
  `syntax-provider.highlights|outline|folding`, `providers.completion|inline-completion|code-actions|
  resolve-code-action|definition|line-markers`, `view-provider.render|handle`.
- **Contribution points** (15, `ide-host/src/plugins/points.rs::register_builtin_points` +
  `plugins/README.md`): `commands`, `themes`, `iconThemes`, `languages`, `runDetectors`, `providers`,
  `secrets`, `menus`, `keymaps`, `statusBar`, `settings`, `views`, `customEditors`, `fileIcons`,
  `fileTemplates`. 7 activation events; ~14 capability classes incl. `process:<program>` (pinned by
  absolute path + content hash, re-checked each run) and `net:<host>`.
- **Lifecycle/registry**: `ExtensionRegistry::prepare` (validate, no side effects) → `commit`
  (all-or-nothing) → withdraw per plugin; `UiStore`/`UiPoint` client projection; grant `ledger`;
  `PluginHost` in `ide-host/src/plugins/mod.rs`; dynamic enable/disable, idle reclaim (5 min),
  project plugins, marketplace index. `ide-plugin` gives each plugin its own `Store`, `Actor` thread,
  fuel budget, deadline, linear-memory cap; a trap poisons only that instance.

**What "compatible with IntelliJ's plugin ecosystem" would concretely require.** IntelliJ plugins are
**JAR archives** with `META-INF/plugin.xml` declaring: `<id>/<name>/<version>/<vendor>`,
`<idea-version since-build/until-build>`, `<depends>` (plugin/module, optional + config-file),
`<incompatibleWith>`, `<content>`/content modules with `loadingRule` (required/embedded/optional/
onDemand) and `visibility` (public/internal/private), `<extensions>`/`<extensionPoints>` with
`area`, `dynamic`, `beanClass`, `<with attribute="…" implements="…">`, `applicationService`/
`projectService`/`moduleService` with `testServiceImplementation`/`headlessImplementation`/
`overrides`/`open`/`preload`/`client`/`os`, `<actions>`/`<groups>`, and the whole
`com.intellij.openapi.*` + PSI + VFS API surface. Runtime: **JBR 25 / Java 25**, per-plugin
**classloaders** with a parent graph, package-prefix resolve scopes, shadowing, visibility
enforcement, dynamic unload with no leaked strong references, 4 named startup phases, 3235 EPs /
29282 registrations, 2187 app + 1165 project services. That is, reimplementing the IntelliJ
**Platform** and embedding a JVM.

**Honest assessment:** full compatibility is **not achievable** — not in this session, and not by any
small extension of the current design. The two ABIs are categorically different (Wasm sandboxed
capability grants vs. JVM in-process classloader extensions); there is no JVM in the process, no
`plugin.xml` descriptor loader for code, and no IntelliJ API. The **only** existing JAR touchpoint is
`ide-host/src/plugins/intellij.rs`, which reads `META-INF/plugin.xml` + `.theme.json` + `.icls` from a
Marketplace `.jar`/`.zip`/installed IDE purely to **import themes** (`PLUGIN_XML` = `META-INF/plugin.xml`,
`quick_xml`), rendered via `src/features/plugins/intellijTheme.ts`. It converts nothing else.

**Achievable subset (honest, valuable):**
1. **Declarative import** of data-only contributions from IntelliJ descriptors: themes (done), icon
   themes, file types/extensions, live templates, keymaps, `<actions>` metadata → OpenIDEA
   `commands`/`menus`/`keymaps` points. No bytecode runs.
2. A **read-only compatibility advisor**: parse `plugin.xml` (`<depends>`, `<idea-version>`,
   `<extensionPoints>`, `<extensions>`, `<actions>`, `<services>`) and produce a structured report
   mapping each declared EP to the nearest OpenIDEA `[[contributes.*]]` / WIT host function, listing
   unsupported ones with reasons (grounded in spec 15 `ExclusionReason`). Surfaced as a
   "Check IntelliJ plugin compatibility" view + `openidea-plugin` subcommand.
3. Expose a **small, stable set** of new WIT host functions mirroring commonly-used declarative EPs
   (inspections, refactorings, file-type/parser registration) so third-party plugins can fill the
   gaps in §1 without platform forks.
4. Never claim to run IntelliJ bytecode; document the boundary in `plugins/README.md`.

---

## 3. Testing & build conventions; toolchain mismatch

- **Rust tests**: inline `#[cfg(test)] mod tests` in nearly every module (e.g.
  `ide-vfs/src/{archive,bytes,compare,encoding,lib,rules,watch}.rs`, `ide-build/src/lib.rs`) plus
  `crates/<name>/tests/*.rs` integration suites (`ide-vfs/tests/vfs.rs`,
  `ide-vcs/tests/{repo,git_workflows,history_ops,ignore,block_history,log_shape,log_projection}.rs`,
  `ide-workspace/tests/{documents,workspace_edits,file_operations}.rs`,
  `ide-search/tests/{search,replace}.rs`, `ide-run/tests/*`, `ide-db/tests/*`, `ide-ssh/tests/session.rs`,
  `ide-remote/tests/{local,remote}.rs`). Test deps in root `Cargo.toml`: `insta` (yaml snapshots),
  `proptest`, `tempfile`. `ide-host/tests/language_smoke` runs ignored per-language with the real
  server installed (`cargo test -p ide-host --test language_smoke -- --ignored --exact <lang>`).
  `src-tauri/tests/export_bindings.rs` regenerates `src/bindings.ts` (tauri-specta).
  SDK tests: `sdk/rust/openidea-plugin/tests/{api_frozen,wit_coverage}.rs` (the latter statically
  asserts every WIT import has an SDK wrapper + mock-host mirror). Plugin fixtures with checked-in
  `dist/plugin.wasm`.
- **Frontend tests**: `pnpm test` (vitest, colocated `*.test.ts(x)`), `pnpm e2e` (Playwright,
  `e2e/*.spec.ts` — 33 specs), `textCatalog.test.ts` enforces every string in `en.json`+`zh.json`.
  `fixtures/` holds per-language sample projects (`ts-app`, `rust-app`, `python-app`, `java-app`,
  `kotlin-gradle`, `polyglot`) for smoke + manual tests; `pnpm smoke smoke/run.test.ts -t <lang>`
  exercises run store + a real `openidea-server`.
- **CI** (`.github/workflows/ci.yml`): `rust` (matrix macos/ubuntu/windows: `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace
  --no-fail-fast`, `git diff --exit-code src/bindings.ts`); `server` (musl build of
  `openidea-server`); `plugins` (per-crate `cargo fmt`/`clippy` for host **and** `wasm32-wasip2`,
  `cargo test`, `plugins/build.sh --check`); `deny` (`cargo deny check`); `frontend`
  (`typecheck`, `lint`, `format:check`, `knip`, `test`, `build`); `e2e` (Playwright container
  `mcr.microsoft.com/playwright:v1.64.1-noble`). Extra workflows: `language-smoke.yml`,
  `release.yml`, `plugins-index.yml`, `pr-check.yml` (requires a `## How it was verified` section).
- **Commands**: `pnpm tauri dev` / `pnpm dev:app` (Node 22.18+, pnpm 11), `pnpm build`
  (`tsc --noEmit && vite build`), `pnpm gen:bindings`, `cargo fmt --all`, `cargo clippy --workspace
  --all-targets -- -D warnings`, `cargo nextest run --workspace`, `cargo build -p ide-host --bin
  openidea-server`. Plugin crates are **excluded** from the root workspace (`exclude = ["sdk",
  "plugins"]`) and build for `wasm32-wasip2` in their own workspaces.
- **⚠ Toolchain mismatch (real blocker for the baseline)**: root `Cargo.toml`
  `[workspace.package]` declares `edition = "2024"`, `resolver = "3"`, **`rust-version = "1.96"`**.
  The installed toolchain is `C:/Users/Lenovo/.rustup/toolchains/1.95-x86_64-pc-windows-msvc/bin/cargo.exe`
  (**rustc 1.95**). There is **no `rust-toolchain.toml`** anywhere in the repo (verified by glob), and
  CI uses `dtolnay/rust-toolchain@stable` (unpinned). `cargo` gates on `rust-version`: with 1.95
  active it will refuse the workspace ("package requires rustc 1.96"). `edition 2024`/`resolver 3`
  themselves are fine on 1.95 (need ≥1.85). **Additional finding**: `C:/Users/Lenovo/Desktop/aaa_notes/cargo.bat`
  (a shim already present in the notes dir) calls `vcvars64.bat` and prepends a **nightly-2026-07-28**
  toolchain to PATH — i.e. the intended way to build here is via that shim/nightly, not the 1.95
  stable. Fix options: (a) use/activate a ≥1.96 toolchain (that nightly satisfies it), or
  (b) lower `rust-version` to `"1.95"` **only if** no 1.96-only features are used (not verified —
  no build run, per instructions), and add a `rust-toolchain.toml` pin so local/CI agree. This must be
  resolved before any ticket compiles; the parent's baseline likely hits this.

---

## 4. Proposed ticket DAG (13 tickets)

All tickets are **blocked-by T1** (workspace must compile). Only intra-DAG deps are listed per row.
Every ticket is one focused PR with a test, targeting existing crates — no greenfield platform.

| ID | Title | Deliverable (real, user-visible) | Target crates/files | Blocked-by | Blocks |
|---|---|---|---|---|---|
| **T1** | Reconcile `rust-version` with the installed toolchain | Workspace builds on rustc 1.95 locally and in CI; add `rust-toolchain.toml` (or lower `rust-version` to 1.95 after a `cargo check` proves no 1.96 features); document in `AGENTS.md` | `Cargo.toml`, `rust-toolchain.toml`, `AGENTS.md`, `.github/workflows/ci.yml` | — | T2–T12 |
| **T2** | Generation-bound cancellable job primitive (`S2` seam utility) | `ide_core::Generation<T>` + `JobHandle`: any background result tagged with the (doc, version, epoch) it was computed from; stale results dropped at the boundary, cancellation leaves no residue. Unit + proptest. Reusable by analysis/index/completion/remote | `crates/ide-core/src/{task,ids}.rs`, `crates/ide-host/src/requests.rs`, `src/platform/ipc.ts` | T1 | T3, T5, T6, T11 |
| **T3** | Daemon analysis scheduler (docs 03/08) | Debounced, cancellable re-analysis on edit: `requestAnalysis(file, version, reason)` runs duplicate/structural/external-linter passes on rayon/`spawn_blocking`, publishes only results matching the current doc version. User sees stale squiggles vanish immediately after typing | `crates/ide-analysis/src/`, `crates/ide-host/src/ops/analysis.rs`, `src/features/analysis/` | T2 | T4 |
| **T4** | First-party inspection registry + quick fixes + suppression (doc 08) | `LocalInspection` trait with severity, per-rule project/dir/file suppression, and a unified **Problems** view merging LSP + plugin + first-party diagnostics with "Fix all" (idempotent batch fix). `inspection_settings.rs` already exists in `ide-core` | `crates/ide-analysis`, `crates/ide-core/src/inspection_settings.rs`, `ide-host/src/ops/analysis.rs`, `src/features/analysis/`, `src/platform/inspections.ts` | T3 | T8 |
| **T5** | Completion session with provenance + version binding (doc 09 §9/§5) | One `beginCompletion` session merges LSP + plugin provider candidates, tags each with `sourceId` + timing, drops stale-version results, and exposes a "why no popup / why this order" diagnostic. Prevents ghost insertions after fast typing | `ide-host/src/ops/lsp.rs`, `ide-host/src/plugins/providers.rs`, `src/editor/lsp/`, `src/features/code-insight/` | T2 | — |
| **T6** | Reference/declaration fallback for dumb mode (docs 06/07) | `ide-syntax` builds a lightweight identifier→declaration graph for grammars with `locals.scm`, so Find Usages / Go to Declaration work when no LSP is installed or while indexing (dumb mode). Routed via `ide-host/src/ops/nav.rs` | `crates/ide-syntax/src/{locals,identifiers,nodes}.rs`, `crates/ide-index/src/worker.rs`, `ide-host/src/ops/nav.rs` | T2 | T7a |
| **T7a** | `RefactoringSession` core: impact set + conflicts + atomic apply (doc 10) | `beginRefactoring` collects usages (LSP `references`/`rename` + T6 fallback), classifies conflicts (unloaded/binary/modified), produces one `WorkspaceEdit` applied as a single undoable transaction with post-condition re-parse. Backend only | `ide-host/src/ops/refactor.rs`, `crates/ide-workspace/src/{documents,file_moves}.rs`, `crates/ide-text/src/lib.rs` | T2, T6 | T7b, T8 |
| **T7b** | Refactoring preview UI | "Refactor Preview" tool window: impact tree grouped by file, conflict list, "Do Refactor" applying T7a atomically; one Ctrl+Z reverts the whole change. Extends `hierarchyRefactor.spec.ts` | `src/features/code-insight/` (or new `features/refactor/`), `src/workbench/contributions.ts`, `e2e/hierarchyRefactor.spec.ts` | T7a | — |
| **T8** | WIT/extension points for inspections & refactorings (doc 15/10) | New contribution points `[[contributes.inspections]]`, `[[contributes.refactorings]]` + WIT host functions, so plugins can supply first-party inspections/refactorings through T4/T7a. Includes `wit_coverage.rs` + `api_frozen.rs` updates | `wit/*.wit`, `crates/ide-extension/src/{point,registry}.rs`, `ide-host/src/plugins/points.rs`, `sdk/rust/openidea-plugin/src/`, a fixture plugin | T4, T7a | T9 |
| **T9** | IntelliJ `plugin.xml` compatibility advisor (honest subset) | Extend `ide-host/src/plugins/intellij.rs` to parse `<depends>`, `<idea-version>`, `<extensionPoints>`, `<extensions>`, `<actions>`, `<services>` and produce a structured report mapping each declared EP → nearest OpenIDEA contribution/host function, listing unsupported ones. New "Check IntelliJ plugin" view + `openidea-plugin compat <path>` CLI. Read-only; never runs bytecode | `ide-host/src/plugins/intellij.rs`, `src/features/plugins/`, `ide-host/src/bin/openidea-plugin/main.rs`, `plugins/README.md` | T8 | — |
| **T10** | Feature gates + telemetry/egress kill switch + safe mode (docs 16/20/01 D5) | Achievable subset of 16: an app-level `FeatureGate` (capability set from build + user toggles), a Settings → "Data & Privacy" page declaring egress per integration with a global off switch (INV-8/9/12, editing unaffected), and "Safe mode" startup disabling all third-party plugins. **Not** license/activation | `crates/ide-core/src/settings.rs`, `crates/ide-workspace/src/settings.rs`, `src/features/{settings,app}/`, `ide-host/src/plugins/mod.rs`, `src-tauri/src/state.rs` | T1 | — |
| **T11** | Remote session resume & consistency (doc 17) | Add `resumeToken` + epoch/generation to `rpc.rs` entities, client-generated idempotency keys for change requests, and offline input buffering on the client; reconnect replays incremental patches and shows a consistent view (no duplicate edits). No browser/Web form | `crates/ide-host/src/rpc.rs`, `src-tauri/src/remote_dev.rs`, `src/features/remote-dev/`, `src/platform/remote.ts`, `e2e/` | T2 | — |
| **T12** | Settings schema version, atomic write, provenance, export/import (doc 14) | `settings.toml` gains a schema `version` + migration chain; writes use temp+rename; a `resolvedFrom(key)` query reports defaults→global→project origin; `exportSettings`/`importSettings` commands. Corrupt write no longer loses all settings | `crates/ide-workspace/src/settings.rs`, `crates/ide-core/src/settings.rs`, `src/features/settings/`, `src-tauri/src/commands/` | T1 | — |

```
T1 ─┬───────────────────────────────────────────────────► (all)
    └─► T2 ─┬─► T3 ─► T4 ──────────┬
            ├─► T5                  ├─► T8 ─► T9
            ├─► T6 ─► T7a ─┬─► T7b ┘
            └─► T11                    │
    └─► T10 ,  T12                 ┘ (T2 also blocks T7a)
```

**Recommended first slice** (highest spec alignment, lowest risk): T1 → T2 → T3 → T4, plus T9. `00`
§Testing Decisions names **S2 (document↔file↔syntax tree)** as "the only recommended default seam";
T2/T3/T4 are exactly that seam and directly close the docs 03/08 PARTIAL gaps. T9 is the honest,
high-visibility answer to "IntelliJ plugin compatibility" without pretending to embed a JVM.

---

## 5. Realistic scope — what can and cannot be delivered

**The spec is a description of a whole commercial IDE**, reverse-engineered from IU-262.8665.337
(2090 modules, 3235 extension points, 29282 registrations, 163 bundled plugins, Java 25/JBR).
`00-spec.md` states explicitly it "描述的是对既有系统逆向得到的设计，**而非待开发功能清单**".
Do not let a ticket list imply "all functions covered". §3 of this file counts 92 user stories across
9 groups; the codebase already covers most of them at some level, but the *design contracts* (every
§5 invariant table) are a different, much larger body of work than the user-visible features.

**Can be delivered by an agent team in one session** (with tests, grounded in existing crates):
1. **T1** — the toolchain fix (unblocks everything; small).
2. **T2/T3/T4** — a version-bound, cancellable analysis pipeline + unified Problems view with
   suppression and batch fix. This is a coherent, ~3-PR slice on the spec's own recommended seam.
3. **T5** — completion version-binding/provenance (small, mostly wiring).
4. **T9** — the read-only IntelliJ `plugin.xml` compatibility advisor (extends existing `intellij.rs`).
5. Optionally **one** of T6/T7a/T11/T12, each a focused backend extension with an integration test.
Realistically: **4–6 of the 13 tickets**, each a reviewable PR, is the honest ceiling for one session;
the DAG is designed so the rest remain independently implementable later.

**Cannot be delivered in this session (and should not be attempted as "tickets"):**
- **Full IntelliJ plugin compatibility / JAR execution.** Requires embedding a JVM (JBR 25),
  reimplementing `com.intellij.openapi.*` + PSI + VFS, per-plugin classloaders with visibility/
  shadowing/parent graphs, and 3235 EPs. Multi-year, categorically different ABI. Only the
  declarative-import + compatibility-advisor subset (T9) is realistic.
- **The spec's service container / module graph / 4 startup phases** (doc 02): 2090-node DAG,
  lazy `required`/`optional` service resolution, `test/headless/overrides/preload/client/os` service
  dimensions, generation-cached extension resolution with topological ordering. OpenIDEA assembles a
  `Host`/`Project` directly; replacing this with a container is a rewrite, not a feature.
- **The formal concurrency model** (doc 03 §5, 15 invariants): read/write permits, write-intent,
  write generations, permit-owner enforcement, lock-upgrade prohibition, message-bus delivery
  guarantees. Rust's ownership + async/tokio already prevents most of the *bugs* those invariants
  target, but the spec's diagnostic/observability surface does not exist.
- **PSI stubs, reference graph, language injection, versioned trees** (doc 06) as a general
  framework; **shared/generational indexes** (doc 07); the **full refactoring state machine** (doc 10)
  for all languages — these need per-language semantic engines that the spec itself declares
  out-of-scope ("具体语言的语法、类型系统与语义规则设计").
- **Licensing, activation, trials, feature tiers, signed update trees, crash-report redaction**
  (doc 16) — no commercial layer exists; only the honest T10 subset is sensible for an OSS IDE.
- **Browser/Web remote form** (doc 17 §4.7), full capability negotiation, port-forward whitelisting,
  and cross-process single-writer consistency — `openidea-server` + `remote_dev.rs` is a desktop
  thin-client, not a browser frontend.
- **All 92 user stories end-to-end** with the §5 invariant guarantees and doc 21's four test levels /
  five seams / concurrency contracts. The existing 33 e2e specs + per-crate Rust tests are strong but
  are not the recorded/replay protocol tests (S5) or the contract-per-EP tests (S1) that doc 21 asks for.

**Bottom line for the parent:** treat the spec as a *quality/contract bar* for the subsystems that
already exist, not as a build list. Prioritize invariant-grounded slices (S2 seam) and the honest
plugin-compat advisor; explicitly descope JAR compatibility, licensing, browser remote, and the
module/service container. Any plan claiming otherwise is not grounded in this codebase.
