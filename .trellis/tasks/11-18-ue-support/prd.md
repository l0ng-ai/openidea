# Unreal Engine project support

## Goal

让 openidea 认出 Unreal Engine 项目，并能跑和调。范围就是用户提的四件事，别的一律不做。

## 开发内容

七块，按依赖顺序。每块给「改哪、做什么、怎么算完」。

### 1. 项目识别（`crates/ide-workspace/src/unreal.rs`，新增）

- 从 `.uproject` 读出 `EngineAssociation` 与 `Plugins`（serde_json，依赖已在）。
- 只在 `.uproject` 同级 `Source/` 下读两类文件，深度固定，**不递归**：
  - `Source/*.Target.cs` → target 名（文件名去 `.Target.cs`）+ 类型（读 `Type = TargetType.X`，没写就是 `Game`）
  - `Source/*/*.Build.cs` → module 名
- `Source/` 不存在 = 纯蓝图项目，targets 与 modules 返回空，不是错误。
- 完成标准：`cargo test -p ide-workspace` 里有针对真实 `.uproject` 文本的单测，蓝图项目返回空列表。

### 2. 生成目录不进索引（`crates/ide-workspace/src/unreal.rs` + 现有排除出口）

- `Binaries`、`Intermediate`、`Saved`、`DerivedDataCache` 标记为 `RootKind::Excluded`，复用 `RootKind` 这条既有出口（Unity 的 `GENERATED_DIRS` 是现成模板）。`.vs` 不进这张表：它和 Unity 一样由「`.` 开头目录不参与发现」处理。
- 完成标准：`Binaries/` 下的文件不出现在 find-in-files，也不在项目树。

### 3. 引擎定位（`crates/ide-workspace/src/unreal/engine.rs`，新增）

- **先认就地引擎**：`EngineAssociation` 为空串或缺失时（源码版引擎的惯例，Lyra 就是 `""`），从 `.uproject` 逐级向上找 `Engine/Build/Build.version`，找到就是引擎根，版本号从该文件读 `major.minor`。注册表只在这里找不到时才读。
- 读两处注册表：`HKLM\SOFTWARE\EpicGames\Unreal Engine\<ver>` 的 `InstalledDirectory`（Launcher 装的）与 `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds` 的值（源码构建）。`LauncherInstalled.dat` 与 HKLM 是同一批引擎，不再重复读。
- 用 `EngineAssociation` 精确匹配（大小写不敏感）；匹配不到、或那个版本没装，取最高版本（按 major.minor 数值比，`5.10` 比 `5.8` 新；GUID 键排最后）。**筛选条件是引擎根目录存在，不是编辑器 exe 存在**——未编译的源码引擎也算「装了」，配置代表意图，跑不起来是运行时的事。
- 对外给引擎根 + 用得到的路径：编辑器 exe **先看 `<project>/Binaries/Win64/UnrealEditor.exe`（源码版把自己的模块编进项目）**，再退回 `<engine>/Engine/Binaries/Win64/UnrealEditor.exe`；另给 `Engine/Build/BatchFiles/Build.bat`。`UnrealEditor-Cmd.exe` 有需要再加。
- 依赖用 `winreg`（`crates/ide-cli` 已用它写注册表），不加 `windows-sys` 的 Registry feature。
- 完成标准：单测覆盖「精确命中 / 只有更高版本 / 注册的目录已删 / 项目在引擎树内用就地引擎 / 源码版编辑器编在项目里」五种；真机返回 `D:\Projects\UE\UE-AS`。

### 4. 运行配置（`crates/ide-run/src/detect.rs` 加 `unreal` 分支）

- 照 `detect::godot`（`crates/ide-run/src/detect.rs:90`）的写法加一条分支：认到 `.uproject` 就产出配置。逻辑就写在这个文件里，不为几十行单开文件。
- **恒定三条，与 `Source/*.Target.cs` 无关**。UE 自己的运行模式只有三种（`Engine/Source/Runtime/Launch/Private/LaunchEngineLoop.cpp` 只设 Editor / RegularClient / DedicatedServer 三个状态；官方文档：`-game` = "Run the editor as a game client"，`-server` = "Run the editor as a dedicated server"）。三条都跑同一个 `UnrealEditor.exe`，只在参数上分：
  - `Unreal Editor`：`UnrealEditor.exe "<abs .uproject>"`
  - `Unreal Game`：`UnrealEditor.exe "<abs .uproject>" -game`
  - `Unreal Server`：`UnrealEditor.exe "<abs .uproject>" -server`
  - 以上 cwd 都是项目根（`cwd` 留空即项目根）。
- 纯蓝图项目一样有这三条：运行模式不是构建目标，不需要 `Source/`。
- 不做 Client：UE 没有 `-client` flag（连服务器的客户端是 `-game` 加 URL）。真要独立 client 二进制得先构建出 `<Game>Client-Win64-*.exe`，那是「做构建」这件事，不在本轮。
- 引擎找不到：不产出配置，`tracing::debug!` 记一条。与本仓其它探测一致（`detect_with_profiles` 全是「找不到就不产出」）；留一条跑不起来的配置反而误导。
- 前端：`src/features/run/types.ts` 的 `TYPES` 加一个 `unreal` 类型（照 Godot 条目 `:153-203` 的字段形态），字段只有 `Project` 与 `Arguments`：`-game` / `-server` 留在参数里，三条共用一种类型；定义里带 `group: "Unreal"`，`categoryOf` 优先读它，所以不必改 `KIND_LABELS` 与 `services.test.ts` 的断言表。
- 完成标准：`crates/ide-run/src/detect.rs` 内部测试断言命令行、名字与 debug adapter；`pnpm typecheck` 通过。

### 5. 项目类型与 bindings（`crates/ide-workspace/src/project_kind.rs`、`crates/ide-host/src/ops/project.rs`、`src/ui/projectType.ts`、`src/bindings.ts`）

- **后端是唯一真源**：新增 `crates/ide-workspace/src/project_kind.rs` 的 `pub enum ProjectKind { UnrealGame, UnrealEngine, Unity, Dotnet, Other }` + `pub fn detect(root) -> ProjectKind`，只读根目录一层，判据顺序 = `.uproject` → `Engine/Build/Build.version`（无 `.uproject` 的源码引擎）→ Unity → 根层 `*.sln`/`*.slnx`/`*.csproj` → `Other`。UE 排第一：引擎树里有 `Samples/**/*.uproject`，且会生成自己的 `.sln`。
- `ProjectInfo` 加 `kind: ProjectKind`（无 `Option`，`Other` 即兜底）；`src/ui/projectType.ts` 的 `PROJECT_TYPES` 加 `unreal`，**排在 `dotnet` 之前**（那个表只管嵌套子目录的图标与排序，first-match-wins）。
- 跑 `pnpm gen:bindings` 重新生成 `src/bindings.ts`。
- 完成标准：`cargo test -p ide-workspace` 覆盖七种判据；打开 UE 项目时 `.sln` 不再产生 `.NET Project` 配置。

### 6. 调试（现有 lldb-dap 通道，无新代码）

- launch：第 4 块的配置带 `debugAdapter = "lldb-dap"`（`languages/cpp.toml` 已配 `adapter = "lldb-dap"`），不新写适配器。
- attach：不改代码。`crates/ide-dap/src/attach.rs:157` 的兜底就是 `AttachKind::Native`，`UnrealEditor.exe` 已经会出现在「Native (LLDB)」分组里。
- 完成标准：`Source/.../*.cpp` 断点命中；attach 到手动启动的 Editor 也命中。

### 7. 前端工程模式与拖拽（`src/features/project-tree/*`、`src/features/app/windows.ts`）

- **工程模式**：`ViewMode` 加 `"unreal"`，与已有的 `"unity"` 完全对称——`VIEW_MODES` 加一项、`ProjectTreeState` 加 `unreal` 字段、`treeOptions()` 注入 `unrealRoot`、`initProjectTree` 带 `unreal` 参数并按它自动切模式、`setViewMode` 加守卫、`modeShows` 加 case、展开状态照常持久化。有了它，Project 工具窗口才会出现「Unreal」面板，根节点显灰字引擎版本。
- **树过滤**：`model.ts` 新增 `unrealPathVisible()`，只在该模式下生效，隐藏 `Binaries`/`Intermediate`/`Saved`/`DerivedDataCache`/`.vs` 与根层 UBT 生成的 `.sln`/`.slnx`/`.suo`/`.user`/`.vcxproj`/`.pidb`，受既有「Show Generated Files」开关控制（不新增开关）。后端 `RootKind::Excluded` 只管索引/搜索/监听，树显示得靠这个。
- **菜单**：`HeaderActions.tsx` 的 pane 列表原本只过滤 unity，加 unreal 后同样只在 UE 项目里出现。
- **拖拽**：Tauri drag-drop 已启用，`openPaths()` 是唯一收口点。`.uproject`/`.sln`/`.slnx` 被拖进来时，把它的父目录当工程根打开（其余文件仍按散文件打开）。
- 完成标准：`pnpm test` 与 `pnpm typecheck` 通过；打开 UE 项目时 Project 面板自动切到 Unreal 且看不到生成目录；拖 `Lyra.uproject` 到窗口打开的是它所在的目录。

## 不做（明确写出来，避免以后被问）

| 不做                                            | 为什么                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `compile_commands.json` 生成 / clangd 消假错    | 这是 cpp 支持本身的缺口，不是 UE 需求；没有它 C++ 会有假错，单独一件事 |
| UHT 后台诊断、UE 专属 inspection、命名检查      | Rider 级能力，与「能跑能调」无关                                       |
| 蓝图资产分析 / Code View / 类向导 / Live Coding | 同上                                                                   |
| 设置页里配引擎路径                              | 先只读注册表；读不到就报原因                                           |
| 多 fixture、CI 矩阵、smoke 用例                 | 一个 fixture + 单测足够验收                                            |
| Linux / macOS                                   | 本机只有 Windows 引擎，不写没验证过的路径                              |

> 原先还列了「构建、Problems 面板接 UBT 输出 → 用户没要」。2026-11-22 复查官方文档后撤回：Rider 与 VS 的 Editor 配置都是 **build → launch 两段式**（VS 原文 “This target builds and launches the Unreal Editor with your game project loaded”），只做 launch 是不完整的，因此移到下面的 backlog。

## Run 链路缺口（backlog）

按「阻断可用 / 体验 / 锦上添花」三档排。前两条是本轮收尾后最该做的。

| #   | 缺口                                         | 现状                                                                                                                                                          | 要做什么                                                                                                                                                                                                                                                                                   | 优先级 | 重要程度                   | 预估    |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------- | ------- |
| B1  | **Run 前不构建**                             | ✅ **2026-11-22 已实现**（照 zig 的 before_launch 模式，见验收清单）。原状：三条只 launch，不编，而 Rider/VS 都是先编 `<Game>Editor Win64 Development` 再启动 | 一条 `unreal:build` 配置跑 `Build.bat <EditorTarget> Win64 Development -Project=<uproject> -WaitMutex`，三条 Run 各挂 `before_launch = [{kind:"run", target:"unreal:build"}]`；Editor target 的 `ExtraModuleNames` 已含 Game 模块，故一次构建覆盖三种模式；纯蓝图项目无 target，不产该配置 | P0     | 高（与两家的根本差距）     | 已完成  |
| B2  | **引擎/关联失配时静默**                      | `locate()` 返回 `None` 就 `tracing::debug!` 然后不产配置，用户在 UI 上看不到任何原因（本次 F 盘引擎被删就是这样，先误判成代码 bug）                           | `ProjectInfo.unreal` 增 `engine: { id, root }`（检测时就地解析，`detect_unreal` 直接复用它，不再二次查注册表）；Project 面板根节点灰字在找不到引擎时显示 `Unreal · engine not found`，找到时显示 `Unreal <id>`（源码版是注册名如 `UE_5.8_Source`）。Run 下拉里的提示行留作 B2b             | P0     | 高（直接对应一次真实误判） | 1 天    |
| B3  | 缺模块 / 缺 ShaderCompileWorker 时报错不引导 | 弹 18 个模块 missing、`Couldn't launch ShaderCompileWorker.exe`，只能靠人读日志                                                                               | 识别这两类输出，提示「跑 Build.bat `<Target>` 修复」                                                                                                                                                                                                                                       | P1     | 中                         | 1 天    |
| B4  | launch 后自动 attach 未验证                  | 配置带 `debugAdapter = lldb-dap`，但「launch 完能不能直接命中断点」没验过                                                                                     | 真机验一次；失败则退成 attach-only（见风险节）                                                                                                                                                                                                                                             | P1     | 高（调试是四需求之一）     | 0.5 天  |
| B5  | 构建输出不进 Problems 面板                   | UBT 的 `error` / `warning` 行有固定格式，现在丢弃                                                                                                             | 解析成诊断条目推给 Problems                                                                                                                                                                                                                                                                | P1     | 中                         | 2 天    |
| B6  | 三条之外没有 Client                          | 不做正确（UE 无 `-client` flag），但 `<Game>Client-Win64-*.exe` 是真实产物                                                                                    | 等 B1 有构建能力后再加，构建完才存在                                                                                                                                                                                                                                                       | P2     | 低                         | 依赖 B1 |
| B7  | 命令行参数不能持久编辑                       | 前端只有 `Project` + `Arguments` 两个字段，够用但不便                                                                                                         | 照 Rider EzArgs 做参数预设                                                                                                                                                                                                                                                                 | P2     | 低                         | 1 天    |
| B8  | 没有 Live Coding                             | Rider 有 `Build and Reload`，UE5 Windows 默认启用                                                                                                             | 需 UE 侧 IPC（RiderLink 级），与 openidea 插件体系耦合                                                                                                                                                                                                                                     | P3     | 低                         | 大      |
| B9  | 无多实例 / 专用服务器编排                    | Rider 能选启动模式、起 server、设玩家数                                                                                                                       | 参考 `UnrealLink` 的运行模式控件                                                                                                                                                                                                                                                           | P3     | 低                         | 中      |

## 验收

- [x] 打开 `D:\Projects\UE\UE-AS\Samples\Games\Lyra` → 认成 `ProjectKind::UnrealGame`，Project 面板出现「Unreal」，根节点灰字 `Unreal`（该 `.uproject` 的 `EngineAssociation` 为空串，故不带版本号；灰字规则见 `src/features/project-tree/store.ts:293`）
- [x] 同一项目里看不到 `Binaries`/`Intermediate`/`Saved`/`DerivedDataCache`
- [x] Run 下拉出现 Unreal Editor / Unreal Game / Unreal Server 三条，命令行 `D:\Projects\UE\UE-AS\Engine\Binaries\Win64\UnrealEditor.exe <abs uproject>`，后两条带 `-game` / `-server`
- [x] 三条里的 Game 真跑通了：`UnrealEditor.exe "D:\Projects\UE\Arts\Arts.uproject" -game -windowed -resx=1280 -resy=720 -log -stdout -nosplash` 存活 90 秒，窗口标题 `Arts（64-位 Development PCD3D_SM6）`，内存 2221 MB，日志 0 条 Error/Fatal。达成前提三件事：补 328 个手工 `.modules`（BuildId `5.8.4-0+++UE5+Release-5.8`）、在 `Arts.uproject` 里禁用三个缺 DLL 的插件（ResonanceAudio / AndroidDeviceProfileSelector / AutomatedPerfTestTools）、编 `ShaderCompileWorker`（284 action / 6.4 分钟）
- [x] 三条里的 Editor（不带 `-game`）起得来 —— 用户实测进入「虚幻编辑器 - Arts / 虚幻编辑器 5.8.4」，加载画面到编辑器；三条里只剩 Server 未测
- [x] Run 前自动构建：有 `Source/*.Target.cs` 且其中有 `Type = TargetType.Editor` 时，多出一条 `unreal:build`（名字 `Build <EditorTarget>`），命令行 `Build.bat <EditorTarget> Win64 Development -Project=<abs uproject> -WaitMutex`；三条 Run 各自带 `before_launch = [{kind:"run", target:"unreal:build"}]`，构建失败即不启动。纯蓝图项目（无 target）不产该配置、三条 Run 也不带 before_launch。单测 `the_editor_target_is_built_before_any_mode_starts` 覆盖
- [ ] 真机点 Unreal Editor 时先看到构建输出再启动编辑器（下一步验证；Arts 纯蓝图无构建，需用 Lyra 或自建 C++ 项目）
- [ ] 三条里的 Server（`-server`）起得来
- [ ] 在 `Source/LyraGame/**/*.cpp` 打断点 → 命中，调用栈有源码行 —— **双阻塞**：Lyra 需 4212 action 全量重编（编过 UBT 后 `UnrealBuildTool assembly is newer` 使 makefile 失效），且源码版 Lyra 无 `Content/`，编完也是空场景
- [ ] 手工开 Editor 后 attach → 命中
- [ ] 拖 `Lyra.uproject` 到窗口 → 打开的是 `D:\Projects\UE\UE-AS\Samples\Games\Lyra` 这个目录
- [ ] 打开引擎根 `D:\Projects\UE\UE-AS` → 认成 `ProjectKind::UnrealEngine`，不产生 `.NET Project` 配置
- [x] 打开 `D:\Projects\UE\Arts`（纯蓝图）→ 认成 Unreal 项目；把引擎注册为 `UE_5.8_Source` 后产出三条配置（此前 association 写 `5.8` 指向已删的 F 盘引擎，故无配置、也不崩）
- [x] `cargo clippy -p ide-workspace -p ide-host --all-targets -- -D warnings`、`cargo fmt --all`、`pnpm typecheck`、`pnpm gen:bindings` 全绿；`cargo test -p ide-workspace unreal` 12 passed

## 验收记录（2026-11-22）

- **真机截图**：Lyra 与 Arts 分别打开，Project 面板显示 `Unreal` / `Unreal UE_5.8_Source`，Run 下拉三组条目齐全（Unreal Engine › Unreal Editor / Unreal Game / Unreal Server）。
- **CDP 取证**：`invoke('open_project', {path:'D:/Projects/UE/Arts'})` → `{kind:"unrealGame", unreal:{engineAssociation:"UE_5.8_Source", targets:[], modules:[]}}`；`invoke('run_configs')` → 三条，`command` 全为 `D:\Projects\UE\UE-AS\Engine\Binaries\Win64\UnrealEditor.exe`，`debugAdapter = lldb-dap`。
- **修掉一个路径缺陷**：`EngineInstall::editor/build_batch` 原先 `root.join("Engine/Binaries/Win64/UnrealEditor.exe")` 会拼出 `D:/…\Engine/Binaries/…` 混合分隔符；改成逐段 `join`，并抽出 `version_file()` 统一 `Engine/Build/Build.version`。
- **环境修复**：注册表 `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds` 增 `UE_5.8_Source = D:\Projects\UE\UE-AS`；`Arts.uproject` 的 `EngineAssociation` 由 `5.8`（指向已删的 `F:\Game\Epic\UE_5.8`）改为 `UE_5.8_Source`。

## 环境

- 引擎：`D:\Projects\UE\UE-AS` —— **源码版**（Angelscript fork），`Engine/Build/Build.version` = 5.8.4，`.uproject` 的 `EngineAssociation` 为空串即就地引擎。最初用的 Launcher 版 `F:\Game\Epic\UE_5.8` 已从磁盘删除，注册表里 5.3/5.5/5.6/5.8 四个键全指向不存在的路径——这正是「Run 下拉没有三条」的真正原因，也是第 3 块把筛选条件从「编辑器存在」改成「引擎根存在」的原因。
- 项目：`D:\Projects\UE\UE-AS\Samples\Games\Lyra\Lyra.uproject`（GitHub 版 Lyra：12 个 `.Target.cs`、2 个 `.Build.cs`、约 80 个插件；**无 `Content/`**，代码完整但跑不出游戏画面）。
- 源码引擎首次全量编译 4–8 小时（8 核：UHT 30 分钟写 22,528 个 generated 文件，随后 4424 个 action），日志 `D:\Projects\.tmp\logs\build-lyra.log`。编译器链 VS 2022 BuildTools MSVC 14.44 + Windows SDK 10.0.22621。

## 风险

lldb-dap 直接 launch `UnrealEditor.exe` 可能因启动慢或多进程模型失败。真失败就退成「只做 attach，launch 交给 Editor 的 Play 按钮」，第 6 块改成只做 attach 并更新验收。
