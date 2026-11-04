# IntelliJ 逆向规格实现工作区

本目录是 `feat/spec-intellij-parity` 分支的共享上下文指针，供所有实现者子代理读取。

- `gap-analysis.md` — 规格 03–20 与现有 Rust 代码库的差距矩阵，含插件 ABI 分析与诚实边界。
- `tickets.md` — ticket 图（阻塞关系）、每个 ticket 的交付物与验收、硬性约束。
- `build.md` — 构建环境：必须用 `C:/Users/Lenovo/Desktop/aaa_notes/cargo.bat` 包装脚本
  （nightly 1.99 + vcvars64），裸跑 `cargo` 会因 MSVC 链接器与 rust-version 失败。
- 完整规格见仓库 `spec/`（23 篇）。

## 边界

完整 IntelliJ JAR 插件生态兼容需要 JVM 与一套不同的 ABI，不可等价实现；
本分支把「兼容」落实为 `META-INF/plugin.xml` 描述符级导入 + 只读兼容性报告。
