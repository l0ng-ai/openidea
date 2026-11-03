# 插件系统 P0 验证结论

对应 `docs/plugin_plan.md` 第 5 节 P0。实验代码保留为回归测试：
`crates/ide-plugin/tests/p0_probe.rs`，探针组件在 `crates/ide-plugin/tests/fixtures/p0-probe/`
（`build.sh` 生成 `dist/min.wasm` 与 `dist/full.wasm`）。环境：wasmtime 49.0.5、wasmtime-wasi 49（p2）、
wit-bindgen 0.63、`wasm32-wasip2`，Apple Silicon，debug 构建（release 数字括注）。

## 1. 可选导出能否按接口绑定 —— 可以

测试：`optional_exports_bind_per_interface`。

- `Component::get_export_index(None, "openidea:probe/code-actions@0.1.0")` 在**编译后、实例化前**就能判断
  组件有没有导出某个接口。安装时据此算出插件实现了哪些 Provider，写进贡献索引，启动时不需要实例化。
- `bindgen!` 生成的整 world 绑定（`ProbeHostPre::new`）要求所有导出都在，缺一个就失败；
  但每个导出接口各有一个 `GuestIndices::new(&instance_pre)`，缺失时返回 `Err`，存在时正常 `load` 和调用。
- 结论：**不需要退回“基础 world + 多个组合 world”**。宿主用一个包含全部可选导出的 world 生成绑定，
  只用到每个接口的 `GuestIndices`，不用整 world 的 `*Pre`。插件作者侧：SDK 为每个 Provider 提供
  feature 或宏，只导出实现了的接口（wit-bindgen 按 world 生成，SDK 内置几个常用组合 world 即可，
  宿主不关心组合方式）。

对设计的影响：无，4.3 节的“可选导出”成立。

## 2. async 调用、取消与实例复用

测试：`spinning_guest_yields_to_the_executor`、`cancelled_instance_cannot_be_reused_but_reinstantiates_fast`、
`async_host_import_does_not_block`。

- wasmtime 49 里 `Config::async_support` 已废弃且无效果，async 能力由 `async` cargo feature 和调用方式决定。
- `store.epoch_deadline_async_yield_and_update(1)` + `call_async`：死循环的 guest 每个 epoch tick 让出一次，
  **单线程**执行器上的其他任务照常推进。长调用不再独占线程。
- async 宿主导入（`imports: { "...sleep-ms": async }`）等待期间不阻塞线程。
- guest 返回 `Err`（不是 trap）后实例照常可用。
- **取消（丢弃 future）后实例不能复用**：下一次调用返回 `Trap::CannotEnterComponent`。
  无论取消发生在 guest 计算中还是 async 宿主导入的等待中，结果相同。原因：wasmtime 在 fiber 被
  dispose 时把错误传回 `catch_traps`，组件 store 被标记为 `trapped`（`may_enter() == false`）。
  这是 wasmtime 的有意行为，不能绕开。
- **重建很便宜**：从已有的 `InstancePre` 新建 store 并实例化，加上第一次调用，约 **50µs**（release 约 40µs）。
  代价在于丢失实例内存里的状态，而不是时间。

结论与对 4.5 节的修订：

1. 取消 = 丢弃 future + 丢弃 store；下次调用前从 `InstancePre` 重建。不需要冷编译。
2. 两段式超时仍然保留，但理由从“避免冷启动”改为“保留实例状态”：
   - **软超时**（编辑路径 50ms）：调用方不再等待、结果丢弃，调用在 actor 内继续执行完，实例和状态保留；
     同一插件的后续调用排队，新请求到来时旧请求如仍在排队则直接丢弃（不进入 guest）。
   - **硬超时**（编辑路径 500ms，命令 5s）：丢弃 future，重建实例，计入熔断计数。
3. 用户主动取消（例如 AI Completion 的旧请求）优先走**协作式取消**（见第 3 节），实例不受影响；
   协作式取消在宽限期内没有返回时，再升级为硬取消。
4. 插件需要跨调用保留的状态一律走 `storage`；实例内存只当缓存。SDK 文档写明这一点。
5. fuel 保留作为死循环兜底；与 epoch 让出同时启用没有冲突。

## 3. WASI p2 上的流式与任务模型 —— 可行，不依赖 p3

测试：`pollable_task_streams_and_cancels_cooperatively`。

- 宿主定义 `task` 资源，方法 `next-ready() -> pollable` 返回 `wasi:io/poll.pollable`（宿主用
  `wasmtime_wasi::p2::subscribe` 包装自定义 `Pollable`）。guest 调 `pollable.block()` 时，wasmtime 在
  async 宿主里等待该 future，执行器线程不被占用。
- guest 循环“等待 → 取数据 → `report` 进度 → 检查 `is-cancelled`”，宿主推送数据并在最后设置取消标志；
  guest 正常返回，**实例保持可用**。
- 流式输出（例如 AI Completion 逐块返回、Kubernetes 日志）用同一模式的反方向：宿主提供
  `output-stream` 风格的资源（`write(chunk)` 是 async 宿主导入），或者 guest 通过 `task.emit(chunk)` 推送；
  两者都只需要 p2 资源 + pollable。
- 结论：4.3 节 `tasks` 接口定为：
  ```wit
  resource task {
      report: func(done: u32, total: option<u32>);
      is-cancelled: func() -> bool;
      /// 取消或有新输入时就绪，供 guest 在等待时让出。
      cancelled: func() -> pollable;
  }
  ```
  `net` 的流式响应体直接复用 `wasi:io/streams.input-stream`，不自造类型。

## 4. `syntax`、`index` 接口

依据：`ide-syntax`（`StructureService`：`node_at`、`syntax_errors`、`locals`、`identifiers_named`、
`structural_ranges`，全部基于 `ide-language` 的 `SyntaxCache` 增量树，0 基行、UTF-16 列）和 `ide-index`
（`ProjectIndex`：`find_files`、`find_symbols`、`symbols_named`，后台 worker + redb 持久化）。
Solidity 与 MyBatis Navigator 两个原型需要的能力如下，接口按它们的最小需求定稿。

### 4.1 `syntax`

两个方向，分开设计：

- **读宿主的树（import）**：适用于宿主有 grammar 的语言（MyBatis Navigator 读 Java、XML）。
  ```wit
  interface syntax {
      resource tree {
          /// 0 基行、UTF-16 列；返回包含该位置的最内层命名节点。
          node-at: func(pos: position) -> option<node>;
          /// tree-sitter 查询语法；只返回被捕获的节点，最多 `limit` 个。
          query: func(source: string, range: option<range>, limit: u32) -> result<list<capture>, error>;
          errors: func(limit: u32) -> list<range>;
      }
      record node { kind: string, range: range, text: string, parent-kind: option<string> }
      record capture { name: string, node: node }
      /// 打开的文档用增量缓存树；未打开的文件现场解析（受 `project.read` 约束）。
      parse: func(path: string) -> result<tree, error>;
  }
  ```
  不暴露节点句柄的游走 API（`parent`/`children` 逐个跨边界调用代价高）；查询一次返回结果列表。
- **插件提供语法树（export，P3）**：宿主没有 grammar 的语言（Solidity）。宿主不加载插件提供的原生
  grammar；插件在 Wasm 里自带解析器，导出 `syntax-provider`，按需返回**扁平结果**而不是树：
  ```wit
  interface syntax-provider {
      highlights: func(text: string) -> list<token>;    // range + 语义类别（映射到 --syn-*）
      outline: func(text: string) -> list<outline-item>;
      folding: func(text: string) -> list<range>;
  }
  ```
  宿主把结果转换成现有的 `OutlineItem`、`FoldRange`、`SyntaxHighlights`，编辑器侧无感知。
  这条路径在编辑路径上，适用 4.5 节的编辑路径预算。
  原因：tree-sitter 的 Wasm grammar 需要 `tree-sitter` 的 wasm 特性和额外的 wasmtime 实例，
  且 grammar 不能表达大纲和折叠；扁平结果把实现方式留给插件。

### 4.2 `index`

- **查宿主的符号索引（import）**：
  ```wit
  interface index {
      find-symbols: func(query: string, types-only: bool, limit: u32) -> list<symbol>;
      symbols-named: func(name: string, kind: option<symbol-kind>, limit: u32) -> list<symbol>;
      find-files: func(query: string, limit: u32) -> list<string>;
      /// 插件自定义索引的查询，见下。
      lookup: func(index: string, key: string, limit: u32) -> list<entry>;
  }
  record entry { key: string, value: string, path: string, range: range }
  ```
- **插件自定义索引（export + 声明）**：MyBatis Navigator 要“Mapper 接口方法 ↔ XML 语句 id”的跨文件映射，
  宿主的符号索引不认识 XML 语句。做法：
  ```toml
  [[contributes.indexes]]
  id = "statements"
  files = ["**/*Mapper.xml", "**/*Mapper.java"]
  version = 1          # 改变索引格式时递增，宿主据此重建
  ```
  插件导出 `indexer.index-file(path, text) -> list<entry>`；宿主在**后台**（复用 `ide-index` 的 worker
  调度和 redb 存储，按插件 id + 索引 id 分表）对匹配文件调用，文件变化时增量更新，插件禁用或卸载时删表。
  插件运行时只能 `lookup` 自己的索引。索引任务是后台任务，适用后台预算并上报进度。

对设计的影响：4.3 节的 `syntax`、`index` 按上面两节定稿；新增 `contributes.indexes` 扩展点（P6）。

## 5. 文档修正

`plugins/README.md` 第 4 节原文暗示插件语言里的 `language-servers`、`debugger` 会生效。实际上插件语言
只经 `languages` 命令进入前端的语言列表（文件检测、注释、缩进、借用的 CodeMirror 模式），不进入后端
`LanguageRegistry`，因此 LSP、DAP、后端语言检测都不生效。README 已改为如实说明，P3 完成后再恢复。

## 6. 对计划的修订汇总

| 位置                 | 原设计                   | 修订                                                         |
| -------------------- | ------------------------ | ------------------------------------------------------------ |
| 4.3 可选导出         | 待验证，备选组合 world   | 按接口 `GuestIndices` 绑定，安装时用 `get_export_index` 记录 |
| 4.5 超时             | 两段式用于避免冷启动     | 重建约 50µs；两段式用于保留实例状态；用户取消优先协作式      |
| 4.3 `tasks`          | `report`、`is-cancelled` | 增加 `cancelled() -> pollable`                               |
| 4.3 `syntax`/`index` | 待定                     | 见第 4 节                                                    |

以上修订已同步到 `docs/plugin_plan.md`。
