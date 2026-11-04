# 实现 ticket 图（IntelliJ 逆向规格 → OpenIDEA Rust 二次开发）

上下文指针：
- 规格：`C:/Users/Lenovo/Desktop/aaa/spec/`（23 篇，`00` 为总纲，`21` 为测试接缝）
- 差距分析：`C:/Users/Lenovo/Desktop/aaa_notes/EXPLORATION.md`
- 构建环境：`C:/Users/Lenovo/Desktop/aaa_notes/BUILD.md`（必须用 `cargo.bat` 包装脚本）
- 仓库约定：`C:/Users/Lenovo/Desktop/aaa/AGENTS.md`、`CONTRIBUTING.md`

## 边界（诚实声明）

`00-spec.md` 明确写"描述既有系统的设计，而非待开发清单"。代码库已是可用的 Rust/Tauri IDE。
完整 IntelliJ 插件兼容（JAR 字节码 + `com.intellij.openapi.*` + 3235 扩展点 + 类加载器 + JVM）
属于**不同 ABI，不可等价实现**；本轮把"兼容其插件生态"落实为：
**描述符级兼容** —— 解析 `META-INF/plugin.xml`，把声明式贡献导入 OpenIDEA 的贡献点，
并给出只读兼容性报告。绝不声称运行 IntelliJ 字节码。

## 阻塞图

```
T0（基线：工具链可编译，已完成验证）
  └─► T1（代际绑定可取消任务原语 ide-core）
        ├─► T2（守护分析调度器 ide-analysis）
        │     └─► T3（本地检查注册表 + 快速修复 + 抑制）
        │            └─► T6（WIT 检查/重构贡献点）
        ├─► T4（补全会话来源绑定与诊断）
        └─► T5（重构会话：影响集合 + 冲突 + 原子应用）
              └─► T6
T7（IntelliJ plugin.xml 兼容顾问 + 声明式导入）— 依赖 T6
T8（设置 schema 版本 + 原子写 + 来源查询 + 导出导入）— 独立
T9（远程会话恢复令牌 + 幂等重放）— 依赖 T1
```

## Tickets

### T1 — 代际绑定可取消任务原语（规格 03/07/08/21 的 S2 接缝）
- 交付：`ide-core` 中 `Generation<T>` / `JobHandle`：后台结果携带（文档、版本、代际）标记；
  边界处丢弃过期结果，取消后无残留。 proptest 覆盖"版本变更后旧结果被丢弃"。
- 目标：`crates/ide-core/src/`、`crates/ide-host/src/requests.rs`
- 阻塞：T0；阻塞 T2/T4/T5/T9
- 验收：`cargo test -p ide-core` 通过；无新依赖；公开 API 有文档注释。

### T2 — 守护分析调度器（规格 08 §4）
- 交付：编辑触发的去抖、可取消重分析；重复代码/结构/外部诊断按阶段发布，
  只发布与当前文档版本匹配的结果；输入变更后旧波浪线立即消失。
- 目标：`crates/ide-analysis/src/`、`crates/ide-host/src/ops/analysis.rs`
- 阻塞：T1；阻塞 T3
- 验收：集成测试"编辑后旧诊断消失、新诊断出现"；`cargo test -p ide-analysis -p ide-host`。

### T3 — 本地检查注册表 + 快速修复 + 抑制（规格 08 §3/§4）
- 交付：第一类 `LocalInspection` 契约（标识、严重级别、作用域、抑制），统一 Problems
  视图合并 LSP + 插件 + 第一类诊断，"全部修复"幂等批量修复。
- 目标：`crates/ide-analysis`、`crates/ide-core/src/inspection_settings.rs`、`src/features/analysis/`
- 阻塞：T2；阻塞 T6
- 验收：单测覆盖抑制优先级与批量修复幂等；前端 `pnpm test` 通过。

### T4 — 补全会话来源绑定与诊断（规格 09 §9）
- 交付：`beginCompletion` 会话合并 LSP 与插件候选，每条带来源与耗时，
  版本不符结果丢弃，提供"为什么没有弹出/为什么这样排序"的诊断入口。
- 目标：`ide-host/src/ops/lsp.rs`、`ide-host/src/plugins/providers.rs`
- 阻塞：T1；无后继
- 验收：单测覆盖快速输入后的过期候选丢弃。

### T5 — 重构会话：影响集合 + 冲突 + 原子应用（规格 10 §4）
- 交付：`beginRefactoring` 收集用法（LSP references/rename 回退）、分类冲突
  （未加载/二进制/已修改），产出单个 `WorkspaceEdit` 作为一次可撤销事务应用，
  之后重新解析验证可编译下限。
- 目标：`ide-host/src/ops/refactor.rs`、`crates/ide-text/src/lib.rs`
- 阻塞：T1；阻塞 T6
- 验收：集成测试"跨文件重命名一次撤销全部回滚"。

### T6 — WIT/扩展点：检查与重构贡献（规格 15/10）
- 交付：新增 `[[contributes.inspections]]`、`[[contributes.refactorings]]` 贡献点 + WIT 宿主函数，
  让插件通过 T3/T5 提供能力；更新 `wit_coverage.rs` / `api_frozen.rs` 与一个 fixture 插件。
- 目标：`wit/*.wit`、`crates/ide-extension/src/`、`ide-host/src/plugins/points.rs`、`sdk/rust/openidea-plugin/`
- 阻塞：T3、T5；阻塞 T7
- 验收：SDK 静态覆盖率测试通过；`plugins/build.sh --check` 通过。

### T7 — IntelliJ plugin.xml 兼容顾问与声明式导入（"兼容插件生态"的可达部分）
- 交付：扩展 `ide-host/src/plugins/intellij.rs` 解析 `<id>/<depends>/<idea-version>/
  <extensionPoints>/<extensions>/<actions>/<services>`，产出结构化兼容报告
  （每个声明的扩展点 → 最近的 OpenIDEA 贡献点/宿主函数；不支持项列原因），
  并把数据类贡献（主题/图标/文件类型/键位/动作元数据）导入现有贡献点。
  只读，绝不执行字节码。新增 `openidea-plugin compat <path>` 与一个"检查 IntelliJ 插件"视图。
- 目标：`ide-host/src/plugins/intellij.rs`、`ide-host/src/bin/openidea-plugin/`、`src/features/plugins/`、`plugins/README.md`
- 阻塞：T6；无后继
- 验收：用 `_rev/pluginxml/` 中真实描述符做快照测试；报告区分"可导入/需改写/不支持"。

### T8 — 设置 schema 版本 + 原子写 + 来源查询 + 导出导入（规格 14）
- 交付：`settings.toml` 带 schema 版本与迁移链；temp+rename 原子写；
  `resolvedFrom(key)` 报告默认值→全局→项目来源；`exportSettings`/`importSettings`。
- 目标：`crates/ide-workspace/src/settings.rs`、`crates/ide-core/src/settings.rs`
- 阻塞：无（与 T1 并行）
- 验收：单测覆盖损坏文件不丢配置、迁移幂等、来源优先级。

### T9 — 远程会话恢复令牌 + 幂等重放（规格 17）
- 交付：`resumeToken` + epoch/代际，客户端生成幂等键，离线输入缓冲；
  重连增量补丁重放且无重复编辑。
- 目标：`crates/ide-host/src/rpc.rs`、`src-tauri/src/remote_dev.rs`
- 阻塞：T1；无后继
- 验收：协议级单测覆盖重连重放不产生重复变更。

## 每个实现者的硬性约束

1. 只改指派 ticket 目标范围内的文件；不得改动他人 crate。
2. 用 `C:/Users/Lenovo/Desktop/aaa_notes/cargo.bat` 验证（见 BUILD.md），不要裸跑 `cargo`。
3. 新增公开 API 必须有文档注释；新字符串进 `en.json` + `zh.json`。
4. 不引入"假回退/占位/TODO 实现"；功能必须真实可测。
5. 每个 ticket 一个独立分支 `feat/spec-<id>`，基于最新的 PR 分支。
6. 提交信息遵循仓库现有 `feat(scope): ...` 风格；PR 描述含 `## How it was verified`。
