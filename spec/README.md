# 一体化代码工作台 — 系统设计规格

对已安装的 **IntelliJ IDEA Ultimate 2026.2.0.1（构建 IU-262.8665.337）** 逆向而成的**语言与平台无关**的系统设计规格。它只描述**设计与功能**：结构、契约、不变量、数据流、故障模式，不描述任何具体语言、框架或类库。

## 读什么

| 文档 | 主题 | 一句话 |
|---|---|---|
| [00-spec](00-spec.md) | 主规格 | 问题、方案、92 条用户故事、实现与测试决策、范围外 |
| [01-system-overview](01-system-overview.md) | 总览 | 定位、能力地图、三种部署形态、质量属性、降级梯度 |
| [02-architecture](02-architecture.md) | 总体架构 | 模块图、服务容器、扩展点、启动相位、动态装卸 |
| [03-runtime-and-concurrency](03-runtime-and-concurrency.md) | 运行时与并发 | 线程角色、单写多读、写意图、取消、哑模式 |
| [04-virtual-file-system](04-virtual-file-system.md) | 虚拟文件系统 | 文件族、事件、刷新、编码、文件类型、写入安全 |
| [05-document-and-editor](05-document-and-editor.md) | 文档与编辑器 | 不可变快照、撤销、光标、折叠、装饰、大文件降级 |
| [06-parsing-and-psi](06-parsing-and-psi.md) | 解析与程序结构接口 | 词法/语法/树、增量重解析、引用解析、桩、注入 |
| [07-indexing-and-search](07-indexing-and-search.md) | 索引与检索 | 索引种类、更新流水线、共享索引、检索原语 |
| [08-analysis-and-inspections](08-analysis-and-inspections.md) | 守护分析与检查 | 高亮阶段、检查模型、快速修复、问题视图 |
| [09-completion-and-navigation](09-completion-and-navigation.md) | 补全与导航 | 补全流水线、排序、导航原语、搜索无处不在 |
| [10-refactoring-and-generation](10-refactoring-and-generation.md) | 重构与生成 | 影响范围、冲突、原子执行、模板体系 |
| [11-project-model-and-build](11-project-model-and-build.md) | 工程模型与构建 | 工作区模型、同步、依赖解析、增量编译 |
| [12-execution-and-debugging](12-execution-and-debugging.md) | 运行与调试 | 运行配置、进程、控制台、调试器、测试、覆盖率 |
| [13-ui-architecture](13-ui-architecture.md) | 界面架构 | 动作系统、工具窗口、主题、通知、进度、可访问性 |
| [14-settings-and-persistence](14-settings-and-persistence.md) | 设置与持久化 | 状态归属、迁移、原子写、注册表键、同步 |
| [15-plugin-and-extension-model](15-plugin-and-extension-model.md) | 插件与扩展 | 装载、类加载、扩展协议、动态插件、治理 |
| [16-licensing-and-distribution](16-licensing-and-distribution.md) | 发行与授权 | 功能分层、许可、遥测、更新、安装集成 |
| [17-remote-development](17-remote-development.md) | 远程开发 | 前后端切分、协议分层、模型同步、断线恢复 |
| [18-vcs-integration](18-vcs-integration.md) | 版本控制 | 抽象层、变更列表、差异、注解、提交、历史 |
| [19-database-and-data-tools](19-database-and-data-tools.md) | 数据库与数据工具 | 数据源、内省、SQL 能力、控制台、数据网格 |
| [20-ai-and-integrations](20-ai-and-integrations.md) | 智能辅助与集成 | 代理协议、工具服务端、语言服务器、终端、容器 |
| [21-testing-strategy](21-testing-strategy.md) | 测试策略 | 四个层级、五个接缝、夹具、并发测试契约 |
| [22-evidence-and-glossary](22-evidence-and-glossary.md) | 证据与术语 | 取证方法、度量总表、术语、交叉索引、局限 |

## 怎么读

- **要理解"系统如何组装"**：01 → 02 → 15
- **要实现最小可用版本**：04 → 05 → 06 → 07 → 08 → 13
- **要接入一门新语言**：06 → 07 → 08 → 09 → 10
- **要做远端/无头形态**：03 → 12 → 17
- **要做工程化集成**：11 → 12 → 18 → 19
- **要做验证**：21 → 22

## 约定

- 规范性用词：**必须 / 必须不 / 应当 / 应当不 / 可以**。
- 无直接证据、依赖同类系统经验补全的内容，标注 `[推断]`，并在各文档 §12 汇总。
- 每篇子系统文档（02–21）为 12 节同一骨架：目的与范围 / 概念模型 / 数据模型 / 行为契约 / 不变量 / 能力契约 / 故障与降级 / 资源与性能 / 可观测性 / 扩展点 / 对照实现（证据锚点）/ 未决问题。
- 结构例外：`00` 按 spec 模板（问题/方案/用户故事/决策/范围外）；`01` 为总览结构（能力地图/部署形态/质量属性/设计原则）；`22` 为附录结构（取证方法/度量/术语/索引/局限）。
- 正文不含任何实现语言、框架、类名、路径；实现锚点只出现在各文档最后一节，用于复核。

## 证据基线（实测）

| 指标 | 值 |
|---|---|
| 内部模块 / 依赖回边 / 最长依赖链 | 2090 / 0 / 57 层 |
| 扩展点声明 / 扩展注册 | 3,235 / 29,282 |
| 动作 / 动作组 | 1559 / 487 |
| 应用级服务 / 项目级服务 | 2,187 / 1,165 |
| 捆绑插件 / 公开模块标识 / 构件 | 163 / 73 / 429 |
| 文件类型 / 处理扩展名 | 172 / 250 |
| 运行时 / 最低 Java | JBR 25.0.3 / 25 |

取证方法与可复现步骤见 [22](22-evidence-and-glossary.md) §2。
