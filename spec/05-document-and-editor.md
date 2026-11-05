# 05 — 文档模型与编辑器
> 范围：可编辑文本缓冲区（文档）与其视图（编辑器）的模型、修改与通知语义、撤销/重做、输入处理、渲染、大文件降级、多视图与可访问性。｜ 依赖：01、02、03、04 ｜ 排除：语法树与语言分析（06、08）、补全与导航（09）、界面布局与动作系统（13）、远端协议（17）。

## 1. 目的与范围
### 1.1 本子系统解决什么问题
"用户敲一个字符"必须同时满足七个互相冲突的要求：

| 要求 | 冲突面 | 答案 |
|---|---|---|
| 同步可见 | 解析、索引、后台分析争同一线程 | 键入路径只含"修改 + 通知 + 局部重算"，解析异步（01 §2.1） |
| 可撤销 | 一次用户意图常由数十次文本修改构成 | 以"命令"为撤销单元，流式合并为撤销组 |
| 可共享 / 可被观察 | 多编辑器同显同一文本 / 十几个子系统都要知道"何处变成了什么" | 文本只在文档中、编辑器只持视图状态 / 按优先级排序的变更通知，顺序可预测 |
| 可降级 / 可不落盘 | 超大文件仍要能打开编辑 / 未命名缓冲区、差异两侧、库内只读片段 | 四档大小阈值 + 纯文本模式 + 分页文档 / 文档独立于虚拟文件，绑定为可选 |
| 可拆分 | 文档与编辑器分处两端时语义不变 | 文本在服务端、视图状态在客户端（17） |
### 1.2 边界
不负责：文本的语法含义（06）、缺陷判定（08）、符号查找（09）；文件内容的物理读写与编码探测（04）；编辑器在界面中的摆放与动作绑定（13）；撤销历史的跨会话持久化——该能力不存在，撤销历史仅存活于会话内。

### 1.3 与其他子系统的关系

| 关系 | 内容 |
|---|---|
| 04 虚拟文件 | 文档是虚拟文件内容的可变投影，经绑定表双向同步（§4.4） |
| 06 语法树 / 08 守护分析 | 语法树以修改戳与修改序号为版本凭证（06 §4）；分析结果以"偏移 + 高亮层"回注编辑器（§4.7） |
| 03 运行时 | 修改必须持有写意图/写锁，通知在写线程上串行（03 §5） |
| 13 界面 | 动作以"编辑器 + 数据上下文"为输入，本子系统可重定向动作（§4.5） |
| 17 远端 | 文本属服务端状态，光标/选区/滚动属客户端状态（§4.7） |
## 2. 概念模型
### 2.1 三层实体

| 层 | 实体 | 生命周期 | 数量级 |
|---|---|---|---|
| 内容层 | **文档（Document）** | 首次解析起至最后一个强引用消失 | 每打开文件一个；项目级数十至数千 |
| 视图层 / 状态层 | **编辑器（Editor）** / 光标、选区、滚动、折叠、软换行、装饰、内联元件 | 标签页或分屏存在期 | 同一文档可有 0..N 个编辑器；状态每编辑器一套 |
**核心约束**：编辑器**必须不持有**文本的权威副本。文本只在文档中，编辑器通过快照读取。这一条决定了多视图一致性与远端拆分的可行性。

### 2.2 文档的双层结构
- **不可变文本快照（Text Snapshot）**：一经产生即不可变，任意线程可无锁读取，自带修改戳。
- **可变当前版本**：仅是"最新快照引用"。修改不是原地改写，而是以新快照替换当前引用。
- **编辑器本地镜像（Editor-local Mirror）**：编辑器可先在影子文档上落笔以消除输入延迟，再由最高优先级的同步器把差异提交给权威文档；提交失败时以权威文档为准回滚。

由此得到三个性质：读取免费（取一次引用即一致视图）、派生物可缓存（语法树/行索引/折叠树以"快照 + 戳"为键）、修改原子（对读者要么完全可见要么完全不可见）。

### 2.3 字符与行双索引
文档同时维护**字符偏移**与**行号**两套索引，且必须增量更新——否则大文件每次按键都是 O(n)：

| 查询 | 结果 | 复杂度要求 |
|---|---|---|
| 偏移 → 行号 | 所在行 | 对数级 |
| 行号 → 行首 / 行尾偏移 | 行首绝对偏移 / 不含分隔符的行尾 | 对数级 |
| 行号 → 分隔符长度 / 已修改标志 | 0、1 或 2 / 自上次保存后是否改动 | 常数级 |
**换行符策略**：文档内部只保存规范化后的行分隔符，每行保留自己的分隔符长度以便无损回写；替换文本中若含非规范分隔符，除声明"接受孤立回车"的文档外必须拒绝（§4.1 步骤 3）。

### 2.4 位置标记与守护区间
外部世界（光标、折叠、装饰、断点、内联元件）不得用裸偏移记录位置。所有"位置"都是**位置标记（Range Marker）**：绑定到文档区间、随修改自动伸缩的对象。

| 变体 | 语义 |
|---|---|
| 普通 / 持久位置标记 | 随插入或删除移动、扩张或收缩 / 在"整篇替换"后仍存活，用于跨重载保持位置 |
| 守护区间（Guarded Block） | 被标记为不可修改的区间 |
标记全部驻留于按区间组织的树中，支持"取出与 [a,b) 相交的全部标记"。这是每次修改后所有视图状态能同步更新的基础。

### 2.5 实体关系
`虚拟文件 --绑定--> 文档 --0..N--> 编辑器（光标集合 / 选区 / 折叠 / 软换行 / 内联元件 / 高亮与装饰 / 滚动）`；文档持有不可变快照、行索引、位置标记树，并向订阅方（语法树、折叠、软换行、光标、远端同步）广播变更。

## 3. 数据模型
```
Document {
  id: DocumentId                  // 会话内唯一
  text: SnapshotRef               // 当前不可变快照
  lineIndex: LineIndex
  writable: bool                  // 逻辑写权限，非文件系统权限
  modificationStamp: long         // 每次修改必须递增；可被外部显式设置
  modificationSequence: int       // 修改次数，仅内部比较用
  changeInProgress: bool          // 重入禁令标志（§4.2）
  inBulk: bool                    // 批量模式，布尔而非计数（§4.2）
  cyclicBufferSize: int           // 0 表示不截断
  markers: RangeMarkerTree
  listeners: ordered ListenerSet  // 按优先级排序（§4.2）
  binding: VirtualFileRef?        // 可空；未命名缓冲区无绑定
  persistence: in-memory only
}
Snapshot { content: immutable chars; length; stamp; textCache: soft ref; lineIndex: soft ref }
Editor   { id; document; clientId; carets: Caret[]; columnMode: bool; settings;
           folding / softWrap / inlay / markup / scrolling: ModelRef }
Caret    { offset; visualPosition: (line, column);  // 视觉位置受折叠与软换行影响
           selectionStart/End: int?; leanForward: bool;  // 软换行边界上的归属侧
           virtualSpaceOffset: int }
Selection{ ranges: (start,end)[]                    // 多段；不重叠、按起点有序
           blockStart/End: (line,col)? }
FoldRegion{ start/end; placeholder; expanded; neverExpands: bool;
            group: FoldingGroup?; gutterRenderer; custom: bool }
SoftWrap { atOffset; width; painter }
Inlay    { offset; relatesToPrecedingText: bool;
           placement: inline | block-above | after-line-end; renderer; priority; width }
```
| 字段 | 默认 | 约束 |
|---|---|---|
| `writable` | true | 置 false 后修改必须抛出可捕获的只读错误，不得静默丢弃 |
| `modificationStamp` | 创建时的单调时钟值 | 必须严格递增；显式设置时必须同时作废全部缓存 |
| `cyclicBufferSize` | 1024 KB（01 §8） | 超限从**头部**丢弃，等价于滑窗 |
| `inBulk` | false | 嵌套进入必须被拒绝而非累加 |
**内联元件的语义分组**是"哪类提示可关闭"的唯一粒度，不得按实现自由命名。已确认 11 类：代码视觉提示（新旧两套）、参数名、类型、值、注解、方法链、lambda、作者、URL 路径、其他。

### 3.1 撤销记录
```
UndoGroup { commandIds; name; actions: UndoableAction[]; 
            confirmationPolicy: default | ask | neverAsk;
            flushReason: enum?;              // 该组为何被封口（§4.3）
            transparent: bool; global: bool; valid: bool;
            stateBefore/stateAfter: EditorState? }   // 光标/选区/滚动
UndoableAction { kind: start-mark | finish-mark | mention-only | editor-change
                     | non-undoable | global | other;
                 affectedDocuments: DocumentRef[]; undo() / redo() }
EditorChangeAction { offset; moveOffset;           // 同一事件内的"移动"语义
                     oldFragment / newFragment: compressed bytes;
                     oldStamp; newStamp;
                     changeRange: mutable interval }  // 在组内的相对定位
```
**撤销栈组织**：不存在单一全局栈，而是**全局栈 + 每文档引用一个栈**的双层结构，可查询每个文档引用的栈深度。远端多客户端下每客户端持有本地栈快照，另有共享栈快照用于一致性同步。

## 4. 行为契约
### 4.1 修改路径
任何修改（插入/删除/替换/整篇替换/移动）必须经过同一条路径：

```
modify(start, end, replacement, moveOffset, newStamp):
 1 边界校验 0 ≤ start ≤ end ≤ length，否则拒绝；写权限校验（三重，见下）
 2 行分隔符校验：除声明"接受孤立回车"的文档外，必须使用规范分隔符
 3 守护区间校验：相交则抛出携带变更事件与守护区间的只读片段错误
 4 重入校验：changeInProgress → 抛出"在变更监听器中修改文档"错误
 5 剥除公共前后缀得到真正变化区间；区间为空且未声明整篇替换 → 不产生事件
 6 changeInProgress = true；构造变更事件（偏移、旧/新长度、旧/新片段、旧戳、
   整篇替换标志、移动目标）；递增修改序号；以新快照替换当前快照
 7 前向通知（逆优先级）+ 更新行索引 + 更新位置标记；后向通知（正优先级）
 8 若设循环缓冲且超限 → 从头部删除超额部分
 9 changeInProgress = false；重放监听器抛出的首个异常
```
**最小差异剥除是强制的，不是优化**：它决定位置标记的迁移范围、语法树的增量重建区间、撤销动作的大小。未剥除的实现会在一次大段粘贴时把所有标记推到文件末尾。**原子性**：把区间 A 搬到位置 B 必须表达为**单个事件**（携带移动目标偏移），而不是"先插入再删除"；否则位置标记被撕裂、语法树重建两次、撤销需要两步。

**只读的三重判定**（不可写当且仅当满足任一）：① 逻辑只读标志可运行时切换，切换必须产生可写性变更事件；② 写权限守卫链中任一守卫返回失败即拒绝，须给出门禁标识与失败原因（非项目文件 / 受版本控制保护 / 被外部工具持有）；③ 修改区间与任一守护区间相交。三者**必须**分别可诊断，不得合并为"不能修改"这一模糊提示。

### 4.2 变更通知
监听器注册进**按优先级排序的写时复制数组**；优先级为整数，越小越"底层"。

| 订阅者 | 优先级 | 理由 |
|---|---|---|
| 外部同步（镜像 ↔ 权威） | 最小整数 + 1 | 必须最先看到变更才能保证一致 |
| 折叠模型 / 逻辑位置缓存 / 文本布局缓存 | 60 / 65 / 70 | 折叠依赖行索引；位置与字形缓存供软换行使用 |
| 软换行模型 / 编辑器尺寸管理 | 100 / 110 | 依赖布局宽度 / 依赖软换行的总高度 |
| 光标集合 | 120 | 依赖折叠与软换行，且需迁移标记 |
| 内联元件模型 / 自定义折行模型 | 150 / 155 | 元件可能被折进折叠区 / 最外层需要全部前置状态 |
**顺序不变量**：`beforeChange` 按优先级**降序**投递（最外层先收到）；`afterChange` 按**升序**投递（最底层先收到）。这不是风格而是**洋葱模型**——每一层在自己的前后两个回调之间看到一致的内外状态。

| 投递保证 | 内容 |
|---|---|
| 串行 / 快照式迭代 | 同一文档的通知在写线程串行；通知开始时取一次数组快照，回调中的增删不影响本次投递 |
| 不可取消 | 通知区间不响应取消，避免半通知状态 |
| 独立容错 | 单个监听器抛错必须被捕获并延迟，其余仍收到通知；全部投递后重放首个错误 |
| 注册/注销严格 | 重复注册必须报错，不得静默去重；移除未注册者必须报错并列出当前集合 |
**批量更新**（一次"格式化整个文件"产生数千条事件，逐条通知的代价是每次重算布局）：
```
enterBulk(): 拒绝已处于批量（嵌套非法）；拒绝"在批量状态通知中改批量状态"；
             记录进入时的调用栈（泄漏诊断）；置 inBulk；逆优先级通知 bulkStarting
exitBulk():  置 inBulk = false；正优先级通知 bulkFinished；订阅方在此一次性全量重算
```
批量模式**是布尔而非计数**：嵌套进入必须被拒绝，否则内外层各自"结束"会让重算提前。它必须在 `try/finally` 语义下退出，异常路径未退出必须被诊断系统识别（进入栈保留）。批量期间的修改**不合并**为单条事件，仍逐条产生，只是订阅方被允许延迟反应；期间**必须禁用**光标视觉位置更新、内联元件逐条重排、以及需要逐行处理的修整（行数超过阈值 1000 时整体跳过）。

**重入禁令**：在任何 `beforeChange` / `afterChange` 回调中修改同一文档必须被判定为编程错误并抛出，不得静默递归——递归修改会使事件嵌套、位置标记树不一致、撤销组边界无法确定。替代路径：排队到当前命令结束之后、或以新命令执行、或使用批量/抑制标志。**异常隔离**：监听器异常按优先级顺序收集、全部投递后重放第一个，且必须携带"是哪个监听器"；对只读文档的写入尝试必须走独立通知路径，因为调用方通常是动作处理器，需据此转为"另存为/解除只读"提示。

### 4.3 撤销与重做
**命令单元**：用户意图的单位是**命令（Command）**。一个命令期间产生的全部文档修改必须收拢为一个**撤销组**；命令之外的文档修改必须被拒绝（除非处于"撤销透明动作"中）。合并是流式的：命令不断到达，合并器决定"与当前未封口的组合并"还是"封口并另起一组"。

**合并规则（封口条件）**——当前组与下一条命令**必须封口**当且仅当满足任一条：

| 条件 | 含义 |
|---|---|
| 命令标识不同 | 两条不同命令不得合并 |
| 显式分组标识变化 | 同一命令内可主动声明分组边界（如批量重命名内的每个文件） |
| 当前组或下一条为"强制全局"且不允许全局合并 | 跨文件命令默认独立成组 |
| 透明性不一致且编辑器状态缺失；或两者均透明但受影响文档集合不同 | 见下段；透明组只对单文档有意义 |
| 清空栈 / 清空队列 / 强制刷新 | 管理性封口 |
反之，同命令、同分组标识、同为透明且文档集合相同时**必须不**封口。**封口原因必须被记录**并进入诊断输出——这是"为什么两次编辑变成两步撤销"的唯一可排查依据。

**透明命令**是"不应出现在撤销栈中"的命令：纯导航、纯折叠、纯滚动、后台建议的临时插入。其动作仍存在，但组被标记为**临时**，不进入可撤销序列；透明命令与"有编辑器状态前后快照"的命令**不得**合并，一旦透明组缺少前置或后置状态快照必须立刻封口；透明动作可以修改文档，但修改必须被"提及"（marker 动作），以便同一命令序列内的普通编辑仍能正确回退到它之前。

**批量动作作为单一撤销单元**："批量替换 500 处"必须表现为**一个**撤销组，即使它修改多个文档、产生数千条局部变更：组的影响集合等于内部全部动作所影响文档的并集；组内动作条数超过阈值（量级 50）必须转入批量处理路径；撤销按动作**逆序**、重做按正序执行；组内"起始标记"与"结束标记"配对数不等时，撤销/重做边界按"多出的一侧"裁决（撤销侧多一个结束标记 → 该组在撤销边界内），而非按动作数判断。

**栈上限与内存**：

| 项 | 契约 |
|---|---|
| 栈粒度 / 上限 | 全局栈 + 每文档引用栈；按**条目数**而非字节数限制，超限从最旧条目淘汰 `[推断]` |
| 条目载荷 / 编辑器状态 | 每条变更只存"偏移 + 压缩后的新旧片段 + 新旧戳"，**不存全文**；每命令最多两份编辑器状态（前/后），仅含光标、选区、滚动 |
| 失效 | 组影响的文档被整篇替换 → 组置为无效；撤销到无效组必须给出明确报告而非崩溃 |
| 会话外 / 远端 | 撤销历史**不持久化**；每客户端持本地栈快照，另有共享栈快照用于跨端一致性 |
"撤销不可用 / 撤销失败"必须是可呈现状态而非异常穿透：存在"无法撤销"报告与"撤销历史导出"诊断入口。**确认策略**三态：默认（全局命令即跨多个物理文件时**应当**请求确认，单文件不请求）、请求确认、不请求确认。**状态还原**：撤销组可携带命令前后的编辑器状态（编辑器标识、光标、选区、滚动）；撤销时若"撤销前"状态存在且编辑器仍存活必须恢复，缺失必须静默跳过而不得使撤销失败，远端场景按客户端隔离。

### 4.4 文档与虚拟文件的双向同步
**绑定表**是键为虚拟文件、值为文档的**弱值映射**：条目可由"强制持有"标记覆盖为强引用；绑定/解绑必须产生绑定变更事件供标签页、语法树、版本控制订阅；同一虚拟文件任一时刻至多一个文档，同一文档至多绑一个物理文件（非物理文件可硬绑定，物理文件不允许硬编码关联）；缓存清理必须能被显式触发。

```
save(document):      未绑定文件 → 转"另存为"；询问否决链（任一否决即放弃并报原因）；
                     不在未保存集合 → 判定无需保存；写锁下取快照 → 按编码与行分隔符序列化 → 写入；
                     成功记录磁盘时间戳、清除行修改标志、移出未保存集合；失败保留未保存状态且不清标志
externalChange(file):无绑定文档 → 忽略；文档不脏 → 以磁盘内容整篇替换快照（产生整篇替换事件）；
                     文档脏 → 进入冲突流程
```
是否需要落盘的判定必须比较"文档修改戳与上次保存戳"，并辅以磁盘时间戳比对；仅比较长度或内容哈希在大文件上不可接受。

**冲突即"内存与磁盘不一致"**，呈现方式：将文件加入**冲突集合**并记录冲突发生时的调用栈（诊断"谁触发的"）；呈现**二方差异视图**（左：内存当前内容；右：磁盘新内容），提供"以磁盘为准 / 以内存为准 / 逐块合并"；未解决前编辑器继续显示内存内容（不丢失正在编辑的文本），但标签页必须显示冲突标记；必须允许"解决器覆盖"，外部集成可声明自己的冲突处理策略并优先于默认策略。

**否决机制**：保存与重载各自存在否决链。保存前返回"不可保存"即放弃（文件被另一进程锁定、只读挂载、不允许导出）；重载前返回"不可重载"即保留内存版本（调试会话进行中、二进制内容不可解码）。否决必须在动作前发生，且支持把"不可重载"标记永久绑定到文档上，避免每次重载都询问。

### 4.5 输入处理
**键入处理器链**：
```
keyTyped(char): 自动弹出检查 → 新键入批次开始通知（用于合并连续键入的撤销组与配对状态）
 → 前置处理：按注册顺序逐条询问是否接管（STOP / CONTINUE / DEFAULT），任一条 STOP 即消费字符
 → 若有选区先通知"选区即将被移除"（可被接管，例如用括号包裹选区）
 → 默认处理：开启自动配对且字符是开放符号则插入配对并回退光标，否则普通插入
 → 后置处理：逐条询问是否追加处理（自动插入分号、触发模板展开）
 → 立即重绘判定：处理器可声明"本字符禁止立即绘制"（等待后续合并）
```
契约：处理器不得假定自己一定被调用（上游 STOP 后不再执行）；必须声明顺序依赖（注册顺序即执行顺序）；**不得**在返回 CONTINUE 的同时修改文档——要修改必须返回 STOP 或走"选区移除前"钩子。

**回车代理**——回车不只插入换行，它要处理智能缩进、括号内换行、注释延续、字符串拼接、模板占位：
```
enter(): 是否"在缩进内"（块注释、多行字符串）→ 交由专用处理器
 → 预处理链：每条可改写插入位置与光标额外前进量，返回
   Default | Continue | DefaultForceIndent | DefaultSkipIndent | Stop
 → 全部 Continue 则插入换行 + 智能缩进；插入后交后处理链（自动补全闭合符号、重排 else 等）
```
**智能缩进**：缩进量必须由"行首上下文"计算而非"复制上一行"——取当前行之前最近的有效结构（括号深度、块开启、标签开启）；制表符与空格混用时按项目配置统一；结果必须可被用户配置覆盖（缩进宽度、是否使用制表符、是否保留续行缩进）。

**退格代理**：有选区则删除选区（不进入代理）；否则先通知"即将删除字符 c"，再逐条询问代理是否已处理；未处理时走默认——先尝试删除一个缩进层级（光标前为纯空白且达到缩进宽度），否则删除一个字符（考虑代理对与组合字符，不得切裂）；删除后通知"已删除字符 c"（用于自动移除配对符号）。必须处理：缩进层级删除、配对符号联动删除、软换行边界上的删除、折叠区域边界上的删除。

**粘贴**：单行纯文本直接插入、不得引入换行；多行纯文本必须按目标上下文重排缩进（可选保留原缩进相对量）；富文本必须优先取纯文本形态，仅显式"粘贴为富文本"时保留样式；大段文本超过阈值必须转为单条批量修改（一个撤销组）；复制自同一编辑器时必须能识别来源以保留缩进策略与智能修正；空选区复制存在专门模式（复制整行 vs 复制空串）。

**输入法组字**是唯一允许绕过逐字符键入路径的输入源：组字进行中必须以"临时内联元件"呈现候选串而**不得**修改文档；提交时一次性以"替换临时区间"写入，产生**单条**变更事件；组字期间不得触发自动配对、不得触发补全弹窗、不得把组字字符送入键入链；必须在界面线程处理，回调落在其他线程时必须转投递而非直接修改；远端场景下组字属客户端状态，中间候选串不得同步给服务端。

**自动配对与代码块补全**：配对由独立扩展点提供且可整体禁用；配对插入必须产生单条变更事件（"插入开符号 + 插入闭符号 + 光标回退"合为一个原子视觉结果）；关闭符号键入在"右侧紧跟同一关闭符号且该符号由配对产生"时必须只越过而不重复插入；配对识别粒度支持"词级"扩展点使各语言自定义"单词"；代码块补全必须可被单次撤销回退且不得跨行破坏已有缩进。

### 4.6 光标与选区

| 操作 | 契约 |
|---|---|
| 追加光标 / 合并 / 主光标 / 物理 vs 视觉 | 上限由配置控制（下限 1），达上限后拒绝追加并给出限频提示（同类间隔量级 10 秒）；两光标同偏移必须合并；主光标始终唯一；软换行与折叠下物理位置与视觉位置不同——键盘移动按**视觉**位置，文本操作用**偏移** |
| 矩形 / 多段选区 | 矩形由对角两点的逻辑行列描述并展开为多段选区，退出列模式必须清除虚拟选区部分；段不重叠且按起点有序，重叠时以"后者覆盖前者"合并 |
| 词选择扩展 | 双击/多次点击的扩展粒度可被语言扩展接管 |
光标**必须**通过位置标记跟踪文本变化，而非每次修改时由外部重算；只有"整篇替换"这类极端事件才需显式缓存与恢复光标状态。

### 4.7 视图模型与渲染
**折叠**：结构性折叠区域的增删必须在批量折叠处理区间内完成，否则拒绝（避免"边算边改"导致折叠树与文档不同步）；区域之间不得重叠，重叠添加必须被拒绝而非静默裁剪；同组区域同开同合；不可展开区域必须被拒绝展开而非"展开后立刻收缩"；跨修改后必须重新校验，越界或被破坏的区域必须被移除而非保留为无效状态；自定义折叠区域由渲染器绘制任意内容，其内容不参与文本布局。

**软换行**：折行位置由排版引擎按可视宽度计算，与字符数无关；结果必须缓存，键包含"文档修改戳 + 视口宽度 + 字体度量版本"；重算必须可限定在受影响区间（滚动到远处不应触发全文重排）；折行改变后所有视觉行列缓存失效而逻辑偏移不变；光标在折行边界上的归属必须显式记录，否则方向键行为不确定。

**缩进参考线**由行首缩进与结构层级计算，属**装饰**而非文本，必须随折叠与软换行同步重算。**装饰**分区间装饰（背景、边框、下划线、删除线、波浪线、自定义绘制）、边栏装饰（图标、点击区、活动指示）、行级装饰（行背景、行边框），全部必须通过位置标记绑定并随文本迁移；装饰的**持久化形态**（可存盘，用于版本控制注解、书签）与会话内形态（文档关闭即消失）必须区分。

**内联元件（Inlay）**：增删必须在其模型的监听器通知之后才进入布局，避免"元件已绘制但模型已移除"；块状元件参与行高计算、行内元件参与列宽计算；宽度在布局期实测并回写，变化必须触发行高或列宽重算；必须可按语义分组整体关闭。**代码视觉提示**以"区间 + 条目"贡献、由绘制器在行上方绘制，提供者必须声明相对排序与"每行是否单条"，重算以编辑器为粒度显式触发而非每次键入。**悬浮与内嵌组件**：悬浮组件（文档弹窗、提示气泡）不得阻塞键入、不得持有编辑器的强引用、必须在编辑器释放时关闭；内嵌的完整组件（表单、表格、预览）作为块状元件参与布局，尺寸变化必须触发重排，其内容不得进入文本流。

**惰性布局**：不为整个文档计算字形与行盒，只对"视口 + 前后缓冲行"布局；滚动、折行、尺寸变化均按需触发。**可见区优先**：绘制顺序必须保证当前视口内可见行先完成，其余在空闲时补齐；任何"先全文布局再绘制"的实现在大文件上都会产生可感知卡顿。**行高缓存**：以"逻辑行号 + 折行序号"为键缓存行盒（含高度与列宽映射），键必须包含字体度量版本与内联元件宽度版本，缓存为软引用可回收重建。

**滚动与可视区**：视口以"可视行区间"为第一等公民，字符偏移与逻辑行都是派生；光标移动导致的滚动必须保证光标完整可见（含所在行与行内元件宽度）；编程式滚动可被"光标锚定"策略修正、用户滚动不得被修正；滚动动画必须可关闭，关闭时立即到位；视口尺寸变化必须触发折行重算但必须节流（量级 200 ms）。

**高亮分层**：每层有独立提供者、独立失效粒度与独立可见性开关。

| 层 | 语义 | 失效触发 |
|---|---|---|
| 语法层 / 注入层 | 词法着色 / 内嵌语言片段（模板、字符串内 SQL）着色 | 文本变更（局部）/ 宿主片段变更 |
| 语义层 | 解析后的符号着色 | 语法树重建 |
| 搜索层 / 分析层 | 查找替换命中 / 检查结果、警告与错误 | 查询变化 / 守护分析完成 |
| 视觉提示层 | 代码视觉提示 | 显式重算请求 |
**重叠优先级**：分析层 > 搜索层 > 语义层 > 注入层 > 语法层——越靠近用户当前问题的层越应可见。**零延迟渲染**允许键入后先以"预测性绘制"呈现字符、待真实布局完成后校正；该路径必须可关闭，且关闭后行为与开启时语义一致（仅为延迟差异）。

### 4.8 多视图、差异视图与可访问性
**多视图**：

| 形态 | 契约 |
|---|---|
| 同一文档多编辑器 | 文本共享；光标、选区、滚动、折叠、软换行、装饰**各自独立**，一个编辑器的折叠不得影响另一个 |
| 分离/移动标签 / 只读预览 | 编辑器对象可跨容器迁移且必须保持视图状态（光标、选区、滚动、折叠）/ 处于只读预览角色时写被拒绝，但导航、搜索、折叠、复制可用 |
| 二方差异视图 | 两侧各为一个编辑器，绑定不同文档或同一文档的两个快照；差异块由差异链路计算并以装饰呈现，**不得修改**两侧文本 |
| 三方差异视图 | 左/右两侧 + 中间结果区；中间区可编辑、两侧只读；合并操作以"采纳某侧"为原子命令 |
| 统一差异形态 | 单编辑器内以装饰表达增删行；行号映射必须与文本保持一致 |
差异视图必须只通过装饰与行号映射表达差异，不得插入/删除文本；因此每一侧都被完整当作普通文档对待（可被折叠、软换行、内联元件影响），差异引擎必须容错这些视图变换。远端多客户端下编辑器以（编辑器标识、文档引用、客户端标识）三元组寻址，每客户端各自持有视图状态与本地撤销栈。

**可访问性**：

| 维度 | 契约 |
|---|---|
| 屏幕阅读器语义 | 必须提供"行级语义单元"：当前行文本、行号、该行边栏标记及其动作与快捷键；光标移动必须产生可播报的语义事件，而非逐字符噪声 |
| 光标适配层 | 必须向无障碍层暴露一个符合文本组件约定的光标视图（位置、选区可见性、闪烁率），使外部辅助技术无需理解内部光标模型 |
| 键盘可达 | 一切鼠标可达能力必须有键盘路径：边栏标记、折叠、内联元件、悬浮内容、编辑器通知条 |
| 字号缩放 | 字号与行距可独立于系统缩放调整，且**不得**改变行列语义（缩放不改变偏移与行号）；缩放必须触发字形缓存与行高缓存失效 |
| 高对比模式 | 装饰与高亮层必须提供可辨识的替代表现（线型、纹理），而非仅依赖颜色 |
## 5. 不变量与约束

| 编号 | 不变量 |
|---|---|
| INV-1 | 任一文本快照一经产生即不可变；当前快照只被整体替换。 |
| INV-2 | 每次修改后修改戳必须严格大于修改前的值。 |
| INV-3 | 行索引必须始终与当前快照一致：行数 ≥ 1，且末行行尾偏移等于文本长度。 |
| INV-4 | 变更事件必须满足"新文本长度 − 旧文本长度 = 净变化量"。 |
| INV-5 | `beforeChange` 按优先级降序投递，`afterChange` 按优先级升序投递。 |
| INV-6 | 任一监听器抛错不得阻止其余监听器收到同一次通知。 |
| INV-7 | 在变更通知期间修改同一文档必须被拒绝。 |
| INV-8 | 批量更新不得嵌套；批量状态不得由批量状态监听器修改。 |
| INV-9 | 命令之外的文档修改必须被拒绝，除非处于撤销透明动作中。 |
| INV-10 | 撤销组影响的文档集合等于其内部全部动作所影响文档的并集。 |
| INV-11 | 撤销组的有效性必须随其任一受影响文档的整篇替换而失效。 |
| INV-12 | 同一虚拟文件任一时刻至多绑定一个文档；同一物理文件不得硬编码绑定。 |
| INV-13 | 位置标记必须随修改自动迁移；不得存在指向越界偏移的存活标记。 |
| INV-14 | 折叠区域之间不得重叠；跨修改被破坏的区域必须被移除。 |
| INV-15 | 布局缓存键必须包含字体度量版本，字体变化必须使布局失效。 |
| INV-16 | 内联元件宽度变化必须触发行高或列宽重算，不得只重绘。 |
| INV-17 | 组字期间不得修改文档，提交时必须为单条变更事件。 |
| INV-18 | 达到光标数上限后追加光标必须被拒绝，且不得进入不一致的多光标状态。 |
| INV-19 | 差异视图不得修改任何一侧的文本；差异只以装饰与行号映射表达。 |
## 6. 对外能力契约
```
createDocument(initialText, writable) -> Document; snapshot(document) -> TextSnapshot
modify(document, start, end, replacement) -> ChangeEvent
moveText(document, fromStart, fromEnd, toOffset) -> ChangeEvent    // 单事件
beginBulk(document) / endBulk(document); setWritable(document, bool)
addGuard(document, start, end) -> GuardHandle
subscribe(document, priority, listener) -> Unsubscriber
version(document) -> (stamp, sequence); offsetToLine(document, offset) -> line
lineToOffset(document, line) -> (start, end, separatorLength)
isLineModified(document, line) -> bool
createMarker(document, start, end, surviveFullReplace) -> Marker
openEditor(document, clientId) -> Editor            // 同一文档可多次调用
getViewState(editor) -> ViewState                   // 光标/选区/滚动/折叠/折行
restoreViewState(editor, ViewState) -> bool; modifyView(editor, transaction) -> void
executeCommand(scope, name, body, opts) -> CommandResult
executeTransparent(scope, name, body) -> CommandResult
undo(documentRef) / redo(documentRef) -> MovementResult
stackDepth(documentRef) -> (undoSize, redoSize)
bind(document, virtualFile); save(document, explicit) -> SaveResult
reload(document) -> ReloadResult; isUnsaved(document) -> bool
```
要求：所有读取能力必须可在**无界面角色**下使用，渲染相关能力在无界面角色下必须返回"不可用"而非失败；`modify` 必须被命令包裹，未包裹时必须显式报错而非隐式开匿名命令；`openEditor` 必须允许 0 个编辑器存在（文档可先于编辑器创建）；`stackDepth` 必须按文档引用查询，只提供全局数字无法回答"这个文件能撤几步"。

## 7. 故障模式与降级

| 故障 | 检测 | 用户可见 | 档位与路径 |
|---|---|---|---|
| 超大文件（超智能上限 / 超可打开上限） | 打开前按扩展名与大小四档判定 | 提示"已以纯文本模式打开" / "文件过大，无法完整加载" | D1：关闭语义能力保留编辑查找 / 仅加载前缀预览且编辑禁用 |
| 内存与磁盘冲突 | 外部内容变更 + 文档脏 | 冲突标记 + 二方差异视图 | D0：用户裁决 |
| 保存被否决 / 重载被否决 | 否决链返回否定 | 明确原因 / 保留内存版本 | D1 / D0 |
| 文档只读 | 三重判定之一 | 编辑被拒 + 具体原因 | D1：编辑禁用，导航保留 |
| 撤销组失效 | 组有效性标志 | "无法撤销"报告 | D1：跳过并说明 |
| 撤销/重做动作抛错 / 监听器异常 | 执行期或通知期捕获 | 报告 + 历史导出入口 / 内部错误记录 | D2：本子系统降级或跳过该订阅者 |
| 批量模式未退出 | 进入栈保留 | 内存与响应性下降 | D3：诊断快照，需重启 |
| 循环缓冲截断 | 长度超缓冲上限 | 顶部内容消失 | D1：文档变滑窗，保存须提示仅保存窗口内内容 `[推断]` |
| 镜像与权威不一致 | 同步器断言失败 | 编辑器回滚到权威内容 | D2：该编辑器重建 |
| 组字期间连接中断 | 连接状态 | 候选串保留在客户端 | D4：仅重连后提交 |
## 8. 资源与性能预算
### 8.1 大文件四档阈值（可按扩展名覆盖）
覆盖表以"扩展名 → 四元阈值"缓存，并带指纹用于失效。

| 档 | 语义 | 阈值（默认，实测配置） |
|---|---|---|
| 内容加载上限 / 智能能力上限 | 超过即不加载全文只加载预览前缀 / 超过即关闭语法、语义、检查、补全 | 20 MB / 2.5 MB |
| 预览上限 / 编码探测上限 | 超内容加载上限时实际读取的字节数 / 超过即不自动探测编码 | 更小的独立阈值 `[推断]` / 独立阈值 `[推断]` |
**纯文本模式必须禁用**：语法高亮（全部层）、语法树构建、桩与索引、检查与快速修复、补全、内联提示、代码视觉提示、结构性折叠、缩进参考线、结构视图、符号导航、重构。**必须保留**：文本显示、基本编辑、撤销/重做、查找替换（含正则）、行号、软换行开关、复制粘贴、保存。

**分页文档**：超可打开上限时文档以"页"表示（每页有页码与是否末页），偏移与绝对符号位置互换算；滚动条为全局虚拟滚动条、局部为不可见滚动条。该形态下"文档长度"不是单一数值，任何按全文操作的接口必须拒绝。

### 8.2 数量级预算

| 项 | 预算 |
|---|---|
| 单次键入处理 | 只含"修改 + 通知 + 局部重算"，不含解析；量级亚毫秒 `[推断]` |
| 订阅者数 / 标记与折叠数 | 数十（平台内建 + 插件）/ 与可见装饰、折叠、内联元件线性，量级 10³ |
| 内联元件分组 / 循环缓冲 | 11 类语义分组，每类可整体关闭 / 1024 KB（实测默认） |
| 撤销条目载荷 / 组内批量阈值 | 压缩后的新旧片段（字节至 KB）/ 50 |
| 全量修整行数阈值 / 视口宽度节流 / 光标上限提示间隔 | 1000 行 / 量级 200 ms / 10 秒 |
| 常驻内存 | 依赖快照弱引用与缓存淘汰；默认堆上限 2 GB（01 §8） |
**内存驻留策略**：快照的字符串化结果、行索引、字形排布缓存全部为软引用，可回收重建；文档与虚拟文件的绑定为弱值，只有显式"强制持有"的文档是强引用；滚动出视口的行不得保留强引用的布局对象。

## 9. 可观测性

| 问题 | 观测入口 |
|---|---|
| 谁改了文档？为什么两次编辑变成两步撤销？ | 变更事件含偏移、增减长度、旧戳（调试级别可记录调用栈）；撤销组的封口原因 + 命令标识 + 分组标识 |
| 这个文件能撤几步 / 撤销为何不可用 / 批量模式是否泄漏？ | 每文档引用的栈深度；组有效性 + 失效原因（哪个文档被整篇替换）；批量进入栈 + 进入时间 + 当前是否仍为批量 |
| 为什么这个文件不能改？ | 只读三重判定命中的具体一条 + 门禁标识 + 失败原因 |
| 冲突是谁触发的？ | 冲突出现时的调用栈 + 冲突集合 |
| 为什么没有智能能力？ | 四档阈值命中的是哪一档 + 命中的扩展名覆盖规则 |
| 为什么按键感觉慢 / 内联提示为何不显示？ | 键入路径分段耗时（前置处理、修改、通知、重算、绘制）；内联提示的分组开关状态 + 该分组元件数 + 是否被折叠或软换行遮挡 |
**可复现问题的最小状态**：文档标识、修改戳、变更事件、订阅者优先级快照、批量状态、只读判定结果、撤销组封口原因。**诊断入口**：撤销历史导出、撤销栈快照导出、编辑器状态导出（光标/选区/折叠/折行）、订阅者列表快照。

## 10. 扩展点
注册数口径为"模块描述符 + 插件描述符"合计（见 `_rev/ep_counts.json`）。

| 接缝 | 注册数 | 必须遵守 | 失败隔离 |
|---|---|---|---|
| 动作处理器 / 编辑器工厂监听 | 260 / 46 | 声明适用条件、不得在无写意图时改文档 / 释放时必须反向清理、不得强引用编辑器 | 该动作不可用，其余正常 / 跳过该监听器 |
| 键入处理器 / 原始键入处理器 | 102 / 4 | 返回明确三态；接管时须自行完成全部修改 | 该字符走默认路径 |
| 回车代理 / 退格代理 | 62 / 33 | 返回五态之一、不得跳过缩进计算 / 成对声明"删除前、删除后" | 走默认回车 / 默认退格 |
| 词选择扩展 | 128 | 对任意偏移返回确定结果 | 退化为空白分隔 |
| 折叠构建 / 自定义折叠 / 折叠选项 | 61 / 7 / 12 | 不得重叠；必须在批量折叠区间内提交 | 该语言折叠整体不生效 / 该自定义折叠消失 |
| 内联元件提供者（命令式 / 声明式） / 代码视觉提示绘制 | 22 / 25 / 24 | 必须按语义分组归类、可被整体关闭 / 声明相对排序与每行是否单条 | 该提供者元件全部消失 / 该提供者不绘制 |
| 编辑器通知条 / 小地图层 | 103 / 27 | 可被用户永久关闭、不得阻塞编辑 / 缩略比例下仍可辨、不得访问全文 | 该提示条消失 / 该层不绘制 |
| 文档写权限守卫 / 同步否决 | 2 / 11 | 必须给出原因、无副作用 / 不得触发嵌套保存 | 视为允许并记录 / 视为不否决 |
| 行绘制 / 文件大小检查 / 自动配对 | 声明存在、无注册（前两项）/ 4 | 只绘制不修改、返回完整四元阈值、可整体禁用且不改变已插入文本 | 该绘制器跳过 / 用默认阈值 / 该能力不生效 |
**通用契约**：任何接缝都**不得**在同一文档的变更通知中注册或注销自身（会破坏投递快照的一致语义）；需要动态增减时必须在命令边界之后进行。

## 11. 对照实现（证据锚点）

| 上文结论 | 证据锚点 |
|---|---|
| 不可变快照 + 可变当前版本 + 冻结只读视图 | `intellij.platform.core.impl` → `openapi/editor/impl/DocumentImpl`（`myText`、`myFrozen`）、`FrozenDocument` |
| 剥除最小差异后替换；移动为单事件；行索引增量更新与行修改标志 | `DocumentImpl.replaceString` 的公共前后缀剥除；`moveText` / `moveOffset`；`changedUpdate`（`LineSet.update(...)`）、`isLineModified` |
| 修改戳与修改序号双计数；循环缓冲头部截断 | `myModificationStamp`、`sequence` / `getModificationSequence`、`setCyclicBufferSize` + `trimToSize` |
| 重入禁令 / 必须在命令内修改 | `assertNotNestedModification`（"Detected document modification from DocumentListener"）、`assertInsideCommand` |
| 只读三重判定与只读片段错误 | `assertWriteAccess`（`myIsReadOnly` + `DocumentWriteAccessGuard` 扩展链 + `getRangeGuard`）、`throwGuardedFragment` / `ReadOnlyFragmentModificationException` |
| 前向逆序、后向正序；按优先级排序的写时复制数组 | `beforeChangedUpdate`（倒序）、`changedUpdate`（正序）、`LockFreeCOWSortedArray(PrioritizedDocumentListener.COMPARATOR, …)` |
| 优先级阶梯 60/65/70/100/110/120/150/155 与外部同步最小值 | `FoldingModelImpl` 60、`LogicalPositionCache` 65、`TextLayoutCache` 70、`LegacySoftWrapModelImpl` 100、`EditorSizeManager` 110、`CaretModelImpl` 120、`InlayModelImpl` 150、`CustomWrapModelImpl` 155、`ElfDocumentSync`/`AdDocumentSynchronizer` = 最小整数+1 |
| 监听器异常延迟收集后重放；批量模式为布尔、禁嵌套、记录进入栈、修整阈值 1000 | `DocumentImpl` 的 `DelayedExceptions` / `rethrowPCE`；`setInBulkUpdate`、`myBulkUpdateEnteringTrace`、`UnexpectedBulkUpdateStateException`、`STRIP_TRAILING_SPACES_BULK_MODE_LINES_LIMIT` |
| 撤销组字段全貌；组内批量阈值 50；透明组即临时组；标记配对裁决边界 | `intellij.platform.ide.impl` → `openapi/command/impl/UndoableGroup`（`BULK_MODE_ACTION_THRESHOLD`、`isTemporary = isTransparent`、`isInsideStartFinishGroup`） |
| 确认策略三态 + 全局默认请求确认 | `UndoConfirmationPolicy` + `UndoableGroup.shouldAskConfirmation` |
| 封口原因枚举；动作类型七态（含提及型、非可撤销型） | `CommandMergerFlushReason`（`INCOMPATIBLE_COMMAND`、`CHANGED_GROUP`、`GLOBAL`、`TRANSPARENT_WITH_DIFFERENT_DOCS`、`NEXT_TRANSPARENT_WITHOUT_EDITOR_STATE_AFTER`、`CURRENT_TRANSPARENT_WITHOUT_EDITOR_STATE_BEFORE`、`CLEAR_STACKS`、`CLEAR_QUEUE`、`GET_LAST_GROUP`、`MANAGER_FORCE`、`UNDO`、`REDO`）；`UndoableActionType`（`START_MARK`/`FINISH_MARK`/`MENTION_ONLY`/`EDITOR_CHANGE`/`NON_UNDOABLE`/`GLOBAL`/`OTHER`） |
| 变更动作存压缩后的新旧片段与新旧戳 | `EditorChangeAction`（`CompressionUtil.compressStringRawBytes`、`myOldTimeStamp`/`myNewTimeStamp`、`myMoveOffset`） |
| 全局栈 + 每文档栈双层；深度可查询；远端本地/共享快照；撤销不可用报告 | `UndoRedoStacksHolder`、`UndoRedoList`/`UndoRedoSet`、`UndoRedoStackSize`、`PerClientLocalUndoRedoSnapshot`、`SharedUndoRedoSnapshot`、`UndoProblemReport`、`CannotUndoReportDialog`、`UndoSpy`、`UndoDumpHistoryAction` |
| 绑定表为弱值映射 + 强制持有键 + 硬绑定禁令 | `FileDocumentManagerBase`（`createConcurrentWeakValueMap`、`HARD_REF_TO_DOCUMENT_KEY`、`fireFileBindingChanged`、`registerDocument` 抛 `IllegalArgumentException`） |
| 大文件以部分预览形态存在；四档阈值 + 按扩展名覆盖 + 指纹 | `FileDocumentManagerBase.isPartialPreviewOfALargeFile`、`BIG_FILE_PREVIEW`、`getPreviewCharCount`；`openapi/vfs/limits/FileSizeLimit`（`getContentLoadLimit`/`getIntellisenseLimit`/`getPreviewLimit`/`getEncodingDetectionLimit`/`getFingerprint`） |
| 保存/重载各自否决；冲突以二方差异视图解决；保存判定比对戳 | `FileDocumentSynchronizationVetoer`（`maySaveDocument`/`mayReloadFileContent`）、`MemoryDiskConflictResolver`（`myConflicts` + `SimpleDiffRequest` + `ConflictsSolverOverride`）、`FileDocumentManagerImpl.isSaveNeeded`、`myUnsavedDocuments`、`NOT_RELOADABLE_DOCUMENT_KEY` |
| 键入处理器三态与钩子；回车五态；退格成对 | `TypedHandlerDelegate`（`STOP/CONTINUE/DEFAULT`、`beforeCharTyped`/`charTyped`/`beforeClosingParenInserted`/`beforeClosingQuoteInserted`/`beforeSelectionRemoved`）、`EnterHandlerDelegate`（含 `invokeInsideIndent`/`preprocessEnter`/`postProcessEnter`）、`BackspaceHandlerDelegate` |
| 折叠必须批量处理；折叠组/不可展/自定义折叠 | `FoldingModelImpl.createFoldRegion` 的 `myIsBatchFoldingProcessing` 断言、`FoldingGroup`、`neverExpands`、`addCustomLinesFolding` |
| 软换行绘制器与变更通知 | `SoftWrapModelEx`（`getSoftWrapIndex`/`addSoftWrapChangeListener`/`isRespectAdditionalColumns`）、`SoftWrapChangeNotifier`、`SoftWrapsStorage` |
| 内联元件"是否贴前文"、三种放置、语义分组 11 类 | `InlayImpl`（`relatesToPrecedingText` 参与区间树插入）、`BlockInlayImpl`、`AfterLineEndInlayImpl`、`InlineInlayImpl`、`InlayGroup`（`CODE_VISION_GROUP_NEW`、`PARAMETERS_GROUP`、`TYPES_GROUP`、`VALUES_GROUP`、`ANNOTATIONS_GROUP`、`METHOD_CHAINS_GROUP`、`LAMBDAS_GROUP`、`CODE_AUTHOR_GROUP`、`URL_PATH_GROUP`、`OTHER_GROUP` 等 11 项） |
| 代码视觉提示契约 | `CodeVisionProvider`（EP `com.intellij.codeInsight.codeVisionProvider`、`precomputeOnUiThread`/`computeForEditor`/`shouldRecomputeForEditor`/`getRelativeOrderings`/`getSingleEntryPerLine`/`getGroupId`） |
| 光标用位置标记树跟踪 + 上限 + 合并 + 限频提示 10 秒；矩形选择展开为多段选区 | `CaretModelImpl`（`myPositionMarkerTree`、`mySelectionMarkerTree`、`MAX_CARET_COUNT`、`doWithCaretMerging`）、`EditorUtil.notifyMaxCarets`（`MAX_CARETS_NOTIFY_INTERVAL_MS = 10000`）、`SelectionModelImpl.setBlockSelection` / `getBlockSelectionStarts` / `getBlockSelectionEnds` |
| 编辑器本地镜像与权威文档双向同步 | `ElfDocumentSync`（`elfToRealSync`/`realToElfSync`、`assertDocumentAreSynced`）、`ElfTheManager`、`EditorImpl.getElfDocument` |
| 分页文档（页号 + 绝对符号位置 + 双滚动条）；纯文本大文件编辑器的独立实现 | `DocumentOfPagesModel`、`Page`、`AbsoluteSymbolPosition`、`GlobalScrollBar`、`LocalInvisibleScrollBar`；`com.intellij.largeFilesEditor`（`LargeFileEditorImpl`、`LargeFileEditorProvider`、`LargeFileNotificationProvider`） |
| 可见区优先布局 + 字形宽度缓存 + 坐标映射 | `openapi/editor/impl/view`（`EditorView`、`EditorPainter`、`CharWidthCache`、`CharacterGrid`、`EditorCoordinateMapper`、`IterationState`） |
| 零延迟渲染管线与视口节流 | `EditorImpl` 的 `editor.zero.latency.rendering`、`.double.buffering`、`.pipeline.flush`、`editor.viewport.width.update.frequency`（默认 200） |
| 二方/三方差异与工具链 | `intellij.platform.diff` → `DiffTool`、`DiffToolType`（`Default`/`Unified`）、`SuppressiveDiffTool`、`FrameDiffTool`、`DiffRequestChain`、`merge/ThreesideMergeRequest` |
| 屏幕阅读器适配（光标适配层与行级语义） | `EditorAccessibilityCaret`（符合文本组件光标约定）、`AccessibleGutterLine`（`SimpleAccessible` + 行级图标/动作/快捷键） |
| 本子系统扩展点声明规模、依赖广度、前后端模块与可持久编辑器实体 | `_rev/evidence/04-document-editor.md`（声明 150 个、有实现的标签 61 组；编辑器界面模块被 811 个模块依赖，`editor.ex` 被 112 个）；`intellij.platform.editor.backend`（`BackendEditorState`、`BackendEditors`）、`intellij.platform.editor.frontend`（`FrontendEditorHandler`）、`intellij.platform.editor` → `EditorEntity`（`id` + `document` + `clientId`） |
## 12. 未决问题
- **撤销栈容量上限**：证据只显示每文档栈深度可查询与"历史清空/导出"动作，未见按条目或字节的硬上限常量；本规格按"条目数限制并从最旧淘汰"描述，默认值 `[推断]`。
- **预览上限与编码探测上限的具体数值**：四档阈值接口存在，但这两档的默认常量位于未反编译的公共工具层，数值 `[推断]`。
- **循环缓冲截断与保存的交互**：截断与保存路径在证据中独立存在，"保存后磁盘丢失窗口外内容"的语义 `[推断]` 为"以当前窗口内容覆盖"。
- **本地镜像的使用边界**：镜像双向同步器与"零延迟渲染"同时存在，二者是否为同一机制的两面 `[推断]` 为是；镜像是否也用于非键入来源（如批量替换预演）未确认。
- **批量期间事件是否可合并**：证据显示批量期间仍逐条产生事件、仅订阅方延迟反应；是否存在"事件合并开关" `[推断]` 为不存在。
- **远端多客户端下撤销的归属**：本地栈与共享栈快照并存，但"用户 A 撤销是否可能回退用户 B 的编辑"未确认；本规格按"本地栈优先、跨端仅同步有效性"描述。
- **折叠区域数量上限**：证据只见批量处理与重叠拒绝，未见数量上限；本规格的"量级 10³"为量级估算 `[推断]`。
- **三方差异是否共用同一工具链**：证据显示三方合并请求与两方请求共用差异管理入口，`[推断]` 为同一链路的不同请求类型。
