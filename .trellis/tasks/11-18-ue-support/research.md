# Unreal Engine 支持调研：能否插件化 / 项目类型识别 / 拖拽 / Rider 功能缺口

调研对象：`D:\Projects\GithubProjects\openidea`（分支 `feat/unreal-engine-support`，HEAD `c5b50f7f3`）
调研日期：2026-11-20
性质：只读调研，未改任何代码。所有断言均带 `路径:行号`，来自源码/文档实读；未取证处标「未获取到」。

---

## 0. 现场环境（2026-11-21 已更新为源码版引擎）

**当前验证环境（源码版，已就位）：**

| 项                     | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎根                 | `D:\Projects\UE\UE-AS`（2026-11-22 由 `D:\Projects\GameProject\UEProjects\UnrealEngine-Angelscript` 移来，动机是缩短路径避开 Windows 260 字符上限；Angelscript fork，`Engine/Build/Build.version` = 5.8.4，Changelist 0，BranchName `UE5`）                                                                                                                                                                                                                                                       |
| 项目                   | `D:\Projects\UE\UE-AS\Samples\Games\Lyra\Lyra.uproject`，`"EngineAssociation": ""`（**空串 = 就地引擎**，用项目上方的 `Engine/`）                                                                                                                                                                                                                                                                                                                                                                 |
| 引擎自带 .NET SDK      | `Engine\Binaries\ThirdParty\DotNet\10.0\win-x64`，**774.5 MB / 5732 文件，sdk 10.0.203 完整可用**（`cmd /c "<dn>\dotnet.exe" --list-sdks` → exit 0）；该目录被 `.gitignore:171` 忽略                                                                                                                                                                                                                                                                                                              |
| UnrealBuildTool        | 已编出并发布到 `Engine\Binaries\DotNET\UnrealBuildTool\`（`UnrealBuildTool.dll` 3.2 MB + 全部依赖 dll），`BuildUBT.bat` 报 `UnrealBuildTool is up-to-date`                                                                                                                                                                                                                                                                                                                                        |
| `UnrealEditor.exe`     | **已存在**：`Engine\Binaries\Win64\UnrealEditor.exe`（504,320 B，2026-11-22 12:15），同目录还有 **488 个 `UnrealEditor-*.dll`（合计 681.6 MB）**，均为 11-21 那轮编译的产物                                                                                                                                                                                                                                                                                                                       |
| `UnrealEditor.modules` | **缺失**（唯一卡点）。UBT 只在构建完全成功时写这个模块清单，而 11-21 那轮 `[3009/3011]` 卡在 4 个 `LNK1104`（Windows 260 字符路径上限，`link.exe` 不是 long-path-aware）→ 清单没写出来 → 启动即 `Unable to read module manifest ... ModuleManager.cpp [Line: 1842]`、exit code 3。格式见 `Engine\Source\Runtime\Core\Private\Modules\ModuleManifest.cpp`：纯文本，只认 `BuildId` / `Modules`（`模块名 -> dll 文件名`）/ `LibraryDependencies` 三个字段，写任何其它字段都会让 `TryRead` 返回 false |
| 编译速度（实测）       | `D:` 是**机械盘** `ST2000DM008-2FR102`（另有三块 SSD 未用于此任务）→ 全量 4424 action 预计 **10 小时以上**；同时 QQ 多个进程占用 62–73% CPU 时间会再拖慢数倍                                                                                                                                                                                                                                                                                                                                      |

**另有一个已失效的旧环境（仍在注册表里，会导致误判）：** Launcher 版引擎 `F:\Game\Epic\UE_5.x` 已不存在——注册表 `HKLM:\SOFTWARE\EpicGames\Unreal Engine` 的 5.3/5.5/5.6/5.8 四个键 `InstalledDirectory` 全指向该已删除路径（`Test-Path` 全 False），`LauncherInstalled.dat` 仍写 `F:\\Game\\Epic\\UE_5.8`。样例项目 `D:\Projects\GameProject\UEProjects\Arts` 仍用 `EngineAssociation: "5.8"` 依赖它，所以打开 Arts 时**不会有运行配置**——这是正确行为（引擎确实不在），不是代码回归。

**代码侧已修复（commit `f59166443`）**：`crates/ide-workspace/src/unreal/engine.rs` 新增就地引擎解析——`EngineAssociation` 为空/缺失时从项目向上找含 `Engine/Build/Build.version` 的目录，`pick` 的过滤条件从「editor 可执行存在」改为「引擎目录存在」。所以 Lyra 现在即使还没编完，也已能产出 3 条 unreal 配置。

---

## 1. 问题一：UE 这套能不能做成插件？

### 1.1 一句话结论

**能做成插件的是「给 UE 项目加命令、加运行配置、加语言支持」；不能的是「让 IDE 认为这个目录是 UE 项目」。**

原因是插件体系里根本没有「项目类型」这个扩展点，而且插件的沙箱读不到注册表、读不到环境变量、也无法改动内置项目树的可见性。

### 1.2 判定表

| UE 需求                                                             | 插件可做 / 需核心改              | 落点与证据                                                                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三条运行配置（Editor / Game / Server）                              | **插件可做**                     | `wit/run.wit:29-64` 的 `launch-configurations`，`configurations(project-root)` 动态返回完整配置集；字段含 `program/args/cwd/env/debugger`                                                            |
| 调试（attach 到 UE Editor 或游戏进程）                              | **插件可做**                     | `wit/run.wit:33-47`：`debugger.attach-child({kind, command-contains})`，`kind` 可为 `native`；或 `debugger.launch("cpp")` 复用 cpp 语言的 lldb-dap                                                   |
| 只在 UE 项目下出现这三条                                            | 插件可做（近似）                 | `docs/en/plugins/manifest.mdx:124` 的 `runConfigurations.files` + `crates/ide-host/src/plugins/run_detectors.rs:156` 的 `root.join(f).exists()`。**只支持具体文件名，不支持 `*.uproject` 通配**      |
| 引擎自动定位（读注册表 + `EngineAssociation`）                      | **需核心改**（已实现）           | 插件沙箱无注册表：`wit/` 全文无 `registry`，`docs/en/plugins/capabilities.mdx:34-59` 无此项；`wit/plugin.wit:6-10` 明说 no file system / network / environment                                       |
| 项目树默认隐藏 `Binaries`/`Intermediate`/`Saved`/`DerivedDataCache` | **需核心改**                     | `wit/decorations.wit:13,20,25,28` 只能给文件加 badge/style/tooltip/icon，**不能删除条目**；真实排除来源是 `crates/ide-vfs/src/rules.rs:13` 的 `files.exclude` 设置 + `.gitignore`（`rules.rs:2,63`） |
| 「这是 UE 项目」的身份（图标、面板、mode）                          | **需核心改**                     | `crates/ide-host/src/plugins/points.rs:70-100` 是全量贡献点清单，**没有 project type**；全 crates 检索 `project_type`/`ProjectType`/`WorkspaceKind` 无匹配                                           |
| 语言定义（`.uproject`/`.ini`/`.usf`/`.ush`）                        | 插件可做                         | `docs/en/plugins/manifest.mdx:129`、`wit/plugin.wit:50-53`、先例 `plugins/official/solidity/plugin.toml:17-18`                                                                                       |
| 语法高亮 / 结构视图 / 折叠（Unreal C++ 自研着色）                   | 插件可做                         | `wit/exports.wit:37-74`                                                                                                                                                                              |
| clangd 智能（补全/跳转/hover/inlay/code lens）                      | 插件可做（需 `process:` 高权限） | `wit/providers.wit:71-83`、`wit/language-features.wit:89-113`；编辑器路径预算 50ms 软 / 500ms 硬（`language-features.wit:4`）                                                                        |
| 生成 `compile_commands.json` 喂 clangd                              | **需核心改**（或插件跑 UBT）     | 插件可调 `process:UnrealBuildTool` 生成，但需要 ①绝对路径程序授权 ②产物落盘 ③路径注入 clangd——当前 `languages/cpp.toml` 的 clangd 参数是静态的，无 `--compile-commands-dir` 注入点                   |
| UBT 构建 + Problems 面板                                            | **需核心改**                     | `crates/ide-build/src/lib.rs:8-20` 只有 `application_update/compile/gradle/kotlin_bridge/maven/pom_edit/sbt/web`；全仓 `compile_commands                                                             | cmake                | msbuild | ninja` 零命中 |
| UHT 后台诊断（Rider 那 17 条检查）                                  | **需核心改**                     | `crates/ide-analysis/src` 只有 `duplicates.rs/lines.rs/structural.rs`；全仓 `UnrealHeaderTool                                                                                                        | generated\.h` 零命中 |
| UE 缓存类检查（Rider 的 `Non-UProperty object member…`）            | 插件可做                         | 走 `wit/diagnostics.wit:7-21` 的 `diagnostics-provider`                                                                                                                                              |
| RPC 校验（`_Validate`/`_Implementation`）、命名约定检查             | 插件可做                         | 同上，纯文本/符号级检查                                                                                                                                                                              |
| 蓝图资产只读分析（Code Vision / Find Usages / inlay）               | 插件可做（受限）                 | `wit/workspace.wit:74 read-bytes`（16 MiB 上限）读 `.uasset` 二进制；要显示图需 `customEditors` + `html` 视图（`wit/views.wit:132-135` 文本 content 不接受二进制）                                   |
| UE Editor 日志面板                                                  | 插件可做                         | `wit/views.wit:10-121`；但需在 Editor 侧写插件把日志推出来（Rider 是 RiderLink 干的这件事）                                                                                                          |
| Live Coding（编译并热重载）                                         | **需核心改**                     | 无任何落点；最多退化成一条 run configuration 跑 UBT                                                                                                                                                  |
| HLSL 支持（着色/IntelliSense/错误）                                 | 插件可做                         | `languages/` 现只有 `gdshader.toml`，无 `hlsl.toml`；可作数据插件加语言 + 走 LSP                                                                                                                     |
| UE Automation / Spec 测试                                           | 插件可做                         | `wit/run.wit:68-92` 的 `test-results`，`framework = "plugin"`                                                                                                                                        |
| 引擎源码 + 游戏项目同视野（Rider solution 视野）                    | **需核心改**                     | 见 §3                                                                                                                                                                                                |
| Natvis / `TArray`/`TMap`/`FString` 美化                             | **需核心改**                     | 全仓 `natvis` 零命中                                                                                                                                                                                 |

### 1.3 插件形态的硬约束（决定了「做插件」的代价）

- 插件是 **WASM component**，跑在 wasmtime，每插件一个 Store、一个 actor 线程（`docs/en/plugins/architecture.mdx:6,15,88`、`docs/en/contribute/architecture/plugin-host.mdx:58,68`）。**没有「子进程式插件」**。
- 每次调用约 5·10⁹ wasm 指令燃料、256 MiB 线性内存、空闲 5 分钟卸载（`architecture.mdx:77-82`）。
- 权限按 `process:<program>` 授予，程序解析成绝对路径 + blake3 哈希，**每次启动前复检**，文件变了就报 `... changed since it was approved`（`docs/en/plugins/capabilities.mdx:67`、`crates/ide-language/src/lib.rs:257-283`）。
- 启动的子进程最多 8 个并发（`wit/io.wit:164-166`），只在 trusted project 生效（`capabilities.mdx:106-108`）。
- 插件贡献的运行配置 `kind` 一律被宿主改写成 `"plugin"`（`crates/ide-host/src/plugins/run_detectors.rs:161,187`）→ **插件无法拥有自己的配置类型名/图标/字段**。
- 声明式 `runDetectors`（manifest 里写死）**不能带 debugger**（`run_detectors.rs:168` `debug_adapter: None`），`args` 也没有占位符（`:42` 原样克隆）→ **`.uproject` 的绝对路径塞不进声明式 detector**，必须用 WASM 动态 `launch-configurations`。

### 1.4 建议的边界划分

| 层                       | 谁做          | 内容                                                                                                                                      |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 核心（Rust crate）       | openidea 本体 | 项目类型识别 `ProjectKind`、引擎定位（已有）、生成目录排除、`roots` 引擎源码分支、构建（UBT）、clangd 编译数据库注入、Natvis、Live Coding |
| 插件（WASM）             | 可独立演进    | `.uproject`/`.usf`/`.ush` 高亮、UE 专属诊断（缓存类/RPC/命名）、蓝图资产只读查看器、UE Editor 日志面板、测试结果解析、类/模块创建模板     |
| Editor 侧插件（UE 工程） | 需 UE C++     | 类似 RiderLink：把 Editor 的日志、PIE 状态、蓝图信息推给 IDE                                                                              |

---

## 2. 问题二：像 Rider 一样识别不同项目类型 + 拖拽识别

### 2.1 现状：四层概念彼此不通信

| 层               | 落点                                                                                                                              | 作用                                                                                          | 谁消费                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A 前端标记表     | `src/ui/projectType.ts:14-42`（`unreal` 在 `:40`，`dotnet` 在 `:41`）                                                             | 16 种生态标记，`detectProjectType` `:54-59` **只吃单目录一层文件名**、first-match-wins        | `src/features/project-tree/projectTypes.ts:6-13` → `store.ts:119`；**只用于嵌套子目录的图标与排序** |
| B 前端视图模式   | `store.ts:87`（`ViewMode`）、`:89-96`（`VIEW_MODES`，首项 `["unity","Unity"]`）、`:215-217 treeOptions()`、`:698-715 modeShows()` | 决定项目树隐藏什么、根节点显示什么                                                            | `ProjectView.tsx`、`HeaderActions.tsx:12`、`model.ts:78-91 unityPathVisible()`                      |
| C 后端工程元数据 | `crates/ide-host/src/ops/project.rs:11-27`（`unity` `:24`、`unreal` `:26`）、`:38-51 info()`                                      | **唯一真正的根级工程类型载体**，已能填 `UnrealProjectInfo{engineAssociation,targets,modules}` | `project-tree/index.ts:53`（`p?.unity`）；**`unreal` 字段前端目前零消费**                           |
| D 后端目录角色   | `crates/ide-workspace/src/roots/mod.rs:22-30 RootKind` + `roots/detect.rs:93-186`（UE 分支 `:104-121`）                           | 告诉索引/LSP 哪些目录算源码、哪些排除                                                         | `ide-index`、LSP 根、Project Structure                                                              |
| E workspace 清单 | `crates/ide-workspace/src/workspace.rs:9`（`.openidea/workspace.json`）、`:26-28 is_container`                                    | 用户手写的成员目录清单                                                                        | `windows.ts:177-180`、`project-tree/index.ts:53`                                                    |

`mode: "unity"` 的完整链路（照它加 UE 即可）：`unity.rs:23-25 is_project` → `unity.rs:27+ detect` → `ops/project.rs:49` → `bindings.ts:11679` → `project-tree/index.ts:53`（唯一 `initProjectTree(..., p?.unity ?? null)` 调用点）→ `store.ts:316-357`（`:330-331` 自动切模式）→ `store.ts:215-217` 注入 `unityRoot`。

### 2.2 关键判断

1. **根级类型识别不能建在前端 `PROJECT_TYPES` 上**。它只吃一层目录、first-match-wins，且设计目标是「workspace 成员的图标与排序」；把根级 mode 建在上面会让 `unreal`(`:40`) 与 `dotnet`(`:41`) 互相掩盖。
2. **真源只能是后端 `ProjectInfo`**（C 层）——它已经在做这件事（`unity` 字段就是这么来的）。
3. **用户提的「根目录有 sln 的可能是引擎源码」这个判据要修正**：Launcher 版引擎根目录**没有** `.sln`（`.sln` 是用户跑 `GenerateProjectFiles` 后生成的，GitHub 源码版才有 `UE5.sln`）。可靠的引擎源码判据是 `Engine/Build/Build.version` + `Engine/Source/Runtime/` 目录同时存在。**注意：此判据在本机无法实测验证，因为引擎目录已不存在**（见 §0）。

### 2.3 落点（按实施顺序）

1. 新增 `crates/ide-workspace/src/project_kind.rs`（`lib.rs` 里 `pub mod project_kind;`）：
   ```rust
   pub enum ProjectKind { UnrealGame, UnrealEngine, Unity, Dotnet, Other }
   pub fn detect(root: &Path) -> ProjectKind
   ```
   判据顺序：`crate::unreal::is_project(root)` → `UnrealGame`；`root.join("Engine/Build/Build.version").is_file() && root.join("Engine/Source/Runtime").is_dir()` → `UnrealEngine`；根层有 `*.sln|*.slnx|*.csproj` → `Dotnet`；`crate::unity::is_project(root)` → `Unity`；否则 `Other`。
2. `crates/ide-host/src/ops/project.rs:26` 后加 `kind: ProjectKind` 字段，`info()` 在 `:50` 后填；跑 `pnpm gen:bindings` 重生成 `src/bindings.ts`（禁手改）。
3. `crates/ide-workspace/src/roots/detect.rs:104-121` 扩引擎分支：`Engine/Source`→Source、`Engine/Config`→Resources、`Engine/{Binaries,Intermediate,Saved,DerivedDataCache}`→Excluded。不加这步，引擎源码树会撞 `MAX_DIRS = 4000`（`detect.rs:11`）预算而看不到模块。
4. `crates/ide-workspace/src/project_discovery.rs:31-41 is_project` 现在只查 `roots::BUILD_FILES` + `[".git",".idea","CMakeLists.txt"]`（`:32`）→ **「Add Projects…」扫 UE/.NET 目录永远扫不出来**，要加 `.uproject` 与 `*.sln`。
5. 前端：`store.ts:87` 的 `ViewMode` 加 `"unreal"|"unrealEngine"`、`:89-96 VIEW_MODES` 加项、`:215-217 treeOptions()` 按 mode 注入生成目录、`:698-715 modeShows()` 加 case。
6. 前端 `model.ts:78-91` 旁新增 `unrealPathVisible(path, opts)`（对称 `unityPathVisible`），隐藏表用 `crates/ide-workspace/src/unreal.rs:13 GENERATED_DIRS`，受「Show Generated Files」开关控制。
7. `project-tree/index.ts:53-58` 把模式切换判据从 `p?.unity` 改成 `p?.kind`；`:282-283` 根节点灰字可用 `p.unreal.engineAssociation` 显示 `UE 5.8`。
8. 用户可见文案同时加 `src/platform/locales/text/en.json` 与 `zh.json`（`textCatalog.test.ts` 强制）。

### 2.4 拖拽识别

**Tauri 2 的 drag-drop 已经启用，不用改配置**：`src-tauri/tauri.conf.json:25 dragDropEnabled: true`（`tauri.linux.conf.json:14`、`tauri.windows.conf.json:15` 同；`src-tauri/src/windows.rs:1546` 只对 `aux` 辅助窗口关闭）；权限 `src-tauri/capabilities/default.json:5,7`；依赖 `package.json:73 @tauri-apps/api ^2` 已有。已有 4 处监听：`src/workbench/fileDrop.ts:66-87 installFileDrop()`（`:72 onDragDropEvent`、`:74 type==="drop"`）、`WelcomeView.tsx:91-118`、`ProjectView.tsx:763-791`、`features/agents/Composer.tsx:819`。

现状行为：

| 拖什么                       | 现在发生什么                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件夹                       | 能开成项目（`WelcomeView.tsx:104-105` → `windows.ts:520-529` → `openPaths` `:129-138` → `:137 openProjectWithPolicy`）；已有项目窗口时按 `general.openProjectIn` 策略询问（`fileDrop.ts:38-45`、`projectWindow.ts:20-49`） |
| 文件夹 → 拖到 Project 视图上 | 不是开项目，是**复制导入**到该目录（`ProjectView.tsx:763-791`、`operations.ts:851`）                                                                                                                                       |
| **`.uproject` / `.sln`**     | **只当普通文本文件开一个 tab**（`fileDrop.ts:38-45,49` → `editorService().openFile`），完全没有工程语义                                                                                                                    |
| 文件 + 文件夹混合            | 文件开 tab，第一个文件夹开成项目（`windows.ts:133-137`）                                                                                                                                                                   |

改法（3 个文件）：

1. 新建 `src/platform/projectEntry.ts`：`projectRootOfFiles(files: readonly string[]): Promise<string | null>` —— 文件名匹配 `\.uproject$|\.sln$|\.slnx$` 就返回 `dirname`；否则读同目录找 `*.uproject`（认「源码文件属于某个 UE 工程」）；多个候选取第一个。
2. `src/features/app/windows.ts:129-138 openPaths()` 里在文件/目录分流后插入判定：`if (root) return openProjectWithPolicy(root, files);`。这是唯一收口点，`file.openPaths`、Welcome 拖拽、`pickFiles`（`:237-241`）都经过它。
3. `src/workbench/fileDrop.ts:26-30 FileDropDeps` 加 `projectRootOfFiles`，在 `openDropped`（`:38-45`）里先判，`defaultDeps`（`:47-51`）接真实实现，保持可注入以便单测。

预期：拖 `MyGame.uproject` → 打开 `MyGame/` 为工程（走 trust/workspace 策略），`.uproject` 自己作为 tab 打开；拖 `Solution.sln` → 打开所在目录，配合 §2.3 的 `kind` 显示为 .NET / UE 工程。

---

## 3. 顺带回答：openidea 的 workspace 和 Rider 的「打开 .uproject 就看到游戏 + 引擎源码」差在哪

**不等价。** openidea 是「显式清单 + 每成员手选依赖」，Rider 是「工程文件驱动的自动根装配」。

| 维度       | Rider                                      | openidea 现状                                                                                                                                                                                       |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 成员来源   | 从 `.uproject`/`.Build.cs`/`.csproj` 推导  | 用户手写 `.openidea/workspace.json`（`workspace.rs:11-19`）                                                                                                                                         |
| 引擎源码   | 自动作为外部模块进入 solution 视野         | **从不出现在项目树/索引**：`roots/detect.rs:104-121` 只加项目自身 `Source`/`Config`；引擎路径只用于算运行配置（`crates/ide-run/src/detect.rs:1503`）                                                |
| 跨成员导航 | solution-wide，开箱可用                    | 默认不可导航，要逐成员在 Project Structure › Dependencies 里挑根 —— 源码原文 `crates/ide-host/src/project.rs:1440-1443`「being attached to the workspace never makes its code navigable by itself」 |
| 构建单元   | 引擎模块级（`*.Build.cs` / `*.Target.cs`） | `crates/ide-workspace/src/unreal.rs:79-90 targets` / `:120-130 module_names` **只抽名字展示**，不产出内容根                                                                                         |

要做到「打开 `.uproject` 就同视野看到引擎源码」，缺的正是 §2.3 的第 1–4 步（`ProjectKind` + 引擎判据 + `roots` 引擎分支 + discovery），外加一步「`UnrealGame` 自动把对应版本引擎 attach 成 workspace 成员」的推断（现在只有手写路径 `src-tauri/src/commands/workspace.rs:41-55`）。

---

## 4. 问题三：Rider 还有哪些 UE 功能需要开发

按「缺口性质」分三档。**A = 必须改核心**，**B = 可做成插件**，**C = 需要 UE 侧插件配合**。

| #   | Rider 能力                                                                                                                             | openidea 现状（取证）                                                                                                                                                                         | 档        | 价值/成本                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------- |
| 1   | 打开 `.uproject` 即建项目模型（读 `.uproject`/`.Build.cs`/`.Target.cs`/`.uplugin`，保存即重建模型）                                    | 只读 targets/modules 名字（`unreal.rs:79-90`、`:120-130`），无 plugin/module 依赖图                                                                                                           | A         | 高/中                                                |
| 2   | UBT 构建 + Problems 面板（含 UBT 版本过旧检测与一键升级）                                                                              | `ide-build` 只有 JVM 系（`lib.rs:8-20`），全仓 `compile_commands\|cmake\|msbuild\|ninja` 零命中                                                                                               | A         | 高/高                                                |
| 3   | 生成 `compile_commands.json` 喂 clangd（UBT 有 `GenerateClangDatabase` 模式）                                                          | `crates/` 零命中；`languages/cpp.toml` 的 clangd 参数是静态的，无 `--compile-commands-dir` 注入点；唯一现成注入钩子 `set_prepare_hook`（`crates/ide-lsp/src/lib.rs:3855`）当前只对 jdtls 生效 | A         | **最高/中**（这是「UE 里不出现假头文件错误」的关键） |
| 4   | UHT 后台诊断（与编译期一致的头文件工具错误）                                                                                           | `ide-analysis` 只有 3 个通用检查；`UnrealHeaderTool\|generated\.h` 零命中                                                                                                                     | A         | 高/高                                                |
| 5   | 17+ 条 UE 专属 inspection（缓存安全、`BlueprintCallable` 可 const/static、命名一致性、delegate 缺 UFUNCTION、`TStructOpsTypeTraits`…） | 无                                                                                                                                                                                            | B         | 高/中                                                |
| 6   | 反射宏补全 + specifier 补全 + `GENERATED_BODY()` 实体解析 + 快速文档                                                                   | 无（需自研 provider 或靠 clangd 兜底）                                                                                                                                                        | B         | 高/中                                                |
| 7   | 蓝图只读分析（派生类列表、UFunction 实现、属性 override、委托绑定、Gameplay tag 用法）                                                 | 无 custom editor；`.uasset` 只能 `read-bytes` 16 MiB                                                                                                                                          | B         | 中/高                                                |
| 8   | RPC 校验（`Client`/`Server`/`NetMulticast` 缺 `_Validate`/`_Implementation` 高亮 + 一键生成）                                          | 无                                                                                                                                                                                            | B         | 中/低                                                |
| 9   | UE 命名约定自动套用（检测到 UE 项目即生效，不可配置）                                                                                  | 无                                                                                                                                                                                            | B         | 中/低                                                |
| 10  | Natvis 自动加载（`UE4.natvis`）+ `TArray`/`TMap`/`TSet`/`FString` 美化 + `[Raw View]` + 宽字符格式化                                   | 全仓 `natvis` 零命中 → 调试器里 UE 容器显示为原始内存                                                                                                                                         | A         | 高/中                                                |
| 11  | HLSL（导航/高亮/语义检查/补全）                                                                                                        | `languages/` 无 `hlsl.toml`                                                                                                                                                                   | B         | 中/中                                                |
| 12  | `TargetType.Program` 不产生运行配置（RIDER-74784）                                                                                     | 已按官方三条恒出，天然满足                                                                                                                                                                    | —         | 已做                                                 |
| 13  | 测试：零配置发现引擎测试、Spec 测试、行内图标跑单类                                                                                    | 无；`wit/run.wit:68-92` 具备插件化条件                                                                                                                                                        | B         | 中/中                                                |
| 14  | Live Coding（`Build and Reload`，UE5 Windows 默认启用）                                                                                | 无落点                                                                                                                                                                                        | A         | 中/高                                                |
| 15  | UE Editor 日志面板（彩色、按 verbosity/category 过滤、点链接跳源码）                                                                   | 无；需 C 档配合                                                                                                                                                                               | C         | 中/中                                                |
| 16  | RiderLink 式联动（IDE 内选运行模式、起 server、指定玩家数）                                                                            | 无                                                                                                                                                                                            | C         | 中/高                                                |
| 17  | 类/模块/插件创建向导（`Add \| Unreal Class/Module/Plugin`，自动更新 `.uproject` 与 `Target.cs`）                                       | `ide-scaffold` 有 `catalog.rs`/`template.rs` 但无 unreal/`.Target.cs`/`.uproject` 模板                                                                                                        | B         | 中/中                                                |
| 18  | 生成目录从项目树隐藏、索引/搜索/监听全排除                                                                                             | 索引层已做（`RootKind::Excluded`）；**前端树过滤只对 Unity 做了**（`model.ts:78-91`）                                                                                                         | A         | 高/低                                                |
| 19  | 按项目类型区分（UE 游戏 / 引擎源码 / .NET）                                                                                            | 无 `ProjectKind`；`project_discovery.rs:31-41` 扫不出 UE/.NET                                                                                                                                 | A         | 高/低                                                |
| 20  | 拖 `.uproject`/`.sln` 识别成工程                                                                                                       | 只当文本文件打开                                                                                                                                                                              | A（前端） | 高/低                                                |
| 21  | 引擎版本展示与 UE 工具窗                                                                                                               | Unity 有面板；UE 只有后端字段 `unreal.engineAssociation`，前端零消费                                                                                                                          | A（前端） | 中/低                                                |

### 建议的实施顺序（按「最小可用 → 价值递增」）

1. **让 IDE 认得出 UE 项目**（§2.3 第 1、2、4 步 + §2.4 拖拽）—— 不含这块，后面所有 UE 能力都只能靠用户手动配 `files.exclude`。
2. **树过滤 + 引擎版本显示**（`ViewMode` + `unrealPathVisible` + `engineAssociation` 灰字）—— 用户能立刻感到「这是 UE 项目」。
3. **`compile_commands.json` 生成 + clangd 注入**（表内第 3 条）—— 消掉 UE 里成片的假头文件错误，是体验落差最大的一项。
4. **UBT 构建 + Problems**（第 2 条）—— 把「构建」从外部命令行搬进 IDE。
5. **Natvis**（第 10 条）—— 调试可用性的分水岭。
6. 之后才是 UHT 诊断、检查器、蓝图、Live Coding、HLSL、测试、RiderLink 那批。

---

## 5. 风险与未取证项

- **引擎目录已不存在**（§0），所有「引擎源码判据」「三条运行配置」的实测验证都要等环境恢复。
- 引擎源码判据 `Engine/Build/Build.version` + `Engine/Source/Runtime`：来自 UE 常规布局，**本机无法实测**。
- 插件侧 `runConfigurations` 能否把 `UnrealEditor.exe` 的**绝对路径**作为 `program`（而非程序名）：`crates/ide-language/src/registry.rs:136` 有 `is_absolute()` 分支说明支持，但插件的 capability 是字符串匹配，用户体验上会随引擎升级失效 —— **未实测**。
- 插件侧读 `LauncherInstalled.dat` 需要 `fs` 能读项目外绝对路径，`wit/fs.wit` 的 scope 未逐行核实 —— **未实测**。
- Rider 侧「引擎源码如何挂载」的做法来自其官方文档的能力描述，**没有**核对 JetBrains 具体实现的文件/配置。
- `pnpm dev:app` 的 GUI 自动验证路径（Tauri MCP）在本会话未挂载工具，只能人工点。

---

## 6. 下一步（待你确认后动手）

- 若同意 §1.4 的分层：先做 §4「建议实施顺序」的 1–2（后端 `ProjectKind` + 前端 mode/树过滤 + 拖拽），这两块纯核心改动、不依赖引擎存在，可以立刻验证。
- 若要先把插件路线验证清楚：我可以先做一个**只读原型**（插件 manifest + `runDetections` 动态配置），证明「插件能出三条 UE 配置并 attach native 调试」，再决定哪些留在插件、哪些下沉核心。
- 引擎环境已解决，无需再装 Launcher 版：改用源码版 `D:\Projects\UE\UE-AS`（Lyra 项目在其 `Samples` 下，`EngineAssociation: ""` 就地引用）。代码侧 `f59166443` 已支持就地引擎解析。`F:\Game\Epic\UE_5.x` 那套失效注册表项留着不影响新环境（只有 `EngineAssociation: "5.8"` 的 Arts 项目会命中它们，命不中就不产出配置，行为正确）。
