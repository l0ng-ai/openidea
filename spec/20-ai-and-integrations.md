# 20 — 智能辅助与外部工具集成

> 范围：智能辅助接入面（代理客户端协议、工具服务端、整行补全、内联补全、搜索排序学习）、上下文供给与预算、代码溯源、协议客户端（语言服务器协议、调试适配协议）、终端、HTTP 客户端、容器与编排、执行位置注册、轻量外部工具集成，以及所有外部集成必须满足的统一约束。｜ 依赖：01、02、03、08、09、12、13、15、17。｜ 排除：调试会话内部语义（见 12）、远程传输与拓扑（见 17）、版本控制模型（见 18）、数据库工具（见 19）。

## 1. 目的与范围

### 1.1 本子系统解决什么问题

本系统的核心机制必须在没有网络、没有外部进程时成立（见 01 §6 原则 7）。但真实工作必然要让**假定不可靠的东西**进入工作台：模型、代理进程、语言服务端、容器、远端主机、外部命令行工具。它们共有四个属性：

1. **可能不存在，也可能变慢** —— 未配置、未安装、被策略禁用；网络往返、远端调度、冷启动。
2. **可能不可信，也可能外发数据** —— 返回内容未经校验、进程可能崩溃、可执行体可能被替换；请求一旦离开进程，用户代码即离开设备。

因此本子系统不是"一批功能"，而是一组**边界设计**：如何把外部能力接进来（接入面），如何把本地能力递出去（工具服务端），如何决定"递什么、递多少"（上下文供给），以及如何在这些通道上维持可禁用、可隔离、可声明、可降级。

### 1.2 边界

**不负责**：模型的训练与推理实现、提示词内容（只规定请求的生命周期、预算与接收约束）；代理自身的决策逻辑（只规定发现、启动、握手、取消、终止）；语言服务器协议/调试适配协议/代理客户端协议/模型上下文协议的报文定义（外部标准，本规格只规定客户端与服务端的工程契约）；容器编排与镜像构建语义；远端传输的编解码与重连（见 17）；调试会话的断点、步进、求值语义（见 12）。

### 1.3 与其他子系统的关系

| 依赖 | 关系 |
|---|---|
| 03 / 08 | 外部调用必须落在可取消的后台任务上，不得占用输入线程；语言服务器与外部分析器的诊断必须归并进统一检查呈现 |
| 09 | 补全通道（整行/内联）作为候选源接入查表，导航结果并入引用与声明 |
| 12 | 调试适配器客户端把外部调试器映射到统一调试模型 |
| 13 / 14 | 每个集成面必须有可见开关、状态与数据出境声明 |
| 15 | 所有集成以扩展点接入；禁用后不得留下残缺状态 |
| 17 | 终端、工具服务端、容器在远程拓扑下必须能在服务端独立成立 |

## 2. 概念模型

### 2.1 术语

| 术语 | 英文 | 定义要点 |
|---|---|---|
| 智能辅助面 | AI Surface | 一切"由模型生成内容"的呈现位置统称（补全、内联编辑、对话） |
| 代理 | Agent | 外部编码代理进程；本系统启动并与之走代理客户端协议 |
| 代理客户端协议 | Agent Client Protocol (ACP) | 本系统为客户端、代理为服务端的会话协议 |
| 工具服务端 | Tool Server | 本系统为服务端，把自身能力以工具形式暴露给模型的一方 |
| 工具集 | Toolset | 同领域工具的邏辑分组，是暴露与授权的最小单位 |
| 补全通道 | Completion Channel | 查找表补全、内联补全（光标处渲染的建议文本）、整行补全（整行/多行粒度候选源）三类候选源的统称 |
| 上下文供给器 | Context Provider | 依据位置与语言装配上下文片段的组件；片段是可独立裁剪、计数、脱敏的最小供给单位 |
| 溯源记录 | Provenance Record | "某段代码由谁以何种方式产生"的事件记录 |
| 语言服务端 | Language Server | 走语言服务器协议的外部分析进程 |
| 调试适配器 | Debug Adapter | 走调试适配协议的调试后端 |
| 执行位置 | Execution Location | 本地 / WSL / SSH / 容器 / 编排集群中的可执行环境 |
| 终端会话 | Terminal Session | 一个伪终端 + 一个 shell 进程 + 一块屏幕缓冲 |
| 请求文件 | Request File | 以文本描述 HTTP 请求的可执行文档；其变量取值集合称环境（Environment），分公有与私有两类 |
| 外部工具 | External Tool | 由用户以声明方式配置的命令行调用 |

### 2.2 三类外部依赖的隔离层级

| 层级 | 承载 | 隔离手段 | 典型成员 |
|---|---|---|---|
| L1 进程内协议客户端 | 只做报文编解码与状态机 | 能力开关、超时、结果丢弃 | 语言服务器协议、调试适配协议、代理客户端协议 |
| L2 独立进程 | 外部可执行体 | 进程边界；启动失败即"不可用" | 语言服务端、代理进程、工具服务端调用的目标、外部工具 |
| L3 远端主机 | 网络可达的执行环境 | 连接生命周期、凭据隔离、路径映射 | SSH 主机、WSL 发行版、容器、编排集群 |

**不变量**：L1 的任何失败不得表现为进程级失败；L2/L3 的任何失败必须降级为"该能力不可用"，而不是"该功能产生错误结果"。

### 2.3 信任边界

```
[可信：本进程]            [半可信：本机子进程]        [不可信：网络对端]
工作区模型/索引/语法树  →  语言服务端/代理/外部工具  →  模型服务/集群 API
      ↑ 只出不回                 ↑ 结果必须校验              ↑ 只出请求，不执行返回物
```

### 2.4 关系图

```
Agent Catalog ─> Agent Session ─> 工具调用 ─> Toolset ─> 平台能力
Completion Request ─> Context Bundle ─(裁剪/脱敏)> 模型 ─> Proposal ─> 编辑器
Document Edit ─> Provenance Event ─> 溯源库 ─> 作者导出 / 质量平台对齐
Language Server ─> 诊断/补全/导航 ─> 平台模型；Terminal ─> 命令块 ─> 历史/VFS 刷新
```

## 3. 数据模型

```
AgentDescriptor {
  id: string; displayName: string    // id 在发现期唯一
  launchKind: process | remote
  capabilities: string[]             // 声明的协议能力子集
  enabled: bool                      // 默认 true；策略可强制 false
}
AgentSession {
  id: string; projectId: string      // 会话必须归属项目
  agent: AgentDescriptor
  state: discovering | launching | handshaking | ready | busy | terminated | failed
  startedAt: timestamp; failureReason: string?
}

ToolDescriptor {
  name: string                       // 形如 "组.动作"，全局唯一
  toolset: string
  sideEffect: read | write | execute | network
  requiresConfirmation: bool         // 由副作用等级推导
  inputSchema: Schema; outputSchema: Schema?
}
ToolInvocation {
  tool: string; args: Data
  state: queued | running | succeeded | failed | cancelled
  progressThrottleMs: int            // 默认 1000
}

CompletionRequest {
  documentId: DocumentId; projectId: string; languageId: string
  offset: int; deadlineMs: int; contextBudget: int
  contextVersion: long               // 文档版本；结果必须对齐此版本
  trigger: explicit | auto | removal
}
CompletionProposal {
  requestContextVersion: long
  range: TextRange                   // 必须与被替换文本对齐
  text: string; multiline: bool; confidence: float
  origin: localModel | remoteModel | heuristic
  state: shown | accepted | rejected | expired | superseded
}

ContextFragment {
  kind: selection | fileHead | fileTail | imports | sibling | diagnostic
      | recent | repositoryMap | schema | frameworkModel | runtimeOutput
  content: string; priority: int     // 优先级是裁剪顺序的唯一依据
  tokenEstimate: int
  redacted: bool; sourceUri: string?
}

ProvenanceRecord {
  documentId: DocumentId; revision: long; range: TextRange
  origin: typed | pasted | completed | refactored | agent | aiAction
  agentId: string?                   // origin 为 agent/aiAction 时必填
  committedRevision: string?         // 提交后回填
}

LanguageServerDescriptor {
  id: string; languageId: string
  launch: process | socket
  capabilities: { completion, diagnostics, navigation, formatting }
  priority: int                      // 与内置语言能力竞争时的判定依据
}

TerminalSession {
  id: string; shell: string; location: ExecutionLocationRef
  state: starting | ready | commandRunning | closed | broken
  screenBuffer: RingBuffer           // 固定容量，溢出丢最旧行
  commandBlocks: CommandBlock[]
}

HttpRequestFile { format: text; requests: HttpRequest[] }    // 纯文本，逐请求分隔
HttpRequest {
  method: string; urlTemplate: string                        // 含变量占位符
  headers: Map<string,string>; body: string?; assertions: Assertion[]
}
Environment {
  name: string; visibility: public | private                 // private 不得进入版本控制
  variables: Map<string,string>
}

ExecutionLocation {
  kind: local | wsl | ssh | container | orchestration
  id: string; credentialsRef: string?                        // 只存引用，不存明文
  pathMapping: { localPrefix, remotePrefix }[]
}

KubernetesResource {
  kind: string; namespace: string; name: string
  parent: ResourceRef?; childCount: int                      // 惰性展开
  health: unknown | healthy | degraded | failed
}
```

**持久化形态**：代理目录与工具集注册属于声明（可随模块装卸）；补全缓存、溯源记录、终端历史、环境变量属于用户数据（写入项目或应用存储，见 14）；执行位置与凭据属于安全敏感数据，凭据只落引用。

## 4. 行为契约

### 4.1 代理会话生命周期

```
discovering ──发现──> launching ──就绪──> handshaking ──协商──> ready ⇄ busy
     │                   │                    │                 │
     └─无可用─> (能力缺席) └─启动失败─> failed                终止请求 ──> terminated
```

- **发现必须可缓存**：目录查询结果按"代理集合版本"缓存，不得每次开会话都遍历磁盘与网络。
- 一个项目可持有多会话，但同一代理的同一会话身份不得重复建立；**协商结果必须被裁剪使用**——未声明的能力不得调用，也不得在界面暴露入口。
- **终止必须两段式**：先请求优雅退出，超时后强制结束并回收子进程。
- 会话状态必须可被工具服务端查询，用于判定"是否有活跃代理可承接确认请求"。

### 4.2 工具服务端

1. **枚举**：把已注册工具集展开为清单；同名工具重复注册视为冲突并拒绝后者。
2. **过滤**：过滤器按序组合且**拒绝优先**；表达式形如 `-*,+组.*,-*.动作`（先全禁、按组开、按动作关），默认允许集必须显式声明，不得默认全开。
3. **授权**：`write`/`execute` 类工具调用前必须完成一次确认（由人或已声明策略代为确认），确认必须携带被影响的路径或命令文本。
4. **进度、取消与输出**：长任务以不低于节流间隔的频率上报进度与心跳（默认 1000 毫秒）；取消必须在安全点生效，不得留下半完成写操作；输出模式可回传调用方，关闭该能力时退化为纯文本结果。

**不变量**：工具调用必须走与用户操作相同的动作/检查/重构入口，不得存在"仅对模型开放"的旁路写路径。

### 4.3 补全通道（整行、内联、查找表）

```
键入 ──> 触发判定 ──> 去抖 ──> 上下文装配 ──> 请求 ──> 候选过滤 ──> 呈现
                                                             │
                                         接受/拒绝/超时/被取代 ┘──> 缓存与统计
```

- **触发判定**在本地完成且可学习：是否值得请求由触发模型判定，可关闭（关闭后退化为规则判定）。
- **去抖分层**：按输入类型分档，默认 20 / 20 / 80 毫秒（实测）；对话式输入默认 200 毫秒。去抖可自适应并带全局关闭开关。
- **版本绑定**：请求携带发起时文档版本，返回版本不符即丢弃，不得"补丁式"应用；队列深度为 1，新请求取代旧请求而非排队。
- **候选过滤**：必须经过语法合法性、重复度、禁止位置、注释与字符串区域抑制；过滤实现可替换。
- **接受、拒绝与缓存**：接受按候选声明的范围替换；拒绝不得改动文档并记录负样本；**移除触发**（用户删掉已呈现建议）必须与"拒绝"分开记录；缓存按"位置 + 上下文键"，失效条件是文档版本推进或编辑器属性变化而非时间。
- **通道优先级**：同一时刻至多一个内联建议已呈现，新建议先取代旧建议；查找表已打开时内联建议让位，除非可作为查找表项插入；两通道共享同一抑制状态来源；部分接受（按词/按行）的边界由元素操纵器定义，不得由文本长度启发式决定。

### 4.4 上下文供给：选择、裁剪、脱敏、按需拉取

按优先级从高到低填充直至预算耗尽：

| 优先级 | 片段 | 说明 |
|---|---|---|
| 1 | 选区 | 用户显式选中，始终包含 |
| 2 | 光标所在文件头尾 | 头部取声明区，尾部取邻近行 |
| 3 | 诊断 | 当前文件错误/警告摘要，只取消息与位置 |
| 4 | 导入与引用声明 | 只取被引用符号的签名，不取实现 |
| 5 | 同族/相似文件 | 由检索策略决定，数量受限 |
| 6 | 最近编辑位置 | 会话内最近跳转与编辑位置 |
| 7 | 仓库结构摘要 | 文件到符号的粗粒度映射 |
| 8 | 数据模型/框架派生 | 由语言或框架插件提供的模式与模型 |
| 9 | 运行结果 | 最近一次运行的输出尾部 |

```
assemble(position, budget):
  1. 由上下文策略集合（按语言选取，逐语言可配置）生成候选片段序列
  2. 按优先级稳定排序；同优先级按体积升序（先塞小的）
  3. 逐片段：tokenEstimate <= 剩余预算 → 收下；否则按行边界截断到预算内
  4. 收下前必须脱敏；脱敏后体积变化必须重新计数
  5. 预算耗尽即停止，不得为"完整性"超预算
  6. 输出 Context Bundle，附带每片段来源以便诊断与撤回
```

- **脱敏必须在离开进程前完成**，强制覆盖：访问凭据、私钥体、连接串中的口令、显式私有环境变量。
- **按需拉取与可撤回**：优先级 5、7、8 可在装配中触发索引查询（见 07）但受同一截止时间约束，超时片段直接缺席；任一供给器可单独禁用且其片段永久缺席，未出现在策略中的片段种类不得被"顺手"加入。

### 4.5 溯源记录

- 粒度是**变更区间**而非整文件；来源固定六类（键入/粘贴/补全/重构/代理/AI 动作）；无法判定时记为"键入"并在诊断中计数，**不得**猜测为代理来源。
- 代理来源必须携带代理标识，代理写入后被人工改写的区间必须重新归属。
- 记录必须能在提交后回填提交修订号，以支持"这行代码来自哪个提交、以何种方式产生"的双向查询。
- 提交、搁置、回滚、暂存必须触发一次导出钩子；是否导出**匿名**作者信息为独立开关，默认关闭。

### 4.6 语言服务端客户端

```
未配置 ─配置─> 解析(可执行/端口) ─> 启动 ─> 握手 ─> 能力登记 ─> 就绪
                                     │                  │
                              失败 ──┴─> 退避重试 ─> 放弃(标记不可用)
就绪 ─> 文档同步(打开/变更/关闭/保存) ─> 请求(补全/诊断/导航)
就绪 ─> 崩溃 ─> 重启一次 ─> 再失败则禁用并通知
```

- **文档同步**：服务端看到的文档表示由文档适配器映射（换行、编码、偏移基准可不同），映射必须双向可逆，否则拒绝装载。
- **能力登记**：握手登记的能力决定后续请求；未登记的能力不发请求，也不得在界面暴露来源。
- **失败降级**：服务端不可用即该类能力缺席，其余编辑与内置语言能力不受影响（D2）。
- **结果并入**：诊断归并为检查结果（可降级为弱警告）；补全归并为查找表项；导航归并为引用/声明结果；结构视图归并为结构树子节点。
- **优先级**：内置语言能力与服务端同类结果并存时内置优先且必须去重，服务端结果必须标注来源。`[推断]`

### 4.7 终端会话与执行位置

- **分配**：一个会话 = 一个伪终端 + 一个 shell 进程；伪终端尺寸必须随视图尺寸变化下发调整。
- **启动路径**：本地 shell 经执行环境抽象启动；WSL 会话经远端执行通道启动而非调用宿主外壳；SSH 会话在远端建立。
- **命令边界检测**：优先使用 shell 集成（shell 侧在提示符与命令结束时发出标记），无集成时退化为启发式；启发式必须显式标注不可靠，其产出（命令块、退出码）不得用于破坏性决策。
- **分页缓冲**：屏幕可见区与历史区分离，历史区为固定容量环形缓冲（溢出丢最旧行），搜索与复制只作用于缓冲内内容。
- **链接识别**：识别绝对与相对路径、行号后缀、URL；文件类链接打开编辑器而非浏览器，相对路径相对"命令执行时的工作目录"解析。
- **多标签、端口转发与执行位置**：标签集合按项目持久化，重启后恢复标签描述（工作目录、shell、标题）而**不是**进程状态；会话可声明远端端口到本地端口转发，方向由执行位置决定；位置选择以运行配置的显式声明优先、项目默认位置次之、最后回退本地，注册位置必须声明路径映射与凭据引用，未声明映射者不得用于需要读写文件的执行。位置注册是全局的，终端、运行、调试、工具服务端经同一注册表查询；映射必须双向，冲突必须报错而非择一。

### 4.8 HTTP 请求文件

- **解析与变量**：按分隔行切分为多个请求，各自独立可执行，必须容忍部分非法（非法请求标记不可执行、其余照常）；变量三级取值——文件内定义 → 环境变量 → 内建动态变量（时间、随机、标识），顺序固定且后者不覆盖前者，只有更高优先级的显式赋值能覆盖。
- **环境选择**：公有环境文件可入库，私有的不得入库；同名变量私有优先。
- **执行与呈现**：请求按协议类型分派给执行支持组件，复用统一超时与取消；响应默认呈现状态、头、体，体可按内容类型切换为结构化视图或内嵌浏览器预览，并可被自定义呈现器接管。
- **认证**：凭据可来自请求头、环境变量、cookie 存储或账户凭据；账户凭据必须显式启用。
- **与代码互操作**：可由服务端路由声明生成请求（方法、路径、参数、示例体），可由命令行会话文本反向生成请求；方向**单向**（代码 → 请求），不得反向改写代码。

## 5. 不变量与约束

| 编号 | 不变量 |
|---|---|
| INV-1 | 任何外部集成必须可单独禁用；禁用后系统其余功能完整可用。 |
| INV-2 | 任何外部调用必须在可取消的后台任务上执行，且必须携带截止时间。 |
| INV-3 | 外部返回内容进入平台模型前必须经过校验/过滤/去重，不得直接作用于文档。 |
| INV-4 | 补全候选的文本范围必须与发起请求时的文档版本对齐；版本推进即作废。 |
| INV-5 | 上下文片段离开进程前必须完成脱敏；未脱敏片段不得进入请求。 |
| INV-6 | 上下文总量不得超过预算；预算耗尽必须停止填充，不得截断后超发。 |
| INV-7 | 每个工具调用必须可追溯到调用者会话与目标资源。 |
| INV-8 | 工具名全局唯一；重复注册必须被拒绝而非覆盖。 |
| INV-9 | 同一时刻至多一个内联建议处于已呈现状态。 |
| INV-10 | 语言服务端未在握手期登记的能力，不得被请求。 |
| INV-11 | 终端命令块由 shell 集成产出时可信；由启发式产出时必须标记为不可靠。 |
| INV-12 | 私有环境文件与凭据明文不得写入版本控制可见的位置。 |
| INV-13 | 无网络时，编辑、导航、内置语言能力、已缓存补全必须照常工作。 |
| INV-14 | 任何数据外发通道必须能在设置中枚举出"外发什么、发往哪里、如何关闭"。 |

## 6. 对外能力契约（概念级）

```
listAgents() -> AgentDescriptor[]
openSession(project, agentId) -> AgentSession
closeSession(session, gracefulTimeoutMs) -> void
requestCompletion(CompletionRequest) -> CompletionProposal[]      // 可能为空
decideProposal(proposal, accepted, granularity) -> Edit?    // 拒绝时不产生编辑
assembleContext(position, budget, policySet) -> ContextBundle

listTools(filter) -> ToolDescriptor[]
invokeTool(name, args, progressSink) -> ToolResult
registerToolset(toolset) -> Handle                               // 失败隔离
setToolFilter(expr) -> void

recordProvenance(record) -> void
queryProvenance(documentId, range) -> ProvenanceRecord[]
exportAuthorship(scope, anonymous) -> Artifact

startLanguageServer(descriptor) -> ServerHandle
serverState(handle) -> { initializing, ready, disabled, failed }
mapResults(serverResult) -> LookupItem[] | InspectionResult[]
startDebugAdapter(descriptor) -> DebugSessionRef                  // 见 12

createSession(location, shell) -> TerminalSession
sessionBlocks(sessionId) -> CommandBlock[]
forwardPort(sessionId, remotePort) -> LocalPort

parseRequestFile(text) -> HttpRequestFile
executeRequest(request, environment) -> HttpExchange
generateRequestFromRoute(symbol) -> HttpRequest

registerLocation(location) -> Handle
listLocations(kind) -> ExecutionLocation[]
resolvePath(location, localPath) -> RemotePath
```

要求：所有返回集合的 API 必须返回稳定顺序（按名称或注册序），以便上层做增量差异；所有注册 API 必须返回可注销句柄，注销后已排队调用必须被取消；所有能力查询必须可在无界面角色下调用（D4 档），此时呈现相关返回值须为空而非报错。

## 7. 故障模式与降级

| 故障 | 检测 | 用户可见 | 档位 | 恢复 |
|---|---|---|---|---|
| 模型服务不可达或返回超时 | 连接失败/截止时间到 | 补全不出建议，无弹窗打断，光标位置不变 | D2 | 指数退避后自动重试 |
| 上下文超预算 | 装配期计数 | 无感知（少给片段） | D0 | 用户可调预算 |
| 代理启动失败 | 退出码/握手超时 | 通知"代理不可用" | D2 | 手动重试 |
| 代理中途崩溃 | 进程死亡检测 | 会话标记终止，已产生的编辑保留 | D2 | 重开会话 |
| 工具调用失败 | 结果状态 | 错误文本回传调用方 | D2 | 调用方重试 |
| 工具越权请求 | 过滤器/授权 | 拒绝并回传原因 | D0 | — |
| 语言服务端崩溃 | 连接断开 | 重启一次，再失败则禁用并通知 | D2 | 手动启用 |
| 语言服务端能力缺失 | 握手结果 | 该类结果标注"来源不可用" | D1 | — |
| 终端 shell 集成缺失 | 探测失败 | 命令块退化为启发式（标注不可靠） | D1 | 换 shell 或启用集成 |
| 伪终端创建失败 | 启动错误 | 会话不建立并提示原因 | D2 | 切换执行位置 |
| HTTP 请求解析失败 | 解析器 | 单个请求不可执行，其余照常 | D1 | 修正文件 |
| 容器/编排连接失败或监听中断 | 连接探测/通道异常 | 资源树显示"未连接"，或停止刷新并标注陈旧 | D2 / D1 | 重连、退避重连（默认 1 秒起） |
| SSH 主机不可达或凭据失效 | 连接超时/认证失败 | 位置不可选或提示重新输入；不缓存失败凭据 | D2 | 重连或重新认证 |
| 完全无网络 | 启动期探测 | 远端能力全缺席，本地能力全保留 | D2 | 网络恢复后按需重试 |

**强制**：任何外部故障不得表现为"编辑被拒绝"或"文件损坏"；D3 及更重档位不得由外部集成触发——外部集成的降级上限是本进程的 D2。

## 8. 资源与性能预算

| 项 | 预算/实测 |
|---|---|
| 补全去抖（三档 / 对话式） | 20 / 20 / 80 毫秒、对话式 200 毫秒（实测默认） |
| 补全候选超时 | 必须小于一次连续输入间隔；超时即丢弃 |
| 内联建议同时呈现数 | 1 |
| 补全缓存条目 | 必须有容量上限与按位置淘汰，不得无界增长 `[推断]` |
| 上下文预算 | 按语言与模型分别设定；未见统一硬上限 `[推断]` |
| 工具进度上报间隔 | 1000 毫秒（实测默认，可配置） |
| 语言服务端重启 | 崩溃自动重启一次，再失败即禁用 |
| 本地模型服务重启延迟 | 60 分钟（实测默认），避免频繁拉起 |
| 终端环形缓冲 / 集群监听退避 / inlay 刷新 | 缓冲固定容量溢出丢最旧行；后两者均 1000 毫秒（实测默认） |
| 溯源界面刷新节流 | 500 毫秒（实测默认） |
| 代理会话数 | 每项目上限由策略设定；超出必须拒绝而非排队 |

**背压**：补全请求队列深度为 1；工具调用队列必须有并发上限，超出排队并上报"排队中"；终端输出由环形缓冲吸收，不得回压到 shell 进程。

## 9. 可观测性

必须可回答：**补全为什么没出来**（触发判定、去抖时长、预算使用量、是否发出、是否被过滤及原因）；**代理为什么不可用**（发现结果、启动命令与退出码、握手失败项）；**工具为什么被拒**（命中的过滤规则、副作用等级、确认状态）；**上下文发了什么**（片段种类、字节数、是否脱敏，**不记录内容本身**）；**语言服务端为何异常**（握手能力集、同步次数与失败点、重启历史）；**命令块为何错位**（用集成还是启发式、标记序列）；**执行位置如何解析**（来源为显式/默认/回退、命中的映射规则）。指标最小集：触发到呈现的分位数时延、接受率、拒绝率、移除率、工具调用成功率与平均时长、会话存活时长、服务端崩溃次数。

**最小可复现状态**：一次补全事件可导出为"策略快照 + 预算使用 + 片段元数据 + 请求响应时延"，且必须能导出为不含用户代码内容的形态。

## 10. 扩展点

| 接缝 | 扩展时必须遵守 | 失败隔离 |
|---|---|---|
| 代理目录/启动器提供者 | 目录只返回描述、不在查询期启动进程；启动器必须支持被强制终止 | 目录抛错 → 忽略；启动抛错 → 该代理标记不可用 |
| 工具集与工具过滤器 | 工具集必须声明副作用等级与输入模式；过滤器必须幂等无副作用 | 注册失败 → 其余照常；过滤器抛错 → 视为"不放行" |
| 上下文供给器 | 必须声明片段种类与优先级，并在预算内自我截断 | 超时/抛错 → 该片段缺席 |
| 补全抑制器 | 只返回"是否抑制"，不得修改建议 | 抛错 → 不抑制 |
| 语言服务端支持/集成提供者 | 支持者给出可执行体或端口与初始化参数；集成者把手写结果映射为平台模型，不得直接改文档 | 前者失败 → 该语言无外部服务端；后者失败 → 结果丢弃 |
| 文档适配器 | 映射必须双向可逆 | 不可逆 → 拒绝装载该服务端 |
| 溯源监听器与数据库提供者 | 只允许追加，不得改写既有记录 | 失败 → 溯源停写并通知 |
| 终端 shell 集成 | 必须声明可识别的提示符与命令结束标记 | 失败 → 退化为启发式 |
| 命令规格提供者 | 只提供静态描述，不得执行 | 失败 → 该命令无补全 |
| HTTP 执行支持 | 必须复用统一超时与取消 | 失败 → 该协议不可执行 |
| 执行位置提供者 | 必须提供路径映射与凭据引用 | 失败 → 该位置不可选 |
| 外部工具提供者 | 必须以声明方式给出命令、参数、工作目录 | 失败 → 该工具不出现于菜单 |

**通用约束**：所有扩展点必须允许"零实现"状态（功能缺席而非崩溃）；必须支持运行期装卸，装卸必须使已缓存的解析结果失效（见 15 §4.3）。

## 11. 对照实现（证据锚点）

> 计数口径为**合计**（模块描述符内 + 插件描述符内，见 `_rev/ep_counts.json`），不是仅插件描述符内的子集。

| 上文结论 | 证据 |
|---|---|
| 代理客户端协议为独立接入面，含"代理目录 + 进程启动器"两接缝 | 插件 `com.intellij.platform.acp`：`agentsCatalogProvider`、`processLauncherProvider`；服务 `AcpAgentsCatalog`（应用级）、`AcpProcessLauncher`（项目级） |
| 工具服务端以工具集为单位暴露，共 7 个扩展点 | 插件 `com.intellij.mcpServer`：`mcpToolset`、`mcpToolsProvider`、`mcpToolFilterProvider`、`mcpProjectPathCustomizer`、`mcpManagedSessionSupport`、`elicitationProvider`、`projectDependenciesProvider` |
| 工具集按领域拆分，合计 13 个实现 | EP `com.intellij/mcpServer.mcpToolset`：合计 13（模块描述符 3、插件描述符 10）；含通用/执行/分析/文件/格式化/读取/补丁/搜索/代码洞察/重构，以及版本控制、终端、调试工具集 |
| 工具过滤为"拒绝优先"表达式；进度节流默认 1000 毫秒 | registryKey `mcp.server.tools.filter`（示例 `-*,+…general.*,-*.read_file`）、`mcp.server.progress.notification.interval.ms = 1000` |
| 工具服务端可在无界面角色启动 | `appStarter id="mcpServer"` + `McpServerHeadlessStarter` |
| 调试能力以工具集形式接入 | 插件 `intellij.debuggerMcp`：`<extensions defaultExtensionNs="com.intellij.mcpServer">` |
| 整行补全去抖分层、自适应、触发模型可关闭 | 插件 `org.jetbrains.completion.full.line`：`completion.cloud.debounce.tier1=20`、`tier2=20`、`tier2.1=80`、`chat.input=200`、`adaptive.debounce.killswitch`、`completion.cloud.use.trigger.model=true` |
| 上下文策略按语言枚举 | 同插件 `completion.cloud.context.strategy.<language>`（值域含 Rag/Iou/Imported/Recent/RecentLocations/File/Repomap/Schema/框架派生） |
| 本地模型与远端模型并存 | 同插件 `full.line.local.models.host`、`full.line.native.server.restart.delay.minutes=60`、`ml.completion.unified.model` |
| 内联补全的缓存、抑制、部分接受、元素操纵，并与查找表共存 | 同插件 `ml.inline.completion.cacheController`、`additionalCacheController`、`cacheKeyEditorAttribute`、`provider.suppressor`；`com.intellij/inline.completion.partial.accept.handler`、`inline.completion.element.manipulator`、`inline.completion.suppress.state.supplier`；`com.intellij/completion.contributor = 290`、`com.intellij/completion.confidence = 34` |
| 搜索排序学习以特征 + 模型装载接入 | `com.intellij.searcheverywhere.ml.rankingModelLoader`(4)、`searchEverywhereElementFeaturesProvider`(15)、`searchEverywhereElementKeyProvider`(10)、`searchEverywhere.mlService`(1)、`com.intellij/fileRankerMlService`、`com.intellij/mlCompletionFeaturesCollector` |
| 溯源记录六类来源与匿名导出 | 插件 `com.intellij.code.provenance` 描述；EP `listenerProvider`(9)、`changeKindDetector`(1)、`authorshipExportHandler`(1)、`databaseProvider`(1)、`vcsKindDetector`(2)；registryKey `code.provenance.should.export.anonymous.authorship.on.vcs` |
| 溯源与质量平台按"仓库 + 修订"对齐 | 插件 `org.intellij.qodana`：`repositoryInfoProvider`、`repositoryRevisionProvider`、`vcsRevisionProvider`、`vcsIgnoredFilesProvider`；CI 配置处理器 6 类 |
| 质量结果以 SARIF 形态承载并可贡献 | 同插件 fileType `SARIF`（`*.sarif.json`）；EP `sarifReportContributor`(4)、`inspectionProfileProvider`(3)、`projectDescriber`(11) |
| 语言服务器协议客户端有三个接缝 | EP `com.intellij.platform.lsp.serverSupportProvider`、`integrationProvider`、`documentAdapter`；模块 `intellij.platform.lsp`、`.impl`、`.impl.structureView` |
| 协议实现依赖外部协议库 | `intellij.platform.lsp.impl` 依赖 `eclipse.lsp4j`、`eclipse.lsp4j.jsonrpc` |
| 调试适配协议为独立模块，供调试子系统复用 | 模块 `intellij.platform.dap`，依赖 `eclipse.lsp4j.debug`、`lsp4j.jsonrpc.debug`（引用见 12） |
| 终端双引擎与远端角色替换 | 插件 `org.jetbrains.plugins.terminal`：`DefaultTerminalRunnerFactory` 被远端/瘦客户端实现 `overrides="true"`；`BackendTerminalHost client="remote"` |
| 终端 shell 集成驱动命令块；无集成时启发式不可靠 | EP `shellsDetector`(6)、`shellSupport`(6)、`com.intellij/terminal.shellCommandHandler`(4)、`commandSpecsProvider`(10)、`commandBlockHighlighterProvider`、`commandHistoryProvider`、`escapeHandler`、`allowedActionsProvider`；registryKey `terminal.classic.refresh.vfs.on.shell.command.finished` 描述原文："May not work 100% reliably as it uses heuristics" |
| 终端链接识别、端口转发、多标签持久化 | registryKey `terminal.generic.hyperlinks`（含相对路径子项）、`terminal.persistent.tabs = true`；服务 `TerminalPortForwardingManager`（前端/瘦客户端两实现） |
| WSL 会话经执行环境抽象而非宿主外壳 | registryKey `terminal.use.EelApi` 描述："the shell process in WSL will be launched via IJEnt instead of using wsl.exe" |
| HTTP 请求文件格式与环境分层 | 插件 `com.jetbrains.restClient`：fileType `HTTP Request`（`http;rest`）；动作 `NewPublicEnvironmentFile`、`NewPrivateEnvironmentFile`；EP `httpClient.customVariableDeclarationProvider`、`dynamicVariablesProvider` |
| HTTP 响应可被自定义呈现、执行可被扩展 | EP `httpClient.responseCustomPresentation`(4)、`requestExecutionSupport`(5)；`httpRequestHandler`(33) |
| 从路由生成请求与格式转换 | 动作 `HttpGenerateRequestFromEndpointsAction`、`GenerateHttpRequestFromStructureAction`、`ConvertCurlToHttpRequestAction`；EP `httpClient.retrofit.minimal.customisation` |
| 容器连接、注册表、资源树；集群监听退避与刷新 | EP `docker.connection.configurator`、`docker.registry.provider`、`docker.containerManagementTool`、`docker.modelProxyRegistry`；应用服务 `DockerTreeFilter`；registryKey `kubernetes.watch.retry.connect.backoff=1000`、`kubernetes.inlays.refresh.interval=1000` |
| 编排的前/后端拆分；集成面普遍三分 | EP `kubernetes.apiProviderProxy`、`remoteLogsApi`、`remoteConfigWatcherApi`、`remoteHelmApi`（均声明于前端侧描述符）；模块族 `intellij.terminal.frontend/.backend`、`intellij.clouds.kubernetes.frontend/.backend`、`intellij.editorconfig.*.split`、`intellij.code.provenance.core.mcp` |
| 执行位置以"凭据类型 + 路径映射"为最小契约；执行环境抽象为独立模块族 | EP `remote.credentialsType`(7)、`remote.pathMappingProvider`(2)、`remote.targetAwarePathMappingProvider`(1)、`remote.credentialsLanguageContribution`(4)；模块 `intellij.platform.eel`、`.impl`、`.provider`、`.nioFs`、`.tcp`；EP `eelMachineResolver`、`eelEnvironment`、`eelEnvironmentInitializer`、`eelAlternativeRootProvider`、`eelTcpPathParser`、`portAccessibleLocally` |
| SSH 连接配置双作用域；WSL 以框架方式注册为执行位置 | 插件 `intellij.ssh.plugin`：`SshConfigManager` 同时注册为应用级与项目级，EP `com.intellij.sshConnectionConfigFormExtension`、服务 `RsyncService`；插件 `org.jetbrains.plugins.wsl.remoteSdk`：`remote.credentialsType` + `remote.pathMappingProvider`，依赖 `org.jetbrains.plugins.remote-run` |
| 外部工具与文件监视是扩展点 | EP `toolsProvider`(4)、`com.intellij/vfs.local.pluggableFileWatcher`(6) |
| 编辑器配置集成以"选项描述"扩展 | 插件 `org.editorconfig.editorconfigjetbrains`：EP `editorconfig.optionDescriptorProvider`、`editorconfig.exportProvider`；服务 `EditorConfigFileHierarchyService`；模块含 `.frontend`/`.backend`/`.frontend.split` |

## 12. 未决问题

- **语言服务端的优先级与文档同步语义**：证据只显示两个接缝与一个优先级字段位，冲突时的判定顺序 `[推断]` 为"内置优先、外部补充"；同步是增量还是全量无直接证据，`[推断]` 按能力协商结果择一。
- **上下文预算的默认数值**：证据按语言配置策略与模型，未发现统一预算常量，`[推断]` 预算由每套模型/语言组合自带。
- **整行补全缓存容量与工具确认的命令层级**：未发现容量型配置项，`[推断]` 为编辑器属性与文档版本驱动的惰性淘汰；存在引导（elicitation）接缝，但"由谁代为确认 write/execute 类工具"的策略层级无直接证据。
- **溯源记录与提交修订的回填时机**：存在仓库修订提供者与 VCS 修订提供者两个接缝，二者谁是权威 `[推断]` 为前者。
- **终端"允许动作"接缝的语义**：名称指向"哪些动作可在该终端内触发"，限制的是宿主动作还是代理动作，证据不足。
- **编排资源树的分页与虚拟化策略**：仅有惰性展开与子节点计数线索，节点规模上限 `[推断]`；HTTP 脚本后处理的沙箱边界亦无直接证据。
