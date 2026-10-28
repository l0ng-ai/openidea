//! The installable tools, keyed by the server / adapter `name` used in
//! `languages/*.toml`.

use crate::platform::{Arch, AssetRule, Os, any_arch, rule};
use serde::Serialize;
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    LanguageServer,
    Debugger,
    /// Loaded into another tool's process, e.g. a jdtls agent.
    Plugin,
}

/// Where release archives come from.
#[derive(Clone, Copy, Debug)]
pub enum ReleaseSource {
    /// Latest GitHub release of `owner/repo`; assets plus links in the release notes.
    GitHub { repo: &'static str },
    /// `api.releases.hashicorp.com` product.
    HashiCorp { product: &'static str },
    /// Latest Eclipse JDT LS milestone tarball from download.eclipse.org.
    EclipseJdtls,
    /// Latest version of a VS Code extension (`.vsix`) on open-vsx.org.
    OpenVsx { namespace: &'static str, extension: &'static str },
    /// Latest release of a Maven Central artifact (the `.jar` itself).
    MavenCentral { group: &'static str, artifact: &'static str },
}

#[derive(Clone, Copy, Debug)]
pub enum Method {
    /// `rustup component add <component>`.
    Rustup { component: &'static str },
    /// npm / pnpm packages installed into `<tools>/node_modules`; the first is the primary one.
    Npm { packages: &'static [&'static str] },
    /// `go install <module>` with `GOBIN=<tools>/<name>/bin`.
    Go { module: &'static str },
    /// A private virtualenv at `<tools>/<name>/venv` (uv when available).
    PipVenv { package: &'static str },
    /// `python3 -m pip install --user <package>`; detected by importing `module`.
    PipUser { package: &'static str, module: &'static str },
    /// A pure-Python package unpacked into `<tools>/<name>/lib` (`pip install --target`,
    /// universal wheel), put on `PYTHONPATH` of whichever interpreter runs it.
    PipTarget { package: &'static str, module: &'static str },
    /// `gem install` into `<tools>/<name>/gems`, launched through `GEM_HOME` wrappers in `bin/`.
    Gem { gem: &'static str },
    /// `dotnet tool install --tool-path <tools>/<name>/tool <package>`, launched
    /// through `DOTNET_ROOT` wrappers in `bin/`.
    DotnetTool { package: &'static str },
    /// Platform archive download into `<tools>/<name>/`.
    Release { source: ReleaseSource, assets: &'static [AssetRule], locate: &'static [&'static str] },
}

impl Method {
    pub fn label(&self) -> &'static str {
        match self {
            Method::Rustup { .. } => "rustup",
            Method::Npm { .. } => "npm",
            Method::Go { .. } => "go install",
            Method::Gem { .. } => "gem",
            Method::DotnetTool { .. } => "dotnet tool",
            Method::PipVenv { .. } => "pip (virtualenv)",
            Method::PipUser { .. } => "pip --user",
            Method::PipTarget { .. } => "pip (private copy)",
            Method::Release { source: ReleaseSource::HashiCorp { .. }, .. } => "HashiCorp release",
            Method::Release { source: ReleaseSource::EclipseJdtls, .. } => "Eclipse download",
            Method::Release { source: ReleaseSource::OpenVsx { .. }, .. } => "Open VSX",
            Method::Release { source: ReleaseSource::MavenCentral { .. }, .. } => "Maven Central",
            Method::Release { .. } => "GitHub release",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ToolSpec {
    pub name: &'static str,
    pub display: &'static str,
    pub kind: ToolKind,
    /// Executables provided; the first is the one launched by the IDE. A `.jar`
    /// is a plugin bundle loaded by another tool (copied to `bin/` under this name).
    pub commands: &'static [&'static str],
    pub method: Method,
    /// Version query: a command (looked up next to the main binary first) and its args.
    pub version: Option<(&'static str, &'static [&'static str])>,
    pub homepage: &'static str,
    /// Runtimes the tool runs on, found on `PATH`: command and why it is needed.
    pub needs: &'static [(&'static str, &'static str)],
}

impl ToolSpec {
    pub fn asset_rules(&self) -> &'static [AssetRule] {
        match self.method {
            Method::Release { assets, .. } => assets,
            _ => &[],
        }
    }
}

use Arch::{Arm64, X64};
use Os::{Linux, Mac, Windows};
use ToolKind::{Debugger, LanguageServer, Plugin};

const V: Option<(&str, &[&str])> = None;
const JAVA: &[(&str, &str)] = &[("java", "Java is required (https://adoptium.net)")];
const NODE: &[(&str, &str)] = &[("node", "Node.js is required (https://nodejs.org)")];
const ELIXIR: &[(&str, &str)] = &[("elixir", "Elixir is required (https://elixir-lang.org/install.html)")];
const ELIXIR_LS_ASSETS: &[AssetRule] =
    &[any_arch(Mac, "elixir-ls-v*.zip"), any_arch(Linux, "elixir-ls-v*.zip"), any_arch(Windows, "elixir-ls-v*.zip")];
const fn ver(cmd: &'static str) -> Option<(&'static str, &'static [&'static str])> {
    Some((cmd, &["--version"]))
}

/// The TypeScript these npm servers load as a library (`tsserver.js`, `ts.server`):
/// TypeScript 7 (the native port) ships neither, and `@latest` resolves to it.
pub const TYPESCRIPT: &str = "typescript@<7";

pub static TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "rust-analyzer",
        display: "rust-analyzer",
        kind: LanguageServer,
        commands: &["rust-analyzer"],
        method: Method::Rustup { component: "rust-analyzer" },
        version: ver("rust-analyzer"),
        homepage: "https://rust-analyzer.github.io",
        needs: &[],
    },
    ToolSpec {
        name: "vtsls",
        display: "vtsls (TypeScript)",
        kind: LanguageServer,
        commands: &["vtsls"],
        method: Method::Npm { packages: &["@vtsls/language-server"] },
        version: V,
        homepage: "https://github.com/yioneko/vtsls",
        needs: &[],
    },
    ToolSpec {
        name: "typescript-language-server",
        display: "typescript-language-server",
        kind: LanguageServer,
        commands: &["typescript-language-server"],
        method: Method::Npm { packages: &["typescript-language-server", TYPESCRIPT] },
        version: ver("typescript-language-server"),
        homepage: "https://github.com/typescript-language-server/typescript-language-server",
        needs: &[],
    },
    ToolSpec {
        name: "pyright",
        display: "Pyright",
        kind: LanguageServer,
        commands: &["pyright-langserver", "pyright"],
        method: Method::Npm { packages: &["pyright"] },
        version: ver("pyright"),
        homepage: "https://github.com/microsoft/pyright",
        needs: &[],
    },
    ToolSpec {
        name: "basedpyright",
        display: "basedpyright",
        kind: LanguageServer,
        commands: &["basedpyright-langserver", "basedpyright"],
        method: Method::PipVenv { package: "basedpyright" },
        version: ver("basedpyright"),
        homepage: "https://docs.basedpyright.com",
        needs: &[],
    },
    ToolSpec {
        name: "ty",
        display: "ty (Python)",
        kind: LanguageServer,
        commands: &["ty"],
        method: Method::PipVenv { package: "ty" },
        version: ver("ty"),
        homepage: "https://docs.astral.sh/ty/",
        needs: &[],
    },
    ToolSpec {
        name: "bash-language-server",
        display: "Bash Language Server",
        kind: LanguageServer,
        commands: &["bash-language-server"],
        method: Method::Npm { packages: &["bash-language-server"] },
        version: ver("bash-language-server"),
        homepage: "https://github.com/bash-lsp/bash-language-server",
        needs: &[],
    },
    ToolSpec {
        name: "yaml-language-server",
        display: "YAML Language Server",
        kind: LanguageServer,
        commands: &["yaml-language-server"],
        method: Method::Npm { packages: &["yaml-language-server"] },
        version: V,
        homepage: "https://github.com/redhat-developer/yaml-language-server",
        needs: &[],
    },
    ToolSpec {
        name: "vscode-json-language-server",
        display: "JSON Language Server",
        kind: LanguageServer,
        commands: &["vscode-json-language-server"],
        method: Method::Npm { packages: &["vscode-langservers-extracted"] },
        version: V,
        homepage: "https://github.com/hrsh7th/vscode-langservers-extracted",
        needs: &[],
    },
    ToolSpec {
        name: "vscode-css-language-server",
        display: "CSS Language Server",
        kind: LanguageServer,
        commands: &["vscode-css-language-server"],
        method: Method::Npm { packages: &["vscode-langservers-extracted"] },
        version: V,
        homepage: "https://github.com/hrsh7th/vscode-langservers-extracted",
        needs: &[],
    },
    ToolSpec {
        name: "vscode-html-language-server",
        display: "HTML Language Server",
        kind: LanguageServer,
        commands: &["vscode-html-language-server"],
        method: Method::Npm { packages: &["vscode-langservers-extracted"] },
        version: V,
        homepage: "https://github.com/hrsh7th/vscode-langservers-extracted",
        needs: &[],
    },
    ToolSpec {
        name: "dockerfile-language-server",
        display: "Dockerfile Language Server",
        kind: LanguageServer,
        commands: &["docker-langserver"],
        method: Method::Npm { packages: &["dockerfile-language-server-nodejs"] },
        version: V,
        homepage: "https://github.com/rcjsuen/dockerfile-language-server",
        needs: &[],
    },
    ToolSpec {
        name: "svelte-language-server",
        display: "Svelte Language Server",
        kind: LanguageServer,
        commands: &["svelteserver"],
        method: Method::Npm { packages: &["svelte-language-server", TYPESCRIPT] },
        version: V,
        homepage: "https://github.com/sveltejs/language-tools",
        needs: &[],
    },
    ToolSpec {
        name: "vue-language-server",
        display: "Vue Language Server",
        kind: LanguageServer,
        commands: &["vue-language-server"],
        method: Method::Npm { packages: &["@vue/language-server", TYPESCRIPT] },
        version: V,
        homepage: "https://github.com/vuejs/language-tools",
        needs: &[],
    },
    ToolSpec {
        name: "angular-language-server",
        display: "Angular Language Server",
        kind: LanguageServer,
        commands: &["ngserver"],
        // Brings the TypeScript and `@angular/language-service` it loads.
        method: Method::Npm { packages: &["@angular/language-server"] },
        version: V,
        homepage: "https://angular.dev/tools/language-service",
        needs: &[],
    },
    ToolSpec {
        name: "graphql-lsp",
        display: "GraphQL Language Server",
        kind: LanguageServer,
        commands: &["graphql-lsp"],
        method: Method::Npm { packages: &["graphql-language-service-cli"] },
        version: V,
        homepage: "https://github.com/graphql/graphiql",
        needs: &[],
    },
    ToolSpec {
        name: "intelephense",
        display: "Intelephense (PHP)",
        kind: LanguageServer,
        commands: &["intelephense"],
        method: Method::Npm { packages: &["intelephense"] },
        version: V,
        homepage: "https://intelephense.com",
        needs: &[],
    },
    ToolSpec {
        name: "gopls",
        display: "gopls",
        kind: LanguageServer,
        commands: &["gopls"],
        method: Method::Go { module: "golang.org/x/tools/gopls@latest" },
        version: Some(("gopls", &["version"])),
        homepage: "https://pkg.go.dev/golang.org/x/tools/gopls",
        needs: &[],
    },
    ToolSpec {
        name: "sqls",
        display: "sqls",
        kind: LanguageServer,
        commands: &["sqls"],
        method: Method::Go { module: "github.com/sqls-server/sqls@latest" },
        version: Some(("sqls", &["--version"])),
        homepage: "https://github.com/sqls-server/sqls",
        needs: &[],
    },
    ToolSpec {
        name: "delve",
        display: "Delve (Go debugger)",
        kind: Debugger,
        commands: &["dlv"],
        method: Method::Go { module: "github.com/go-delve/delve/cmd/dlv@latest" },
        version: Some(("dlv", &["version"])),
        homepage: "https://github.com/go-delve/delve",
        needs: &[],
    },
    ToolSpec {
        name: "debugpy",
        display: "debugpy (Python debugger)",
        kind: Debugger,
        commands: &["python3"],
        method: Method::PipTarget { package: "debugpy", module: "debugpy" },
        version: V,
        homepage: "https://github.com/microsoft/debugpy",
        needs: &[],
    },
    ToolSpec {
        name: "clangd",
        display: "clangd",
        kind: LanguageServer,
        commands: &["clangd"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "clangd/clangd" },
            assets: &[
                any_arch(Mac, "clangd-mac-*.zip"),
                rule(Linux, X64, "clangd-linux-*.zip"),
                rule(Windows, X64, "clangd-windows-*.zip"),
            ],
            locate: &["clangd"],
        },
        version: ver("clangd"),
        homepage: "https://clangd.llvm.org",
        needs: &[],
    },
    ToolSpec {
        name: "lua-language-server",
        display: "Lua Language Server",
        kind: LanguageServer,
        commands: &["lua-language-server"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "LuaLS/lua-language-server" },
            assets: &[
                rule(Mac, Arm64, "lua-language-server-*-darwin-arm64.tar.gz"),
                rule(Mac, X64, "lua-language-server-*-darwin-x64.tar.gz"),
                rule(Linux, X64, "lua-language-server-*-linux-x64.tar.gz"),
                rule(Linux, Arm64, "lua-language-server-*-linux-arm64.tar.gz"),
                rule(Windows, X64, "lua-language-server-*-win32-x64.zip"),
            ],
            locate: &["lua-language-server"],
        },
        version: ver("lua-language-server"),
        homepage: "https://luals.github.io",
        needs: &[],
    },
    ToolSpec {
        name: "marksman",
        display: "Marksman (Markdown)",
        kind: LanguageServer,
        commands: &["marksman"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "artempyanykh/marksman" },
            assets: &[
                any_arch(Mac, "marksman-macos"),
                rule(Linux, X64, "marksman-linux-x64"),
                rule(Linux, Arm64, "marksman-linux-arm64"),
                rule(Windows, X64, "marksman.exe"),
            ],
            locate: &["marksman"],
        },
        version: ver("marksman"),
        homepage: "https://github.com/artempyanykh/marksman",
        needs: &[],
    },
    ToolSpec {
        name: "taplo",
        display: "Taplo (TOML)",
        kind: LanguageServer,
        commands: &["taplo"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "tamasfe/taplo" },
            assets: &[
                rule(Mac, Arm64, "taplo-darwin-aarch64.gz"),
                rule(Mac, X64, "taplo-darwin-x86_64.gz"),
                rule(Linux, X64, "taplo-linux-x86_64.gz"),
                rule(Linux, Arm64, "taplo-linux-aarch64.gz"),
                rule(Windows, X64, "taplo-windows-x86_64.zip"),
            ],
            locate: &["taplo"],
        },
        version: ver("taplo"),
        homepage: "https://taplo.tamasfe.dev",
        needs: &[],
    },
    ToolSpec {
        name: "zls",
        display: "ZLS (Zig)",
        kind: LanguageServer,
        commands: &["zls"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "zigtools/zls" },
            assets: &[
                rule(Mac, Arm64, "zls-aarch64-macos.tar.xz"),
                rule(Mac, X64, "zls-x86_64-macos.tar.xz"),
                rule(Linux, X64, "zls-x86_64-linux.tar.xz"),
                rule(Linux, Arm64, "zls-aarch64-linux.tar.xz"),
                rule(Windows, X64, "zls-x86_64-windows.zip"),
            ],
            locate: &["zls"],
        },
        version: ver("zls"),
        homepage: "https://github.com/zigtools/zls",
        needs: &[],
    },
    ToolSpec {
        name: "terraform-ls",
        display: "Terraform Language Server",
        kind: LanguageServer,
        commands: &["terraform-ls"],
        method: Method::Release {
            source: ReleaseSource::HashiCorp { product: "terraform-ls" },
            assets: &[
                rule(Mac, Arm64, "terraform-ls_*_darwin_arm64.zip"),
                rule(Mac, X64, "terraform-ls_*_darwin_amd64.zip"),
                rule(Linux, X64, "terraform-ls_*_linux_amd64.zip"),
                rule(Linux, Arm64, "terraform-ls_*_linux_arm64.zip"),
                rule(Windows, X64, "terraform-ls_*_windows_amd64.zip"),
            ],
            locate: &["terraform-ls"],
        },
        version: Some(("terraform-ls", &["version"])),
        homepage: "https://github.com/hashicorp/terraform-ls",
        needs: &[],
    },
    ToolSpec {
        name: "codelldb",
        display: "CodeLLDB",
        kind: Debugger,
        commands: &["codelldb"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "vadimcn/codelldb" },
            assets: &[
                rule(Mac, Arm64, "codelldb-darwin-arm64.vsix"),
                rule(Mac, Arm64, "codelldb-aarch64-darwin.vsix"),
                rule(Mac, X64, "codelldb-darwin-x64.vsix"),
                rule(Mac, X64, "codelldb-x86_64-darwin.vsix"),
                rule(Linux, X64, "codelldb-linux-x64.vsix"),
                rule(Linux, X64, "codelldb-x86_64-linux.vsix"),
                rule(Linux, Arm64, "codelldb-linux-arm64.vsix"),
                rule(Linux, Arm64, "codelldb-aarch64-linux.vsix"),
                rule(Windows, X64, "codelldb-win32-x64.vsix"),
                rule(Windows, X64, "codelldb-x86_64-windows.vsix"),
            ],
            locate: &["codelldb"],
        },
        version: V,
        homepage: "https://github.com/vadimcn/codelldb",
        needs: &[],
    },
    ToolSpec {
        name: "js-debug",
        display: "JavaScript Debugger (vscode-js-debug)",
        kind: Debugger,
        commands: &["js-debug-adapter"],
        // The standalone DAP server; a Node script, launched through `node` by the bin wrapper.
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "microsoft/vscode-js-debug" },
            assets: &[
                any_arch(Mac, "js-debug-dap-*.tar.gz"),
                any_arch(Linux, "js-debug-dap-*.tar.gz"),
                any_arch(Windows, "js-debug-dap-*.tar.gz"),
            ],
            locate: &["dapDebugServer.js"],
        },
        version: V,
        homepage: "https://github.com/microsoft/vscode-js-debug",
        needs: &[],
    },
    ToolSpec {
        name: "jdtls",
        display: "Eclipse JDT Language Server",
        kind: LanguageServer,
        commands: &["jdtls"],
        method: Method::Release {
            source: ReleaseSource::EclipseJdtls,
            assets: &[
                any_arch(Mac, "jdt-language-server-*.tar.gz"),
                any_arch(Linux, "jdt-language-server-*.tar.gz"),
                any_arch(Windows, "jdt-language-server-*.tar.gz"),
            ],
            locate: &["jdtls", "jdtls.bat"],
        },
        version: V,
        homepage: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
        needs: &[],
    },
    ToolSpec {
        name: "java-debug",
        display: "Java Debugger (Microsoft java-debug)",
        kind: Debugger,
        commands: &["com.microsoft.java.debug.plugin.jar"],
        // The jdtls bundle from vscode-java-debug (java-debug itself is EPL-1.0).
        method: Method::Release {
            source: ReleaseSource::OpenVsx { namespace: "vscjava", extension: "vscode-java-debug" },
            assets: &[
                any_arch(Mac, "vscjava.vscode-java-debug-*.vsix"),
                any_arch(Linux, "vscjava.vscode-java-debug-*.vsix"),
                any_arch(Windows, "vscjava.vscode-java-debug-*.vsix"),
            ],
            locate: &["com.microsoft.java.debug.plugin-*.jar"],
        },
        version: V,
        homepage: "https://github.com/microsoft/java-debug",
        needs: &[],
    },
    ToolSpec {
        name: "lombok",
        display: "Lombok (jdtls agent)",
        kind: Plugin,
        commands: &["lombok.jar"],
        // Newer than the Lombok a project pins: old ones fail inside current ECJ.
        method: Method::Release {
            source: ReleaseSource::MavenCentral { group: "org.projectlombok", artifact: "lombok" },
            assets: &[
                any_arch(Mac, "lombok-*.jar"),
                any_arch(Linux, "lombok-*.jar"),
                any_arch(Windows, "lombok-*.jar"),
            ],
            locate: &["lombok.jar"],
        },
        version: V,
        homepage: "https://projectlombok.org",
        needs: &[],
    },
    ToolSpec {
        name: "kotlin-lsp",
        display: "Kotlin LSP (JetBrains)",
        kind: LanguageServer,
        commands: &["kotlin-lsp"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "Kotlin/kotlin-lsp" },
            assets: &[
                rule(Mac, Arm64, "kotlin-lsp-*-mac-aarch64.zip"),
                rule(Mac, X64, "kotlin-lsp-*-mac-x64.zip"),
                rule(Linux, X64, "kotlin-lsp-*-linux-x64.zip"),
                rule(Linux, Arm64, "kotlin-lsp-*-linux-aarch64.zip"),
                rule(Windows, X64, "kotlin-lsp-*-win-x64.zip"),
                // Older releases ship one platform-independent archive.
                any_arch(Mac, "kotlin-*.zip"),
                any_arch(Linux, "kotlin-*.zip"),
                any_arch(Windows, "kotlin-*.zip"),
            ],
            locate: &["kotlin-lsp", "kotlin-lsp.sh", "kotlin-lsp.cmd"],
        },
        version: V,
        homepage: "https://github.com/Kotlin/kotlin-lsp",
        needs: &[],
    },
    // ElixirLS ships launcher scripts only: on first start they build the server
    // with the Elixir / OTP found for the project (Mix.install, needs network).
    ToolSpec {
        name: "elixir-ls",
        display: "ElixirLS",
        kind: LanguageServer,
        commands: &["elixir-ls"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "elixir-lsp/elixir-ls" },
            assets: ELIXIR_LS_ASSETS,
            locate: &["language_server.sh", "language_server.bat"],
        },
        version: V,
        homepage: "https://github.com/elixir-lsp/elixir-ls",
        needs: ELIXIR,
    },
    ToolSpec {
        name: "elixir-ls-debugger",
        display: "ElixirLS Debugger",
        kind: Debugger,
        commands: &["elixir-ls-debugger"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "elixir-lsp/elixir-ls" },
            assets: ELIXIR_LS_ASSETS,
            locate: &["debug_adapter.sh", "debug_adapter.bat"],
        },
        version: V,
        homepage: "https://github.com/elixir-lsp/elixir-ls",
        needs: ELIXIR,
    },
    ToolSpec {
        name: "buf",
        display: "Buf (Protocol Buffers)",
        kind: LanguageServer,
        commands: &["buf"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "bufbuild/buf" },
            assets: &[
                rule(Mac, Arm64, "buf-Darwin-arm64.tar.gz"),
                rule(Mac, X64, "buf-Darwin-x86_64.tar.gz"),
                rule(Linux, X64, "buf-Linux-x86_64.tar.gz"),
                rule(Linux, Arm64, "buf-Linux-aarch64.tar.gz"),
                rule(Windows, X64, "buf-Windows-x86_64.zip"),
                rule(Windows, Arm64, "buf-Windows-arm64.zip"),
            ],
            locate: &["buf"],
        },
        version: ver("buf"),
        homepage: "https://buf.build",
        needs: &[],
    },
    ToolSpec {
        name: "clojure-lsp",
        display: "clojure-lsp",
        kind: LanguageServer,
        commands: &["clojure-lsp"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "clojure-lsp/clojure-lsp" },
            assets: &[
                rule(Mac, Arm64, "clojure-lsp-native-macos-aarch64.zip"),
                rule(Mac, X64, "clojure-lsp-native-macos-amd64.zip"),
                rule(Linux, X64, "clojure-lsp-native-linux-amd64.zip"),
                rule(Linux, Arm64, "clojure-lsp-native-linux-aarch64.zip"),
                rule(Windows, X64, "clojure-lsp-native-windows-amd64.zip"),
            ],
            locate: &["clojure-lsp"],
        },
        version: V,
        homepage: "https://clojure-lsp.io",
        needs: &[],
    },
    ToolSpec {
        name: "texlab",
        display: "TexLab (LaTeX)",
        kind: LanguageServer,
        commands: &["texlab"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "latex-lsp/texlab" },
            assets: &[
                rule(Mac, Arm64, "texlab-aarch64-macos.tar.gz"),
                rule(Mac, X64, "texlab-x86_64-macos.tar.gz"),
                rule(Linux, X64, "texlab-x86_64-linux.tar.gz"),
                rule(Linux, Arm64, "texlab-aarch64-linux.tar.gz"),
                rule(Windows, X64, "texlab-x86_64-windows.zip"),
                rule(Windows, Arm64, "texlab-aarch64-windows.zip"),
            ],
            locate: &["texlab"],
        },
        version: ver("texlab"),
        homepage: "https://github.com/latex-lsp/texlab",
        needs: &[],
    },
    ToolSpec {
        name: "neocmakelsp",
        display: "neocmakelsp (CMake)",
        kind: LanguageServer,
        commands: &["neocmakelsp"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "Decodetalkers/neocmakelsp" },
            assets: &[
                any_arch(Mac, "neocmakelsp-universal-apple-darwin.tar.gz"),
                rule(Linux, X64, "neocmakelsp-x86_64-unknown-linux-gnu.tar.gz"),
                rule(Linux, Arm64, "neocmakelsp-aarch64-unknown-linux-gnu.tar.gz"),
                rule(Windows, X64, "neocmakelsp-x86_64-pc-windows-msvc.zip"),
                rule(Windows, Arm64, "neocmakelsp-aarch64-pc-windows-msvc.zip"),
            ],
            locate: &["neocmakelsp"],
        },
        version: ver("neocmakelsp"),
        homepage: "https://github.com/Decodetalkers/neocmakelsp",
        needs: &[],
    },
    ToolSpec {
        name: "lemminx",
        display: "LemMinX (XML)",
        kind: LanguageServer,
        commands: &["lemminx"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "redhat-developer/vscode-xml" },
            assets: &[
                rule(Mac, Arm64, "lemminx-osx-aarch_64.zip"),
                rule(Mac, X64, "lemminx-osx-x86_64.zip"),
                rule(Linux, X64, "lemminx-linux-x86_64.zip"),
                rule(Linux, Arm64, "lemminx-linux-aarch_64.zip"),
                rule(Windows, X64, "lemminx-win32.zip"),
            ],
            locate: &["lemminx-*"],
        },
        version: V,
        homepage: "https://github.com/eclipse/lemminx",
        needs: &[],
    },
    ToolSpec {
        name: "perlnavigator",
        display: "Perl Navigator",
        kind: LanguageServer,
        commands: &["perlnavigator"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "bscan/PerlNavigator" },
            assets: &[
                any_arch(Mac, "perlnavigator-macos-x86_64.zip"),
                rule(Linux, X64, "perlnavigator-linux-x86_64.zip"),
                rule(Windows, X64, "perlnavigator-win-x86_64.zip"),
            ],
            locate: &["perlnavigator"],
        },
        version: V,
        homepage: "https://github.com/bscan/PerlNavigator",
        needs: &[("perl", "Perl is required (https://www.perl.org/get.html)")],
    },
    ToolSpec {
        name: "kotlin-language-server",
        display: "Kotlin Language Server (fwcd)",
        kind: LanguageServer,
        commands: &["kotlin-language-server"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "fwcd/kotlin-language-server" },
            assets: &[any_arch(Mac, "server.zip"), any_arch(Linux, "server.zip"), any_arch(Windows, "server.zip")],
            locate: &["kotlin-language-server"],
        },
        version: V,
        homepage: "https://github.com/fwcd/kotlin-language-server",
        needs: JAVA,
    },
    ToolSpec {
        name: "kotlin-debug-adapter",
        display: "Kotlin Debug Adapter",
        kind: Debugger,
        commands: &["kotlin-debug-adapter"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "fwcd/kotlin-debug-adapter" },
            assets: &[any_arch(Mac, "adapter.zip"), any_arch(Linux, "adapter.zip"), any_arch(Windows, "adapter.zip")],
            locate: &["kotlin-debug-adapter"],
        },
        version: V,
        homepage: "https://github.com/fwcd/kotlin-debug-adapter",
        needs: JAVA,
    },
    ToolSpec {
        name: "netcoredbg",
        display: "netcoredbg (.NET debugger)",
        kind: Debugger,
        commands: &["netcoredbg"],
        method: Method::Release {
            source: ReleaseSource::GitHub { repo: "Samsung/netcoredbg" },
            assets: &[
                rule(Mac, Arm64, "netcoredbg-osx-arm64.zip"),
                rule(Linux, X64, "netcoredbg-linux-amd64.tar.gz"),
                rule(Linux, Arm64, "netcoredbg-linux-arm64.tar.gz"),
                rule(Windows, X64, "netcoredbg-win64.zip"),
            ],
            locate: &["netcoredbg"],
        },
        version: V,
        homepage: "https://github.com/Samsung/netcoredbg",
        needs: &[],
    },
    ToolSpec {
        name: "bash-debug",
        display: "Bash Debug",
        kind: Debugger,
        commands: &["bash-debug-adapter"],
        method: Method::Release {
            source: ReleaseSource::OpenVsx { namespace: "rogalmic", extension: "bash-debug" },
            assets: &[
                any_arch(Mac, "rogalmic.bash-debug-*.vsix"),
                any_arch(Linux, "rogalmic.bash-debug-*.vsix"),
                any_arch(Windows, "rogalmic.bash-debug-*.vsix"),
            ],
            locate: &["bashDebug.js"],
        },
        version: V,
        homepage: "https://github.com/rogalmic/vscode-bash-debug",
        needs: NODE,
    },
    ToolSpec {
        name: "php-debug",
        display: "PHP Debug (Xdebug)",
        kind: Debugger,
        commands: &["php-debug-adapter"],
        method: Method::Release {
            source: ReleaseSource::OpenVsx { namespace: "xdebug", extension: "php-debug" },
            assets: &[
                any_arch(Mac, "xdebug.php-debug-*.vsix"),
                any_arch(Linux, "xdebug.php-debug-*.vsix"),
                any_arch(Windows, "xdebug.php-debug-*.vsix"),
            ],
            locate: &["phpDebug.js"],
        },
        version: V,
        homepage: "https://github.com/xdebug/vscode-php-debug",
        needs: NODE,
    },
    ToolSpec {
        name: "ruby-lsp",
        display: "Ruby LSP (Shopify)",
        kind: LanguageServer,
        commands: &["ruby-lsp"],
        method: Method::Gem { gem: "ruby-lsp" },
        version: V,
        homepage: "https://shopify.github.io/ruby-lsp",
        needs: &[],
    },
    ToolSpec {
        name: "solargraph",
        display: "Solargraph (Ruby)",
        kind: LanguageServer,
        commands: &["solargraph"],
        method: Method::Gem { gem: "solargraph" },
        version: ver("solargraph"),
        homepage: "https://solargraph.org",
        needs: &[],
    },
    ToolSpec {
        name: "csharp-ls",
        display: "csharp-ls",
        kind: LanguageServer,
        commands: &["csharp-ls"],
        method: Method::DotnetTool { package: "csharp-ls" },
        version: V,
        homepage: "https://github.com/razzmatazz/csharp-language-server",
        needs: &[],
    },
    ToolSpec {
        name: "fsautocomplete",
        display: "FsAutoComplete (F#)",
        kind: LanguageServer,
        commands: &["fsautocomplete"],
        method: Method::DotnetTool { package: "fsautocomplete" },
        version: V,
        homepage: "https://github.com/ionide/FsAutoComplete",
        needs: &[],
    },
];

/// Plugin tools and the tool that loads them.
pub const PLUGIN_HOSTS: &[(&str, &str)] = &[("lombok", "jdtls")];

pub fn find(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique() {
        let mut names: Vec<_> = TOOLS.iter().map(|t| t.name).collect();
        names.sort_unstable();
        let len = names.len();
        names.dedup();
        assert_eq!(names.len(), len);
    }

    #[test]
    fn registry_names_match_language_configs() {
        let langs = ide_language::LanguageRegistry::load(None).unwrap().all();
        let mut known = std::collections::HashSet::new();
        for l in &langs {
            for s in &l.language_servers {
                known.insert((s.name.clone(), s.command.clone()));
            }
            if let Some(d) = &l.debugger {
                known.insert((d.adapter.clone(), d.command.clone()));
            }
        }
        for t in TOOLS.iter().filter(|t| t.kind != Plugin) {
            assert!(
                known.contains(&(t.name.to_string(), t.commands[0].to_string())),
                "{} / {} is not referenced by languages/*.toml",
                t.name,
                t.commands[0]
            );
        }
    }

    #[test]
    fn plugins_have_a_known_host() {
        for t in TOOLS.iter().filter(|t| t.kind == Plugin) {
            let host = PLUGIN_HOSTS.iter().find(|(p, _)| *p == t.name).map(|(_, h)| *h);
            assert!(host.and_then(find).is_some(), "{} has no known host", t.name);
        }
    }

    #[test]
    fn every_release_tool_covers_mac_linux_windows() {
        for t in TOOLS {
            if let Method::Release { assets, .. } = t.method {
                for os in [Mac, Linux, Windows] {
                    assert!(assets.iter().any(|r| r.os == os), "{} has no {os:?} asset", t.name);
                }
            }
        }
    }
}
