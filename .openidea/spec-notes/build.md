# 构建环境（所有实现者子代理必须遵守）

Rust 工具链不在 PATH 上；Git Bash 自带 `/usr/bin/link.exe` 会遮蔽 MSVC 链接器，直接 `cargo` 必然失败。
必须使用包装脚本（已验证 `cargo check --workspace` 通过，耗时约 6m43s）：

```
cmd.exe /c "$(cygpath -w 'C:/Users/Lenovo/Desktop/aaa_notes/cargo.bat')" <cargo 子命令> <参数>
```

`cargo.bat` 内容：先 `call vcvars64.bat`，再把 nightly 工具链目录放到 PATH 前面，
最后调用 `C:\Users\Lenovo\.rustup\toolchains\nightly-2026-07-28-x86_64-pc-windows-msvc\bin\cargo.exe`。

- 版本：rustc 1.99.0-nightly (2026-07-27)。Cargo.toml 声明 `rust-version = 1.96`；
  稳定版 1.92 / 1.95 均不足（wasmtime 49 要求 1.96），**只能用 nightly**。
- `cargo check --workspace --offline` 会失败（本地 registry 缓存缺 `toml 0.9` 等），需要联网。
- 单 crate 验证：`... check -p ide-xxx` / `... test -p ide-xxx`，比全量快得多。
- 不要修改 `rust-version`，不要降级依赖版本。

# GitHub

- 上游 `l0ng-ai/openidea` 当前 token 只有 pull 权限，**不能推送**。
- 已建立 fork：`https://github.com/NothingFumo/openidea`，有 push/admin 权限。
  本地 remote 名 `fork`。PR 分支必须推到 fork。
- token 取法：`printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep '^password=' | cut -d= -f2-`
  然后 `export GH_TOKEN=...`。scope: gist, repo, workflow。
