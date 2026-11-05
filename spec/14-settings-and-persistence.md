# 14 — 设置与持久化

> 范围：跨会话状态的归属、状态契约、存储与崩溃一致性、损坏恢复、运行期开关、作用域解析、凭据、同步、导入导出。｜ 依赖：01、02、03、04。｜ 排除：派生数据（索引、缓存、桩）的存储（见 07）、文档未保存缓冲（见 05）、设置界面的信息架构（见 13）、许可与更新通道（见 16）。

## 1. 目的与范围

### 1.1 本子系统解决什么问题

进程退出后仍有意义的状态，必须被**显式声明、可验证、可恢复**地保存。本子系统回答五个问题：

1. **哪些状态要活过本次会话** —— 由配置单元声明，而非代码在运行期顺手写盘。
2. **它属于谁** —— 应用 / 项目 / 模块 / 每客户端；可共享 / 仅本机 / 仅本会话。
3. **它长什么样** —— 序列化契约：字段默认值、缺省省略、未知字段保留、版本与迁移。
4. **它如何被安全替换** —— 批量、延迟、原子、崩溃一致、外部修改可检测。
5. **它如何被覆盖与强制** —— 代码默认 → 产品默认 → 用户 → 项目 → 模块 → 文件类型 → 企业强制，且每次解析可查询来源。

**边界判据**：任何持久状态都必须能回答"删除它会不会损失用户意图"。答案为否者属派生数据，走 07 的丢弃-重建路径，不得进入配置文件组。

### 1.2 边界

不负责：用户文件的保存与崩溃恢复策略（见 04、05；共用文件层原子替换，但**触发时机不同**：用户文件由用户显式或空闲触发，配置由脏判定 + 阈值触发）；索引/缓存/桩的格式与淘汰（见 07）；设置界面的分组与搜索（见 13）；工程模型结构的权威（见 11；本子系统只是序列化通道，并允许把写权外委给构建系统）；许可与遥测通道（见 16、20）。

### 1.3 与其他子系统的关系

| 关系 | 说明 |
|---|---|
| 02 容器 | 配置单元是服务的能力形态；作用域决定状态归属（见 02 §2.3、§3） |
| 02 §4.1 | 应用级载入先于项目可用；项目级载入必须先于该项目的初始化活动 |
| 03 并发 | 读取可并发；写入必须串行化并处于写意图之下 |
| 04 文件层 | 复用原子替换、行分隔符保持、只读介质处理 |
| 11 工程模型 | 构建系统拥有的配置文件由外部系统写，本子系统只镜像并检测外部修改 |
| 13 界面 | 界面消费"声明"，不直接读写文件 |
| 17 远程部署 | `perClient` 状态的传输与合并顺序由 17 约束 |

## 2. 概念模型

### 2.1 术语

| 术语 | 英文 | 定义要点 |
|---|---|---|
| 配置单元 | Configuration Unit | 一个可序列化状态对象的持久化单位，标识全局唯一 |
| 状态规格 | State Spec | 单元声明：标识、存储、可重载性、类别、导出性等 |
| 存储 / 存储组 | Storage / Storage Group | 物理承载位置（文件或目录）；组是用户视角下的一个逻辑配置文件集合 |
| 工作区状态 | Workspace State | 与"本机 + 本项目"绑定、**不得**共享的状态 |
| 方案 | Scheme | 一组成员命名的可切换档案（配色、代码风格、键位映射），目录 + 每方案一文件 |
| 键 / 高级设置 | Key / Advanced Setting | 运行期开关；对既有单元字段的**声明式投影**，可搜索可重置但无独立存储 |
| 层 / 托管层 | Layer / Managed Layer | 默认值与覆盖的来源；托管层由组织策略下发且对用户只读 |
| 迁移 | Migration | 旧形态（旧文件、旧字段、旧命名）向新形态的转换 |

### 2.2 三层结构与归属

必须区分：**声明**（状态规格，装载期确定）→ **承载**（存储与存储组，装载期确定）→ **生效值**（层解析结果，运行期变化）。

关系约束：一个存储组含多个单元，一个单元可跨多个存储；单元状态由层解析器求值，层解析器同时受托管层与用户/项目/模块/文件类型层影响；凭据以引用形式挂在一个单元上，实体本身在独立安全存储；同步通道只读取经白名单过滤的应用组与项目组，不触达工作区组与凭据；方案目录独立于单元，其"当前选中项"反过来是一个普通单元。

| 归属 | 生命周期 | 共享性 | 典型内容 | 存储组 |
|---|---|---|---|---|
| 应用 | 进程 | 用户级，可跨机同步 | 主题、编辑器行为、键位映射、工具开关 | 应用组 |
| 项目（可共享） | 项目打开→关闭 | 随项目进版本库 | 项目级编码风格、检查配置、运行配置 | 项目组 |
| 项目（工作区） | 项目打开→关闭 | **不得**共享 | 打开的文件、光标、折叠、最近搜索 | 工作区组 |
| 模块 | 模块存在期 | 随项目进版本库 | 模块级输出目录、模块级依赖引用 | 模块组 |
| 每客户端 | 会话 | 不共享 | 客户端本地视图状态（远程部署） | 工作区组（按客户端隔离） |
| 凭据 | 系统密钥库 | **永不**进配置文件 | 口令、令牌、私钥口令 | 独立安全存储 |

**判定规则**：含"本机路径、本机环境、会话视图位置、任何秘密"的状态，必须声明为工作区状态或凭据，不得落入可共享组。该规则由声明强制，不依赖实现者自觉。

## 3. 数据模型

### 3.1 状态规格与存储规格

```
StateSpec {
  key: string                  // 全局唯一；持久化时作为单元在文件中的标识
  storages: StorageSpec[]      // ≥1；同一单元可被拆到多个存储
  reloadable: bool             // 外部修改后能否就地重载（false ⇒ 只能重启/重开项目）
  defaultFromResource: bool    // 默认值取自随产品发布的只读资源
  externalOnly: bool           // 禁止落入可共享的项目配置文件
  exportable: bool             // 进入导出/同步候选集
  category: UI|KEYMAP|CODE|TOOLS|SYSTEM|PLUGINS|OTHER   // 默认 OTHER
  perClient: bool              // 状态按客户端隔离
  requiresUiThread: bool       // 状态读写必须在界面线程
  presentableName: string?     // 导出/同步界面的人类可读名
  reportStatistic: bool        // 变更进入设置变更采样
}

StorageSpec {
  groupId: string              // 同组单元共享一个物理文件/目录
  layout: exclusive | split    // exclusive：文件根即单元；split：按分区键拆成多文件
  roaming: disabled | local | perOs | default
  deprecated: bool             // 旧位置；迁移后应被清理
  saveThreshold: never | always | auto   // auto：非共享且过阈值才落盘
  pathMacros: bool             // 写入前展开、读取后回缩路径宏
}
```

`roaming = disabled` 是**共享性的唯一权威标记**：同时决定"是否进入同步白名单"与"是否按写阈值节流"。工作区组、缓存集合与其他特殊集合被强制视为 `disabled`，即使声明写了别的值。

### 3.2 运行期视图、键、高级设置、凭据与方案

```
ConfigUnit {
  spec: StateSpec
  state: opaque           // 当前状态对象（可变，由所属作用域持有）
  storedForm: bytes?      // 上次持久化形态；用于脏判定与低内存驻留
  lastSavedAt: timestamp?
  loadPolicy: load | defaultOnly | skip    // 故障隔离与实验特性用
  savingBlocked: reason?  // 载入失败或外部冲突时置位
}

RegistryKey {
  name: string            // 点分名称，稳定标识
  description: string     // 面向工程师
  defaultValue: string    // 文本形态；类型由文本推导（bool/int/string/enum）
  restartRequired: bool
  overrides: bool         // 允许与其他声明同名并覆盖
  managed: bool           // 托管层下发 ⇒ 用户不可写
  stability: public | internal | experimental   // 稳定性等级 [推断]
}

AdvancedSetting {
  id, default, group: string
  titleRef, descriptionRef: localizedRef
  visible: bool
  bind: { unitKey: string, property: string }   // 投影目标：既有单元的一个字段
  visibilityCondition, enabledCondition: ref?   // 运行期可计算
}

CredentialRef { kind: string; attributes: map; remembered: bool; present: bool }

Scheme { key, name: string; origin: bundled|user|external; file: path;
         category: SettingsCategory; readOnly: bool; lastModified: timestamp }
```

- `storedForm` 是性能设计的一部分：未变更单元以序列化字节驻留，仅脏单元重新序列化，使"大量单元、少量变更"从"每次全量序列化"变为"只序列化脏单元"。
- 键与高级设置的默认值全部来自声明；**未声明的键不得被读取**（必须报错而非返回空默认，否则拼写错误会变成静默失效）。
- 状态对象中只允许出现 `CredentialRef`，必须不出现口令明文。
- 单元与方案的差别：单元是"一个对象一段状态"，方案是"一族可切换档案"；**当前选中项**是普通配置单元，方案本体是目录下的独立文件，可在文件层面同步、被外部编辑、被导入导出。

## 4. 行为契约

### 4.1 载入

步骤：① 组内全部存储标记"仅默认" ⇒ 跳过磁盘读取；② 否则按清单读取，单文件解析失败 ⇒ 该文件贡献 0 单元并标记"禁止保存"；③ 每个声明了规格的单元：含该单元段 ⇒ 反序列化，不存在 ⇒ 保持代码默认（若 `defaultFromResource` 先以只读资源填充），`loadPolicy=skip` ⇒ 不构造；④ 反序列化采用合并语义 —— 已知字段覆盖已存在对象，未知段保留在待回写缓冲；⑤ 单单元失败只影响该单元。

- **载入以存储为单位整体完成，序列化以单元为单位惰性完成**：一个文件可有数百单元，但打开项目只解析文件一次。
- 载入顺序由组依赖决定，不由文件名顺序决定；同组内单元之间**不得**存在载入顺序依赖。
- 载入阶段**不得**产生任何写入；只读运行（D3/D5）必须能完整载入。

### 4.2 保存

```
markDirty(unit)  // 仅记录，不触盘
  ↓ 触发（显式保存 / 空闲 / 阈值 / 关闭）
beginSaveSession()
  for each dirty unit: serialize -> session.buffer[storage]   // 同存储多单元合并
  for each storage: savingBlocked ⇒ 跳过并记录原因；否则 write(storage)  // 原子替换见 4.4
  collectFileEvents()   // 自写事件，供文件层抑制回环
  commitDirtyMarks()    // 仅写成功的单元清除脏标记
```

- **一次会话内同一存储至多写一次**：多单元写同一文件必须合并为单次替换，否则出现"写一半"窗口。
- **写失败不得清除脏标记**，被跳过的存储必须留下可查询原因。
- **延迟写与阈值**：非共享单元距上次落盘不足 **5 分钟** 且无显式保存请求时，可以只更新内存与脏标记；可共享单元不享受该豁免（承载用户显式意图，丢失代价高）。窗口失焦/空闲后延迟 **15 秒** 启动会话，该延迟是"至少等待"，显式保存不受其约束。
- **关闭时**：先做一次完整会话；仍失败的存储必须记录，并在下次启动呈现"上次未落盘"，不得静默丢弃。

### 4.3 序列化契约

| 规则 | 内容 | 理由 |
|---|---|---|
| 缺省即省略 | 字段等于代码默认时不写 | 体积与差异噪声最小；默认值可随版本演进 |
| 未知字段保留 | 不认识的段/属性原样保留并在回写时写回 | 前向兼容：新版文件被旧版读一次后不得被削平 |
| 顺序稳定 | 同一状态两次序列化必须字节相同 | 使"未变则不写"可判定，避免无意义写盘与同步噪声 |
| 行分隔符保持 | 沿用原分隔符；新文件用平台默认 | 避免整文件 diff |
| 无内容即删除 | 单元空且文件无其他单元 ⇒ 删段；文件空 ⇒ 删文件；目录空 ⇒ 删目录 | 防止空壳配置堆积 |
| 路径可移植 | 可共享状态中的绝对路径写成宏形态，读取时展开 | 项目可在不同机器/根路径打开 |

序列化失败是**拒绝写**而非写半截：该单元保持脏并记录错误，同存储其余单元仍正常写入（隔离到单元）。

### 4.4 原子替换与崩溃一致性

写入步骤：在**同目录**建临时文件 → 写满并刷盘 → 以重命名替换目标（原子）→ 只读介质上抛出"只读修改"信号，获得写权限后重试一次。

不变量：**任何时刻读目标文件，看到的必须是上一完整版本或这一完整版本，不得是拼接体**。临时文件**必须**与目标同目录（跨目录重命名不保证原子）。

- 只读介质（只读挂载、权限不足、被占用）：写入被拒时必须保留待写内容并抛可重试信号，不得丢弃；重试一次仍失败则该存储进入只读回退（见 §7）。自写抑制：本子系统产生的文件事件必须携带来源标记，外部修改检测据此忽略自写事件，否则每次保存都会触发一次虚假"外部修改"。

### 4.5 外部修改

步骤：① 过滤来源为本子系统自身的事件，并按项目聚合成批；② 每个受影响存储——全部单元 `reloadable` ⇒ 就地重载并通知订阅方，否则收集"不可重载单元清单"；③ 存在不可重载单元 ⇒ 询问重启（应用级）/重开项目（项目级）：同意则对这些存储禁用保存后执行，拒绝则保持保存禁用直至用户解决。

- **就地重载必须"外部版本胜出"**：重载后内存与磁盘一致，未落盘的本地修改被丢弃。这就是拒绝重启时必须禁用保存的原因 —— 否则下次保存会静默覆盖用户刚在外部编辑器中做的修改。
- 冲突提示可配置（存在"外部变更冲突是否弹通知"的开关，默认关闭以适配非模态设置界面）。方案目录监听是独立通道：仅当事件来源不是本子系统写入者时才重扫方案清单。

### 4.6 版本与迁移

| 类别 | 触发 | 幂等要求 | 失败处理 |
|---|---|---|---|
| 存储位置迁移 | 单元从旧文件/目录移到新位置 | 必须可重复（旧位置可能已不存在） | 保留旧文件，下次启动重试 |
| 字段形态迁移 | 旧字段名/结构 → 新结构 | 必须可重复 | 单元保持旧形态，不得写半转换结果 |
| 命名/整体布局迁移 | 单文件项目描述 → 目录化配置 | 一次性，成功写"已完成"标记 | 标记未写则下次重试；新位置校验通过前不得删旧文件 |

- **迁移必须在载入之后、任何保存之前完成**：若在保存之后迁移，旧形态已被新格式覆盖，迁移逻辑再也读不到源数据。
- 一次性迁移必须留标记（标记本身是一个配置单元），无标记的迁移必须设计为可重复执行。**迁移失败必须回滚**：写新位置失败 ⇒ 旧位置不动；部分成功 ⇒ 以备份目录恢复（见 §7）。
- 废弃存储清理是独立机制：声明"某文件中的某些单元已废弃"，下一次保存会话必须把这些单元从该文件移除；文件变空则删除。

### 4.7 键与高级设置的解析

读取顺序：查声明表（未声明 ⇒ 错误，不得静默返回空）→ 托管层含该键 ⇒ 返回托管值并标记只读 → 用户覆盖层含该键 ⇒ 返回覆盖值 → 否则返回声明默认值；类型转换失败 ⇒ 告警一次、回退默认值并保留原始文本。

- 键变更必须广播（带旧值/新值）；`restartRequired` 的键在变更后必须明示"重启后生效"，不得静默生效。键读取必须廉价（无磁盘 IO、无锁竞争）：键集合启动期一次性装载，之后只读。
- 高级设置的可见性与可编辑性由声明条件计算，条件求值失败按"不可见/不可编辑"保守降级并记录；搜索索引按"标题 + 描述 + 分组"建立，使条目可被设置搜索命中。
- 稳定性等级决定暴露面：`internal`/`experimental` 的键不进入常规文档与普通设置界面，只在高级入口可见。高级设置**必须**提供描述文案并由该文案说明风险（改变后可能影响稳定性或性能），界面在分组层统一给出"高级设置可能影响稳定性"的提示 `[推断]`。
- **高级设置的重置 = 把绑定字段写回其代码默认**，而非删除整个单元；修改高级设置必须与直接修改该字段等价（同一写入路径、同一通知、同一脏标记），因为它们是同一份状态的两个视图。

### 4.8 作用域解析

```
resolveValue(key):
  for layer in [managed(100), project(80), module(70), fileType(60),
                user(50), bundledDefault(30), productDefault(20), codeDefault(10)]:
      if layer.has(key): return (value, layer)
  return (codeDefault, codeDefault)
```

| 秩 | 层 | 写者 | 可写 | 典型场景 |
|---|---|---|---|---|
| 100 | 托管 | 组织策略 | 否 | 强制禁用某项能力 |
| 80 | 项目 | 项目内用户操作 | 是 | 项目级检查配置、编码风格 |
| 70 | 模块 | 模块级用户操作 | 是 | 模块级依赖引用、输出目录 |
| 60 | 文件类型 | 用户按文件类型设定 | 是 | 某类文件的缩进与折行 |
| 50 | 用户 | 应用级用户操作 | 是 | 全局编辑器行为 |
| 30 | 产品发布默认 | 产品发布 | 否 | 语言默认配色/风格预设 |
| 20 | 产品默认（首启生成） | 首次运行 | 是（生成后即用户级） | 首启写入的初始状态 |
| 10 | 代码默认 | 声明 | 否 | 字段初值 |

**可查询性（强制）**：任一生效值必须能回答"来自哪一层、该层载体是什么、被哪些层遮蔽"，即诊断视图输出 `(键, 生效值, 来源层, 载体标识, 被遮蔽层列表)`；缺此项用户无法解释"我关掉了却还在生效"。**粒度覆盖**：项目覆盖应用、模块覆盖项目、文件类型覆盖通用设置 —— 三者不是"另一种层"，而是同一链上不同粒度的层，必须共用同一解析器，不得各自实现优先级。

### 4.9 凭据

- 凭据必须存于独立安全存储；配置文件只出现引用（秘密写安全存储，状态对象保存 `CredentialRef` 的定位属性）。
- 安全存储不可用（无系统密钥库、密钥库锁定、平台不支持）时，**不得**回退为明文写配置：必须降级为"仅本会话保存"并在界面明示"不会记住"。
- 凭据缺失（引用存在、目标被删/换机器/密钥库重置）：解析返回"未命中"，调用方走"提示输入"路径，不得让状态载入失败。一次性迁移：历史版本可能把口令明文存在配置文件中，迁移必须搬入安全存储并从配置文件**删除**该字段，失败时不得删除原字段（宁可下次重试）。
- 会话内可清除已缓存凭据而不影响已持久化的凭据；退出时未标记"记住"的凭据必须不落盘。

### 4.10 同步

```
syncCycle():
  1. 候选 = exportable 且 roaming != disabled 的单元
  2. 白名单过滤：排除凭据引用、工作区组、缓存集合、perClient 状态、本机路径绑定项
  3. 计算变更集（按单元状态内容摘要，不按文件时间戳），拉取远端并逐单元比较
  4. 冲突消解：同单元两侧均变 ⇒ 取较晚修改时间；时间相同 ⇒ 按设备标识定序（确定性）
  5. 应用远端变更到内存 → 标脏 → 常规保存会话落盘
  6. 推送本地变更；失败则保留变更集并退避重试
```

- **白名单是排除式的**：任何新增单元默认**不**进入同步，直到其声明被显式标记可导出。这防止新增敏感状态因遗漏而被同步出去。
- **冲突必须可解释**：消解后必须记录"哪侧胜出、依据是什么"；不可解释的静默覆盖不允许。
- **删除传播**：删除必须作为可传播的事实（墓碑），而非"对方没有这个文件"；仅当墓碑超过保留期才可两侧彻底清除 `[推断]`。**隐私边界**：过滤器运行在**序列化之后**，以防过滤遗漏时泄漏到日志。
- **自动同步**默认按固定周期（默认 **3600 秒**）与"应用获得焦点"触发，周期 ≤0 关闭定时；手动推送始终可用。通道可替换（见 §10），通道不可用只影响推送、不影响本地保存。同步历史必须可查看（工具窗口形态），因为"我的设置被改回去了"是最难自行诊断的故障之一。

### 4.11 导出、导入与诊断包

导出条目 = 所选单元的序列化内容（按存储组相对路径）+ 所选方案目录整体 + 已安装模块清单 + 标记条目；同名条目只保留首个，未选中的文件不得进入包。**导出是选择式的**：可按类别（界面/键位/代码/工具/系统/插件/其他）只导出某几类，而非全有或全无。

- **导入必须先备份**：把当前配置目录整体复制到带时间戳的备份目录，上限 **10** 份，超限淘汰最旧；导入后必须重启（已载入状态无法整体替换）。
- **诊断包与导出包不同**：面向排障，含配置组清单、各文件摘要（大小、单元清单、上次修改时间）、生效键来源表、脏单元与禁写原因、迁移记录；**不得**含凭据与用户文件内容。
- 导入包可能来自更高版本：未知单元/字段按"保留但不解释"处理，不得使导入整体失败。

## 5. 不变量与约束

| 编号 | 不变量 |
|---|---|
| INV-1 | 每个配置单元有且仅有一个声明；标识全局唯一，重复声明必须在装载期报错。 |
| INV-2 | 单元存储组必须与作用域相容：应用级不写项目组，项目级不写应用组。 |
| INV-3 | 工作区组、缓存集合与凭据必须不进入任何可共享或可同步集合。 |
| INV-4 | 配置文件中不得出现口令明文，只允许凭据引用。 |
| INV-5 | 序列化输出必须确定：相同状态 ⇒ 相同字节。 |
| INV-6 | 未知字段在"读—写"一轮后必须仍然存在。 |
| INV-7 | 同一存储在一次保存会话中至多被替换一次。 |
| INV-8 | 目标文件在任何时刻要么是旧完整版本，要么是新完整版本。 |
| INV-9 | 载入阶段不得产生任何写入。 |
| INV-10 | 保存失败不得清除脏标记；被跳过的存储必须可查询原因。 |
| INV-11 | 外部修改被拒绝重载后，该存储的保存必须被禁用，直到冲突解决。 |
| INV-12 | 生效值的来源层必须可查询；不可查询的覆盖视为缺陷。 |
| INV-13 | 未声明的键不得可读；类型转换失败必须回退默认值并留痕。 |
| INV-14 | 迁移必须先于任何保存执行，且失败时旧形态必须完好。 |
| INV-15 | 单元级失败不得传播为存储组级失败，存储组级失败不得传播为应用级失败。 |
| INV-16 | 凭据存储不可用时，秘密只能存在于内存，且在本会话结束前消失。 |

## 6. 对外能力契约

```
// 声明（装载期）
declareUnit(spec) -> Handle | declareKey(keyDecl) -> Handle
declareAdvancedSetting(decl) -> Handle | declareObsoleteStorage(groupId, unitKeys[]) -> Handle

// 状态（运行期）
getState(unitKey) -> state?          // 惰性载入；未声明必须报错
setState(unitKey, state) -> void     // 仅置脏，不保证立即落盘
markDirty(unitKey) -> void | setLoadPolicy(unitKey, load|defaultOnly|skip) -> void

// 保存
saveNow(scope) -> SaveReport                // {written[], skipped[{storage, reason}]}
isSavingBlocked(storageId) -> reason? | onExternalConflict(handler) -> Unsubscriber

// 键与高级设置
readKey(name) -> value | writeKey(name, value) -> SetResult{done|forbidden|inapplicable}
subscribeKey(name, listener) -> Unsubscriber | resetAdvancedSetting(id) -> void

// 解析
resolve(key) -> {value, layer, carrier, shadowed[]}
listEffective(scope) -> row[]               // 诊断用全量

// 凭据
resolveCredential(ref) -> credential?       // 未命中不抛错
storeCredential(ref, secret, remember) -> void | clearSessionCredentials() -> void

// 同步与维护
syncCandidates(scope) -> unitKey[] | pushChanges() -> SyncReport | pullChanges() -> SyncReport
runMigration(id) -> MigrationResult | createBackup(label) -> path
exportSettings(selection, out) -> void | importSettings(package) -> ImportResult  // 需重启
buildDiagnosticBundle(out) -> void
```

- 写入类 API **必须**在写意图之下调用（见 03），否则必须立即失败而非延迟到落盘时失败。
- 查询类 API 必须在无界面角色（D4）下可用，不得依赖界面已初始化；句柄必须可显式注销，注销后查询不得再返回该条目（对应 02 §6）。

## 7. 故障模式与降级

| 故障 | 检测 | 用户可见 | 降级动作 | 档位 |
|---|---|---|---|---|
| 单文件语法损坏 | 载入期解析异常 | 警告：文件位置 + 原因 + "内容将被重建"或"请修正文件内容" | 该文件贡献 0 单元；**禁止保存该文件**（避免用默认值覆盖用户数据）；其余存储正常 | D2 |
| 关键项目配置损坏且禁止保存 | 同上且属项目组 | "项目配置不可写"提示 | 编辑/导航保留；配置修改仅存内存；可重开项目 | D3 |
| 存储只读（权限/只读介质/被占用） | 写入被拒 | "设置无法保存" | 保留待写内容，获权后重试一次；仍失败则只读回退，修改只存内存 | D2 |
| 外部修改且单元不可重载 | 外部变更检测 | 对话框：不可重载单元（最多 10 项 + 计数）+ 重启/重开提议 | 同意 ⇒ 禁用这些存储保存并重启；拒绝 ⇒ 保存保持禁用 | D3 |
| 托管层拒绝写入 | 写入返回"禁止" | 控件只读，附策略来源 | 该键修改被拒，其余设置不受影响 | D0（局部禁写） |
| 用户覆盖值类型非法 | 类型转换失败 | 无（静默回退）+ 诊断项 | 回退默认值，保留原始文本 | D0 |
| 凭据存储不可用 | 提供者探测失败 | "本会话有效，不会记住" | 秘密仅驻内存，不得写明文 | D0 |
| 凭据缺失 | 引用解析未命中 | 按需弹出输入 | 请求时输入，不阻断状态载入 | D0 |
| 迁移失败 | 迁移过程异常 | "设置迁移未完成"，指向备份路径 | 旧形态保留，下次启动重试 | D2 |
| 同步通道不可用 | 连接/认证失败 | 错误通知（可稍后重试） | 本地保存不受影响；变更集保留并退避重试 | D1 |
| 同步冲突 | 双侧变更集 | 历史中显示消解依据 | 按时间/设备定序消解，保留可解释记录 | D0 |
| 配置目录整体不可用或大面积损坏 | 启动期完整性检查 | 引导修复向导 | 以最小配置启动，只读不覆盖原目录，导出诊断包 | D5 |
| 导入包不可读/版本过高 | 导入期校验 | 说明原因 | 中止导入；备份已存在，原配置未变 | D2 |

恢复动作统一要求：**先保存现场再修复**（重建默认值前必须已有备份）；**修复必须可逆**（备份保留到用户确认正常，轮换上限 10 份）；**不得静默修复**（覆盖用户文件必须留下通知与日志）。

## 8. 资源与性能预算

| 项 | 预算/实测 | 说明 |
|---|---|---|
| 启动期载入 | 只解析配置目录内文件，不得触及用户源码与工程内容 | 与 01 §8 的"冷启动 < 5 s"一致 |
| 单文件解析 | 以存储为单位一次完成；数百单元的组不得逐单元开关文件 | — |
| 未变更单元驻留 | 以序列化字节驻留，按需反序列化 | 内存与"变更集大小"相关，而非与"单元总数"相关 |
| 保存写放大 | 一次会话同一存储写一次；内容未变不写 | 由确定性序列化 + 内容比对保证 |
| 非共享单元写阈值 | **5 分钟**（实测默认） | 超阈值或显式保存才落盘 |
| 空闲触发延迟 | **15 秒**（实测） | 避免连续操作期间反复写盘 |
| 外部变更聚合 | 秒级批处理；后台刷新间隔默认 **15 秒**（可配置） | 批量处理同项目多文件变更 |
| 同步周期 | 默认 **3600 秒** + 焦点触发；≤0 关闭定时 | 实测默认值 |
| 备份数量 | **10** 份 | 超出淘汰最旧；整目录复制，仅发生在导入/重置/大版本迁移 |
| 键读取 | 内存查表，无 IO、无锁竞争 | 键集合启动期一次装载 |
| 设置变更采样 | 1 分钟窗口聚合、按天周期上报（若启用） | 可关闭 |

背压与内存压力：配置目录**不是**缓存，不得因内存紧张而丢弃未落盘状态；内存压力只允许影响"驻留形态"（对象 ↔ 字节），不允许影响"是否持久"。大量单元同时变更时（如批量导入后首启），保存会话必须分片执行且可取消；取消后已写部分保持有效（每存储替换独立）。

## 9. 可观测性

| 事件 | 关键字段 |
|---|---|
| 存储组载入与单元载入失败 | 组标识、文件数、单元数、耗时、失败项及原因；失败单元记录标识、载体、异常摘要、处置（保持默认 / 保持旧形态 / 禁用保存） |
| 保存会话与写失败 | 触发原因（显式/空闲/阈值/关闭）、脏单元数、写入存储数、跳过项及原因、耗时；写失败时记录存储标识、异常类型（只读/空间/占用/序列化）与重试结果 |
| 外部修改 | 受影响存储、可重载与不可重载单元划分、用户选择 |
| 迁移 | 迁移标识、方向、结果、备份路径 |
| 键变更 | 键名、旧值、新值（敏感键只记"已变更"）、是否需重启 |
| 同步往返 | 方向、单元数、冲突数及消解依据、失败原因 |
| 凭据操作 | 类别、定位属性摘要（**不得**记录秘密）、结果 |

指标：配置载入/保存耗时分布（按存储组）；脏单元峰值；被禁写存储数（长期 >0 说明冲突未解决）；同一迁移连续失败次数（必须升级为用户可见提示）。

诊断入口必须产出"最小可复现状态"：配置组与文件清单、每文件单元清单与摘要、生效键来源表、脏与禁写原因、最近一次保存会话报告。任何"设置不生效"问题必须仅凭该状态回答：**这个值来自哪一层、为什么上层没覆盖它、它有没有被写下去**。

## 10. 扩展点

| 接缝 | 允许第三方做什么 | 必须遵守 | 失败隔离 |
|---|---|---|---|
| 应用设置声明 | 声明"某服务携带应用级可持久化状态" | 标识唯一；作用域为应用；不得声明工作区组 | 声明非法 ⇒ 跳过并通知，其余设置正常 |
| 项目设置声明 | 声明"某服务携带项目级状态" | 作用域为项目；跨项目共享状态不得在此声明 | 同上 |
| 按键声明 | 注册运行期开关 | 必须给默认值；名称冲突须显式声明覆盖 | 冲突 ⇒ 保留先注册者并记录 |
| 高级设置声明 | 把既有字段暴露为可搜索条目 | 绑定目标必须存在；不得绑定凭据字段；重置回到代码默认 | 绑定缺失 ⇒ 条目不可见并记录 |
| 废弃存储声明 | 声明"旧文件中某单元已废弃" | 必须给出替代位置或明确"删除即可" | 声明错误 ⇒ 只记录，不删数据 |
| 凭据存储提供者 / 凭据类别 | 提供密钥库实现；新增需要凭据的连接类型 | 必须支持"不可用"语义、不得静默回退明文；类别须提供定位属性集合与提示文案 | 失败 ⇒ 降级为会话内保存；类别未注册 ⇒ 该类型不可持久记忆 |
| 同步提供者 / 同步通道 | 判定"哪些状态可同步"；提供传输实现 | 必须遵守排除式白名单，不得扩大到工作区/凭据；通道不得阻塞本地保存 | 提供者异常 ⇒ 其单元视为不可同步；通道失败 ⇒ 仅影响推送 |
| 设置控制器 | 提供替代键值承载（远端/多云） | 必须实现"不适用"返回以允许回退本地文件 | 不适用 ⇒ 自动回退本地存储 |
| 配置界面组 | 提供设置页面与其状态绑定 | 页面不得直接读写文件，只能经由配置单元 | 页面构造失败 ⇒ 该分节不可用，其余可打开 |
| 选项适用性过滤器 | 按上下文隐藏不适用选项 | 只影响呈现，不影响生效值 | 异常 ⇒ 按"全部适用"降级 |

统一约束：第三方**必须不**自行实现配置文件读写、原子替换、备份轮换（平台单点职责，绕过即破坏 INV-6/7/8）；第三方声明的状态在卸载时必须"保留而不解释"，**不得**在卸载时删除其配置文件（用户可能稍后重装同一功能）；任何声明的持久化影响面（写入哪个组、是否进入同步、是否需重启）必须可由声明静态推导，以便装载期校验。

## 11. 对照实现（证据锚点）

| 上文结论 | 证据锚点 |
|---|---|
| 状态规格字段集合（可重载、类别、导出、每客户端、仅外部存储、需界面线程、统计上报） | 模块 `intellij.platform.configurationStore.impl`：`StateAnnotation` 实现的状态注解方法集 |
| 存储规格字段（独占、拆分、漫游、废弃、写阈值、路径宏） | 同模块 `StorageImpl` 构造参数；`StateStorageManagerImpl.getStateStorage` 读取 `roamingType/storageClass/stateSplitter/exclusive/usePathMacroManager` |
| 漫游四态，仅非 `DISABLED` 可迁移 | `intellij.platform.core` → `RoamingType`（`DISABLED/LOCAL/PER_OS/DEFAULT`、`canBeMigrated`） |
| 非共享存储判定（工作区文件、`other.xml`、缓存文件、产品工作区文件） | `ComponentInfoKt.isSpecialOrNonRoamableStorage` / `isSpecialStorage` |
| 四类存储组的路径宏；默认项目状态位于应用组内单独文件 | `ApplicationStoreImplKt.APP_CONFIG`（`$APP_CONFIG$`）、`ModuleStateStorageManager`（`$MODULE_FILE$`）、`ProjectStoreImpl`（`$PROJECT_FILE$`、`$WORKSPACE_FILE$`、`$PROJECT_CONFIG_DIR$`）、`DefaultProjectStoreImplKt.PROJECT_DEFAULT_FILE_SPEC`（`$APP_CONFIG$/project.default.xml`） |
| 载入策略三态 | `StateLoadPolicy`（`LOAD/LOAD_ONLY_DEFAULT/NOT_LOAD`） |
| "每存储一个生产者"、单元合并写 | `SaveSessionProducerManager.getProducer`（按存储键去重）、`saveSessions` |
| 非共享单元写阈值 5 分钟 | `ComponentStoreImplKt.NOT_ROAMABLE_COMPONENT_SAVE_THRESHOLD_DEFAULT`（`MINUTES.toSeconds(5)`） |
| 空闲监听延迟 15 秒、后台刷新默认 15 秒 | `SaveAndSyncHandlerImplKt.LISTEN_DELAY`；键 `vfs.background.refresh.interval` 默认 15 |
| 缺省即省略的序列化过滤器、未知段合并 | `StateStorageBaseKt.serializeState` 使用 `SkipDefaultsSerializationFilter`；`mergeInto` 合并语义 |
| 未变更单元以字节驻留、按需反序列化 | `StateMap.getState(archive)` / `StateMap.archive` |
| 原子写、内容相等不写、只读介质可重试 | `FileBasedStorageKt.writeFile`、`ReadOnlyModificationException`（携带待写内容，权限恢复后重试） |
| 解析失败 ⇒ 阻止保存 + 用户通知 | `FileBasedStorage.processReadException`：对项目/工作区/模块文件置 `blockSaving`，并向"System Messages"发警告通知 |
| 空内容删除文件/目录；自写事件抑制 | `DirectoryBasedStorage.DirectorySaveSessionProducer.save`（空则递归删目录）、`deleteFiles` 清理不再声明的 `.xml`；`StorageUtilKt.RELOADING_STORAGE_WRITE_REQUESTOR`、`SchemeFileTracker` 排除本子系统来源事件 |
| 外部修改 ⇒ 就地重载 / 询问重启；重载结果四态 | `ComponentReloadingKt.reloadComponents`、`StoreReloadManagerImplKt.askToRestart`（不可重载单元最多列 10 项，同意后对受影响存储 `disableSaving`）、`ReloadComponentStoreStatus`（`RESTART_AGREED/RESTART_CANCELLED/ERROR/SUCCESS`） |
| 备份轮换上限 10、按时间戳命名 | `intellij.platform.ide.impl` → `ConfigBackup.MAX_BACKUPS_NUMBER = 10`，目录 `<配置目录>-backup/<yyyy-MM-dd-HH-mm>` |
| 废弃存储声明（文件 + 是否项目级 + 单元清单） | 扩展点 `com.intellij.obsoleteStorage`（40 条注册）→ `ObsoleteStorageBean`；消费点 `ComponentStoreWithExtraComponents.commitObsoleteComponents` |
| 旧单文件项目描述 → 目录化配置迁移；构建系统写权外委 | `NestedProjectStorePathManagerKt`：`$PROJECT_FILE$` 作为 `DEPRECATED_PROJECT_FILE_STORAGE_ANNOTATION`；`StreamProviderFactory`/`isJpsBridgeAwareStorageSpec`（`libraries.xml`、`artifacts.xml`、`modules.xml`） |
| 运行期键的声明字段 | 扩展点 `com.intellij.registryKey`（2 061 条注册）→ `RegistryKeyBean`：`key`、`description`、`defaultValue`、`restartRequired`、`overrides` |
| 托管键只读 | 扩展点 `com.intellij.registry.managed`（`ManagedRegistry`，`dynamic="false"`）；模块 `intellij.platform.registry.cloud` |
| 键的读取与订阅 | `RegistryManager`：`is/intValue/stringValue/get`、`TOPIC`、`resetValueChangeListener` |
| 高级设置声明字段与类型推导；绑定既有字段、可搜索、可重置 | 扩展点 `com.intellij.advancedSetting`（302 条注册）→ `AdvancedSettingBean`（`id`、`default`、`titleKey`、`groupKey`、`descriptionKey`、`bundle`、`enumClass`、`visible`、`service`、`property`，`type()` 由默认文本推导）；`AdvancedSettingControl`（`cellBuilder`+`isDefault`+`reset`）；`AdvancedSettingsConfigurableKt` 用 `SearchableOptionsRegistrar` |
| 设置类别七值 | `intellij.platform.projectModel` → `SettingsCategory`（`UI/KEYMAP/CODE/TOOLS/SYSTEM/PLUGINS/OTHER`） |
| 应用级/项目级设置声明（指向携带可持久化状态的服务） | 扩展点 `com.intellij.applicationSettings`（529 条）、`com.intellij.projectSettings`（430 条，`area="IDEA_PROJECT"`）→ `SettingsComponentDescriptor.service` |
| 设置界面组接入 | 扩展点 `applicationConfigurable`（142）、`projectConfigurable`（125）、`groupConfigurable`（28）、`optionsApplicabilityFilter`（5）、`optionController`（18） |
| 键值承载可路由、可回退、可被拒绝 | `intellij.platform.ide.core` → `SettingsController`（`getItem/setItem` 可"不适用"）、`SetResultResolution`（`INAPPLICABLE/DONE/FORBID`）、`ReadOnlySettingException`；标签 `NonShareableTag`、`CacheTag`、`PersistenceStateComponentPropertyTag`；写入由控制器接管，不可写则 `StateStorageBaseKt.serializeState` 回退文件存储 |
| 凭据独立存储与提供者接缝 | 扩展点 `com.intellij.credentialStore`（6）、`remote.credentialsType`（7）、`sshCredentialProvider`（1）；模块 `intellij.platform.credentialStore{,.common,.impl,.ui,.backend.split,.frontend.split}` |
| 凭据可迁移出明文配置 | `intellij.platform.ide.impl` → `ProxyMigrationService`、`HttpConfigurableToCredentialStoreAdapter`（`remember`、`clearTransientCredentials`、`clearAllCredentials`） |
| 同步候选集与本地/远端分离 | 模块 `intellij.settingsSync.core`（`SettingsSyncSettings`、`SettingsSyncLocalSettings`、`SettingsSynchronizer`）、扩展点 `com.intellij.settingsSync.settingsProvider`、`com.intellij.settingsSync.communicatorProvider`（1）、`com.intellij.settingsSyncMigration` |
| 同步周期与焦点触发默认值 | 键 `settingsSync.autoSync.frequency.sec` 默认 `3600`、`settingsSync.autoSync.on.focus` 默认 `true`；另见 `settingsSync.manualPush`、`settingsSync.history`、`settingsSync.errors` |
| 同步可替换通道与本地实现 | 插件 `com.intellij.settingsSync`（目录 `settingsSync`）+ 模块 `intellij.platform.settings.local`、`intellij.platform.registry.cloud` |
| 导出为归档包（选择式、含模块清单）；导入前备份并重启 | `ExportSettingsActionKt.exportSettings`（压缩包写入所选条目、三方文件、`installed.txt`、全局标记条目）、`ChooseComponentsToExportDialog`、`ImportSettingsAction`（`ConfigBackup` + `restart()`）；模块 `intellij.ide.startup.importSettings` |
| 外部变更冲突提示可关闭 | 键 `ide.settings.external.change.conflict.show.notification` 默认 `false` |
| 方案（可切换档案）模型 | `SchemeManagerImpl`（bundled 只读、`filesToDelete`、`isOldSchemeNaming`、`RoamingType`、`SettingsCategory`）、`SchemeFileTracker`（外部文件跟踪） |
| 设置变更统计采样 | 同模块 `statistic/eventLog/FeatureUsageSettingsEventSchedulerKt`（`PERIOD_DELAY = 1 day`）、`FeatureUsageSettingsEvents`（1 分钟窗口） |
| 默认设置重置（确认 → 备份 → 重启）；项目设置可外置存储 | `defaults/DefaultSettingsHelper`、`defaults/RestoreDefaultSettingsAction`、`DefaultSettingsService.restoreDefaultSettings`；`ExternalStorageConfigurationManagerImpl`（`isEnabled/setEnabled`） |
| 平台规模基线 | 2090 模块；扩展点声明 3 235、注册条目 29 282（模块描述符 18 615 + 插件描述符 10 667，见 `_rev/ep_counts.json`）；本子系统相关注册：应用设置 529、项目设置 430、键 2 061、高级设置 302、废弃存储 40、配置界面组 142+125+28 |

## 12. 未决问题

- 键覆盖值自身的持久化载体未能定位，`[推断]` 落在应用配置组的一个普通配置单元内。
- 同步白名单各单元的实际 `exportable` 取值分布未统计，只确认"由可导出标志 + 漫游属性推导"。
- 同步删除传播的墓碑保留期未找到常量，`[推断]` 与备份/历史保留策略同量级（天）。
- 外部变更的批处理去抖窗口未实测，仅确认按项目聚合与 15 秒级后台刷新键。
- 托管层下发协议与刷新时机未展开：扩展点存在且为非动态，`[推断]` 由远端配置服务拉取并校验。
- `perClient` 状态在多客户端同时连接时的合并顺序由 17 的会话通道保证，本子系统未定义 `[推断]`。
- 方案文件"旧命名迁移"的判别条件未展开，`[推断]` 为按扩展名/前缀兼容读取而非整体重命名。
