# Vue/TS/JS/HTML 项目索引 — 实施方案（定稿 v4，可交付开发）

状态：四轮复查闭环（Q1–Q12 决策、H1–H5 自查、E1–E7 对抗复查、E8–E11 执行流推演），
**语法树 kind 表已 dump 实测（§17）**。开工前置仅剩：M0 spike 三个闸门数字（需项目路径）。
目标场景：以 Vue/TS/JS/HTML 为主力栈替代 WebStorm。开发上手见 §16。

## 0. 问题

语义跳转完全外包给 LSP（vtsls/vue-language-server 等）：服务器未装/未启动完/超时 → 退化成文本搜索。
`.vue` 文件是索引盲区：`ide-language` 把 vue 映射到 HTML 语法树（`syntax/mod.rs` `web_grammar`），
只提取 CSS class/id；`<script>` 里的 TS 代码零符号、零作用域、兜底直接返回空。
自建索引（`ide-index`）只有文件名 + 顶层符号名，无引用表。

## 1. 范围

**做**：workspace 内 `.ts/.tsx/.js/.jsx/.mts/.cts/.vue/.html` 的符号级跳转与查找用法
（LSP 不可用/未就绪时的可靠地板）；`.vue` 组件进 ⌘O；`<MyComp>` 标签跳转（含 unplugin 免 import 兜底）；
组件 Find Usages（模板标签 + import 语句）；⌘-hover 探测先查索引。

**不做**（命名在案）：Vue 模板表达式 `{{ }}`/`:prop`、HTML 内联 `onclick`、node_modules、
rename 兜底、CJS（`require`/`module.exports`）、`#` 子路径 import、动态 `import()` glob 形态、
`.vue` 的 Structure 工具窗口升级（⌘O/搜索已覆盖；结构视图属前端 structure 服务，另立后续）、
vite.config.ts 专属 alias（tsconfig 优先，需要时补）。

## 2. 架构（无新 crate，全部嵌入现有层）

```
ide-core     paths.rs（resolve_spec/alias 纯函数；E3 修订，jsonc.rs 旁）
ide-language syntax/sfc.rs（<script> 区域，pub）+ syntax/modules.rs（import/export/声明事实，pub）
ide-workspace roots/tsconfig.rs（项目根定位薄封装；纯函数在 ide-core）
ide-index     worker 提取阶段 + FileRecord.facts + 查询期模块图解析
ide-host      ops/nav.rs：index_goto / index_usages + IndexGoto/IndexNote 类型（WebGoto 同居惯例）
前端          navigation.ts / syntaxUsages.ts 兜底链接线 + 索引状态检查（E6）
```

关键决策：

- **查询期解析，不预建图**：import 边在查询时现场解析（相对路径/别名 → 扩展名补全 → 目标文件事实），
  无级联失效问题；tsconfig 每次查询现读（几 KB JSON，~1ms，不缓存）。
- **索引是地板+快路径，LSP 是主答案**（D3 阶段一）；M3 一致率 ≥90% 才翻转优先级。
- **所有索引答案带置信度**（certain/candidate），UI 标注 "based on project index"，不冒充语义引擎。
- **纯增量**：LSP 主路径零改动；每个 PR 独立可回退；索引无消费者时无害。

## 3. 已核实地基（全部现成，零新增顶层依赖）

| 设施                      | 位置                                                                                 | 复用方式              |
| ------------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| TS/TSX/JS 语法树          | `ide-language`（tree-sitter-typescript 0.23.2 / javascript 0.25.0）                  | 解析器                |
| `<style>` 区域提取先例    | `ide-language/src/syntax/web.rs` `css_regions`                                       | `<script>` 照抄此模式 |
| HTML 树对 vue 的映射      | `syntax/mod.rs` `web_grammar`（vue/svelte/jsp→html）                                 | 区域提取入口          |
| JSONC 解析                | `ide-core/src/jsonc.rs` `strip`（doc 注释明说为 tsconfig.json 服务）                 | tsconfig 读取         |
| 字节↔UTF-16 转换          | `ide-language` 内部（web.rs 产出 `SymbolTag` 带 Range，转换必然存在）                | 坐标换算              |
| 作用域分析                | `ide-syntax` `StructureService::locals` + `Snapshot::text`（pub）                    | .vue script 局部变量  |
| 索引 worker               | `ide-index/src/worker.rs` `extract()`（blake3 增量、2MB 上限、watcher 喂 Job）       | 加一级提取            |
| 持久化                    | `ide-index/src/store.rs`（postcard + redb，SCHEMA stamp 触发重建）                   | FileRecord 扩展       |
| 「语法+索引」组合跳转先例 | `ide-host/src/ops/nav.rs` `web_goto`（blocking + snapshot + 活文档优先）             | index_goto 照抄       |
| 命令注册链                | ops `d.add` → `src-tauri/commands/nav.rs` → `pnpm gen:bindings`                      | 新命令                |
| 符号种类                  | `ide-core` `SymbolKind`（Class/Function/Variable/Constant/TypeAlias/Interface 全有） | 组件用 Class          |

## 4. M0 — spike（**已完成 2026-11-05，TS 侧三闸门全过，PR-1 解锁**）

实测（独立 spike 项目，语料=本仓库 `src/`：1654 个 TS/TSX 文件、12.3MB，release 构建）：

| 闸门            | 实测                                                              | 判定        |
| --------------- | ----------------------------------------------------------------- | ----------- |
| 全量索引 <30s   | **4.38s**（单线程；worker 是 rayon 并行，实际更快）               | ✅ 7× 余量  |
| 内存 <500MB     | **17MB**（663,399 出现 × 24B + 23,338 名字表 ≈ 1.1MB）            | ✅ 30× 余量 |
| 抽取成功率 ≥95% | **99.9%**（tree-walk 18,089 vs 行级真值 18,112 条 import/export） | ✅          |

`.vue` 机制验证（合成 SFC 语料）：script setup `lang="ts"`、options API（plain js script）、
`.html` 内嵌 module script 全部正确提取（区域数、import/export 计数全对）。

**M0 发现（并入 PR-1）**：

1. **语法局限（不阻塞）**：`f<typeof import("./x")>()`（vitest `vi.mock` 惯用法）在
   tree-sitter-typescript 0.23.2 产生 ERROR 节点——162/1654 文件受影响（全是测试文件），
   但 tree-sitter 容错恢复，import/export 提取不受影响（99.9% 达标）。
   `satisfies`/`const` 类型参数/`using`/装饰器/箭头泛型/模板字面量类型全部正常。
   后续升级语法版本可消；`export =`/`declare module` 在语料中出现 1 次，正常。
2. **script 跳过规则修正**：除 `lang` 属性外必须检查 `type` 属性——
   `type="application/json"`/`text/template`/`importmap` 等跳过（spike 原型只查 `lang`，
   JSON script 被误计入）。PR-1 的 sfc.rs 规则：无 `type` 属性，或 `type` 为
   `module`/`text/javascript`/`application/javascript` 才提取。

待补（不阻塞 PR-1）：用户真实 Vue 项目的 .vue 规模实测 + vtsls 跳转质量基线（需项目路径；
TS 语料 7×/30× 余量下，.vue 规模确认属复核性质）。

**闸门判定：通过。PR-1 开工。**

## 5. PR-1 — 提取层（`ide-language`，纯函数，约 700 行含测试）

### 5.1 `src/syntax/sfc.rs`

```rust
pub(crate) struct ScriptRegion {
    pub base: usize,            // 区域起点在外层文档的字节偏移
    pub language: LanguageId,   // typescript | tsx | javascript（lang 属性决定）
    pub text: String,           // 脚本文本（owned）
}
/// .vue/.html 的 <script> 区域；照抄 web.rs css_regions 的 walk + raw_text 模式。
/// 注意：必须以 `Syntax::script_regions` 公开（非 pub(crate)）——ide-host 的
/// index_goto 要用区域文本构造 Snapshot（E7）。
pub fn script_regions(g: &Grammar, tree: &Tree, text: &str) -> Vec<ScriptRegion>
```

- HTML 树 walk 找 `script_element` → `raw_text` 子节点；`lang` 属性
  （`attribute` → `attribute_name`/`quoted_attribute_value`，**值带引号取内层**；
  `setup` 是无值的裸 `attribute`）映射：`ts`/`typescript`→typescript、
  `tsx`→tsx、缺省/`js`→javascript、其它（`json` 等）跳过。结构已 dump 验证，见 §17。
- 多 script 块（`<script>` + `<script setup>`）全返回，按 `base` 排序。
- **单测矩阵**：无 lang / `lang="ts"` / `lang="tsx"` / `setup` 组合 / 双 script / 空 script /
  `lang="json"` 跳过 / `.html` 内嵌 script / CJK 内容（UTF-16 回归）。

### 5.2 `src/syntax/modules.rs`

```rust
pub struct Facts {
    pub decls: Vec<Decl>,          // { name, kind: SymbolKind, range, exported }
    pub imports: Vec<Import>,      // { names: Vec<ImportName>, source, range }
    pub reexports: Vec<Reexport>,  // export {x} from / export * from
}
pub enum ImportName {
    Named { imported: String, local: String },  // import { a as b }
    Default { local: String },
    Namespace { local: String },                // import * as ns
}
```

- 直接节点遍历（kind 已 dump 实测，**完整表见 §17**）：`import_statement`（`named_imports`>`import_specifier`、
  `import_clause`>`identifier`、`namespace_import`）、`export_statement`（声明导出 /
  `export_clause` / `export *`）、`function_declaration` / `class_declaration` /
  `lexical_declaration`（>`variable_declarator`）/ `type_alias_declaration` /
  `interface_declaration` / `enum_declaration`。
- **实测抓到的关键差异**：class/interface/type_alias 的名字节点是 **`type_identifier`**，
  function/enum/变量是 `identifier`——遍历时两种都要认，否则漏提取。
- `import type` 也入事实（类型跳转同样需要；`verbatimModuleSyntax` 等对导航无影响）。
- **坐标单次换算原则**：区域内部字节 + `base` → 外层字节 → 一次转 UTF-16 Range。
  禁止「区域内先转 Pos 再加 base」的双重换算。
- `Syntax` 公开入口（同 crate 私用 `analyze`，零 API 面变化）：

```rust
/// vue/html: 各 script 区域合并（Range 已换算为文件绝对坐标）；ts/js: 全文。
pub fn script_facts(&self, lang: &LanguageId, text: &str) -> Facts
```

### 5.3 验证

`cargo fmt --all` && `cargo clippy -p ide-language --all-targets -- -D warnings` &&
`cargo nextest run -p ide-language`。无 IPC 无 UI。

## 6. PR-2 — 模块图解析（`ide-workspace`，约 400 行）

### 6.1 路径解析纯函数（`ide-core/src/paths.rs`，E3 修订）+ tsconfig 定位（`ide-workspace/src/roots/tsconfig.rs`）

```rust
// ide-core/src/paths.rs（ide-index 与 ide-host 都能调；ide-core 是共享词汇层）
pub struct AliasMap { pub base_url: PathBuf, pub paths: Vec<(String, Vec<String>)> }
pub fn resolve_spec(root: &Path, from: &Path, spec: &str, aliases: &AliasMap,
                    exists: impl Fn(&Path) -> bool) -> Option<PathBuf>
```

```rust
// ide-workspace/src/roots/tsconfig.rs（项目模型归这里；读文件 + 调 ide-core 纯函数）
/// 从 from 逐级向上收集 tsconfig*.json / jsconfig*.json（到 root 为止），
/// 合并 compilerOptions.paths（就近目录优先），extends 链跟进（含 @tsconfig/*，深度 ≤5）。
pub fn alias_map(root: &Path, from: &Path) -> AliasMap
```

- Vite 脚手架现实：根 `tsconfig.json` 只有 `references`，`paths` 在 `tsconfig.app.json` ——
  单文件读取会静默失效，必须多配置合并。过近似可接受（兜底层，答案标 candidate）。
- `jsonc::strip` + `serde_json` 解析；文件不存在 → 空 map（纯相对路径项目照常工作）。

### 6.2 路径解析（查询期，纯函数）

```rust
/// import spec → 目标文件。相对路径扩展名补全 + tsconfig 别名；裸说明符（'vue'）→ None。
pub fn resolve_spec(root: &Path, from: &Path, spec: &str, aliases: &AliasMap,
                    exists: impl Fn(&Path) -> bool) -> Option<PathBuf>
```

- 扩展名表（按 TS 解析顺序）：`.ts` `.tsx` `.d.ts` `.js` `.jsx` `.mts` `.cts` `.vue`，
  再试 `index.ts`/`index.tsx`/`index.js`/`index.vue`。
- 别名：最长前缀匹配，`/*` 通配替换后走同一扩展名补全；`baseUrl` 拼接。
- re-export 链：`export {x} from` / `export * from` 递归跟进，深度 ≤8，visited 环 guard。

### 6.3 测试

单测含 Vite 脚手架布局 fixture（根 references + app 配置 paths）、`extends` 链、
通配符、环、裸说明符。`cargo nextest run -p ide-workspace`。

## 7. PR-3 — 索引接入 + `indexGoto`（ide-index + ide-host + src-tauri，约 500 行）

### 7.1 worker 与存储

- `worker.rs` `extract()`：`syntax.tags()` 之后加
  `rec.facts = syntax.script_facts(&lang, &text)`（grammar 为 typescript/tsx/javascript，
  或 web 语言 vue/html/jsp/svelte；沿用 2MB 上限与 ignored 跳过）。
  **E2 修订**：`has_symbols` 对 vue 走 `web_grammar` 分支返回 true（已核实
  [syntax/mod.rs:162]），所以 vue 文件**已经**会进 `tags()` 提取（CSS 符号）——
  facts 提取不能挂在 `has_symbols` 后面，要独立判断：
  `matches!(lang, ts/js 系) || web_grammar(lang).is_some()`。
- `data.rs`：`FileRecord` += `facts: Facts`、内存 `FileEntry` 同步扩展；
  **`store.rs` SCHEMA 常量升版**（旧缓存 stamp 失配 → 一次性全量重建，M0 实测重建时长）。
- `.vue` 符号入索引（⌘O + 现有 findSymbols 兜底同时受益）：
  - 组件符号：文件名 stem、`SymbolKind::Class`、range = 首个 script 区域起点；
  - script 声明：`Facts.decls`（exported 的）并入 `rec.symbols`。

### 7.2 `indexGoto` 命令（ops/nav.rs，照抄 web_goto 模式）

```rust
// ops/nav.rs（与 WebGoto 同文件；specta::Type + serde，camelCase）
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexGoto { pub targets: Vec<Location>, pub note: IndexNote }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IndexNote { Certain, Candidate }

pub async fn index_goto(host: &Host, window: &str, doc: DocId, pos: Pos)
    -> IdeResult<Option<IndexGoto>>
// Location 复用 ide-core（path + range + uri）；None = 索引答不了，前端继续降级
```

解析顺序（`blocking` 包裹，全程 CancellationToken 无需——查询 <100ms）：

1. `documents.snapshot(doc)` 取 `DocumentInfo`（text/language/large/dirty 全有，
   [documents.rs:17]）；`large===true` → 直接 `None`（照抄 web_goto 的 large 短路，E10）。
2. vue/html：定位 pos 所在 script 区域（**输入坐标换算链，E16**：外层 Pos →
   外层字节用现成 `lines::byte_at(text, pos)`（ide-language lines.rs:90）→
   减 `base` → 区域字节 → 区域内定位）→ `Snapshot::text(&区域语言, &区域文本)` →
   **`project.structure.locals(...)`（ide-host 已有字段，[project.rs:42]；不能用
   `host.syntax()`——那是 `ide_language::Syntax`，没有 `locals`；`StructureService`
   在 ide-syntax）**。区域语言是 typescript/tsx/javascript，`kinds::locals_source`
   对它们有值，`support` 检查通过（E1 修订：vue 本身 `grammar_name` 查表无条目、
   `StructureSupport::default()` 全 false——所以**必须**以区域语言构造 Snapshot，
   不能以 vue）。命中 → 目标 Range + base 换算返回（certain）。
3. 取 pos 处标识符 → 当前文件 imports（活文本现提取）→ 绑定名匹配 →
   `resolve_spec` → 目标文件（Documents 打开则活文本，否则索引 facts）→
   找 `imported` 名的导出声明 → Location（certain）。
4. re-export 链跟进（6.2）。
5. 组件标签（vue/html，pos 在模板）：标签名 kebab↔Pascal 归一 → import 默认绑定 →
   `.vue` 文件（Location = script 起点）；无 import → 文件名注册表
   （索引内同名 `.vue` stem 精确匹配）→ candidate。
6. 都未命中 → `None`（前端继续走现有 findSymbols 名字匹配兜底）。

### 7.3 命令注册链

ops/nav.rs `d.add("index_goto", …)` → `src-tauri/src/commands/nav.rs` 薄适配 →
`pnpm gen:bindings` 并提交 `src/bindings.ts`。远程模式零额外工作（ops 层共享）。

### 7.4 fixture 与测试

`fixtures/vue-app/`（照 mybatis-app 模式）：`package.json`、根 `tsconfig.json`（references）+
`tsconfig.app.json`（`paths: {"@/*": ["src/*"]}`）、`src/components/UserCard.vue`
（`<script setup lang="ts">`）、`src/api/client.ts`（具名导出）、`src/api/index.ts`
（re-export）、`src/App.vue`（import + `<UserCard/>` + 别名 import）、`index.html`（内嵌 script）。
ide-host 集成测试走 ops 全链路。

### 7.5 验收（=「可用」硬标准）

无 LSP 起项目（不装 vtsls），⌘B 依次可跳：.vue script 局部变量 → import 的符号 →
re-export 目标 → `<UserCard>` → UserCard.vue；⌘O 搜到 UserCard。
真机验证：`.agents/skills/verify` 截图（CONTRIBUTING 的 How it was verified）。

## 8. PR-4 — 前端接线（约 300 行 TS）

- [syntaxFallback.ts](src/editor/lsp/syntaxFallback.ts) `declarationFallback`：
  **indexGoto 调用必须放在 `support.tree` 门之前**（E15，行级定位
  syntaxFallback.ts:145 `if (!support.tree) return { kind: "unsupported" }`——
  vue 在此提前返回，「locals 之后插入」对 vue 永远执行不到）。正确顺序：
  ① `commands.indexGoto(doc, pos)`（vue/html/ts/js 全走，内部已做区域 locals）
  → 有目标即返回（带 `INDEX_NOTE`）；② 原有 support 门 + locals（ts/js 走，
  vue 到此返回 unsupported 属预期——indexGoto 已答过）；③ findSymbols 兜底。
  `INDEX_NOTE`（"Based on project index (language server not ready)"）。
  **E6**：先查索引状态——**复用现有 `index_status` 命令**（ops/nav.rs:167 已注册，
  bindings 里已有 `indexStatus`，零新增后端），`indexing===true`
  时显示「索引构建中」而非「未找到」，避免冷启动期误报。
- [navigation.ts](src/editor/lsp/navigation.ts) `gotoTargets`：`fromSyntax` 提示位复用，
  新增索引来源标注；错误路径 console.debug 后继续降级（现有模式）。
- i18n：`INDEX_NOTE` 走 `locales/text/<locale>.json`（键=英文原文，en 无文件——
  键即英文；zh.json 加 `"Based on project index (language server not ready)":
  "基于项目索引（语言服务器未就绪）"`，照 SYNTAX_NOTE 惯例，textCatalog.test.ts
  会强制源字面量与目录同步）。
- vitest：mock `commands.indexGoto` 测兜底链顺序（照 navigationPending.test.ts 模式）。
- 验收：`pnpm typecheck && pnpm lint && pnpm vitest run src/editor/lsp` + 真机复验 PR-3 场景。

## 9. M2 — 出现索引 + 查找用法（3 个 PR）

1. **PR-5**：`FileRecord` += `occurrences: Vec<StoredOccurrence{name, range, qualified}>`
   （script 区域标识符 walk，**拷贝** `identifiers.rs` 的叶子 kind 排除表
   （~10 行，E17：它在下游 ide-syntax，不能 import）；模板 `tag_name`
   出现归一 PascalCase，仅含大写/连字符的标签）；内存倒排用 **§11a 驻留紧凑表示**
   （`NameId`/`PathId` u32 + Range，约 24B/条——默认设计非备选；加载时建、增量补丁）；
   `index_usages(name, from)` 命令。
2. **PR-6**：[syntaxUsages.ts](src/features/code-insight/syntaxUsages.ts) 文本搜索兜底 →
   索引查询（索引空时保留文本搜索为再下一级）；组件用法 = 模板标签 + import 语句；
   `probeNavigation`（navigation.ts）先查 indexGoto，命中即下划线，未命中才发 LSP 探测
   （消灭每词一次的 definition 请求）。
3. **PR-7**：criterion bench（ide-index 现有 `[[bench]] index`）加 facts/goto/usages 用例，
   预算进 `perf/budgets.json`。

验收：无 LSP 时 Find Usages 符号级结果 <100ms 无误报；「组件在哪被用」含模板标签。

## 10. M3 — 一致性闸门（1 个 PR）

`fixtures/vue-app` + 已装 vtsls：抽样 N 个 (file, pos)，对比 `lspGoto` vs `indexGoto`
目标（path+line 相等）。`#[ignore]` 标注（照 `language_smoke --ignored --exact` 惯例，
CI 单独 job）。**≥90% 一致才允许翻转优先级**（索引先答 <50ms + LSP 异步精化）；
不达标 → 永停「兜底」定位，不一致样本归档进 fixture 防回归。

## 11. 验证命令汇总（对齐 CI）

每个 PR：`cargo fmt --all --check`、`cargo clippy -p <touched> --all-targets -- -D warnings`、
`cargo nextest run -p <touched>`；动 IPC 后 `pnpm gen:bindings`（提交 bindings.ts）；
动前端后 `pnpm typecheck && pnpm lint && pnpm format:check && pnpm knip &&
pnpm vitest run <path>`；用户可见行为：verify skill 真机截图。
长检查逐条跑，不串联（10 分钟工具超时坑）。

## 11a. 性能与内存预算（效率/内存保障，第五轮核实）

**效率成本模型**（代码事实已核实）：

- **打开文档的语法树有缓存**：`SyntaxCache` 按 DocId 缓存 + `Tree::edit` 增量
  （cache.rs），`SyntaxObserver`（project.rs:1287）随 open/edit/close 喂缓存。
  indexGoto 对当前 `.vue` 文件的 HTML 树**走缓存零重复解析**；仅 script 区域的
  TS 解析是临时解析（`Syntax::with_parsed` 无缓存）——典型 5–20KB 区域约 0.5–2ms。
- 索引扫描并行：worker full_scan/增量均 rayon `par_iter`（worker.rs:176/297）。
  单文件成本：`.ts` 一次解析、`.vue` 两次（HTML + 区域 TS），各约 0.5–3ms；
  2k 文件单线程约 2–6s，多核 wall-clock 亚秒级。M0 闸门 <30s 留 5–10× 余量。
- 查询链：缓存树 + 1 次区域解析 + HashMap 查找 → **目标 <10ms**（预算 100ms 的 1/10）。
- ⌘-hover 探测：同上，前端已有 per-word probe 缓存（navigation.ts `probed` map）。
- M2 用法查询：倒排表 O(该名字出现数)，µs–ms 级。增量更新：watcher 去抖 100ms
  后单文件重提取约 1–3ms。
- 已知双解析成本：`.vue` 索引时 `tags()` 与 `script_facts()` 各解析一次 HTML 树
  （盘上文本无缓存）。M0 实测若显著，修法是合并入口 `tags_and_facts()` 共享一次
  解析——**先测后修**，不预优化。

**内存预算（M2 出现索引：驻留紧凑表示是默认设计，非备选）**：

- M1 facts：每文件 10–50 条 × ~50B ≈ 1–2.5KB → 2k 文件约 5MB。
- M2 出现：`OccEntry { name: NameId(u32), path: PathId(u32), range: Range(16B), flags: u8 }`
  ≈ **24B/条**；名字表 `Vec<Arc<str>>` + 反查 HashMap；path 复用 IndexData 文件表索引。
  - 2k 文件 × 300 出现 = 60 万条 ≈ 14MB + 名字表 ≈ **总量约 20MB**；
  - 50k 文件 = 1500 万条 ≈ 360MB + 表 → 触发 M0 500MB 闸门 → 降级路径：
    按 tsconfig `include` 切索引范围。
- 持久化（redb/postcard）照旧存 `StoredOccurrence{name: String, …}`（磁盘便宜），
  加载时转驻留形式。

**需求覆盖矩阵**（用户栈 Vue/TS/JS/HTML 的导航需求 → 方案落点）：

| 需求                           | 落点                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| .ts/.js 里 ⌘B                  | locals（现有）+ import 链（PR-4）+ 名字匹配（现有兜底）                |
| .vue script 里 ⌘B              | 区域 locals（E1）+ import 链                                           |
| `<MyComp>` → 组件文件          | PR-3/4（Q2/Q7）                                                        |
| 模板 class/id/`var(--x)` → CSS | 现有 webGoto，零新增                                                   |
| Find Usages（无 LSP）          | M2                                                                     |
| 「组件在哪被用」               | M2（Q8）                                                               |
| ⌘O 搜组件                      | PR-3                                                                   |
| ⌘-hover 即时下划线             | M2 probe                                                               |
| 冷启动期不误报                 | E6                                                                     |
| .html script ⌘B                | PR-1 区域提取                                                          |
| 不覆盖（命名在 §13）           | CSS class 的 Find Usages、模板表达式、rename 兜底、.vue Structure 窗口 |

## 12. 风险表

| 风险                                                           | 缓解                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tree-sitter 边缘语法抽取率（export =、declare module、装饰器） | M0 闸门 ≥95%；不足处标 candidate                                                                                                                                                                                                                                |
| 大项目倒排内存                                                 | M0 实测；字符串驻留备选；超限按 tsconfig include 切范围                                                                                                                                                                                                         |
| .vue script 区域边界变体                                       | PR-1 矩阵单测（lang 属性、双 script、CJK）                                                                                                                                                                                                                      |
| tsconfig 布局多样（references/app/node）                       | 向上多配置合并过近似 + candidate 标注                                                                                                                                                                                                                           |
| 一致率 <90%                                                    | 永停兜底定位（D3 阶段一），不翻转                                                                                                                                                                                                                               |
| SCHEMA 升版触发全量重建                                        | 一次性成本，M0 实测时长（预期秒级）                                                                                                                                                                                                                             |
| 旧版本回退                                                     | **E5 修订：postcard 不读 serde(default，已核实 store.rs 用 `postcard::to_extend`/`from_bytes` 裸序列化）——回退兼容只能靠 SCHEMA 升版触发旧库重建 + 降级时旧版本自己也升 SCHEMA；真正兜底是「索引库可弃」：删 cache 目录即重建，无数据损失**；无消费者时索引无害 |

## 13. 遗留缺口（命名，防「悄悄半成品」）

模板表达式、内联事件、node_modules、CJS、rename 兜底、`#` 子路径、动态 import glob
（见 §1）；`.vue` Structure 工具窗口仍 HTML 大纲；Svelte/JSP 理论免费覆盖
（同一 html 映射）但未验证未测试；vite.config.ts 专属 alias；
**CSS class 的 Find Usages**（「`.card` 在哪些模板被用」——webGoto 只做定义跳转，
M2 出现索引只覆盖 script 标识符与组件标签；今天可用文本搜索顶替，后续可加
class 出现提取，第五轮 E14 命名）。

## 14. 对抗性复查修订（2026-11-05 第三轮，E1–E7）

已核实并写回上文：E1 locals 调用点必须是 `project.structure`（ide-syntax 的
StructureService），且 Snapshot 必须以**区域语言**构造（vue 查表无 grammar →
support 全 false）；E2 vue 已走 `has_symbols`→`web_grammar` 分支进 tags()，facts
提取须独立判断；E5 postcard 不读 serde(default)（store.rs 裸 `to_extend`），
回退兼容靠 SCHEMA + 「索引库可弃」。

新遗漏（E3/E4/E6/E7，全部并入对应 PR）：

- **E3**：`tsconfig.rs` 放 `ide-workspace/src/roots/` 会让 `ide-index` 无法调用
  （ide-index 不依赖 ide-workspace，依赖图：ide-workspace → ide-index 方向）。
  修订：`alias_map`/`resolve_spec` 的**纯函数部分**放 `ide-core`（`ide-core/text.rs`
  旁新建 `paths.rs`；ide-core 是全图共享词汇层，jsonc.rs 先例），`ide-workspace`
  只留「项目根/tsconfig 文件定位」的薄封装（roots 模型归它）。
- **E4**：`IndexNote` 枚举别放 ide-core（全仓无此名，避免词汇层膨胀）——放
  `ide-host/src/ops/nav.rs`，与 `WebGoto` 同居（已核实 WebGoto 就定义在 ops/nav.rs:18，
  IPC 类型进 nav.rs 是本仓库惯例）。
- **E6**：`indexGoto` 返回 `Option<IndexGoto>` 时前端无法区分「索引说没有」和
  「索引没建好」——加 `indexStatus` 查询（`IndexState` 事件已有，前端
  code-insight/servers.ts 已订阅；PR-4 在兜底链里检查 `indexing===false` 才信
  「没有」，否则提示「索引构建中」）。
- **E7**：`script_regions` 必须是 `Syntax` 上的 **pub** 方法（非 pub(crate)）：
  ide-host 的 index_goto 要拿区域文本构造 Snapshot；`Syntax::script_facts` 同理。
  已在 §5.1 标注。
  **且 sfc.rs 内部不能走 `analyze()`**（它 `grammar(vue)?` 返回 None）——用
  `web_grammar` + 私有 parse 路径（同 crate 内可直取，第四轮推演核实）。

## 15. 执行流推演复查（2026-11-05 第四轮，E8–E11，全部核实通过或已修）

沿「照方案写代码」的执行流逐接缝验证，结论：**方案主链路全部走通**，新增 4 项修订：

- **E8（核实通过，写明防呆）**：坐标换算链完整存在——`ide-language` 内部
  `LineIndex::pos()` 产出 UTF-16 列（`utf16_at` 差值，[syntax/lines.rs:58]），
  outline.rs:214 `idx.range(node.start_byte(), …)` 就是字节→Range 的现成用法。
  modules.rs 照此：`LineIndex::new(区域文本)` → `idx.range(内部字节)` →
  **行号加 `base` 所在外层行**（不是字节加 base 再换算——区域首行与外层行对齐，
  列直接沿用；跨行 range 的行号同样加偏移）。防呆注释写进 modules.rs。
- **E9（核实通过）**：`locals_source`（[ide-syntax/kinds.rs:408]）对
  `typescript`/`tsx`/`javascript` 都有值——E1 的区域语言 Snapshot 三种都成立
  （tsx 也映射到 typescript 的 locals.scm），`<script setup lang="tsx">` 覆盖。
- **E10（修订）**：`indexGoto` 的输入用 `documents.snapshot(doc)` 返回的
  `DocumentInfo`（[documents.rs:17]：`text/language/large/dirty` 字段全有），
  `large===true` 直接返回 None（照抄 web_goto 的 large 短路）——方案 §7.2 第 1
  步原文只说「取活文本+语言」，未提 large 短路，补上。
- **E11（核实通过，写明并发模型）**：查询期读索引走 `shared.data.read()`
  （RwLock，[worker.rs:46]；find_symbols/symbols_named 同模式 [lib.rs:206-214]），
  worker 写在 `process()` 持写锁批量 apply——查询与索引更新天然互斥、无脏读；
  index_goto 查询期间持读锁做 resolve_spec 的文件系统 `exists` 探测（stat 调用，
  微秒级）可接受，无需快照拷贝。PR-3 实现照此，不另造锁。

其余推演点全部通过（无修订需要）：`analyze()` 对 vue 走 `grammar(lang)?` 返回
None——所以 sfc.rs **不能**用 `analyze`，要用 `web_grammar` + `with_web_tree`
同款私有路径（同 crate 内，PR-1 直取）；`ProjectIndex` 公开查询 API + host 的
`project.index` 字段（[project.rs:33]）就位；前端 `gotoFallback`
（navigation.ts:304）就是 indexGoto 的插入点，bindings.ts 由 gen:bindings 生成
（当前无 indexGoto 条目，PR-3 生成后自动出现）。

## 16. 开发快速上手（交付给开发人员的第一页）

1. **建独立工作树**（AGENTS.md 并行工作树惯例，别混入其它 WIP）：
   `git worktree add ../semantic-index -b feat/semantic-index origin/main`，然后 `pnpm install`。
2. **按 PR 顺序开工**：M0 → PR-1 → PR-2 → PR-3 → PR-4 → M2 → M3。每个 PR 的类型签名、
   插入点（file:line）、验收标准、验证命令都在 §4–§10 对应节里，照做即可。
3. **M0 harness**：写 `crates/ide-index/examples/spike.rs`——遍历项目文件 →
   `syntax.script_facts()` → 计时/计数/内存预估；抽样边缘语法（`export =`、
   `declare module`、装饰器、双 script 块）统计成功率。运行：
   `cargo run -p ide-index --example spike -- <项目路径>`。产出数字对照 §4 闸门，
   **闸门不过不开 PR-1**。
4. **仓库铁律**（违反 CI 必红）：动 IPC 后 `pnpm gen:bindings` 并提交
   `src/bindings.ts`；新用户可见字符串 en.json + zh.json 双登记；长检查逐条跑
   （10 分钟工具超时坑）；clippy 提交前跑一次（`cargo clippy -p <crate> --all-targets -- -D warnings`）。
5. **真机验收**：PR-3/PR-4 用 `.agents/skills/verify`（Tauri MCP + 截图），
   PR 描述带 How it was verified（CONTRIBUTING 模板）。
6. **卡住时**：§3 地基表有每个复用点的位置；§14/§15 记录了 16 处「照抄会踩空」
   的坑及修法；§18 是全部决策的为什么。

## 17. 语法树 kind 表（dump 实测 2026-11-05，与仓库捆绑版本一致）

实测环境：tree-sitter 0.25.10、typescript 0.23.2、javascript 0.25.0、html 0.23.2
（与 ide-language 捆绑版本一致）。**modules.rs / sfc.rs 的遍历以此表为准。**

### import（TS/JS 同构）

```
import_statement
├─ import / type                       ← type-only 时多一个 type 关键字
├─ import_clause
│  ├─ identifier                       ← 默认导入的本地名
│  ├─ named_imports > import_specifier*（多个）
│  │    └─ identifier [as identifier]  ← 导入名[ as 本地名]（别名=两个 identifier）
│  └─ namespace_import > identifier    ← * as ns 的本地名
├─ from
└─ string > string_fragment            ← 模块说明符（string_fragment 无引号）
```

### export

```
export_statement
├─ export + <declaration>              ← 声明导出（declaration 见下表）
├─ export + default + <declaration>|identifier   ← 默认导出
├─ export + export_clause > export_specifier > identifier + from + string  ← re-export 列表
├─ export + * + from + string          ← export * from
└─ export + namespace_export > identifier + from + string ← export * as ns from
```

### 声明名字节点（关键差异，混用会漏提取）

| 声明节点                                                                 | 名字节点 kind                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `function_declaration` / `enum_declaration`                              | `identifier`                                           |
| `lexical_declaration` > `variable_declarator`                            | `identifier`（`const a = 1, b = 2` 有多个 declarator） |
| `class_declaration` / `interface_declaration` / `type_alias_declaration` | **`type_identifier`**                                  |

### HTML（.vue/.html 的 script 区域）

```
script_element
├─ start_tag
│  ├─ tag_name "script"
│  ├─ attribute > attribute_name "setup"                    ← 裸属性（无值）
│  └─ attribute > attribute_name "lang" + quoted_attribute_value "\"ts\"" ← 值带引号，取内层
├─ raw_text                                                ← 脚本文本（字节区间即区域）
└─ end_tag
```

- `style_element` 同构（`css_regions` 先例即此结构）。
- 模板组件标签：`element` > `start_tag` > `tag_name`（组件名在此，kebab/Pascal 均原样）。
- `export default { name: 'X' }`（options API）在 `raw_text` 里按 TS/JS 解析，
  `export_statement` > `default` > `object`——组件文件级跳转不依赖它（目标=文件）。

## 18. 决策记录

Q1 HTML 树区域提取（零依赖）· Q2 组件标签跳进 M1 · Q3 tsconfig-only 别名 ·
Q4 砍 rename 兜底 · Q5 node_modules 交 LSP · Q6 M0 用最大真实项目 ·
Q7 unplugin 文件名注册表兜底（candidate）· Q8 组件标签 Find Usages 进 M2 ·
Q9 跳过 HTML 内联事件 · Q10 跳过 CJS · Q11 M0 时提供项目路径 · Q12 方案存档。
H1 撤回新 crate（嵌入 ide-language，web.rs 先例）· H2 tsconfig 多配置合并 ·
H3 .vue 区域级 locals（Snapshot::text 服务端技巧）· H4 嵌入现有兜底链而非平行命令 ·
H5 SCHEMA 升版 + 脏缓冲 load 闭包 + 坐标单次换算。
E1 locals 调用点 = project.structure（非 host.syntax）+ Snapshot 用区域语言 ·
E2 facts 提取独立于 has_symbols 判断 · E3 resolve_spec 纯函数下沉 ide-core（依赖图）·
E4 IndexGoto/IndexNote 类型放 ops/nav.rs（WebGoto 惯例）· E5 postcard 无 serde(default)，
回退靠 SCHEMA + 索引库可弃 · E6 索引构建期状态提示（防冷启动误报）·
E7 script_regions/script_facts 必须 pub（跨 crate 调用）。
第五轮（效率/内存/需求专项）：E12 查询路径效率核实——打开文档语法树有 SyntaxCache
缓存（SyntaxObserver 喂），indexGoto 仅区域 TS 是临时解析（~ms），目标 <10ms；
E13 内存设计定稿——出现索引驻留紧凑表示（NameId/PathId + Range ≈ 24B/条）为默认
设计，2k 文件约 20MB，50k 文件触发 500MB 闸门走 tsconfig include 切分降级；
E14 需求覆盖矩阵入 §11a，CSS class Find Usages 补入 §13 命名缺口。
性能与内存预算全文见 §11a。
第六轮（实现者视角行级走查）：**E15（真错误）** declarationFallback 的
`support.tree` 门（syntaxFallback.ts:145）对 vue 提前返回 unsupported，
「locals 之后插入 indexGoto」对 vue 永远执行不到——indexGoto 必须放在门前，
已改写 §8；**E16** 输入坐标换算链写明：外层 Pos → 字节用现成
`lines::byte_at(text, pos)`（ide-language lines.rs:90）→ 减 base → 区域字节 →
区域 `LineIndex::pos()`——E8 只写了输出方向，输入方向补齐；**E17** M2 出现
提取的叶子 kind 排除表是**拷贝**进 ide-language（identifiers.rs 在下游
ide-syntax，不能 import，方案原文「复用」易误导）；**E18** E6 的 indexStatus
是复用现有 `index_status` 命令（ops/nav.rs:167），非新增——已改写 §8。
i18n 惯例核实：SYNTAX_NOTE 走 `locales/text/<locale>.json`（键=英文原文，
en 缺省即键本身），INDEX_NOTE 照此登记 zh（及其它已有 locale 目录），
en 无需文件（键即英文）——§8 的「en.json+zh.json 双登记」表述已按此理解，
实际落点是 `src/platform/locales/text/zh.json` 加一条。
