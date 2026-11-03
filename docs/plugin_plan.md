# 插件系统重构计划

状态：P0–P8 完成（P4 release 实测在预算内），WIT 冻结为 `openidea:plugin@1.0.0`。涉及 `crates/ide-plugin`、`crates/ide-host`、`wit/`、
`src-tauri/src/commands/plugin.rs`、`src/features/plugins`、`src/workbench/contributions.ts`。

## 1. 目标

- 新增贡献类型时不改内核：领域 crate 或前端 feature 注册一个扩展点即可。
- 插件能做出实质功能：Provider、事件、长任务、视图、自定义编辑器、外部工具链。
- 第三方代码默认隔离，能力需声明并由用户逐个插件授权。
- 已安装插件不拖慢启动：没有被触发的插件不实例化 Wasm。
- 本地和远程项目使用同一套宿主，从 P3 起每阶段都在远程项目上验收。
- 用 10 个官方插件验证设计，只走公开 SDK。

### 非目标

- 不把第一方 feature 改造成插件。它们和插件共用注册表即可。
- 不兼容 VS Code 插件。
- API 1.0 不支持插件间的代码依赖，只能通过命令 id 协作。
- 不提供服务端市场，先用静态索引。

## 2. 现状

### 已有，可直接复用

| 能力              | 位置                                                                                                          | 本计划中的用途                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 项目信任          | `crates/ide-host/src/trust.rs`；`create_host` 通过 `set_project_policy` 接入，未受信项目走 `restrict_project` | 项目插件加载的前置门槛                             |
| when 上下文求值   | `src/platform/context.ts`                                                                                     | 菜单、键位、状态栏的 `when` 条件，不另造表达式语言 |
| 后台符号索引      | `crates/ide-index`                                                                                            | `index` 接口在其上开放，不从零设计                 |
| epoch + fuel 限额 | `crates/ide-plugin/src/runtime.rs`                                                                            | 保留作为兜底，调用模型改为 async（见 4.5）         |
| 性能预算          | `perf/budgets.json`                                                                                           | 新增插件相关指标                                   |

### 问题

| 问题             | 证据                                                                                                                              | 后果                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 贡献类型写死     | 新增一类要改 `Contributions`、`Registrations`、`PluginInfo`、`CatalogPlugin`、`static_contributions`、`files()`、`bridge.ts`      | 扩展成本线性增长                                                   |
| 内部扩展点没开放 | 前端有 48 个 `register*` 函数，插件只能贡献命令、语言、主题                                                                       | 插件做不出实质功能                                                 |
| 插件语言是半成品 | `PluginHost::languages()` 只被 `commands/app.rs` 的 `languages` 命令使用，没有进入 `LanguageRegistry`；语法树只能来自内置 grammar | `plugins/README.md` 写的 `language-servers`、`debugger` 实际不生效 |
| 只有拉模型       | guest 只导出 `activate`、`deactivate`、`run-command`，同步调用，单次上限 5s，超时即 trap                                          | 无事件、无 Provider、无长任务、无取消                              |
| 启动全量激活     | `load_all` 逐个编译并激活，没有预编译缓存                                                                                         | 插件越多启动越慢                                                   |
| 信任只有项目一级 | 受信项目里 `.openidea/plugins/*` 全部自动加载，无逐插件确认；首次迁移时最近项目被整体标为受信；已安装插件声明即授权               | 开放进程或网络后，打开一个受信仓库就会执行其中任意插件             |
| 宿主位置不对     | `PluginHost` 在 `src-tauri`，`ide-host` 和 `openidea-server` 都没有                                                               | 远程项目无法在项目所在机器运行插件                                 |
| 安装非原子       | `lib.rs` 安装时先 `remove_dir_all` 旧目录再 `rename`                                                                              | 中途失败插件丢失；无版本回滚                                       |
| 分发不完整       | 无打包格式、签名、市场                                                                                                            | 无法形成生态                                                       |
| 编辑无版本校验   | `insert-text`、`replace-selection` 是发完不管的事件                                                                               | 存在竞态，插件也拿不到结果                                         |

## 3. 目标架构

```text
 主 WebView（只跑第一方代码）
   贡献投影层：已校验的声明 → 现有 register*（不会失败）
   声明式视图渲染器（src/ui）｜ 沙箱 iframe（逃生口）
        │ 快照/增量 + 视图树          ▲ 用户事件
────────┼────────────────────────────┼────────── 本地 IPC 或远程协议
 ide-host（本地与 openidea-server 共用，运行在项目所在机器）
   ExtensionRegistry：扩展点 + 按插件记账
   CapabilityBroker：授权账本 + 项目信任
   ActivationManager：激活事件 + 空闲回收
   WasmRuntime：每插件一个 actor，async 调用 + 分级预算
        │ 只通过能力接口
   project / editor / syntax / index / lsp / net / process / storage
        │ 需要本机的能力（secrets、通知、剪贴板）
   本地代理（客户端侧）
```

依赖方向：`ide-core` ← `ide-extension`（manifest、注册表、记账、能力模型，不依赖 wasmtime）←
各领域 crate（实现扩展点）与 `ide-plugin`（Wasm 运行时）← `ide-host`（组装）。

### 放置规则

现在就定下来，不等到远程阶段：

1. **Wasm 一律运行在项目所在机器**（本地项目在本机，远程项目在 `openidea-server`）。
2. **UI 只做声明投影**：插件不直接接触 WebView，视图树和用户事件通过协议往返。
3. **`Placement` 属于扩展点，不属于插件**：`Ui` 类声明（菜单、键位、主题、图标）投影到客户端；
   `Workspace` 类声明（语言、LSP、运行配置）在宿主侧生效。
4. **只有本机才有的能力走本地代理**：`secrets` 存在客户端的系统钥匙串，宿主按需转发；
   `net` 从项目所在机器发出（与 LSP 一致），在授权页上注明。
5. 编辑路径 Provider 在远程模式下的预算另计网络往返，单独设指标。

## 4. 关键设计

### 4.1 扩展点

```rust
pub trait ExtensionPoint: Send + Sync {
    fn id(&self) -> &'static str;                 // "languages"
    fn placement(&self) -> Placement;             // Ui | Workspace
    /// 只解析和校验，无副作用；同时算出这条声明需要的能力。
    /// Ui 类扩展点也在这里做完全部校验（JSON schema），前端投影不允许失败。
    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String>;
}

pub struct Prepared {
    pub capabilities: Vec<Capability>,            // 带 LSP 的语言 → process:<binary>
    pub commit: Box<dyn FnOnce() -> Result<Disposable, String> + Send>,
}
```

- 原子生效：全部 `prepare` 成功才开始 `commit`；任一 `commit` 失败，把已 commit 的 `Disposable` 逆序撤销。
- 前后端一致：所有校验都在 Rust 侧完成，前端只做投影。投影抛错时记为缺陷，不做部分生效。
- 干净卸载：贡献记在所属插件名下，禁用或卸载时统一 dispose。
- 前向兼容：不认识的 `contributes.<point>` 告警并跳过，不让整包失败。
- 前端投影：`defineUiPoint("menus", decl => registerMenuGroup(...))`，复用现有注册函数；
  `when` 条件交给 `src/platform/context.ts` 求值。
- `LanguageRegistry` 改为“内置 + 插件覆盖层”的可变结构；内置 `languages/*.toml` 走同一扩展点。

### 4.2 能力分级

按实现形式分：

| 级别        | 形式                        | 用途                                                      |
| ----------- | --------------------------- | --------------------------------------------------------- |
| L0 声明     | 纯数据                      | 主题、图标主题、语言、片段、键位、模板、设置 schema、i18n |
| L1 逻辑     | Wasm 组件                   | 命令、Provider、事件订阅                                  |
| L2 视图     | 声明式视图树；必要时 iframe | 工具窗、面板、自定义编辑器                                |
| L3 外部进程 | LSP、DAP、CLI               | 语言工具链                                                |

按风险分（决定授权页怎么展示）：

| 风险 | 能力                                                                 | 授权方式                                     |
| ---- | -------------------------------------------------------------------- | -------------------------------------------- |
| 低   | `project.read`、`editor.read`、`storage`、事件订阅（不含按键）       | 安装页列出，一次确认                         |
| 中   | `editor.write`、`vcs.write`、`net:<host>`、`secrets`、按键与输入事件 | 安装页单独列出并说明用途                     |
| 高   | `process:<binary>`、`fs.read:<项目外路径>`                           | 单独弹窗，明确提示“等同于在本机执行任意代码” |

`process:<binary>` 说明：

- 它是完全的代码执行权限，参数无法有效限制（例如 `git -c core.sshCommand=...`），不把它包装成细粒度权限。
- 二进制在授权时按绝对路径解析并写入账本；运行时路径或文件哈希变化要重新确认。不在运行时按 PATH 查找，
  防止仓库在 PATH 前面放同名程序冒充。
- 声明也算能力：带 `language-servers.command` 的语言包同样需要 `process:` 授权，否则语言注册修好后就成了沙箱绕过口。

`net:<host>` 由宿主的 HTTP 客户端实现，每一跳重定向都校验主机；不向插件暴露原始 socket。

默认用声明式视图树（tree、list、form、toolbar），由 `src/ui` 渲染，自动跟随主题和无障碍规范。
iframe 只用于富内容：严格 CSP、仅 `postMessage`、不暴露 Tauri API。第三方代码不进主 WebView。

### 4.3 WIT API

开发期版本号用 `openidea:plugin@0.2.0`，**P8 远程验收通过后才定为 1.0**（已于 P8 冻结为 `1.0.0`）。
视图和远程两块最可能逼出破坏性改动，提前承诺 1.0 没有意义。
目前只有样例和主题包，0.1 不写适配层；0.2.x 期间允许破坏性修改；1.0 之后 minor 只做增量，major 由宿主保留旧版适配。

```wit
package openidea:plugin@0.2.0;

interface workspace { resource project { root: func() -> string;
    read-file: func(path: string) -> result<string, error>; } }
interface editor    { resource text-editor {
    apply-edits: func(version: u64, edits: list<text-edit>) -> result<_, error>; } }
interface syntax    { resource tree { node-at, query, errors } parse: func(path) -> result<tree, error>; }
interface index     { find-symbols, symbols-named, find-files, lookup /* 插件自定义索引 */ }
interface events    { subscribe: func(kind: event-kind) -> subscription; }
interface tasks     { resource task { report: func(done: u32, total: option<u32>);
                                      is-cancelled: func() -> bool;
                                      cancelled: func() -> pollable; } }
// 另有 ui、vcs、net、process、storage、secrets

interface commands  { run: func(id: string, ctx: borrow<invocation>, arg: option<string>)
                        -> result<option<string>, error>; }
// 可选导出：code-actions、completion、inline-completion、run-detector、view-provider、
//           syntax-provider、indexer …
```

`syntax`、`index`、`tasks` 的定稿与理由见 `docs/plugin_p0.md` 第 3、4 节。

- 窗口和项目作为句柄传入，去掉隐式的 `Invocation` 调用态。
- P5 实施的偏差：`events.subscribe` 不返回 `subscription` 资源，订阅记在宿主、会话内有效，因为实例会被
  空闲回收而订阅要继续生效（`on-event:<kind>` 声明同样效果）；`tasks.task` 暂无 `cancelled() -> pollable`，
  调用是同步的线程 actor，`is-cancelled` 轮询即可，等 P6 流式接口一起加；guest 侧语法提供者用只导出
  `syntax-provider` 的 `syntax` world 与 `plugin` 合并（wit-bindgen 对同一导出接口会生成重名宏）。
- P6 实施的偏差：Provider 不靠探测可选导出，而由 manifest `[[contributes.providers]]` 声明种类和语言，
  宿主只调用声明匹配的插件（未匹配的不加载）；导出放在 `providers` 接口、`plugin-providers` world。
  `net.fetch` 一次返回完整响应（≤ 8 MiB），没有流式 body；内联补全的取消由宿主中断调用完成
  （`call_cancellable`，宽限 250ms），仍不需要 `pollable`。密钥不经 guest：请求头写 `{{secret:<name>}}`，
  宿主发出前替换（这就是“本地代理”的做法）；远程项目里由服务器按需向桌面端请求。
- 权限失败返回 `error::denied`，不再 trap，插件可以降级运行。
- 安装时读取组件 import 列表并与 manifest 比对，使用了未声明接口的拒绝安装。
- 编辑带文档版本号，版本不符返回 `error::stale`，由插件决定重试。
- 坐标继续遵守 0 基行号和 UTF-16 列。

### 4.4 Manifest

```toml
id = "acme.rust-tools"              # 带发布者命名空间
version = "1.2.0"
engines.openidea = "^0.2"
wasm = "plugin.wasm"
activation = ["on-language:rust", "on-command:acme.check"]

[capabilities]
required = ["project.read", "editor.write"]
optional = ["net:crates.io", "process:cargo"]

[[contributes.commands]]
id = "check"
title = "%check.title%"

[[contributes.menus]]
menu = "editor.context"
command = "check"
when = "editorLang == rust"         # 由 src/platform/context.ts 求值

[[contributes.languages]]
path = "languages/rust.toml"

[contributes.settings]
schema = "settings.schema.json"     # 自动生成设置页并接入设置搜索

[[contributes.views]]
id = "crates"
location = "toolWindow.right"
```

菜单、键位、状态栏只靠声明显示，用户首次触发时才激活插件。
激活事件：`on-command`、`on-language`、`on-file`、`on-view`、`on-schedule`、`on-startup-finished`。
`optional` 能力在用户拒绝后插件照常加载，调用时返回 `error::denied`。

### 4.5 运行时

- 启动只读缓存的贡献索引，不实例化 Wasm。
- 用 `Component::serialize` 把编译结果落盘，以 wasm 哈希加引擎版本作为键；引擎升级后后台重新编译。
- ~~调用改为 async~~（P4 实施时改为线程 actor，见下一条）：async 方案要把宿主绑定全部改成 async，
  而一个实例同一时刻只执行一个调用，换来的只是少几个线程。
- 每个活动插件一个 actor 线程独占 `Store`，调用方把任务投进邮箱、在回复通道上等待，不再跨调用持锁；
  软超时由调用方停止等待实现，硬超时和取消由 store 的 `epoch_deadline_callback`（每个 epoch tick 检查
  截止时间和取消标志）中断。fuel 保留作为死循环兜底。空闲回收后线程随之结束。
- 超时与实例复用（P0 已验证）：丢弃 future 后实例被 wasmtime 标记为不可再进入，必须重建；从 `InstancePre`
  重建约 50µs。编辑路径 Provider 用“软超时丢结果、硬超时才重建”的两段式，目的是保留实例状态；
  用户主动取消优先走协作式取消（`task.is-cancelled` / `cancelled()`），宽限期后再硬取消。
- 分级预算：编辑路径 Provider 软超时 50ms（丢弃结果），硬超时 500ms（重建实例）；命令 5s；
  后台任务时限更长，但必须上报进度。
- 故障恢复：指数退避重启，连续失败才熔断，不再一次 trap 就停用整个会话。
- 空闲后销毁实例，持久状态通过 `storage` 接口保存；`on-schedule` 到点时重新激活，不阻止回收。
- 每插件统计激活耗时、调用延迟、错误数，在设置页显示，并写入 `perf/budgets.json`。

性能预算（P4 已用 release 实测确认，数字见 P4 完成情况）：

| 指标                                        | 初值   |
| ------------------------------------------- | ------ |
| 安装 50 个插件时 `startup.readyMs` 增量     | ≤ 20ms |
| 启动阶段实例化的 Wasm 数                    | 0      |
| 有预编译缓存时单插件冷激活                  | ≤ 30ms |
| 编辑路径 Provider p95（本地）               | ≤ 50ms |
| 编辑路径 Provider p95（远程，扣除网络 RTT） | ≤ 50ms |
| 已回收插件的常驻内存                        | 0 实例 |

### 4.6 信任与授权

- 授权账本：记录插件 id、版本、包哈希、已授权能力，以及高风险能力对应的二进制绝对路径和文件哈希。
- 安装时展示能力清单，确认结果写入账本；更新后能力有增加时要重新确认，能力不变时静默升级。
- 项目插件 `.openidea/plugins/*`：项目受信只是前提，每个插件还要单独确认后才加载。
  首次迁移标为受信的项目也遵守这一条。
- 开发插件：“链接开发插件”按**目录路径**授权，不按包哈希授权，避免每次构建都弹窗；能力有增加时仍然重新确认。
- 已安装插件“声明即授权”的旧行为，在账本上线时一次性迁移：已有插件只自动授予低风险能力，其余首次使用时再确认。

### 4.7 分发

- 包格式：单文件 zip，内含 manifest、wasm、资源、签名。
- 签名：Ed25519。信任根是官方索引里登记的发布者公钥；发布者的 id 前缀（`acme.`）与公钥绑定；
  发布者自行轮换密钥，旧密钥签发的版本继续有效，直到被吊销。
- 未签名包：只能通过“从文件安装”或“链接开发插件”安装，安装页显示明确警告。
- 吊销：静态索引附带吊销和下架列表，宿主每天检查一次；命中的插件禁用并通知用户。
- 目录：`plugins/<id>/<version>/` 加 active 指针，支持原子升级和回滚；数据放 `data/<id>/`。
- 市场：静态索引（Git 仓库 + JSON + CDN）。

### 4.8 SDK 与工具

“只走公开 SDK”是验收前提，所以 SDK 本身就是交付物：

- `openidea-plugin` Rust crate：封装 wit-bindgen 生成的绑定，提供命令、Provider、视图的辅助类型。
- 脚手架：`new`（模板）、`build`（组件化并校验 import 与 manifest 一致）、`link`（链接开发插件）、`pack`（打包与签名）。
- mock host：插件作者在 `cargo test` 里不启动 IDE 就能测命令和 Provider。
- 官方插件全部使用这套工具构建，宿主测试也通过 mock host 覆盖。

### 4.9 否决的方案

| 方案                                 | 否决原因                                           |
| ------------------------------------ | -------------------------------------------------- |
| JS 扩展宿主进程                      | 没有真正的沙箱，要多维护一个 Node 进程，API 面巨大 |
| 第三方 JS 直接进主 WebView           | 能调用全部 Tauri IPC，完全绕过权限                 |
| Rust `dylib` 原生插件                | ABI 不稳定，没有隔离                               |
| 第一方 feature 全部插件化            | 大量重写，换不来用户价值                           |
| 通用 JSON-RPC `handle(method, json)` | 丢掉类型安全和 WIT 契约                            |
| 一开始就定为 API 1.0                 | 视图和远程没验证，大概率要破坏性修改               |
| `process:` 运行时按 PATH 解析        | 仓库可以在 PATH 前面放同名程序冒充                 |

代价：Wasm 生态较小。可提供 TS SDK（`jco componentize`）缓解，但单包体积会明显增大。

## 5. 实施阶段

每阶段都可以单独发布。从 P3 起，每阶段的验收同时在本地和远程项目上运行。

### P0 验证

- [x] 验证 wasmtime 49 能否按接口绑定可选导出；不行就退回“基础 world + 多个组合 world”（可以，按接口绑定）
- [x] 验证 async 调用：epoch 让出、丢弃 future 取消、**取消或超时后实例能否复用**（不能复用，重建约 50µs）
- [x] 验证 WASI p2 上的流式和任务模型（`pollable` + `task` 资源），API 不依赖 p3
- [x] Solidity、MyBatis Navigator 最小原型，基于 `ide-syntax` 和 `ide-index` 定稿 `syntax`、`index` 接口
- [x] 修正 `plugins/README.md` 中不生效的语言能力说明

结论见 `docs/plugin_p0.md`。

验收：四个验证项都有书面结论；结论推翻了第 4 节设计的，先改文档再进入 P1。

### P1 内核

- [x] 新增 `ide-extension`：manifest、`ExtensionPoint`、注册表、记账、commit 失败回滚
- [x] 迁移命令、主题、语言到扩展点
- [x] 前端贡献投影层，`when` 接入 `src/platform/context.ts`
- [x] 宿主移入 `ide-host`，`src-tauri` 只保留适配
- [x] 安装改为先写临时目录、再原子替换，不先删旧版
- [x] SDK crate、`new`/`build`/`link` 脚手架、mock host
- [x] 官方插件：Material Icons

验收：现有 `crates/ide-plugin/tests/host.rs` 场景全部通过；新增 `iconThemes` 不改内核；
Material Icons 用 SDK 脚手架构建。

完成情况：`host.rs` 迁为 `crates/ide-host/tests/plugins.rs`，原场景全部保留并通过，`hello` 改用 SDK
重新构建；`iconThemes` 只在 `ide-host/src/plugins/{icons,points}.rs` 注册，`ide-extension` 未改。
SDK 在 `sdk/rust/openidea-plugin`（`Plugin` trait、`register_plugin!`、原生目标上的 `mock::MockHost`）；
脚手架是 `ide-host` 的第二个二进制 `openidea-plugin`（`new --template command|theme|icon-theme|language`、
`build`、`check`、`link`/`unlink`/`links`），`check` 走与安装相同的校验并拒绝导入 WIT 以外接口的组件。
Material Icons 在 `plugins/official/material-icons`，由 `new --template icon-theme` 生成，
106 个原创图标，文件夹图标同样生效（有角色的目录保留内置图标）。规模测试：3000 个 SVG 的主题
安装约 1.2s、启动加载约 0.28s（release；debug 为 1.7s / 0.6s），启动时逐个重新净化，P4 的贡献索引缓存应消除这部分。

### P2 授权

- [x] 授权账本、安装确认页、能力变更时重新确认
- [x] 项目插件逐个确认；开发插件按路径授权
- [x] 已安装插件的授权迁移
- [x] 风险分级展示；`process:` 绝对路径解析和哈希校验

验收：打开受信仓库时，未确认的项目插件一律不执行；能力增加时要求重新确认；
替换授权过的二进制后，调用被拒绝并提示重新确认。

完成情况：账本在 `ide-extension/src/ledger.rs`（`grants.json`，按已安装 id 或目录路径记账）；三条验收
分别由 `plugins.rs` 的 `untrusted_or_unconfirmed_project_plugins_never_run`、
`new_capabilities_require_consent_again`、`replaced_binaries_are_refused` 覆盖。0.1 授权只自动迁移低风险能力，
其余在首次调用时弹出确认（`ConsentRequested`）。语言声明推导出的 `process:` 视为可选，拒绝后语言照常可用。

### P3 语言全链路

- [x] `LanguageRegistry` 覆盖层，插件语言进入语言检测和 LSP
- [x] LSP、DAP 声明，接入 `process:` 授权
- [x] 插件提供语法树
- [x] 开放 `ide-run` 的运行配置检测
- [x] 官方插件：Solidity

验收：纯声明插件能启动语言服务器，本地和远程都可用；拒绝 `process:` 后语言高亮照常、LSP 不启动；
把一个内置语言定义迁成插件，跑通 DAP。

完成情况：

- **覆盖层**：`LanguageRegistry::attach_plugins` 挂上 `PluginLanguages`，按 revision 惰性重建，项目 fork 自动跟随；
  内置和用户定义在 id、扩展名、文件名上都优先，插件不能抢占。插件语言变化时发 `LanguagesChanged`，
  宿主重新检测已打开文档、重配 LSP，前端刷新语言表。
- **`process:` 授权**：服务器和调试器只在授权后出现在有效配置里，并带 `ProgramPin`（授权时的绝对路径
  - blake3）；`ide-lsp`、`ide-dap` 启动前校验，文件被替换即拒绝（`PermissionDenied`）。用户在
    Settings › Language Servers 自己改了命令则不再受插件授权约束。
- **远程**：客户端把插件语言和已授权程序名经 `plugin_sync_languages` 推给 `openidea-server`，服务器在本机
  `PATH` 上解析并钉住（`plugin-pins.json`），撤销授权即删除钉住；连接建立和语言/授权变化时同步。
- **语法树**：WIT 新增可选导出 `syntax-provider`（`plugin-syntax` world，扁平 token/symbol/fold，UTF-8 字节偏移）；
  运行时按接口绑定，旧组件不受影响；`ide-language` 的 `ExternalSyntax` 在没有内置 grammar 时接管，
  结果按文档版本缓存；SDK 提供 `SyntaxProvider` 和 `register_plugin!(T, syntax)`。远程项目暂不运行插件 Wasm（P4/P5）。
- **运行配置**：`ide-run` 的 `ExternalDetection` 钩子 + `runDetectors` 扩展点（标记文件 → 命令），
  命令同样是 `process:` 能力，启动前校验钉住的程序。
- **Solidity**：`plugins/official/solidity`，SDK 构建，手写词法器提供高亮、结构视图、折叠；声明
  Nomic Foundation 语言服务器和 `solc --lsp`（回退），Foundry / Hardhat 运行配置。
- **DAP 迁移**：`ide-dap` 测试把内置 `gdscript.toml` 作为插件语言加载（无内置定义），经钉住的程序跑通调试会话，
  替换程序后拒绝启动。

### P4 运行时

- [x] 贡献索引与惰性激活
- [x] 预编译缓存
- [x] ~~async 调用~~线程 actor、分级预算、熔断、空闲回收
- [x] 每插件统计；4.5 节的预算写入 `perf/budgets.json`

验收：安装 50 个插件时达到 4.5 节预算，启动不实例化 Wasm。

完成情况：

- **贡献索引**：`ide-extension::ContributionIndex`，已安装副本（有 `.package-hash`）的 UI 声明校验结果按
  包哈希 + 扩展点 + 声明 + IDE 版本落盘（`plugins/.cache/contributions`），启动直接复用，不再逐个净化 SVG；
  链接和项目插件不进索引。后台预热时清理不再使用的条目。
- **预编译缓存**：`PluginEngine::compile_cached`，键为模块 blake3 + `precompile_compatibility_hash`
  （`plugins/.cache/components`），安装校验时顺带写入，启动完成后后台补齐并清理。
- **运行时**：`ide-plugin::Actor`（见 4.5），`Limits` 增加 `edit_soft`/`edit_hard`/`restart_backoff`/
  `max_failures`/`idle_timeout`。trap 后丢弃实例，下次使用时按 1s、2s… 退避重建，连续 3 次才标记 Failed；
  正常返回即清零。用户取消（`PluginHost::cancel`）不计入熔断。`PluginHost::tick`（桌面端每 5s）
  负责回收空闲 5 分钟的实例、上报无人等待的崩溃、触发到期的 `on-schedule`（激活后照样会被回收）。
  “从 InstancePre 重建”改为从预编译缓存重新实例化，冷激活同样很便宜，回收后不必常驻已编译组件。
- **统计**：激活次数与耗时、调用数、错误数、最慢与近 128 次 p95、崩溃、编辑路径超时、回收次数，
  设置页显示。`crates/ide-host/benches/plugins.rs` 测 50 个插件启动加载、冷激活、编辑路径调用，
  预算在 `perf/budgets.json` › rust › `plugins/*`，`pnpm perf:rust` 检查。
- **实测**（2026-11-01，release bench profile，Apple Silicon，`cargo bench -p ide-host --bench plugins`，
  criterion 均值及 95% 区间）：

  | bench id                                       | 实测                   | 预算 (`perf/budgets.json`) | 占比 |
  | ---------------------------------------------- | ---------------------- | -------------------------- | ---- |
  | `plugins/load_50`（50 插件建宿主 + 加载）      | 16.93ms（16.51–17.49） | 20ms                       | 85%  |
  | `plugins/cold_activation`（预编译，激活+调用） | 0.313ms（0.293–0.337） | 30ms                       | 1%   |
  | `plugins/syntax_highlights_2k_lines`           | 1.69ms（1.67–1.73）    | 50ms                       | 3%   |

  50 插件为 20×hello、10×solidity、10×material-icons、10×纯声明插件；启动不实例化 Wasm 由 bench 内断言保证。
  三项均在预算内，验收通过。预算值不收紧：`load_50` 已占 85%，另两项是面向用户的体验上限而非回归门限，
  余量留给更慢的机器和远程场景。`load_50` 量的是插件宿主加载耗时，作为 `startup.readyMs` 增量的上界近似；
  语法高亮测的是整篇 2k 行单次调用，比编辑路径的单次 Provider 调用更重。

### P5 事件与任务

- [x] WIT 拆分、资源句柄、事件、任务、存储、VCS
- [x] 带版本校验的编辑接口
- [x] `hello` 迁移到 0.2 API
- [x] 官方插件：String Tools、Key Promoter、Git Toolbox

验收：三个插件只用公开 SDK 完成；Git Toolbox 的定时 fetch 在空闲回收后仍能按时触发。

完成情况：

- **WIT 0.2**（`wit/`，按接口分文件）：`types`（`error` 变体）、`log`、`contributions`、`ui`（通知、状态栏项）、
  `storage`、`workspace`（`project` 资源、`projects()`）、`editor`（`text-editor` 资源）、`invocation`、`vcs`、
  `events`、`tasks`；导出 `lifecycle`、`commands`（`run(id, borrow<invocation>, arg)`）、`event-handler`，
  可选 `syntax-provider`。缺能力一律返回 `error::denied`，不再 trap。0.1 组件不再运行（无适配层，见 4.3）。
- **编辑**：`apply-edits(version, edits)` 在宿主经 `Documents::apply_edits_at` 于文档锁内比对版本，
  不符返回 `stale`；成功即一次 `DocPatched`，编辑器里是一步撤销。命令调用时前端带上焦点编辑器的路径、
  语言和选区（UTF-16 列）。
- **事件**：前端按插件关心的种类（`plugin_event_kinds`）上报打开/保存文件、焦点编辑器、动作（带来源和快捷键）、
  仓库变化；宿主按插件和窗口排队，运行中的插件即时投递，空闲插件攒 2s 再唤醒。订阅经 `subscribe` 或
  manifest `on-event:<kind>`，整个会话有效、跨空闲回收。`on-schedule` 到点投递 `scheduled`。
- **任务**：`tasks.begin` 进入前端后台任务列表（可取消，取消同时取消宿主侧的 fetch），打开任务的调用改用
  60s 后台预算；任务不跨调用。
- **存储**：`plugins/.data/<id>/storage.json`，1 MiB，卸载时删除。**VCS**：`ide-vcs` 读状态，fetch 仅在受信项目。
- **SDK**：`Invocation`/`Project`/`TextEditor`/`Task` 句柄、`transform_selections`、`text` 坐标工具；
  mock host 有带版本的编辑器、存储、订阅、任务、VCS。脚手架模板随之更新。
- **官方插件**（`plugins/official/`）：String Tools 26 条命令分 4 组、多光标一步撤销；Key Promoter 由
  `on-event:action-performed` 激活、计数存 storage；Git Toolbox `on-schedule:300` 抓取所有项目、状态栏显示
  分支和 ↑↓。宿主端到端测试 `official_*`，验收由 `official_git_toolbox_fetches_on_schedule_after_idle_reclaim`
  （本地 bare 远端、回收后 `tick` 到点、状态栏变为 `main ↓1`）覆盖。

### P6 Provider 与网络

- [x] 通用 Provider：诊断、快速修复、补全、内联补全、导航、行标记
- [x] 网络、密钥（经本地代理）、一次性进程
- [x] 官方插件：Checkstyle、AI Completion、MyBatis Navigator

验收：三个插件只用公开 SDK 完成；AI Completion 在连续输入时旧请求能被取消，达到编辑路径预算；
Checkstyle 在远程项目上读到的是远端文件。

完成情况：

- **WIT**：新增 `io.wit`（`diagnostics.publish`、`net.fetch`、`secrets.is-set`、`process.run`）、
  `providers.wit`（`completion`、`inline-completion`、`code-actions`、`definition`、`line-markers`），
  `workspace.project.find-files`（`ignore` + glob，遵守 `.gitignore`）。偏差见 4.3。
- **Provider**：manifest `[[contributes.providers]] kinds/languages` 声明；宿主 `provide_*` 分发，
  结果并入现有 LSP 操作（补全列表、⌥⏎ 快速修复、⌘B、内联补全），新增 `plugin_line_markers` 操作和编辑器
  行标记栏（有标记时才出现）。编辑路径走 50ms 软 / 500ms 硬预算；内联补全不受 50ms 限制，但请求被取代即中断。
- **网络**：共享 reqwest 客户端；仅 https（`localhost` 可 http）、按 `net:<host>` 授权、拒绝跨主机重定向、
  8 MiB 上限、随调用取消。**密钥**：`[[contributes.secrets]]` 在 设置 › 插件 中录入，存 macOS 钥匙串
  （其他平台为 0600 文件）；guest 读不到值。**进程**：只运行 `process:` 授权时固定的程序（路径 + 哈希），
  工作目录为受信项目根，4 MiB 输出，取消或超时即杀。**诊断**：按插件和文件替换，进 Problems 视图。
- **远程**（放置规则 1、4）：`openidea-server` 内置插件宿主（`plugins::remote_host`）。桌面端在连接时和插件
  变化后（800ms 防抖）同步已启用的代码插件：先发摘要和授权，再只上传服务器缺少的包；服务器按桌面端授权
  记录，`process:` 在服务器 `PATH` 上解析并固定。窗口的运行时命令（运行命令、事件、状态栏项、任务、行标记）
  与桌面命令同名，远程窗口自动路由到服务器；插件事件以 `plugin` 通知回到该窗口；密钥由服务器以
  `plugin_secret` 请求向桌面端按需索取。项目插件（`.openidea/plugins`）暂不在远程运行，服务器侧 storage
  与桌面端不同步。
- **官方插件**：AI Completion（Ollama / OpenAI，密钥只发往 api.openai.com）；Checkstyle（保存时检查，
  新保存取消旧任务，三种快速修复，项目级配置 `checkstyle.xml` / `config/checkstyle/checkstyle.xml` 优先）；
  MyBatis Navigator（接口 ↔ XML 跳转、行标记、XML 中 statement id 补全）。
- **验收**：`official_ai_completion_cancels_superseded_requests`（连续输入时旧请求在宽限内被中断，结果在编辑
  路径预算内）；`official_checkstyle_checks_on_save`；`official_mybatis_navigates_between_interface_and_xml`
  （p95 远低于 50ms）；远程验收由 `remote_projects_run_the_desktops_code_plugins_on_the_server` 覆盖：
  经远程协议同步 Checkstyle 与 AI Completion，保存只存在于服务器上的文件，Checkstyle 在服务器上运行并读到该
  文件，诊断经协议回到客户端；密钥向客户端索取；桌面端停用后服务器卸载。

### P7 UI 贡献

- [x] 菜单、键位、状态栏、设置 schema
- [x] 声明式视图、自定义编辑器
- [x] 最后做 iframe
- [x] 官方插件：Kubernetes、CSV Editor

验收：示例插件能做出带树视图的工具窗；CSV Editor 与文本视图双向同步并共享撤销；
两个插件在远程项目上都可用。

完成情况：

- **L0 声明**（`plugins::ui_points`，全部在 Rust 侧校验，前端只投影）：`menus`（编辑器、项目视图、编辑器标签
  的上下文菜单，以及原生 Tools 菜单的动态槽 `pluginTools`）、`keymaps`（插件默认键位排在预设和用户覆盖之下，
  已被占用的按键丢弃；必须带 Ctrl/Alt/Meta 或功能键）、`statusBar`（声明即显示，代码用同 id 的
  `set-status-item` 更新）、`settings`（JSON schema 子集：boolean/string/number/integer、enum、默认值；生成
  设置页、进设置搜索、项目可覆盖；值存在 `Settings.plugins[<id>]`，插件经 `settings.get` 读取，类型不符回落到默认值）。
  菜单、键位、状态栏只能引用本插件声明过的命令。
- **L2 视图**（`wit/views.wit`）：视图是数据——工具栏、body（tree、list、form、table、message、html）、状态行；
  可选导出 `view-provider.render/handle`，用户操作以 `view-event` 回传，代码用 `views.refresh` 请求重绘。
  WIT 不能递归，树是带 `parent` 的扁平列表，`expandable` 的节点展开时才取子节点；表格只取可见行（`viewport`），
  大文件不整体传输。`views` 成为工具窗，显示即激活（`on-view`）。
- **自定义编辑器**：`customEditors` 按文件名模式接管打开（`option` 只出现在 Open With）；编辑器标签挂到该文件的
  共享文档上（`attachDocument`），插件经带版本的 `apply-edits` 改文档，所以文本标签同步显示、撤销是同一条
  历史（有文本标签时记在它那里，否则记在自定义编辑器自己的历史），保存、脏标记、关闭提示都走文档；
  “Open as Text” 打开文本编辑器。
- **iframe**：`html` body 放进 `sandbox="allow-scripts"`（不透明源）的 `srcdoc`，CSP 只允许内联脚本、样式和
  `data:` 图片，无网络、无 IDE API；只经 `openidea.postMessage/onMessage` 与插件交换消息（`view-event::message`、
  `views.post-message`）。边界：声明式 body 能表达的一律用声明式，html 只用于富内容。
- **终端**：`views.open-terminal(title, program, args)` 在调用窗口打开终端标签运行 `process:` 固定的程序，
  长连接流（`kubectl logs -f`）和交互会话（`kubectl exec -it`）都走它，不另加流式进程接口。
- **远程**：`plugin_view_render`、`plugin_view_event` 与桌面命令同名，远程窗口路由到服务器；`viewChanged`、
  `viewMessage`、`openTerminal` 经 `plugin` 通知回到窗口，终端在服务器上运行。
- **官方插件**：CSV Editor（RFC 4180、引号与换行、短记录补齐、插入/删除行、表头与分隔符设置、按版本缓存解析）；
  Kubernetes（命名空间 → Pods/Deployments/Services 逐级加载、状态摘要、日志和 shell 在终端、context/
  命名空间/日志行数/shell 设置、Tools 菜单刷新）。`hello` 增加带树视图的工具窗和菜单、键位、状态栏声明。
- **验收**：`sample_plugin_tool_window_with_a_tree`（声明在代码加载前就列出，显示即激活，展开触发 refresh，
  停用后声明全部撤销）；`official_csv_editor_edits_the_shared_document`；`attachment.test.ts` 的共享撤销用例
  （无文本标签与有文本标签两种情况）；`official_kubernetes_browses_the_cluster_and_opens_logs`；远程验收
  `remote_projects_get_plugin_views_and_custom_editors`（表格编辑的是服务器上的文档，集群用服务器的 kubectl，
  日志终端开在远程窗口）。

### P8 分发与 1.0

- [x] 包格式、签名、发布者公钥登记、吊销列表
- [x] 版本目录、原子升级、回滚
- [x] 静态市场索引与市场页
- [x] 冻结 WIT，发布 `openidea:plugin@1.0.0`

验收：升级失败能自动回滚；命中吊销列表的插件被禁用；10 个官方插件只改 `engines.openidea` 和 WIT 包版本即可切到 1.0。

完成情况：

- **包与签名**（`ide_extension::package`）：`<id>-<version>.oiplugin` 是 zip（manifest、声明引用的文件、组件、
  许可证文件、可选的 `SIGNATURE.json`）；解包拒绝越界路径、链接和超限内容。签名是 Ed25519，签的是
  `openidea-plugin/1\n<id>\n<version>\n<摘要>`，摘要覆盖 manifest 与包内文件。`openidea-plugin keygen`、
  `pack --key --publisher`、`index`（由一批包生成索引，保留已有吊销和旧公钥）。
- **信任与吊销**：静态索引（`index.json`，格式 1）登记发布者及其公钥（信任根；发布者 `acme` 只能发布
  `acme.*`）、插件条目（含摘要）和吊销（某些版本或全部版本；公钥可标为吊销）。签名不成立（被改过、
  不是该发布者的公钥、越权前缀、公钥已吊销）的包拒绝安装；无签名包从磁盘安装时提示。宿主保存最近一次读到
  的索引（`market-index.json`），启动时、每次刷新（桌面端每天一次）都重新评估：命中的插件停用并给出原因、
  通知用户，`set_enabled` 无法绕过；解除吊销后自动恢复。
- **版本目录与回滚**（`plugins::install`）：`<plugins>/<id>/<version>/` 加 `active`、`previous` 指针，新版本
  写完后才原子替换指针；更新后**新版本代码首次启动失败**（实例化失败、`activate` 出错或 trap）时自动回滚到
  被替换的版本、删掉失败的版本、恢复旧的授权记录并通知用户；加载即失败的更新在安装时就回滚。设置页可手动
  “回滚到 …”。旧的平铺安装在下次更新时迁入版本目录；中断的迁移由 `recover` 复原。
- **市场页**：设置 › 插件 › Available 填入索引 URL（`https://…/index.json` 或本地路径）后列出市场插件，
  安装/更新时下载、对照索引条目核对摘要和发布者签名，再走同一个授权安装页；已安装插件显示“由 … 签名 /
  未签名”。没有配置市场时仍显示本机可用的包。
- **冻结 WIT 1.0**：包名改为 `openidea:plugin@1.0.0`，宿主 `ENGINE_VERSION`/`API_VERSION` 为 1.0；0.x 组件
  不再运行（与 4.3 的约定一致：1.0 之后 minor 只做增量，major 由宿主保留旧版适配）。
- **验收**：`a_failing_update_rolls_back_automatically`（`2.0.0-broken` 首次启动失败 → 回到 1.0.0、失败版本
  删除、用户收到通知、之后正常；成功的更新可手动回滚；重启后仍是生效版本）；
  `signed_marketplace_plugins_install_and_revocations_disable_them`（签名安装、篡改与越权签名被拒、版本吊销
  与公钥吊销都会停用且重启后仍生效、解除后恢复）；`installs_from_before_versioning_keep_working_and_move_on_update`；
  10 个官方插件的源码未改，只把 `engines.openidea` 改为 `^1.0`、用 1.0 的 SDK 重新构建，`openidea-plugin
  check` 全部通过，宿主与远程测试全部通过。

## 6. 官方验证插件

第二列是功能原型，不进入产品名、代码和提交信息；不移植原插件的代码。

| #   | 官方插件          | 功能原型                           | 级别    | 主要检验                                                                         | 阶段             |
| --- | ----------------- | ---------------------------------- | ------- | -------------------------------------------------------------------------------- | ---------------- |
| 1   | Material Icons    | Atom Material Icons                | L0      | 新扩展点只需一处注册；上千个 SVG 的净化、包体积、首屏加载；SDK 脚手架            | P1               |
| 2   | Solidity          | Solidity                           | L0 + L3 | 声明式语言包走通 LSP；`process:` 授权；开放 `detect_*`；插件语法树               | P0 原型，P3 完成 |
| 3   | String Tools      | String Manipulation                | L1      | 大量命令声明和菜单分组；未激活也能显示；多光标编辑合并撤销；SDK 体验             | P5               |
| 4   | Key Promoter      | Key Promoter X                     | L1      | 高频事件批量投递，避免频繁唤醒；按键事件属于中风险授权；持久化统计               | P5               |
| 5   | Git Toolbox       | GitToolBox（不含内置已有的 blame） | L1 + UI | 定时 fetch 与空闲回收的配合；VCS 读写权限；状态栏刷新                            | P5               |
| 6   | Checkstyle        | CheckStyle-IDEA                    | L1 + L3 | 一次性进程；诊断和快速修复；保存时触发并取消旧任务；项目级设置；远程             | P6               |
| 7   | AI Completion     | GitHub Copilot                     | L1      | 按键级延迟和取消；流式网络；密钥经本地代理；内联补全从 LSP 专用改为通用 Provider | P6               |
| 8   | MyBatis Navigator | MyBatisX                           | L1      | Mapper 与 XML 互跳、行标记、基于 `ide-index` 的跨文件索引、SQL 补全              | P0 原型，P6 完成 |
| 9   | Kubernetes        | Kubernetes                         | L2 + L3 | 声明式树视图的能力上限；日志长连接流；`kubectl exec` 接内嵌终端；项目外访问授权  | P7               |
| 10  | CSV Editor        | CSV Editor                         | L2      | 自定义编辑器双向同步、共享撤销、大文件；划定声明式视图与 iframe 的边界           | P7               |

候补：Grep Console（运行控制台过滤，首选）、Translation（简单网络场景）、PlantUML（预览 + 外部渲染）。
DAP 不在这 10 个之内：P3 把一个内置语言定义迁成插件来测。

### 验收规则

1. 只用公开 SDK：代码放在 `plugins/official/`，不依赖内部 crate，宿主里没有按插件 id 判断的逻辑。
2. 缺 API 就加通用扩展点，并记录有没有第二个使用者；只有一个使用者的 API 要重新审视。
3. 10 个全部安装后，启动不实例化 Wasm，指标符合 4.5 节预算。
4. 自动化测试覆盖禁用和卸载：菜单、视图、语言、进程都清理干净。
5. 每个插件都跑 panic、超时、拒绝授权三类测试：IDE 不受影响，插件能降级运行。
6. 从 P3 起，每个插件都在远程项目上跑一遍。

## 7. 风险与待定项

| 项                                                           | 影响                                   | 处理                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `syntax`、`index` 接口                                       | 决定语言类和框架类插件能否成立         | 已在 P0 定稿（`docs/plugin_p0.md` 第 4 节），P3、P6 实现时验证                                                                            |
| 取消或超时后实例能否复用                                     | 决定编辑路径 Provider 的成本           | P0 结论：不能复用，重建约 50µs；用两段式超时保留状态                                                                                      |
| 可选导出的绑定方式                                           | 影响 Provider 的接入形式               | P0 结论：按接口 `GuestIndices` 绑定                                                                                                       |
| 流式和任务模型                                               | AI Completion、Kubernetes 依赖         | P0 结论：p2 资源 + `pollable` 可行                                                                                                        |
| 远程模式下编辑路径的延迟                                     | 补全类 Provider 在远程项目上可能不可用 | P4 起单独设远程指标；不达标时允许 Provider 声明“仅本地”                                                                                   |
| `on-schedule` 与空闲回收的关系                               | Git Toolbox 依赖                       | P4 实现，P5 用 Git Toolbox 验证                                                                                                           |
| 项目外文件访问：`fs.read:<path>` 还是只给 `process:<binary>` | 影响能力模型                           | 已定（P7）：Kubernetes 只要 `process:kubectl`，kubeconfig 由 kubectl 自己读，插件不读项目外文件；`fs.read` 仍保留为高风险能力，暂无使用者 |
| 发布者密钥丢失或泄露                                         | 影响已发布版本的可信度                 | 吊销列表 + 发布者重新登记，P8 写成流程文档                                                                                                |
| Wasm 单包体积（尤其 TS SDK）                                 | 影响分发和内存                         | P4 纳入性能预算观测                                                                                                                       |
