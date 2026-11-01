<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src-tauri/icons/source/openidea-wordmark-dark.svg">
    <img src="src-tauri/icons/source/openidea-wordmark.svg" alt="OpenIDEA" height="56">
  </picture>
</p>

<p align="center">
  你熟悉的 IDE，用 Rust 重新打造。
</p>

<p align="center">
  <a href="https://github.com/l0ng-ai/openidea/blob/main/README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/l0ng-ai/openidea/releases/latest"><b>下载</b></a>
  &nbsp;·&nbsp;
  <a href="#基准测试">基准测试</a>
  &nbsp;·&nbsp;
  <a href="#构建">构建</a>
  &nbsp;·&nbsp;
  <a href="https://discord.gg/2Zy4yn7gP">Discord</a>
</p>

https://github.com/user-attachments/assets/234dd54c-1255-4b3a-b35c-533d78d737c0

OpenIDEA 把 IntelliJ IDEA 的工作方式——它的快捷键、工具窗口、随处搜索的习惯——带到一个以 Rust 为核心的原生应用中。

编辑器、代码洞察、调试器、Git、终端、数据库与 HTTP 客户端，支持 60 多种语言。可构建于 macOS、Windows 和 Linux。

## 基准测试

打开 [freqtrade](https://github.com/freqtrade/freqtrade)（Python，约 770 个文件），缓存已预热，取 5 次运行的中位数：

|                       | OpenIDEA       | IntelliJ IDEA 2026.2.3 |
| --------------------- | -------------- | ---------------------- |
| 打开项目窗口          | **0.9 秒**     | 3.1 秒                 |
| 就绪（CPU 平稳）      | **1.1 秒**     | 13.2 秒                |
| 内存（USS，所有进程） | **169 MB**     | 2011 MB                |
| 就绪前的 CPU 时间     | **2.4 秒**     | 47.9 秒                |
| 空闲 CPU              | **单核的 4 %** | 单核的 7 %             |
| 退出                  | **0.3 秒**     | 5.9 秒                 |

以上为 `main` 分支构建的 OpenIDEA release 版本，与使用默认设置和默认插件的 IDEA，运行于 Windows 11、32 核 AMD、62 GB 内存的机器上。
IDEA 对 Python 的分析更深入，因此两边的“就绪”并不代表完成了同样的工作量。两者的测量都从外部进行、方式一致：参见
[`perf/compare`](perf/compare)，可在你自己的机器和项目上复现。

## 构建

```sh
pnpm install
pnpm tauri dev
```

需要 Rust 1.96、Node 22、pnpm 以及 [Tauri 的依赖](https://v2.tauri.app/start/prerequisites/)。

原生 Notebook 执行测试默认不启用，需要两个都已安装 `ipykernel` 的独立 Python 环境：

```sh
OPENIDEA_TEST_PYTHON=/first/env/bin/python \
OPENIDEA_TEST_PYTHON_SECOND=/second/env/bin/python \
cargo test -p ide-notebook --test kernel_runtime -- --ignored --test-threads=1
```

## 许可证

[Apache 2.0](LICENSE)。随附的第三方资源列于 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)。

<sub>本项目与 JetBrains 无任何关联。IntelliJ IDEA 是 JetBrains s.r.o. 的商标。</sub>
