# 13 — 界面架构与交互模型

> 范围：动作系统与可发现性、主窗口信息架构、工具窗口契约、编辑区语义、交互原语、设置界面、视觉系统、通知、进度、可访问性。｜ 依赖：01、02、03、05、14。｜ 排除：像素级视觉规范与配色数值、远端传输协议（见 17）、插件装载与注册机制本体（见 02、15）。

## 1. 目的与范围

### 1.1 本子系统解决什么问题

本系统在安装形态下同时存在 **1559 个动作标识**、**487 个动作组**、**37 个工具窗口**、**73 个状态栏部件工厂**与 **452 个通知组**。若每个功能自行决定"命令如何被触发、面板如何摆放、结果如何提示"，产品会退化成互不相干的工具集合。本子系统提供四个统一机制：

1. **命令的单一表示**：一个命令只注册一次，即可被菜单、工具栏、上下文菜单、快捷键、命令搜索共用（§4.4）。
2. **呈现与行为分离**：动作只描述"能否执行、叫什么、显示什么状态"，不描述"出现在哪个表面"；表面只描述"如何呈现"，不改写行为（INV-4）。
3. **窗口的声明式装配**：面板以标识注册，布局以数据描述，首次可见时才创建内容（§4.6）。
4. **反馈的统一通道**：通知、进度、状态栏部件共用同一套投递、去重与合并规则（§4.8、§4.9）。

### 1.2 边界

本子系统**不负责**：具体控件绘制与像素级视觉（只规定角色化颜色与渲染管线约束，§4.11）；编辑器内部渲染与装饰（见 05）；设置的持久化格式与迁移（见 14）；远端界面模型的序列化协议（见 17）。

### 1.3 与其他子系统的关系

| 关系 | 内容 |
|---|---|
| 02 容器与扩展 | 动作、工具窗口、主题、通知组均以扩展点注册；实例化时机受容器约束 |
| 03 并发 | 动作更新线程声明、界面/后台线程边界、写意图、取消语义 |
| 05 文档/编辑器 | 编辑区持有编辑器视图；同一文件多视图共享文档（§4.7） |
| 09 / 10 / 14 | 补全与导航弹窗复用本文的弹窗/列表/树原语（§4.12）；设置界面读写 14 定义的状态对象，本文只规定界面契约 |
| 17 远端 | 工具窗口、通知、进度必须能在无渲染侧降级为数据（D4） |

## 2. 概念模型

### 2.1 术语

| 术语 | 英文 | 定义 |
|---|---|---|
| 动作 / 动作组 | Action / Action Group | 可被触发的命令单元，拥有稳定标识与呈现 / 动作容器，可嵌套，构成菜单与工具栏层级 |
| 呈现 | Presentation | 动作在一次求值中得到的可视状态：文本、描述、图标、可用、可见、选中 |
| 位置 / 表面 | Place / Surface | 表面与宿主环境的字符串标识 / 承载动作的容器（菜单、工具栏、上下文菜单、命令搜索、状态栏） |
| 数据上下文 / 数据键 | Data Context / Data Key | 求值与执行时可查询的隐式输入集合 / 其中的类型化键（同名不同类型视为不同键） |
| 更新会话 / 工具窗口 / 条带 / 内容 | Update Session / Tool Window / Stripe / Content | 一次批量呈现求值，多表面共享同一结果 / 主编辑区之外可停靠的功能面板 / 其在窗口边缘的常驻按钮列 / 其内可并列切换的页面单元 |
| 编辑区 / 编辑器窗口 / 预览标签 | Editor Area / Editor Window / Preview Tab | 承载标签的区域 / 其中的一个分屏格 / 单槽、可被下一次"预览打开"替换的临时标签 |
| 可配置项 | Configurable | 设置树叶子，负责创建、读取、校验、写回一组设置 |
| 通知组 / 后台任务 | Notification Group / Background Task | 通知分类单元（决定缺省显示策略与目标面板）/ 持有进度指示、可取消、可合并显示的长任务 |

### 2.2 分层

```
动作层(动作/组/呈现/数据键) → 求值层(更新会话·更新线程·提升器)
  → 表面层(菜单·工具栏·上下文菜单·命令搜索·状态栏)
  → 窗口层(主窗口·停靠区·编辑区·通知区·进度区) → 视觉层(角色色·图标主题·字体度量)
```

**下层的变化不得反向修改上层的动作定义**：动作不得因"被放进工具栏"而改变可用性判定；工具栏也不得因"动作在某位置不可见"而修改动作本身，只在本次求值中隐藏。

### 2.3 实体关系

```
动作组 ──含──▶ 动作 ──求值于──▶ 位置        动作 ──读取──▶ 数据上下文
工具窗口 ──含──▶ 内容      工具窗口 ──注册于──▶ 布局档案
通知 ──属于──▶ 通知组 ──缺省显示于──▶ 工具窗口        后台任务 ──聚合到──▶ 进度区
```

## 3. 数据模型

### 3.1 动作与呈现

```
Action {
  id: string                      // 全局唯一、跨版本稳定；日志与遥测以此归因
  text: localized;  description: localized?   // 显示名 / 悬停说明（命令搜索的二级匹配目标）
  icon: IconRef?;  group: ActionId?   // 图标角色（非位图路径）/ 归属组，null 为自由动作
  shortcut: Shortcut[]            // 0..n，来自当前键位方案
  updateThread: background | ui   // 必填（INV-2）
  searchable: bool = true;  dumbAware: bool = false     // 进入命令搜索 / 哑模式可用（01 §7 D1）
  requiresWrite: bool = false;  handler: opaque          // 需写意图（03 §5）/ 执行体，不参与求值
}
Presentation {
  visible: bool = true;  enabled: bool = true;  selected: bool = false
  text: localized?;  description: localized?;  icon: IconRef?;  iconText: string?
  disabledReason: localized?      // 供提示与可访问性朗读
}
```

约束：`enabled=false` 且 `visible=true` 的呈现**必须**提供 `disabledReason` 或等价可解释信息，否则违反"每个动作都可用、可发现、可解释"（01 §6.5）。

### 3.2 数据上下文

```
DataKey<T> { name: string; type: TypeRef }
DataContext {
  get<T>(key) -> T?;  getAsync<T>(key) -> Future<T>?   // 同步键 / 延迟键
  snapshot() -> DataSnapshot                 // 冻结视图
}
DataSnapshot : DataContext { sourceFocus: ComponentRef? }   // 只读，会话内值不变
```

取值规则：上下文由焦点组件向上逐级合并，同名键**近者优先**；结果**必须**冻结为快照后再交给动作求值，禁止求值过程中回查活的组件树（否则同一会话内不同动作看到不同的世界）。

### 3.3 工具窗口与布局

```
ToolWindow {
  id: string;  anchor: top | left | bottom | right;  type: docked | floating | sliding | windowed
  secondary: bool                  // 进入"更多"分组（次要条带）
  icon: IconRef?;  stripeTitle: localized
  visible: bool = false;  available: bool = true      // 可用性关闭时按钮消失、状态保留
  showStripeButton: bool = true;  contentUiType: tabbed | combo
  hideOnEmptyContent: bool = false;  canCloseContents: bool = true
  weight: float = 0.3;  sideWeight: float?;  split: bool = false   // 主占比 / 分屏次级占比 / 并入相邻分屏
}
LayoutProfile {
  id: string;  frameType: string   // 主窗口 / 对话框宿主 / 欢迎屏
  applyMode: seedOnly | forceOnce;  migrationVersion: int;  entries: ToolWindowLayoutEntry[]
}
```

### 3.4 编辑区

```
EditorTab {
  file: FileId
  editors: EditorRef[]             // 一个标签可承载多个视图（如设计/源码）
  pinned: bool = false;  preview: bool = false   // 每窗口至多一个（INV-9）
  index: int;  window: EditorWindowRef           // 拖放重排后重算 / 所属分屏
}
EditorWindow { orientation: horizontal | vertical; tabs: EditorTab[]; selected: EditorTab? }
```

### 3.5 通知与进度

```
Notification {
  groupId: string                  // 必填（INV-10）
  type: information | warning | error | productUpdate
  title: localized;  subtitle: localized?;  content: localized
  actions: ActionRef[]             // 至多 3 个主按钮 + 次级下拉
  collapseDirection: none | left | right;  removeWhenExpired: bool = false
  important: bool = false;  suggestion: bool = false         // 阻止过期 / 建议类（采纳·忽略）
  doNotAskId: string?;  remindLaterHandler: string?         // 记住选择 / 稍后提醒策略
  timestamp: instant;  expired: bool
}
NotificationGroup {
  displayId: string;  displayType: none | balloon | stickyBalloon | toolWindow
  logByDefault: bool = true;  toolWindowId: string?   // displayType=toolWindow 的落点
  parentId: string?;  hideFromSettings: bool = false;  title: localized?
}
ProgressTask {
  id: string                       // 同 id 任务合并显示（§4.9）
  title: localized;  detail: localized?;  cancellable: bool
  indeterminate: bool = false;  fraction: float?           // 二者互斥
  modality: none | modal;  ownerProject: ProjectId?
}
```

## 4. 行为契约

### 4.1 动作注册：两阶段

- **预注册**：只登记 `id → 描述符` 与快捷键转发关系，**不得**实例化执行体，不读项目状态；必须在主窗口出现前完成。
- **后注册**：执行体按需实例化；此时允许定制器改写注册表（增删动作、改绑定）。
- **桩语义**：描述符动作首次取用前以**桩**存在（只有 id、类型、来源模块、图标路径）；"遍历全部动作"必须能不触发实例化（INV-16）。单个描述符非法 → 跳过并记录，注册表继续。
- **定制器策略**：必须声明为三档之一——轻量同步（只改元数据）、重量同步（可增删动作，拖慢启动）、异步轻量（可延后）；未声明者按重量同步处理。

### 4.2 呈现求值：更新会话

```
updateSession(place, targets):
  1. 建立数据快照（当前焦点 + place 宿主组件）
  2. 对本会话动作集合去重 → 每动作至多求值一次
  3. ui 线程动作 → 界面线程批量求值；background 动作 → 后台求值后合并回界面
  4. 应用位置层装饰（文本/图标替换、"此处不显示"过滤）
  5. 按提升器重排（组内优先级）
  6. 撤回快照，投递结果到表面
```

- **单会话单次**：同一动作在同一次会话内**必须**只求值一次，即使它同时出现在菜单与工具栏（INV-3）。
- **强制刷新**：表面可请求绕过去抖的刷新（如弹窗刚打开），但不得在用户输入事件内同步执行重计算。
- **提升器**：`promote(actions, context) -> actions` 只允许**重排**，不得增删；典型用途是搜索输入激活时把文本类动作提前。
- **异常与超时**：单动作求值抛错 → 该动作本次不可用并记录；界面线程求值超单帧预算 → 记为"动作更新超时"并按动作标识聚合。

### 4.3 执行管道

```
execute(action, context, place):
  1. 前置校验：enabled? 哑模式允许? 只读项目允许? 许可证允许? 写意图已获取?
     → 不满足则报告原因（可见提示或通知），结束
  2. 前置钩子（按注册序）：可 veto、可改写 context
  3. 执行体
  4. 异常 → 归类为用户可见错误（通知 + 保留现场）或内部错误（记录 + 降级）
  5. 撤销单元：本次全部文档/模型变更并入同一撤销单元，除非显式声明多单元
  6. 遥测：动作标识 + 位置 + 耗时 + 结果
```

撤销必须原子：动作内多次修改同一文档仍为一个单元；跨文件变更要么全部回滚、要么全部保留。超过阈值（§8）的执行必须转后台任务并附进度指示。同一动作在前一次执行结束前再次触发必须被拒绝（INV-18）。

### 4.4 表面复用

| 表面 | 呈现形态 | 特有约束 |
|---|---|---|
| 主菜单 | 文本 + 图标 + 快捷键提示 | 组层级决定子菜单；空组不显示 |
| 工具栏 | 图标优先，可折叠进次级菜单 | 布局策略决定先隐藏哪些 |
| 上下文菜单 | 文本 + 快捷键 | 只显示与当前选区相关的动作 |
| 命令搜索（命令面板） | 名称/描述/缩写三级匹配 | 结果必须标明动作的来源位置 |
| 状态栏 | 图标或短文本部件 | 部件独立于动作系统（§10） |

- **行为不变**：同一动作在任意表面执行效果一致（INV-4）；位置敏感仅限"是否出现"，不得有"在某位置效果不同"。
- **次级折叠**：空间不足时按布局策略移入次级菜单；被折叠的动作仍必须可被命令搜索命中。
- **选择态同步**：互斥组内至多一个 `selected=true`；跨表面的同一互斥组共用一份状态源。

### 4.5 快捷键与键位方案

- **方案继承**：用户方案派生自内置方案，只保存**差异**；解析为"派生覆盖父"，删除派生项即回落到父。
- **绑定转发**：动作可声明"使用另一动作的快捷键"，源动作改绑则目标自动跟随（INV-17）。
- **内置方案**：实测 17 个方案标识（默认、Eclipse、Emacs、GNOME、KDE、macOS、NetBeans、Qt Creator、ReSharper、Rider、Sublime、Visual Assist、Visual Studio、VS Code、VS for Mac、Xcode、XWin），部分按操作系统限定可用性。
- **冲突检测**：①方案内冲突（同键绑多动作，列出冲突动作并允许改绑/移除/忽略）；②系统冲突（与操作系统或窗口管理器保留键冲突，支持**静音**以免反复打扰）。
- **多键序列**：冲突判定在"完整序列"层面进行；前缀相同但后续不同不构成冲突。
- **冲突不阻塞**：冲突时快捷键仍生效（按解析顺序取首个），但必须在设置界面可见。

### 4.6 工具窗口契约

```
未注册 ──注册──▶ 已注册(条带按钮可见)
已注册 ──首次激活──▶ 内容已创建 ──显示──▶ 可见(停靠/浮动/滑出/独立窗口)
可见 ──隐藏──▶ 已注册(状态保留)
任意态 ──可用性关闭──▶ 不可用(按钮消失，状态保留)
任意态 ──项目关闭/模块卸载──▶ 销毁
```

- **内容惰性**：`内容已创建` 之前**必须不**构造任何内容组件（INV-6）；"内容管理器是否存在"必须与"激活"解耦。
- **空内容自动隐藏**：声明该行为的窗口在最后一个内容关闭后自动隐藏，但保持注册态。
- **可用性关闭 ≠ 隐藏**：前者表示"当前上下文此功能不适用"（如无版本控制的项目不显示提交窗口），恢复时回到关闭前的布局位置。
- **激活回调与放置**：激活必须支持"完成后回调"（在内容创建之后、焦点转移之前触发，调用方不得假设同步完成）；四种类型与四个锚点均可运行期变更，变更触发重新布局而非重建内容。
- **与数据上下文**：窗口激活**必须**把自身注册为上下文提供者，使动作可查询"当前是哪窗口、哪内容、哪选中项"；内容不得假设自己一定活动。
- **远端位置**：结构描述（标识、锚点、类型、内容列表、可见性）必须能与内容本身分离并序列化；渲染侧不支持的内容由拦截器替换为"不支持提示"，不得显示空白面板；白名单限定哪些窗口允许出现在远端。

### 4.7 编辑区

- **编辑器窗口树**：编辑区是可递归分割的树；分割产生新窗口，方向水平或垂直；"强制分割"允许在同一位置重复分割。
- **标签与视图解耦**：一个标签承载一个或多个编辑器视图（同一文件的不同呈现形态）；视图持有光标、选区、折叠，文档由 05 统一管理；关闭标签只释放视图（INV-8）。
- **同一文件多视图**：多个窗口可有独立编辑器实例，各自维护光标与折叠，共享同一文档与撤销栈。
- **预览标签**：每窗口至多一个（INV-9）；以预览方式打开新文件时**替换**当前预览标签；编辑、显式固定、拖放后转为普通标签。
- **拖放**：标签可窗口内重排、跨窗口移动、拖出成独立窗口。拖起时若标签未固定，必须**先固定再移动**，否则源窗口预览槽会被意外清空。
- **关闭与恢复**：关闭标签进入有限深度（量级 10）的"最近关闭"栈，恢复时重开文件并可选恢复光标位置。
- **优先级**：编辑区永远占据主窗口最大权重；工具窗口显示/隐藏不得改变编辑区分割结构。

### 4.8 通知

- **级别支配**：合并显示时取最高级别（错误 > 警告 > 信息 > 产品更新）。
- **显示策略由组决定**：单条通知只能通过 `important` 阻止自动过期，**不得**把 `none` 的组强行弹成气泡（INV-11）。
- **路由**：投递前按注册序经过路由扩展，首个返回"已处理"者截断链路（用于把某项目/某窗口的通知改投别处）。
- **去重**：同组且 `doNotAskId` 相同 → 视为同一通知，更新内容与时间戳；同组且标题与内容完全相同 → 合并并累加计数（"×N"）。去重必须在投递前完成，且对同一毫秒内的并发投递成立。
- **过期与撤销**：普通气泡超时后自动过期，常驻气泡与 `important` 通知必须显式关闭；过期时执行撤销回调。破坏性操作的通知必须携带撤销动作，撤销在过期前有效，因此"可撤销"必须伴随"过期后仍在通知日志中可见"。
- **记住选择与稍后提醒**：`doNotAskId` + 显示名，选择"不再询问"后同标识通知不显示但仍入日志、可在设置中逐条撤销；稍后提醒由策略标识决定延后与复现，策略未注册时退化为"仅入日志"。
- **通知日志**：所有通知（含被抑制者）必须进入日志面板，按组过滤、可搜索。

### 4.9 进度

- **两类形态**：模态（阻塞界面，必须可取消）与后台（不阻塞，进入进度区）。
- **协作式取消**：指示器置取消态，执行体在检查点抛出取消异常；无检查点的长任务违反 INV-12。
- **不可取消段**：临界区（如提交事务）可声明为不可取消段，期间取消请求被挂起，段结束后立即生效。
- **不确定进度与两级文本**：无法估算时用不确定态、不得伪造分数；一级为任务名、二级为当前步骤，二级更新不得比一级更频繁地触发重布局（合并到同一帧）。
- **并行合并**：同 `id` 任务合并为一条并累加计数；不同 `id` 按提交顺序列出并给出总数；界面被模态阻塞时进度区显示"挂起"而非"完成"。
- **完成通知**：后台任务可附完成通知；成功且无需关注的任务**应当不**产生通知。

### 4.10 设置界面

两级结构 = 分组树 + 叶子可配置项。分组携带 id、父 id、排序权重、帮助主题、显示名与描述的资源键；叶子携带创建/读取/校验/写回四个操作。分组必须支持"纯容器"与"自身有界面且有子项"两种形态。每个可配置项**必须**向搜索索引贡献词条（显示名、描述、组路径、内部选项标签）；命中后展开祖先、选中叶子、高亮并滚动到可见。搜索必须能在**不创建界面组件**的前提下完成大部分匹配（索引来自声明与静态文本），否则首次打开会卡顿。动作也可贡献设置入口（"在设置中查找此项"）。

```
isModified(configurable) -> bool
apply(configurable)      -> 可能抛校验错误
reset(configurable)
```

- **apply 逐叶子执行**：任一叶子失败则该叶子保持未应用并给出原因，**其余叶子继续应用**（不得整体回滚，否则用户改动全丢）；**reset** 恢复为"已持久化值"而非"出厂默认值"，恢复默认是独立动作。
- **生效时机**：每项必须声明立即生效或重启生效；立即项在 apply 后重配界面；重启项提示"重启后生效"，且不得在运行期部分生效。
- **外部变更**：设置被外部修改（另一实例、导入）时，已打开界面必须标记过期并允许重新载入。
- **设置项 schema**：`SettingItem { key, scope: application|project, type, default, effect: immediate|restart, searchTerms, validator }`。

### 4.11 视觉系统

- **语义角色而非颜色名**：界面只引用**角色**（"编辑器背景""错误文本""选中项背景"）。解析顺序：主题映射 → 回退角色链 → 内置默认。直接写死颜色值违反 INV-14。
- **计算色与主题**：角色可由函数从其他角色派生（如"悬停背景 = 基础背景加固定亮度偏移"），派生关系必须声明；一个主题 = 角色映射集合 + 图标主题 + 编辑器配色方案标识，可声明"需要重启"（涉及窗口装饰与系统集成时）。
- **高对比度**：独立主题变体而非开关；必须覆盖全部角色，回退链不得回落到低对比度值。
- **图标**：以矢量为主并按主题重着色；同一语义图标在不同主题下是同一"图标角色"的不同呈现，位图仅用于无法矢量化的场景。
- **字体度量**：界面字号与编辑器字号**分离**缩放；界面缩放因子变化触发全量重新度量，编辑器字号变化只影响编辑区；行高按度量计算。
- **刷新**：主题切换必须使全部角色解析缓存失效（INV-15）；已打开的窗口与编辑区就地重绘，不得重建内容。

### 4.12 交互原语

| 原语 | 契约 |
|---|---|
| 对话框 / 弹窗 | 对话框支持模态或非模态、"记住选择"、帮助入口、默认按钮、Esc 取消，非模态不得阻塞后台任务；弹窗轻量、无标题栏、失焦或 Esc 可关，内容不得依赖弹窗自身拥有焦点 |
| 列表/树/表格 | 共用增量过滤：逐字符前缀匹配 + 权重排序；键盘导航（上下移动、左右展开折叠、回车确认）；多选与全选/反选 |
| 就地编辑 / 拖放 | 就地编辑期按键不得冒泡到全局快捷键，Esc 回滚到编辑前值，提交前必须校验；拖起必须携带类型化载荷，放置目标校验类型，跨窗口可拖出成新窗口 |
| 面包屑 | 表示当前位置层级路径；点击任一层跳转；与选中项保持**单向**同步（选中项变 → 面包屑变） |

过滤是**视图层**行为，不得修改底层模型；过滤激活时焦点转入过滤框，退出时回到原焦点位置。

### 4.13 可访问性

- **键盘全路径可达**：一切功能必须有可达的键盘路径（菜单层级、动作快捷键、命令搜索三选一即可）；焦点顺序按视觉顺序，模态区域必须可 Esc 逃逸，不得出现键盘陷阱。
- **焦点模型**：焦点请求异步完成并返回回调；窗口每次停用记录"最后焦点组件"，重新激活时优先回到该点；数据上下文随焦点变化，动作求值只认快照。
- **朗读语义**：可交互元素必须暴露名称、角色、状态与禁用原因；状态变化与通知必须可被朗读播报，播报分"打断当前输出"与"排队等待"两种优先级。
- **缩放**：界面缩放与编辑器字号分离；缩放变化只改变度量，不得改变布局语义或隐藏功能入口。

## 5. 不变量与约束

| 编号 | 不变量 |
|---|---|
| INV-1 | 动作标识全局唯一且版本间稳定；不得复用已废弃标识。 |
| INV-2 | 每个动作必须声明更新线程（后台或界面线程）。 |
| INV-3 | 同一动作在同一次更新会话内至多求值一次。 |
| INV-4 | 动作行为不得依赖其出现的位置；位置只影响是否出现与呈现形态。 |
| INV-5 | 未声明不可搜索的动作必须可被命令搜索命中，且必须能显示其快捷键。 |
| INV-6 | 工具窗口内容必须在首次激活时创建；激活前不得构造内容组件。 |
| INV-7 | 未激活的工具窗口不得持有其内容的强引用。 |
| INV-8 | 同一文件的多个编辑器视图必须共享同一文档与撤销栈。 |
| INV-9 | 每个编辑器窗口至多一个预览标签。 |
| INV-10 | 每条通知必须属于一个已注册的通知组。 |
| INV-11 | 通知显示策略由组决定，单条通知不得绕过用户对组的选择。 |
| INV-12 | 所有可取消的长任务必须持有进度指示并在检查点检查取消。 |
| INV-13 | 每个设置项必须声明作用域与生效时机。 |
| INV-14 | 界面必须通过语义角色引用颜色，不得硬编码颜色值。 |
| INV-15 | 主题切换后不得残留旧主题的角色解析缓存。 |
| INV-16 | 枚举全部动作的查询必须能在不实例化执行体的前提下完成。 |
| INV-17 | 以转发方式绑定快捷键的动作，源动作改绑后必须自动跟随。 |
| INV-18 | 同一动作在前一次执行结束前不得再次进入执行体。 |

## 6. 对外能力契约（概念级）

```
registerAction(action) -> Handle    unregisterAction(id)    getAction(id) -> Action?
bindShortcuts(sourceId, targetId)   unbindShortcuts(targetId)
iterateActions(includeStubs: bool) -> ActionRef[]        // 不实例化
registerToolWindow(descriptor) -> Handle    getToolWindow(id) -> ToolWindow?
activateToolWindow(id, onReady)             // onReady 在内容创建后调用
addActionCustomizer(customizer, strategy)   // light | heavy | asyncLight
addActionPromoter(promoter)    addSurfaceDecoration(place, decorator)
notify(notification)    getNotificationDisplayType(groupId) -> DisplayType
runTask(task) -> CancellableHandle          registerConfigurable(descriptor, scope)
openSettings(groupId?, searchQuery?)       // 可直接定位到某个设置项或搜索结果
```

要求：所有查询接口必须可在无渲染角色（D4）下调用并返回数据而非组件；所有注册接口必须幂等或显式拒绝重复注册，不得"后者覆盖前者"；所有句柄必须可显式注销，注销后查询不得再返回。

## 7. 故障模式与降级

| 故障 | 检测 | 用户可见 | 档位 | 恢复 |
|---|---|---|---|---|
| 动作求值抛错 / 更新超时 | 求值期捕获 / 单帧预算检查 | 该动作本次不可用 / 无提示（诊断可见） | D2 / D0 | 下一次会话重试 / 按动作标识聚合记录 |
| 执行体抛错 | 执行期捕获 | 通知 + 保留现场 | D2 | 撤销单元回滚后重试 |
| 定制器/提升器失败 | 注册与求值期 | 该定制不生效 | D2 | 跳过该项；可禁用后重启 |
| 工具窗口工厂抛错 | 内容创建期 | 错误占位，按钮保留 | D2 | 重新激活可重试 |
| 通知组未注册 | 投递前校验 | 落入默认组并记录 | D2 | 修正注册 |
| 布局档案损坏/版本过旧 | 载入期校验 | 回落默认布局 | D2 | 自动迁移；失败则用默认 |
| 主题缺角色 | 解析期 | 回退链生效，视觉可能不一致 | D0 | 诊断报告缺失角色清单 |
| 键位方案缺失 / 任务不响应取消 | 载入期 / 取消后超时 | 回落默认方案 / 标记"取消中" | D2 / D0 | 提示重新选择 / 允许强制终止（隔离进程见 12） |
| 设置应用失败 | 校验/写回期 | 该项标红并给原因 | D0 | 修正后重试 |
| 界面线程冻结 | 看门狗（03 §10） | 卡顿报告入口 | D2 | 导出线程栈 |

无渲染角色（D4）下，动作、工具窗口、通知、进度**必须**以数据形式可用；任何"必须渲染才能求值"的实现都是设计缺陷。

## 8. 资源与性能预算

| 项 | 预算/实测 |
|---|---|
| 扩展点声明 / 注册条目 | 3235（模块 2352 + 插件自命名空间 883）/ 29282（模块 18615 + 插件 10667），实测 |
| 动作标识 / 动作组 | 1559 / 487（实测） |
| 描述符层动作与组声明 | 3033 / 1128 条（实测）；同标识声明合并后计入上表数量级 `[推断]` |
| 工具窗口 | 37（模块 24 + 插件 13，实测） |
| 状态栏部件工厂 | 73（实测） |
| 通知组 / 编辑区通知提供者 | 452 / 103（实测） |
| 主题提供者 / 配色页面 | 30 / 61（实测） |
| 内置键位方案 / 单次更新会话 | 17 个标识（实测）/ 必须 ≤ 一帧，超预算必须记录 |
| 单动作呈现求值 / 工具窗口首次内容创建 | 量级 1 ms（超 10 ms 视为设计问题）/ 量级 100 ms（超出显示占位）`[推断]` |
| 通知气泡停留 / 最近关闭标签栈深度 | 量级 10 s（常驻气泡不自动消失）/ 量级 10 项 `[推断]` |
| 图标驻留 | 以角色为键缓存；切换主题时整批失效 |

## 9. 可观测性

必须能回答以下问题，并给出最小状态：

1. **命令是什么、在哪触发、多久**：动作标识 + 位置 + 耗时 + 结果（成功/取消/异常）。
2. **界面为何卡**：界面线程上最长的更新会话、涉及动作标识、是否超单帧预算。
3. **焦点为何转移**：焦点请求日志（请求者、目标、项目、是否强制、是否在窗口内），可按时间回放。
4. **通知为何没出现**：投递记录（组、显示策略、是否去重、是否被路由拦截、是否"不再询问"）。
5. **进度为何不动**：任务标识、最后检查点、是否已请求取消、是否处于不可取消段。
6. **布局与主题为何异常**：档案标识、应用模式（播种/强制）、迁移版本与差异；主题标识、角色解析链（请求角色 → 命中角色 → 默认）、缺失角色清单。

诊断入口必须支持导出为可粘贴文本快照，且不含用户代码内容。

## 10. 扩展点

| 接缝 | 契约 | 失败隔离 |
|---|---|---|
| 动作与动作组 | 标识、实现、图标、快捷键引用；组可声明不可搜索 | 单动作失效 → 该动作不可用 |
| 动作定制器 / 提升器 | 定制器三档策略（轻量同步/重量同步/异步轻量）；提升器只能重排不得增删 | 抛错 → 跳过定制器 / 使用原顺序 |
| 键位扩展 | 为方案追加/覆盖绑定 | 冲突按 §4.5 处理，不阻断 |
| 工具窗口 / 内容后处理 | 标识、锚点、图标、次要性、可否关闭内容、是否随启动激活；内容创建后加工（换标题、加工具条） | 工厂失败 → 错误占位；后处理抛错 → 跳过加工 |
| 内容抽取模式 / 状态栏部件 | 声明远端可渲染的内容类型 / 标识、显示名、可用条件、创建部件 | 未声明类型按不支持处理；部件创建失败 → 不占位 |
| 通知组 | 显示标识、缺省策略、是否入日志、目标面板、父组 | 组注册失败 → 落入默认组并记录 |
| 通知路由 / 稍后提醒策略 | 投递前拦截并返回是否已处理；声明延后时长与复现方式 | 抛错视为未处理继续链路；缺失策略退化为仅入日志 |
| 编辑区通知 | 在编辑区顶部注入提示条（信任、配置缺失等） | 抛错 → 不显示该条 |
| 主题 | 标识、资源路径、父主题、目标界面类型、是否需重启 | 解析失败 → 回退父主题 → 回退默认 |
| 主题元数据 / 重映射 / 配色页面 | 补充角色定义、修正旧角色名、贡献可编辑角色组 | 失败 → 忽略该映射 / 该页不出现 |
| 图标提供者 / 文件图标提供者 | 按文件或元素返回图标角色 | 抛错 → 使用默认图标 |
| 设置分组 | id、父 id、权重、帮助主题、显示名与描述键 | 父缺失 → 挂到根并按权重排序 |
| 欢迎屏 | 欢迎屏本体、标签页工厂、定制项、项目提供者 | 失败 → 使用内置欢迎屏 |

通用约束：扩展**必须**声明来源模块以便卸载级联（02 §4.4）；扩展**不得**在注册期创建界面组件（否则破坏 INV-6）；界面类扩展的异常必须隔离在"该扩展不可用"层面，不得传播为窗口级失败。

## 11. 对照实现（证据锚点）

| 上文结论 | 证据锚点 |
|---|---|
| 动作/组数量与扩展点总量（§1.1、§8） | `_rev/agg.json`：`actions`=1559、`groups`=487；`_rev/ep_counts.json`：`total`/`module`/`plugin` 三档口径 |
| 更新线程二值契约、单会话去重、强制刷新（§4.2、INV-2/3） | `ActionUpdateThread`（`BGT`/`EDT`）、`AnAction#getActionUpdateThread`；`ActionToolbarImpl#updateActionsImmediately` / `updateActionsAsync` / `myForcedUpdateRequested` |
| 两阶段注册、转发绑定、桩惰性、定制器三档（§4.1、INV-16/17） | `impl/ActionRegistrar`（`putAction`/`bindShortcuts`/`getActionBinding`）、`ActionPreInitRegistrar`、`PostInitActionRegistrar`、`ActionGroupStub`、`ActionManagerImpl#unstubbedActions`；`ActionConfigurationCustomizer` 的 `Light`/`SyncHeavy`/`AsyncLight` 策略 |
| 提升器只重排（§4.2、§4.4） | 扩展点 `com.intellij.actionPromoter`（46 处）；`SpeedSearchActionPromoter#promote(List, DataContext)` |
| 位置标识与工具栏折叠/外观（§4.4、§4.11） | `ActionPlaces`：`MAIN_MENU`、`MAIN_TOOLBAR`、`EDITOR_POPUP`、`TOOLWINDOW_POPUP`、`STATUS_BAR_PLACE`、`ACTION_SEARCH` 等；`ActionToolbarImpl`：`setLayoutStrategy`、`SHOW_TEXT_IN_TOOLBAR`、`setCustomButtonLook` |
| 可搜索性关闭与快捷键转发（§4.5、INV-5/17） | `ActionPluginRegistrarKt`：`group.setSearchable(boolean)`（描述符 `searchable="false"` 103 处）；属性 `use-shortcut-of` |
| 方案继承、差异存储、方案内与系统冲突（§4.5） | `keymap/impl/KeymapImpl`：`parent`、`schemeState`、`getConflicts(actionId, shortcut)`；`SystemShortcuts`：`MuteConflictsSettings`、`getUnmutedKeymapConflicts` |
| 内置方案清单与动作缩写（§4.4、§4.5、§8） | `KeymapManagerImpl`：`eclipse`/`emacs`/`gnome`/`kde`/`macOS`/`netbeans`/`qtcreator`/`resharper`/`rider`/`sublime`/`visualAssist`/`visualStudio`/`vsCode`/`vsForMac`/`xcode`/`xwin` 等；`AbbreviationManagerImpl`（状态文件 `abbrevs.xml`，分类 KEYMAP） |
| 数据上下文/快照/异步键（§3.2） | `openapi/actionSystem`：`DataKey`、`DataContext`、`DataSnapshot`、`DataSink`、`UiDataRule#uiDataSnapshot(sink, snapshot)` |
| 工具窗口类型/锚点/内容形态/注册属性/惰性（§3.3、§4.6、INV-6/7） | `ToolWindowType`、`ToolWindowAnchor`（`isSplitVertically`）、`ToolWindowContentUiType`（`TABBED`/`COMBO`）；扩展点 `com.intellij/toolWindow`（bean `ToolWindowEP`，属性 `anchor`/`secondary`/`canCloseContents`/`doNotActivateOnStart`/`order`）；`ToolWindow#getContentManagerIfCreated`/`setAvailable(bool, callback)`/`setToHideOnEmptyContent` |
| 布局档案、播种模式、默认布局构建器（§3.3、§4.6、§7） | `ProjectFrameToolWindowLayoutBean`（`frameType`/`applyMode`/`migrationVersion`）、`ToolWindowLayoutApplyMode`（`SEED_ONLY`/`FORCE_ONCE`）、`ProjectFrameToolWindowBean`（`weight`/`sideWeight`/`split`）、`DefaultToolWindowLayoutBuilder`；扩展点 `defaultToolWindowLayout`（6 处）、`toolWindowLayoutProfileProvider` |
| 布局版本迁移与远端拦截（§4.6、§7） | `ToolWindowLayoutProfileMigrationHelperKt`；扩展点 `toolWindowExtractorMode`（6）、`toolWindowAllowlist`（9）、`com.intellij.rdserver.toolWindowContentInterceptor`、`com.intellij.rdserver.unsupportedToolwindowMessageProvider` |
| 编辑区打开选项、预览、拖起固定（§4.7、INV-9） | `FileEditorOpenOptions`（`usePreviewTab`/`pin`/`reuseOpen`/`index`）、`EditorWindow`（`isPreview()`、`shouldReservePreview`、`DRAG_START_PINNED_KEY`、`split(...)`、`restoreClosedTab`） |
| 多视图共享文档（§4.7、INV-8） | `FileEditorManager#getComposite(VirtualFile)`、`getSelectedEditors()`、`openFile(file, focus, searchForOpen)` |
| 通知级别、显示策略与字段层级（§3.5、§4.8、INV-10/11） | `NotificationType`（`getDominatingType`）、`NotificationDisplayType`（`NONE`/`BALLOON`/`STICKY_BALLOON`/`TOOL_WINDOW`）；`Notification`（`myActions`/`myCollapseDirection`/`myDoNotAskId`/`myRemindLaterHandlerId`/`myImportant`）、`NotificationGroup`（`displayId`/`displayType`/`isLogByDefault`/`toolWindowId`/`parentId`） |
| 按组持久化策略与落点（§4.8） | `NotificationsConfiguration#getDisplayType/changeSettings/getNotificationLocation`；`NotificationLocation` 默认 `BOTTOM_RIGHT`；描述符 `<toolWindow id="Notifications" secondary="true">` |
| 朗读模式与投递路由（§4.8、§4.13） | `NotificationAnnouncingMode`（`NONE`/`MEDIUM`/`HIGH`）；扩展点 `com.intellij.notificationRouter`（5）→ `NotificationRouter#routeNotification` |
| 进度指示器与模态/后台形态（§4.9） | `ProgressIndicator`（`isCanceled`/`isIndeterminate`/`setFraction`/`startNonCancelableSection`/`pushState`/`isModal`）；`ProgressManager#runProcessWithProgressSynchronously` / `…Asynchronously`；`PerformInBackgroundOption` |
| 并行任务合并（§4.9） | `MergingQueueGuiExecutor`（`MergeableQueueTask`、`MergingTaskQueue`、`suspendedText`、`isRunning`） |
| 设置作用域、分组、搜索与定位（§4.10、§10） | 扩展点 `applicationConfigurable`（142）、`projectConfigurable`（125）、`groupConfigurable`（28）；`ConfigurableGroupEP`（`id`/`parentId`/`weight`/`helpTopic`）；`SearchableConfigurable#enableSearch`；`ConfigurableEP#searchableInActions` |
| 语义角色/主题/配色页面/图标注入（§4.11、INV-14） | `ColorKey`（`externalName`/`defaultColor`/`fallbackColorKey`/`FUNCTION_KEY`）；`UIThemeProvider`（`id`/`path`/`parentTheme`/`restartRequired`）、`UITheme#isDark()`；扩展点 `themeProvider`（30）、`colorSettingsPage`（61）、`iconProvider`（39）、`fileIconProvider`（31） |
| 状态栏部件契约（§10、§8） | `openapi/wm/StatusBarWidget`：`ID()`、`getPresentation()`、`WidgetPresentation#getTooltipText/getShortcutText/getClickConsumer`；扩展点 `statusBarWidgetFactory`（73） |
| 编辑区内联提示与欢迎屏（§10） | 扩展点 `editorNotificationProvider`（`area=IDEA_PROJECT`，103 处）、`welcomeScreen`、`welcomeTabFactory`（17）；`TabbedWelcomeScreen`、`NewWelcomeScreen` |
| 过滤原语、面包屑与焦点模型（§4.12、§9、§4.13） | `SpeedSearchBase`（`isStickySearch`/`keepEvenWhenFocusLost`/`hasActiveSpeedSearch`）、`BreadcrumbsComponent`、`BreadcrumbsForceShownSettings`；`FocusManagerImpl`（`requestFocus`/`doWhenFocusSettlesDown`/`getLastFocusedFor`/`FOCUS_REQUESTS_LOG`/`requestDefaultFocus`） |
| 朗读与辅助技术检测、平台差异（§4.13） | `accessibility/ScreenReader`（`isActive`、`ACCESS_BRIDGE`、`ATK_WRAPPER`）、`AccessibleAnnouncerUtil#announce`；`com/intellij/accessibility`（`LinuxAccessibilitySupport` 等） |

## 12. 未决问题

- **命令面板的统一索引**：动作搜索与设置搜索是两个独立贡献者，但"统一命令面板"是否把项目级命令（运行配置、工具窗口、设置项）合并为同一结果集并按统一权重排序，证据不足；本文按"多来源合并 + 每来源自带排序"描述，`[推断]`。
- **工具窗口多实例**：工具窗口以 `id` 唯一标识，未见"同一 `id` 多实例"的声明属性；本文按"一个 `id` 一个实例、多内容并列"建模，`[推断]`。
- **通知去重键的确切语义**：`displayId` 与 `doNotAskId` 的用途在字段层可见，但"合并计数"与"就地更新"的选择依据未在证据中出现，`[推断]` 为"同 displayId 且内容相同则计数，否则就地更新"。
- **进度区呈现与主题重启边界**：进度指示器与合并队列存在，但"状态栏部件承载进度汇总"的具体部件未见，`[推断]` 由状态栏部件体系承担；`restartRequired` 标记存在，但哪些角色或窗口装饰触发重启未细化，`[推断]` 与系统级窗口装饰和图标缓存相关。
- **高对比度的角色覆盖面**：存在独立高对比度主题资源，但"是否覆盖全部角色"无法静态确认，本文按"必须覆盖"约束（INV-14 推论），`[推断]`。
- **哑模式下的判定粒度**：动作有 `dumbAware` 标记，但"部分可用"（导航可用、重构不可用）如何表达未见三态，`[推断]` 为按动作拆分。
