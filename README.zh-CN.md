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
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://github.com/l0ng-ai/openidea/releases/latest"><b>下载</b></a>
  &nbsp;·&nbsp;
  <a href="https://openidea.sh/zh">文档</a>
  &nbsp;·&nbsp;
  <a href="#性能对比">性能对比</a>
  &nbsp;·&nbsp;
  <a href="#插件">插件</a>
  &nbsp;·&nbsp;
  <a href="#社区">社区</a>
  &nbsp;·&nbsp;
  <a href="#赞助">赞助</a>
</p>

https://github.com/user-attachments/assets/234dd54c-1255-4b3a-b35c-533d78d737c0

OpenIDEA 把 IntelliJ IDEA 的使用方式（快捷键、工具窗口、随处搜索的习惯）带到一个以 Rust
为核心的原生桌面应用里。

编辑器、代码洞察、调试器、Git、终端、数据库客户端和 HTTP 客户端，支持 60 多种语言。
提供 macOS、Windows 和 Linux 版本。

## 性能对比

在缓存已预热的情况下打开 [freqtrade](https://github.com/freqtrade/freqtrade)（Python，约 770 个文件），
取 5 次运行的中位数：

|                       | OpenIDEA       | IntelliJ IDEA 2026.2.3 |
| --------------------- | -------------- | ---------------------- |
| 显示项目窗口          | **0.9 s**      | 3.1 s                  |
| 就绪（CPU 平稳）      | **1.1 s**      | 13.2 s                 |
| 内存（USS，所有进程） | **169 MB**     | 2011 MB                |
| 就绪前消耗的 CPU 时间 | **2.4 s**      | 47.9 s                 |
| 空闲 CPU              | 单核的 **4 %** | 单核的 7 %             |
| 退出                  | **0.3 s**      | 5.9 s                  |

测试使用 `main` 分支的 OpenIDEA release 构建，以及默认设置和插件的 IDEA，环境为 Windows 11、
32 核 AMD、62 GB 内存。IDEA 对 Python 的分析更深入，所以两边的“就绪”并不代表完成了同样多的工作。
两者都以相同方式从外部测量：可以用 [`perf/compare`](perf/compare) 在自己的机器和项目上复现。

## 插件

插件可以添加操作、补全、快速修复、工具窗口、自定义编辑器、主题、文件图标和语言。插件以沙箱化的
WebAssembly 组件运行；主题、图标主题和语言无需编写代码。

在“设置 › 插件”中安装，或用 `openidea-plugin new` 创建自己的插件：参见
[编写 OpenIDEA 插件](https://openidea.sh/zh/plugins)和[官方插件](plugins/official)。插件 API 目前仍是预览版。

## 社区

- [Discord](https://discord.gg/2Zy4yn7gP)：提问、反馈和版本发布消息。
- 微信群，扫码加入：

  <img src=".github/assets/wechat-group.png" alt="微信群二维码" width="200">

- 参与贡献：参见 [CONTRIBUTING.md](CONTRIBUTING.md) 和[贡献者文档](https://openidea.sh/zh/contribute/setup)。

## 赞助

如果 OpenIDEA 帮你节省了时间，可以通过支付宝或微信支付支持它的开发。

<table>
  <tr>
    <td align="center"><img src=".github/assets/sponsor-alipay.png" alt="支付宝收款码" width="200"><br>支付宝</td>
    <td align="center"><img src=".github/assets/sponsor-wechat.png" alt="微信支付收款码" width="200"><br>微信支付</td>
  </tr>
</table>

## 许可证

[Apache 2.0](LICENSE)。随附的第三方资源列在 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) 中。

<sub>与 JetBrains 无关联。IntelliJ IDEA 是 JetBrains s.r.o. 的商标。</sub>
