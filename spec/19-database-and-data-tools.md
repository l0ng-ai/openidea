# 19 — 数据库与数据工具

> 范围：外部数据库的建模、内省、SQL 语言能力、查询执行、数据编辑、DDL 与差异、数据网格。｜ 依赖：04、05、06、07、08、09、10、12、13、17。｜ 排除：具体产品引擎语义、驱动的二进制内容、SSH/代理协议实现（见 12）、通用文本编辑（见 05）、通用补全与检查框架（见 08、09）。

## 1. 目的与范围

### 1.1 本子系统解决什么问题

外部数据库是**进程外状态**：不由本系统索引、不受本系统版本控制、可用性由网络与远端权限决定。本子系统把它接入系统的四个既有世界——文件、符号、执行、呈现——并保持四者对同一份外部状态的一致理解。必须解决六类固有难题：
1. **可寻址化**：库/模式/表/列/索引/约束/例程/触发器必须成为可枚举、可导航、可引用的对象，才能参与补全、导航、重构与检查（§2、§4.4）。
2. **异构收敛**：数十种产品的元数据接口、SQL 方言、类型系统、DDL 语法、错误码各不相同，必须收敛到**一套对象模型**与**一套语言服务**，同时保留产品特化（§3、§10）。
3. **驱动隔离与惰性成本**：驱动是第三方二进制，可能崩溃、泄漏、阻塞或死锁，必须运行在受控边界之外且失败不得危及宿主进程（§4.1、INV-6）；完整内省可能耗时数分钟，必须分级、可中断、可缓存、可增量（§4.3、§8）。
4. **双向一致性与机制性安全**：模型派生自数据库而 DDL/DML 又要写回，两个方向的差异必须可比较、可脚本化（§4.8）；凭据保密、只读连接、危险语句确认必须由机制保证而非调用方自律（§4.9、§5）。

二维数据呈现与编辑是**语言与领域无关的独立层**：它不仅服务数据库结果集，也服务外部表格化数据文件，因此必须能在没有任何数据库连接时工作。

### 1.2 边界

**不负责**：数据库引擎语义（隔离级别、锁、优化器行为）；驱动的二进制内容与协议实现（系统只声明"如何取得与装载"）；隧道协议实现（隧道只是连接流水线中的改写步骤）；运维意义上的备份/复制/容量；并发写冲突的仲裁（只能检测与提示，裁决属于数据库）；完整 SQL 语法（系统定义**接入与覆盖方式**，语法内容由方言提供者给出）。

### 1.3 与其他子系统的关系

| 关系 | 说明 |
|---|---|
| 04 虚拟文件系统 | 对象定义文本（表 DDL、视图定义、例程体）以**专用虚拟文件系统**呈现为文件，可打开、可比较、可搜索 |
| 05 文档与编辑器 | 查询文件、DDL 文件、控制台内容都是普通文档；本子系统只追加语义（高亮、补全、检查、执行上下文） |
| 06 程序结构接口 / 07 索引 | 复用通用语法树设施，但**引用解析的目标集合来自内存模型而非索引**；数据库对象**不进入**通用索引（索引器无法遍历外部数据库） |
| 08、09、10、12 | 检查、补全、导航、重构作为普通贡献者接入，遵循同一套取消与丢弃语义；驱动宿主是受管子进程，可置于本地、容器、WSL 或远端执行环境（EEL） |
| 17 远端化 | 前后端职责切分已下沉到本子系统的模块结构（§6.4） |

## 2. 概念模型

### 2.1 术语

| 术语 | 英文 | 定义要点 |
|---|---|---|
| 数据源 | Data Source | 具名连接目标 + 绑定它的模型快照 + 绑定它的查询文件。用户视角的唯一工作单元 |
| 连接配置 | Connection Profile | 主机/端口/库/参数、认证、隧道、SSL、超时、自动提交的聚合 |
| 驱动 / 构件 / 宿主 | Driver / Artifact / Host | 把统一驱动接口翻译为某产品协议与语义的适配层（**一组能力而非一个类**，§10）；其可下载文件集合（带版本与校验值）；装载并运行它的受管进程 |
| 会话 | Session | 物理连接 + 事务状态 + 搜索路径（当前库/模式）。事务语义的作用域 |
| 元数据模型 | Metadata Model | 内省产出的内存对象图，带代际号（§3.2） |
| 内省 / 内省层级 | Introspection / Level | 读取元数据并合并进模型的过程；L1/L2/L3 三级粒度控制深度与代价（§4.3） |
| 数据库源码 / 查询控制台 | Database Source / Query Console | 对象定义文本，经专用虚拟文件系统呈现为文件；绑定数据源的执行上下文（文本 + 会话 + 结果区 + 事务开关） |
| 结果集 / 数据网格 / 数据编辑器 | Result Set / Data Grid / Editor | 一次语句执行的产出（列描述 + 行流）；行列二维呈现与编辑控件（**不依赖数据库存在**，也服务外部表格化数据文件）；以表为单位的数据视图，含过滤/排序/分页/提交 |
| DDL 映射 / 模式差异 | DDL Mapping / Schema Diff | SQL 文件与数据源之间的显式关联；两个模型之间的对象级差异树 |
| 影响分析 | Effect Analysis | 判定一条语句将要触及哪些对象，用于危险语句确认（§4.9） |

### 2.2 实体关系

```
数据源 ─1..1─ 连接配置 ─0..1─ 隧道(SSH/代理/云连接器)；连接配置 ─1─ 驱动描述 ─1..n─ 驱动构件
数据源 ─1..1─ 元数据模型 ─1..n─ 数据库对象 ─0..1─ 数据库源码(VF)
数据源 ─1..n─ 会话 ─1..n─ 结果集 ─1..1─ 数据网格
```

### 2.3 一个数据库对象的三重身份

这是本子系统最核心的建模决定，也是理解全部行为契约的钥匙。

| 身份 | 载体 | 生命周期 | 权威来源 |
|---|---|---|---|
| **模型对象** | 内存对象图 | 模型代际 | 内省的最近一次快照 |
| **文本引用** | SQL 语法树中的名字节点 | 文档版本 | 上述模型的某个代际 |
| **定义文本** | 数据库源码虚拟文件 | 文件版本 + 模型代际 | 上述模型的某个代际 |

三条规则：文本引用解析到模型对象时必须携带**模型代际**，代际不符即失效（INV-10）；定义文本与其模型快照必须来自**同一次内省**，不得出现"表已改名而 DDL 文件仍是旧名"（INV-11）；模型对象是**唯一真相载体**，文本与文件都是可丢弃并重建的投影。

## 3. 数据模型

### 3.1 数据源与连接

```
DataSource { id; name; scope: application | project   // 决定持久化位置与共享范围
             profile: ConnectionProfile; readOnly: bool     // 发送前生效（INV-2）
             introspectionLevel: auto | L1 | L2 | L3; options: map<string,string>
             attachedSchemas: SchemaRef[]
             state: disconnected | connecting | connected | failed
             credentialsRef: CredentialRef? }         // 仅引用；明文不得进入本结构
ConnectionProfile { dbmsId: string                    // 产品标识，驱动与方言的查找键
                    host; port; database?; user?; urlTemplate: string
                    params: map<string,string>; driverRef: DriverRef; ssl: SslConfig?
                    tunnel: { kind: ssh | proxy | cloudConnector | localForward
                              host; port; user; credentialsRef?; options }?
                    connectTimeoutMs; socketTimeoutMs; statementTimeoutMs; autoCommit: bool }
```

约束：`scope = project` 的数据源必须可随项目分发，但 `credentialsRef` 指向的凭据**不随项目分发**；三个超时相互独立——连接超时约束建连，套接字超时约束静默读，语句超时约束单条语句。

### 3.2 元数据模型

```
MetadataModel { dataSourceId; generation: int    // 每次有效更新递增；所有引用绑定它
                levels: map<ObjectId, level>; roots: DatabaseObject[]
                complete: bool; warnings: IntrospectionWarning[] }
DatabaseObject { id: ObjectId                    // 在 generation 内稳定
                 kind: catalog | schema | table | view | materializedView | column
                     | index | constraint | primaryKey | foreignKey | routine
                     | trigger | sequence | type | synonym
                 name: QualifiedName             // 大小写与引号策略由方言决定
                 parent; children: DatabaseObject[]; loaded: bool; invalid: bool
                 source: SourceRef? }            // → 数据库源码虚拟文件
```

`loaded` 与 `invalid` 的区分是刻意的：前者表示"我们还不知道"，后者表示"我们知道了但它是坏的"。SQL 检查必须据此产生不同诊断（INV-9）。`children` 未展开时为空而非"空集"。

### 3.3 执行与网格

```
ResultSetDescriptor { index; statementRef; columns: GridColumn[]; rowCount: int?
                      updatable; paged; truncated: bool }
GridColumn { name; typeName; domain: DomainRef; nullable; editable; hidden }
CellValue { kind: null | text | number | boolean | temporal | binary
                | array | structured | spatial | other
            raw: bytes?; display: string; decoded: any? }   // 后两者可丢弃
DirtyRow { key: RowKey; op: none | insert | update | delete
           original: CellValue[]; current: CellValue[]; submitted: bool }
```

`rowCount` 为 null 表示流式未知；`paged` 表示结果以 LIMIT/OFFSET 分页取得；`truncated` 表示因上限被截断，必须在界面上可见。

### 3.4 持久化形态

| 数据 | 位置 | 可丢弃性 |
|---|---|---|
| 数据源定义（应用级 / 项目级） | 应用或项目配置存储 | 不可丢弃（用户资产）；项目级可随项目分发 |
| 凭据 | 平台凭据存储，按操作系统各有实现 | 可丢失（需重输），但**不得回落到明文** |
| 驱动构件 | 本地构件缓存目录 | 可丢弃并重下载 |
| 元数据模型 / 数据库源码 / 数据源历史 / DDL 映射 | 内存为主（可落快照）；专用虚拟文件系统（**非物理文件**）；应用级设置或随 SQL 文件 | 完全可丢弃并重建；历史与映射丢弃仅影响便捷性 |

平台自身另有内置的**本地关系存储引擎**，用于平台级派生数据；它与用户数据库无关，不得被本子系统用作元数据缓存（避免把"缓存损坏"升级为抢救模式）。

## 4. 行为契约

### 4.1 连接建立流水线

连接不是一次调用，而是一条**有序拦截器链**加一次跨进程建连。

```
connect(dataSource):
  1. 解析数据源 → 连接配置 + 驱动引用 + 凭据引用
  2. 组装连接串：urlTemplate 展开 + 参数合并（产品默认 < 数据源 < 会话级覆盖）
  3. 顺序执行连接拦截器链
  4. 选择或创建驱动宿主（本地 / 容器 / WSL / 远端执行环境），在宿主内装载驱动并物理建连
  5. 会话初始化（搜索路径、时区、只读标志、会话参数）；需要内省则触发 §4.3
  6. 状态置为 connected 并投递"连接已建立"事件
```

**拦截器链语义**（本子系统最重要的开放接缝）：按声明的顺序（first / before-X / after-X / last）稳定排序，同级保持注册序；输入为**可变**的连接参数字典 + 凭据引用 + 数据源元信息；输出为改写后的参数与凭据，或"拒绝建连 + 原因"；**禁止**修改数据源定义（不得产生持久副作用）与持有连接。典型职责：认证提供、隧道建立并改写 host/port、SSL 配置、连接串校验修正、宿主进程参数注入、诊断日志注入。
顺序约束：**无凭据回退必须最后**（只在所有需要凭据的方式失败后才尝试匿名连接）；**隧道改写必须先于凭据注入**（凭据可能依赖隧道后才可达的端点 `[推断]`）；**产品特化拦截器必须声明相对锚点**（如"在 SSH 之前"），不得依赖注册顺序。
`DISCONNECTED → CONNECTING → CONNECTED`；`CONNECTING` 失败或超时进入 `FAILED`，`CONNECTED` 断链进入 `LOST`，后者只能回到 `CONNECTING`。
`LOST` 之后事务**不可恢复**：在途语句必须失败，不得静默重试（事务边界已丢失）。纯读操作（内省、元数据读取）可自动重试一次，且重试必须重建会话而非复用旧句柄。`FAILED` 必须记录**最后一个失败阶段**（解析/隧道/装载/握手/初始化），这是诊断的最小信息。

### 4.2 会话池

每个数据源维护一个会话池。会话是**稀缺资源**（数据库侧有连接数上限），必须有上限、空闲回收与检出/归还协议。三种占用形态：控制台独占、数据编辑器独占、内省共享（可并发只读）。检入时若仍有未结束事务，必须显式标记为"脏会话"，由策略决定回滚或保留。同一会话上的语句必须串行化，需要并发的语句必须分配不同会话（INV-13）。数据源断开、宿主退出、空闲超限、项目关闭都必须解散会话并释放池条目。

### 4.3 内省：分层、增量、可中断

| 层级 | 内容 | 典型用途 | 代价量级 |
|---|---|---|---|
| L1 | 对象名、种类、列名与列类型、主键 | 树呈现、补全、基本解析 | 小 |
| L2 | 索引、约束、默认值、生成表达式、注释、序列 | 结构检查、DDL 生成、差异比较 | 中 |
| L3 | 视图定义、例程体、触发器体、完整对象源码 | 源码编辑、全文检查、数据库源码文件 | 大 |

`auto` 按访问行为按需升级——展开树、打开数据编辑器只需 L1；打开 DDL/源码文件、生成脚本、执行差异比较时升到 L3。用户可对数据源或单个对象固定层级，"继承"语义允许子对象沿用父级设定。

```
introspect(scope, targetLevel):
  1. 解析 scope → 对象集合 S（受 attachedSchemas 与权限过滤）；levels[o] ≥ targetLevel

     且 fingerprint(o) 未变者跳过
  2. 分段（批量元数据查询 + 逐对象特化查询）后分批执行，每批必须可取消
  3. 每批完成后立即合并：新对象 loaded；消失对象 invalid（不删除，见 INV-9）
  4. generation += 1 并投递变更集合；阶段被截断 → complete = false 并记录 warning
```

刷新触发有三种：**手动**（指定范围立即重内省并保持层级）、**周期性**（可配置计划，仅对已连接且启用的数据源生效）、**惰性**（节点缓存超阈值时在展开时刷新，默认关闭；若产品提供变更通道则定向失效 `[推断]`）。此外 **DDL 执行成功后对应对象必须失效并重内省**——不得假设"执行成功 == 状态一致"。缓存键为（数据源、模式、对象、层级）；任何代际变更必须使依赖它的解析结果失效；缓存必须可从零重建且重建不要求用户干预。

### 4.4 SQL 语言能力

**双方言注册**：每个产品声明两个相互独立的方言实现——**数据方言**（对象模型、DDL 生成、类型系统、执行计划、DML 生成、错误解析、命名规则）与**语言方言**（词法、语法、语法树形态、引用解析规则、代码风格与格式化）。两者共用产品标识关联但可分别替换，这是"支持一种产品的 SQL 方言"与"支持一种产品的元数据"解耦的关键。
**检查族**（SQL 语言的本地检查共 54 项，全量描述符统计）分四组：

| 组 | 代表检查 | 作用 |
|---|---|---|
| 引用正确性 | 未解析引用、歧义列、派生表别名、误导性引用 | 保证名字能唯一定位 |
| 类型与值域 | 类型兼容、插入值列数、生成列写入、非空列插空 | 发送前拦截必然失败 |
| 结构与方言一致性 | 缺少 ON 的连接、未分组列、不可达代码；方言不匹配、当前模式、单会话模式 | 结构缺陷与跨方言误用 |
| **风险语义** | 无 WHERE 的 UPDATE/DELETE、语句副作用、触发器内事务语句、索引列删除 | 危险性与代价预警 |

```
resolveAt(sqlText, offset, modelGeneration):
  1. 文本 → 语法树（方言语法）；定位 offset 处最内层名字引用
  2. 作用域链：语句局部（别名、CTE、例程参数、循环变量）→ 模式 → 库 → 系统对象
  3. 依次查找模型对象；返回 唯一命中 / 歧义 / 未加载 / 不存在
```

解析失败分**四类**且必须区别对待：不存在、歧义、未加载（只有第一类是错误）。**解析不经过通用索引**：模型是内存对象图，因此引用解析不依赖索引就绪状态，只依赖"模型已内省到所需层级"。结果必须携带模型代际，过期即视为未解析。
**补全**按作用域链分层：别名/CTE（语句局部，优先级最高）→ 当前模式对象 → 其他已附加模式 → 关键字与函数 → 系统对象。产品特化的排序可重排候选但不改变候选集合语义。**格式化**由语言方言的代码风格提供者驱动；注入到其他语言中的 SQL 片段同样可格式化，但可配置跳过。
**导航与重构**：表/视图 → 定义，在数据库源码虚拟文件系统中打开（未内省到 L3 时先升级层级）；列 → 引用，以（数据源、模型对象）为目标的用法搜索，覆盖全部查询文件与 DDL 文件；重命名表/列必须做**三处原子改写**——模型对象名（需在数据库上执行 DDL）、SQL 文件中的引用、DDL 映射文件中的定义，任一环节失败必须整体报告并列出已完成部分，且改名前必须提示受影响的引用数量。

### 4.5 查询控制台：执行与结果

**语句切分**必须由方言完成（块结构、语言内嵌的字符串与定界符、过程体、批分隔符），不得以分号字面切分。**执行目标**三选一：整个文件 / 光标所在语句 / 选中区间，差别必须显式呈现。

```
execute(session, statements, options):
  1. 语句切分 → 逐条取文本与源区间
  2. 对每条：只读校验（INV-2）→ 影响分析（§4.9）→ 在会话内提交
  3. 取结果：0..N 个结果集（每条上限 100）；列描述先到，行分批到达；值按类型域归一化
  4. 错误：定位到语句 → 源区间 → 编辑器；无位置信息时定位到语句起点
```

| 关注点 | 规则 |
|---|---|
| 分页 / 可滚动 | 优先 LIMIT/OFFSET（可由产品配置关闭），否则依赖驱动游标；驱动声明支持可滚动则启用，否则退化为"仅前进" |
| NULL 与空串 | **必须可区分**（不同呈现与底色语义） |
| 二进制 / 大对象 / 数组 / 类型域 / 截断 | 呈现长度与摘要，可切换十六进制/文本，不得默认全量解码；大对象惰性加载，失败只影响该单元格；数组按元素截断（上限 1000）；归一化为有限域，渲染与导出只依赖归一化域；被截断的结果集必须标记并显式可见（INV-16） |

**执行计划**：对选中语句可请求计划视图，由产品的计划提供者产出计划树与代价指标；无提供者的产品该视图必须不可用而不是显示空表。**取消与超时**：取消请求必须投递到驱动宿主，并向用户显示"正在取消"；取消是**尽力而为**，返回后必须再次确认会话状态（是否仍在执行、事务是否仍活跃），不得假定停止（INV-7）；语句超时走同一路径并标记"超时"；取消后已到达的结果行可保留展示，但结果集必须标记不完整。

### 4.6 事务控制

两种模式：**自动提交**（每条语句自成事务）与**手动**（会话级事务）。手动模式下必须提供提交、回滚、提交并继续（保持事务活跃）、事务设置（隔离级别等，若产品支持）。会话意外断开时手动事务**必须回滚**（默认行为，可配置），不得尝试恢复。事务状态迁移必须可观测（有专用调试入口记录迁移）——"为什么我的写入消失了"是本子系统最常见的困惑。数据编辑器的一次提交是**独立事务**，不与控制台的手动事务合并（除非显式选择共享会话）。

### 4.7 数据编辑：脏值、DML 与冲突

**编辑模型**：单元格级脏值，`original` 与 `current` 分离，修改不立即写库；行级操作分为插入、更新、删除；脏行集合是提交的单位，未提交脏值在关闭视图前必须提示。

```
inferRowKey: 主键 → 唯一约束 → 产品行标识（物理行 ID 等）→ 否则"不可定位"（禁止更新/删除，只读呈现）
submit(dirtyRows):
  1. 生成语句序列（按产生顺序：插入先于更新，删除最后）
  2. 开启事务 → 分批执行（每批语句数上限 2000）→ 逐批校验影响行数
  3. 全部成功 → 提交；任一批失败 → 整体回滚，并按行报告语句与数据库错误原文
```

**DML 生成**由产品的 DML 提供者完成，**必须参数化**（位置或命名参数），不得拼接用户值；生成结果必须可预览（可见语句与绑定值），这是"注入防护可验证"的前提；更新与删除必须带定位条件（主键或唯一键）并校验**影响行数 = 1**。
**并发冲突**：影响行数为 0 → 判定"目标行已不存在或已被他人修改"。界面必须提示**冲突行清单**并提供"重新加载此行/重新加载全部"动作，**不得自动重试**。冲突判定只覆盖"行消失"与"键冲突"两类确定性事件；值级并发覆盖（丢失更新）由数据库隔离级别决定，本子系统只做提示 `[推断]`。

**过滤、排序、分页**在**服务端**生效：过滤生成 WHERE（含 LIKE/比较/空值判定），排序生成 ORDER BY，分页生成 LIMIT/OFFSET。过滤条件必须结构化（列 + 运算符 + 值），不得让自由文本进入语句。任何过滤或排序变更都必须作废当前脏值集合并提示用户。

### 4.8 DDL、差异与迁移

| 方向 | 输入 | 输出 | 用途 |
|---|---|---|---|
| 模型 → DDL | 模型对象 | 创建/修改语句 | 脚本生成、复制 DDL、文档化 |
| DDL → 模型 | SQL 文件 | 内存模型 | 从脚本建立数据源结构、离线设计 |
| 模型 ↔ 模型 | 两个模型快照 | 差异树 | 环境对比、版本对比 |
| 差异 → 脚本 | 差异树 | 迁移语句 | 部署、迁移工具消费 |

```
DiffTree { nodes: DiffNode[]; summary: {added, removed, modified} }
DiffNode { kind: added | removed | modified | unchanged; objectKind; name: QualifiedName
           changes: PropertyChange[]; children: DiffNode[]; script?: string }
```

要求：差异比较必须在**同一层级**上比较（两侧都需内省到 L2 以上，否则属性级差异不可信）；语句生成顺序必须满足依赖（创建父先子后、被引用先于引用；删除反之）；差异树必须支持"只应用选中节点"，且应用前必须展示将要执行的脚本全文。

**导入导出**：导入（文件 → 表）支持分隔符文本、结构化文本、脚本化数据源，必须先预览（预览字符上限 10000），列映射可手工修正，批量提交；导入（SQL 文件 → 数据源）先解析为模型、与现有模型做差异，再决定执行；导出（结果集/表 → 文件）的类型格式（日期格式、空值表示、引号策略）必须可配置。

**迁移工具的集成点**：外部迁移工具以**消费者**身份接入，消费差异树、脚本生成能力、连接生命周期事件。它不得直接操作连接池或会话；它可以扩展**SQL 名字解析**（把"尚未执行的迁移脚本中创建的表"纳入可解析范围），这是唯一允许它影响语言服务的接缝；它必须声明"已应用的迁移版本"，以便界面区分"数据库中的结构"与"脚本中的结构"。

### 4.9 安全

**凭据**：明文**只**存在于平台凭据存储中，数据源定义只保留引用（INV-1）；凭据可按（数据源、用途）分槽——数据库、隧道、代理相互独立；凭据缺失时必须提示重输，不得静默使用空凭据或回退到明文文件。

**只读**：只读是**发送前**的机制性判定——写类语句（DML、DDL、例程调用、事务控制）在提交给会话之前被拒绝并给出原因（INV-2）。判定覆盖控制台执行、数据编辑器提交、DDL 执行、导入、脚本生成后执行；只读数据源仍允许内省、查询、导出、生成脚本。

**注入防护**：系统生成的所有语句（DML、过滤、分页、DDL）必须参数化，用户值只能作为参数绑定；标识符（表名、列名）不能参数化，因此必须走**标识符引用规则**（按方言的引号与大小写策略），且只接受来自模型的对象名，不接受自由文本；提交前必须能预览参数化语句与绑定值，使注入面可被人工核验。

```
guardedExecution(statement, session):
  1. effect := analyzeEffect(statement)   // 无法分析 → 保守判定为"未界定"
  2. effect 触及数据源之外的对象、或触及全表（无定位条件）→ 要求确认并列出受影响对象
  3. 数据源为只读 → 直接拒绝；最后记录判定结果（供事后审计）
```

影响分析由产品的影响分析器给出；无分析器的产品退化为基于语句种类的保守启发式。确认记录必须包含语句指纹、判定依据、用户选择。

## 5. 不变量与约束

| 编号 | 不变量 |
|---|---|
| INV-1 | 凭据明文不得出现在数据源定义、查询文件、日志、诊断包、崩溃报告中。 |
| INV-2 | 只读数据源上的任何写路径必须在发送到会话之前被拒绝，不得依赖数据库侧报错。 |
| INV-3 | 模型对象标识在一次模型代际内稳定；代际变更后旧引用必须判定为失效。 |
| INV-4 | 每条面向用户的语句执行都必须经过影响分析并记录判定结果。 |
| INV-5 | 一次数据编辑提交必须原子：全部行生效或全部回滚。 |
| INV-6 | 驱动宿主的异常终止不得导致宿主应用进程退出；其全部会话必须判定为丢失。 |
| INV-7 | 取消返回后必须重新确认会话状态，不得假定语句已停止。 |
| INV-8 | 内省不得阻塞文本输入与文档编辑；内省期间模型必须自洽（不出现半构造对象）。 |
| INV-9 | 未内省到的对象不得报"不存在"，只能报"未加载"；已删除或不可读的对象必须保留为"无效"。 |
| INV-10 | SQL 引用解析结果必须携带模型代际；代际不符即失效。 |
| INV-11 | 数据库源码文件的内容与其对应模型快照必须来自同一次内省。 |
| INV-12 | 数据源定义的持久化不得依赖模型是否已加载或连接是否可用。 |
| INV-13 | 同一会话上的语句必须串行化；并发语句必须分配不同会话。 |
| INV-14 | 禁用本子系统后，其会话、驱动宿主、模型缓存、数据库源码文件必须全部释放。 |
| INV-15 | 系统生成的语句必须参数化；标识符只能来自模型对象名。 |
| INV-16 | 任何被上限截断的结果集必须显式标记为不完整，不得静默丢弃行。 |

## 6. 对外能力契约

### 6.1 概念级接口

```
createDataSource(profile, scope) -> DataSource ; updateDataSource(id, patch) -> DataSource
connect(dataSourceId, sessionOptions) -> Session ; disconnect(sessionId, mode) -> void
introspect(dataSourceId, scope, targetLevel, cancellable) -> IntrospectionResult
getModel(dataSourceId) -> ModelView ; invalidateModel(dataSourceId, objectIds?) -> void
resolveAt(sqlText, offset, modelGeneration) -> Resolved | Ambiguous | Unloaded | NotFound
completeAt(sqlText, offset, modelGeneration) -> Candidate[]
execute(sessionId, statements, options) -> ResultStream ; cancel(sessionId, statementId) -> CancelOutcome
prepareDml(modelView, dirtyRows) -> ParameterizedStatement[]
submitDml(sessionId, statements, batchSize) -> SubmitReport ; generateDdl(modelView, ids, opts) -> Script
diffModels(left, right) -> DiffTree ; applyDiff(sessionId, diffTree, selection) -> ApplyReport
analyzeEffect(statement, modelView) -> EffectSet
```

### 6.2 通用要求

全部接口必须可在**无界面角色**下调用，不得要求界面已初始化；全部读取接口必须携带或返回**模型代际**，调用方不得缓存跨代际结果；接口不得暴露驱动宿主内部的私有对象，跨进程边界的数据必须是可序列化的中性结构；长操作（内省、执行、差异比较）必须接受取消令牌，取消语义遵循 INV-7。

### 6.3 事件

| 事件 | 载荷 | 顺序保证 |
|---|---|---|
| 数据源已变更 / 连接状态已变更 | 数据源标识 + 变更种类；新状态 + 失败阶段 | 按变更提交顺序；同一数据源内严格有序 |
| 模型已更新 | 数据源标识 + 新代际 + 变更集合 | 代际单调递增 |
| 语句已开始/已结束、事务状态已变更 | 会话标识 + 语句标识 + 结果摘要；旧状态 → 新状态 | 同一会话内严格有序 |

### 6.4 角色切分

| 能力 | 前端 | 后端 | 说明 |
|---|---|---|---|
| SQL 词法/语法/高亮/格式化 | 必须 | 可以 | 纯文本级能力，客户端自足 |
| 引用解析与补全 | 需要模型投影 | 必须（模型权威） | 代际由后端推进 |
| 数据源定义编辑 / 驱动装载、物理连接、内省、执行与事务 | 界面 / 禁止 | 持久化 / 必须 | 配置写入在后端；驱动二进制与会话只在后端进程内 |
| 结果网格渲染与编辑交互 | 必须 | — | 呈现与输入在客户端 |
| DML 生成与提交 / 数据库源码写入 | 草案与只读投影 | 必须（发送、事务、权威内容） | 提交与写入必须后端 |
| 无界面/命令行 | — | 必须 | 数据源管理与导出必须可脚本化 |

**硬约束**：前端插件与完整插件在同一进程中**互斥**；远端会话中完整的数据库能力必须位于后端，前端只加载其子集。前端在没有后端时必须降级为"只做语法级 SQL 编辑"（D4），不得显示半可用的连接界面。

## 7. 故障模式与降级

| 故障 | 检测方式 | 用户可见结果 | 降级路径 | 档位 |
|---|---|---|---|---|
| 驱动未配置 / 构件校验失败 / 下载失败 | 配置校验 + 哈希比对 + 获取失败 | "驱动不可用"及原因；通知 + 重试入口 | 该数据源禁用，其余不受影响；保留已有构件 | D2（局部） |
| 隧道建立失败 / 认证失败 | 隧道阶段异常；拦截器链拒绝 | 指出失败阶段与端点；提示重新输入凭据 | 若允许则回退直连，否则保持断开；凭据更新后重试 | D2（局部） |
| 连接超时 | 建连超时计时器 | 通知 + 最后尝试阶段 | 保持断开；缓存模型仍可只读呈现 | D2（局部） |
| 权限不足致部分对象不可读 | 内省返回权限错误 | 树上灰显 + 警告汇总 | 其余对象按 L1 可用 | D1 |
| 模型过期（代际不符） | 代际比较 | 解析结果标记"需刷新" | 检查降级为"未加载"而非"错误" | D1 |
| 驱动宿主崩溃 | 调用失败/心跳丢失 | 全部会话标记丢失 | 重建宿主并按需重连；未提交数据必须提示 | D2 |
| 语句超时或被取消；数据编辑提交失败 / 并发冲突 | 超时触发/取消确认；影响行数不符、为 0 或异常 | 结果标记"不完整/超时"；逐行报告 + 回滚确认；冲突行清单 + 重新加载动作 | 保留已到达行；事务按策略回滚；数据保持原状，脏值保留；不自动重试 | D2（局部）；D2（局部） |
| 模型快照损坏；项目只读 / 索引未就绪 | 反序列化失败；项目模型不可写；平台模式标志 | 静默丢弃，首次连接时重建；项目级数据源配置不可改；无影响（模型非索引） | 退化为"无预加载模型"；仍可连接、查询、执行只读操作；解析与检查仍可用 | D5（局部）；D3 / D0 |
| 远端后端不可用 | 连接/心跳 | 前端提示后端离线 | 仅语法级 SQL 编辑；连接与执行不可用 | D4 |

**恢复动作的统一要求**：每条降级路径都必须提供**一个可点击的恢复入口**（重试、重输凭据、刷新模型、重建宿主、重新加载行），且恢复动作不得要求用户重开项目。

## 8. 资源与性能预算

| 项 | 数值/量级 | 说明 |
|---|---|---|
| 单次执行的语句结果集数上限 | 100（实测配置） | 超出部分标注截断 |
| 网格显示的列数上限 | 2000（实测配置） | 超出列不渲染但仍可导出 |
| 数据编辑批处理的语句数 | 2000（实测配置） | 每批一个子事务边界 |
| 数组呈现的元素上限 / 分隔符文本预览字符数 | 1000 / 10000（实测配置） | 超出省略并标记；导入向导的预览窗口 |
| 模式落盘的写缓冲 | 约 10 MB（实测配置） | 超出刷盘 |
| 树过滤时的展开上限 / 格式化矩阵对齐的插入行上限 | 10000 行 / 1000 节点；1000（实测配置） | 防止过滤导致全树展开；超出改用非对齐格式 |
| 最近使用数据源条目 / 网格渲染缓存倍数 | 20 / 3（实测配置） | 历史列表容量；内存与滚动流畅度的折衷 |
| 面向外部代理的结果摘要上限 / 模型常驻内存 | 5000 个标记（实测配置）；与对象数线性，万级对象为百 MB 量级 `[推断]` | 暴露给自动化调用方时的裁剪阈值；依赖"未展开即未加载"控制规模 |
| 驱动宿主进程数 / 内省单批时长 | 每数据源至多一个；亚秒级到数秒级 `[推断]` | 避免连接数放大；决定"取消"的体感 |

**背压规则**：行流必须按消费速度拉取，消费者缓慢时不得无限缓冲；内省合并必须按批提交模型变更，不得在长事务式窗口内持有全局写锁；脏值集合、结果集缓存、模型缓存都必须有显式上限并能被清理（"清理缓存"必须是一个可执行动作）；结果集的列描述必须优先于首批行、首批行必须优先于总行数统计，避免全量扫描阻塞首屏。

## 9. 可观测性

**日志通道**（以"只记录、不打扰"为原则）：

| 通道 | 内容 |
|---|---|
| 连接诊断 | 建连各阶段耗时与结果、拦截器链的改写摘要（**不含凭据值**） |
| 执行日志 / 内省日志 | 语句指纹、耗时、影响行数、结果集数；范围、层级、批次、对象计数、被截断原因 |
| 重构日志 / 视图日志 | 重命名或差异应用的对象清单与失败点；树的刷新、缓存命中与失效原因 |

**通知**（必须可关闭）：配置类问题（驱动缺失、配置校验失败）；检测类发现（配置文件中发现的数据源）；**慢语句**（超出阈值必须显式提示而非静默变慢）；取消进度（"正在取消"必须可见）；数据编辑的更新结果与冲突。

**诊断入口与最小可复现状态**：必须可在无界面角色下导出——连接诊断报告（数据源标识、产品、驱动版本、拦截器链顺序、每阶段结果）、内省诊断包（范围、层级、每批对象计数与耗时、警告汇总）、模型转储（序列化为可读文本，用于对比"界面看到什么"与"模型里有什么"）、事务状态迁移记录（会话标识 + 状态序列 + 触发源）。最小可复现状态为：数据源标识 + 产品与版本 + 驱动版本 + 内省层级 + 模型代际 + 语句指纹 + 会话状态 + 最后一次失败阶段，且**必须不含凭据**。

## 10. 扩展点

### 10.1 扩展面清单

| 扩展面 | 契约职责 | 粒度 | 失败隔离 |
|---|---|---|---|
| 产品描述 | 产品标识、显示名、默认端口、默认参数模板 | 每产品一条 | 该产品整体不可用 |
| 数据方言 | 对象模型、DDL 生成、类型系统、命名、执行计划、DML 生成、错误解析、影响分析 | 每产品可多条 | 该产品对应能力降级 |
| 语言方言 / 代码风格；驱动描述符 / 构件仓库 | 词法、语法、语法树、解析规则、格式化；驱动入口、可用版本、构件地址与校验值；构件来源（公共仓库、私有镜像、本地目录） | 每产品一条；每产品一组 / 全局多条 | 退化为通用方言；该产品无法新建连接；回退本地缓存 |
| 认证与隧道拦截 / 连接串参数编辑器 | 改写连接参数与凭据、建立隧道；为产品特化参数提供编辑界面与校验 | 全局有序 / 每产品多条 | 跳过该条并记录；退化为键值表编辑 |
| 元数据四件套；领域与命名 / SQL 辅助三件套 | 内省器（读取元数据）、元数据封装（修正驱动偏差）、源码加载（取定义文本）、模型门面（映射为统一对象模型）；类型域注册、命名与引用规则；导航（定位 DDL）、成员（限定名后的候选）、求值（常量表达式）与方言格式化 | 每产品各一条；每产品可多条 | 逐级退化：无源码文件 → 仅 L1 骨架 → 模型不完整；使用通用规则；该动作不可用或回退通用规则 |
| SQL：解析扩展 / 检查抑制委托 | 向名字解析注入额外符号来源（如迁移脚本中的表）；决定某检查在某上下文中是否适用 | 全局多条 | 跳过该来源 / 不抑制 |
| 执行四件套；数据网格五件套 | 语句构造、执行计划、错误处理（含位置）、错误修复；单元格呈现、格式化器、归一化、抽取器、工具栏 | 每产品一条 / 计划可多条；全局多条 | 无计划视图 → 仅原始错误文本 → 无修复建议；回退文本呈现 / 默认格式 / "其他"域 / 不可导出 / 动作不出现 |
| 值编辑器与审计 / 导入器 | 大值专用编辑器页；提交前审查脏行集合；把外部数据导入到表 | 全局多条 / 每产品多条 | 无专用编辑器 / 无审查 / 该产品无导入 |
| DDL 三件套 | 脚本生成、差异定制、模型→脚本翻译 | 每产品一条 / 全局多条 | 该产品不可生成脚本 / 使用默认比较 |
| 控制台提供者与运行上下文调优 / 外观与选择 | 为非 SQL 数据源提供控制台、调整执行环境参数；树节点装饰、把模型对象"发送到"其他工具窗口、报告活动连接 | 每产品可多条 / 全局有序 | 无控制台或跳过；无装饰 / 该项不出现 / 无信息 |

### 10.2 扩展必须遵守的契约

1. **声明产品归属**：面向产品的扩展必须声明适用产品标识，不得对不匹配的产品生效。**无状态**：不得持有连接、会话或语句，需要时通过上下文按次获取。
2. **尊重代际**：任何读取模型的结果必须与其代际一同返回，不得缓存跨代际对象。
3. **不得阻塞**：扩展调用发生在编辑、解析、渲染路径上，必须快速返回或明确声明自身可异步且可取消。
4. **不得写入持久状态**：连接拦截类扩展尤其如此（§4.1）。**可空实现**：所有面向产品的扩展面都必须允许"无实现"，此时走通用退化路径而不是报错。

### 10.3 扩展失败的隔离

单个扩展实例化失败 → 记录并跳过，该扩展面对当前产品退化为默认实现。产品级扩展全部失败 → 该产品退化为"通用方言 + 通用语言方言"，仍可连接但能力受限（D2）。扩展在运行期抛错 → 只影响当前操作（一次解析、一次渲染、一次导出），操作以"不可用"结束，不得污染模型。扩展声明的产品标识冲突 → 按注册顺序取第一个并对冲突发出诊断，不得静默择一。

## 11. 对照实现（证据锚点）

| 上文结论 | 证据锚点 |
|---|---|
| 本子系统是独立插件，声明对"数据库能力"模块标识的依赖，且与客户端插件互斥（完整插件与客户端侧插件不可同进程共存） | 插件 `com.intellij.database`（`<incompatible-with>com.intellij.jetbrains.client`）；依赖 `com.intellij.modules.database-capable` |
| 客户端侧另有只提供 SQL 语言支撑的前端插件，完整插件必须位于后端；前后端切分已下沉到模块 | 插件 `org.jetbrains.plugins.database.frontend`：描述为 "Client-side plugin that enhances SQL language support in a remote development session"，注明 "regular plugin must be loaded on the backend"；模块 `intellij.database.frontend.split`、`.backend.split`、`.impl.frontend`、`.impl.common`、`.sql.frontend.core`、`.sql.frontend.impl`、`.sql.backend.core`、`.frontend.plugin`、`.jdbcConsole.shim` |
| 本子系统共 125 个模块（含数据网格家族）；连接层是中枢 | `_rev/modules.json` 中 `intellij.database.*` 与 `intellij.grid.*` 前缀计数 = 125；`intellij.database.connectivity` 声明 56 个模块依赖，`intellij.database.impl` 声明 100 个 |
| 产品描述以声明式 bean 注册（75 个产品标识）；双方言注册且均按产品标识绑定 | 扩展点 `com.intellij.database.dbms`（beanClass 型），`<dbms id=... instance=... />` 注册 75 条；`com.intellij.database.dialect`（35 条）与 `com.intellij.sql.dialect`（39 条）均以 `dbms` 属性绑定（去重 35 个产品标识） |
| 连接建立是有序拦截器链，支持相对锚点与首尾锚定；无凭据回退必须最后；隧道与代理各是一个拦截步骤；SSH 支持是可选装载模块 | 扩展点 `com.intellij.database.connectionInterceptor`（34 条），含 `order="first"`、`"before ssh"`、`"before proxy-param"`、`"last"`；`NoCredentialsAuthProvider` 声明 `order="last"`；实现 `SshConnectionInterceptor`（id="ssh"）、`*CloudSQLProxyInterceptor`（PostgreSQL/MySQL/MariaDB/MSSQL）、`LocalDbInterceptor`、`OraTnsNamesSshInterceptor`（`before ssh`）；模块 `intellij.database.ssh`、`.ssh.ui` 声明 `loading="optional"` |
| 驱动以声明式配置清单注册（54 份），并运行在受管宿主进程中，可在执行环境中启动；环境参数按序调优 | 扩展点 `com.intellij.database.driversConfig`，`<driversConfig config="databaseDrivers/*.xml" />` 54 条；扩展点 `com.intellij.database.remoteProcessInitializer`、`processParamProvider`；注册键 `databases.use.eel`（"Use EEL for databases in docker and WSL"）；`consoleRunContextParametersTuner` 的 `EelParametersTuner`（`last`）与 `ProxyParamTuner`（id="proxy-param"） |
| 数据源有应用级与项目级两种存储作用域；凭据由独立服务承载，底层是操作系统凭据存储；数据库源码以专用虚拟文件系统呈现为文件 | 服务 `DataSourceModelStorage` 同时注册为应用级与项目级；注册键 `database.datasource.registry.using.storages`、`...in.advance`；服务 `DatabaseCredentials`（应用级）+ 平台扩展点 `credentialStore`（按操作系统注册）；`<virtualFileSystem ... key="dbSrc" physical="true" />`；配套 `fileIconProvider`、`editorTabTitleProvider`、`DbSrcStorageManager`、`DbSrcModelStorageService` |
| 内省有三级层级，可对单对象设定、可继承、可自动选择；支持逐层与按片段增量，并可复用预置系统对象快照；元数据能力分为内省器、元数据封装、源码加载、模型门面、领域注册、命名服务等协作面 | 动作 `DatabaseView.SetIntrospectionLevel1/2/3Action`、`SetInheritedIntrospectionLevelAction`、`SetAutoIntrospectionLevelAction`；注册键 `database.introspection.level.auto.select.strategy`、`database.view.levels.hide.L3`、`database.introspection.{postgres,redshift}.is.enable.levels`/`...fragment`、`database.snapshots.auto`；扩展点 `com.intellij.database.introspector`（28 条）、`jdbcMetadataWrapper`、`jdbcSourceLoader`、`modelFacade`、`domainRegistry`（34 条）、`namingService`（49 条）；类型系统 `typeSystem`（31 条） |
| SQL 检查族 54 项，覆盖引用、类型、结构与风险语义；危险语句确认依赖逐产品的影响分析器；解析允许外部注入符号来源；重命名走通用重构设施 | 全量描述符中 `localInspection language="SQL"` 计数 = 54，含 `SqlResolveInspection`、`SqlTypeInspection`、`SqlAmbiguousColumnInspection`、`SqlWithoutWhereInspection`、`SqlSideEffectsInspection`、`SqlDialectInspection`；扩展点 `com.intellij.database.sqlEffectAnalyzer`（6 条，覆盖 PostgreSQL/MySQL/MariaDB/MSSQL/Oracle/Redshift）、`com.intellij.sql.resolveExtension`；`<lang.refactoringSupport language="SQL">` 与 `<suggestedRefactoringSupport language="SQL">` |
| 表→DDL、列→引用的导航由产品级导航/成员辅助提供；查询执行以控制台为上下文，会话/数据源/模式可切换；取消是显式动作 | 扩展点 `com.intellij.sql.navigationHelper`、`sql.membersHelper`、`com.intellij.database.definitionProvider`（22 条）；动作组 `Console.Jdbc.ChooseSession`、`ChooseDataSource`、`ChooseSchema`；动作 `Console.Jdbc.Cancel`；通知组 "Database cancelling running statements" |
| 结果集数量与批处理大小有硬上限；分页优先 LIMIT/OFFSET；手动事务断链自动回滚；数据编辑由逐产品 DML 提供者生成语句，网格编辑前有脏行审查接缝 | 注册键 `database.result.set.limit=100`、`database.batch.size=2000`、`database.grid.paging.offset=true`、`database.scrollable.result.sets=true`、`database.console.enable.auto.rollback.in.manual.tx=true`；动作 `Console.Transaction.Commit/Rollback/TxSettings/Debug.LogTxState`；扩展点 `com.intellij.database.dmlHelper`（32 条）、`com.intellij.database.dataAuditor` |
| DDL 生成、差异、模型→脚本各是独立接缝；DDL 映射可从数据库重新生成；导入有逐产品导入器（29 条）；导出/转储可走原生工具 | 扩展点 `com.intellij.database.scriptGenerator`（35 条）、`schemaDiffCustomization`、`toDatabaseScriptTranslator`、`synchronizeHandler`；动作 `DatabaseView.CreateDdlMapping`、`DDL.Editor.Regenerate`、`DatabaseView.CopyDdlFromDbAction`、`DatabaseView.ShowDiff`、`ShowContentDiff`；扩展点 `com.intellij.database.dataImporter`；动作 `DatabaseView.ImportFromSql`、`FileEditor.ImportToDatabase`、`Console.TableResult.ImportTable`、`DatabaseView.Dump.Native`；扩展点 `cli.runTargetProvider`；注册键 `custom.cli.run.target.providers` |
| 迁移工具以"数据库插件依赖方"身份集成，可扩展解析并监听连接事件；数据网格是独立层，含渲染、格式化、抽取、编辑、图表与脚本化数据源；列数有硬上限 | 插件 `com.intellij.flyway`（依赖 `com.intellij.database`，注册 `sql.resolveExtension`，监听连接管理器主题）；插件 `com.intellij.liquibase`（模块 `intellij.liquibase.core` 依赖数据库模块族）；扩展点 `com.intellij.database.datagrid.cellViewerFactory`、`formatterCreatorProvider`、`objectNormalizerProvider`、`extractorsHelper`、`customToolbarProvider`、`valueEditorTab`、`minimizedFormatDetector`；模块 `intellij.grid.core.impl`、`.csv.core.impl`、`.json.impl`、`.images.impl`、`.scripting.impl`、`.charts.impl`；注册键 `grid.tables.columns.limit=2000`、`database.grid.cache.factor=3` |
| 无界面/脚本化能力通过命令行启动器暴露；向外部自动化调用方开放工具集并裁剪数据量 | 扩展点 `appStarter`：`dataSources`、`dumpArtifacts`（模块 `intellij.database.cliCommands`）；模块 `intellij.database.mcp` 注册 `mcpServer.mcpToolset`；注册键 `db.table.data.token.limit=5000` |
| 观测面按"日志通道 + 通知 + 诊断"三分 | 通知组 "Database view log"、"Database execution log"、"Database refactoring log"（`displayType="NONE"`，仅记录）；"Database queries that took much time"、"Update Table"、"Database cancelling running statements"（气泡） |
| 本子系统共声明 94 个唯一扩展点（命名空间 `com.intellij.database` / `sql` / `datagrid`）；平台另有内置本地关系存储与本子系统无关 | 全量描述符去重计数 = 94 个 `extensionPoint` 声明；模块 `intellij.platform.sqlite`，`visibility="public"`，仅依赖 `intellij.platform.util.ex` |

## 12. 未决问题

- **拦截器链的冲突消解**：两个认证拦截器都成功改写凭据时采用哪个结果？证据只显示存在排序与首尾锚点，冲突消解语义 `[推断]` 为"后执行者覆盖"。
- **L1/L2/L3 的精确定义**：证据给出三级命名、按对象设定与自动选择开关，但每级包含哪些属性只能从"L3 才能产出源码"这条线索推断，其余 `[推断]`。
- **驱动宿主的粒度**："每数据源一个进程"还是"每执行环境一个进程"无直接证据，`[推断]` 为前者。
- **并发写冲突的判定面**：证据仅有影响行数校验与脏行审计接缝；是否实现基于版本列/时间戳的乐观并发控制 `[推断]` 为未实现。
- **截断结果集的续取语义**：上限存在（结果集数、列数、数组元素数），但"截断后是否允许分页续取"无证据，`[推断]` 为允许。
- **前端持有的模型投影形态**：是完整模型的副本还是按需查询后端无证据；`[推断]` 为按需查询 + 局部缓存。
- **只读模式的传播范围**：只读标志是否约束"生成脚本后由用户手动执行"的路径（该路径不经过会话）无证据，`[推断]` 为不约束。
- **迁移工具对模型的写权限**：迁移插件同时依赖模型层与差异层，是否允许直接构造模型对象（而非只读）无证据，`[推断]` 为允许构造但不允许推送。
