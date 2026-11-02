//! Host platform and release-asset selection.

use serde::Serialize;
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Arch {
    X64,
    Arm64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Platform {
    pub os: Os,
    pub arch: Arch,
}

impl Platform {
    pub fn current() -> Self {
        let os = if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        };
        let arch = if cfg!(target_arch = "aarch64") { Arch::Arm64 } else { Arch::X64 };
        Self { os, arch }
    }

    /// File name of an executable on this platform (`foo` / `foo.exe`).
    pub fn exe(&self, name: &str) -> String {
        if self.os == Os::Windows && !name.contains('.') { format!("{name}.exe") } else { name.to_string() }
    }
}

/// One candidate asset name pattern (`*` matches any run of characters) for
/// an OS and, optionally, one architecture.
#[derive(Clone, Copy, Debug)]
pub struct AssetRule {
    pub os: Os,
    pub arch: Option<Arch>,
    pub pattern: &'static str,
}

pub const fn rule(os: Os, arch: Arch, pattern: &'static str) -> AssetRule {
    AssetRule { os, arch: Some(arch), pattern }
}

pub const fn any_arch(os: Os, pattern: &'static str) -> AssetRule {
    AssetRule { os, arch: None, pattern }
}

/// Picks the asset for `platform`: rules are tried in order and the first
/// rule matching any asset name wins. ARM64 macOS and Windows fall back to x64 assets
/// under OS emulation when no native build exists.
pub fn select_asset<'a>(names: &[&'a str], rules: &[AssetRule], platform: Platform) -> Option<&'a str> {
    let pick = |arch: Arch| {
        rules
            .iter()
            .filter(|r| r.os == platform.os && r.arch.is_none_or(|a| a == arch))
            .find_map(|r| names.iter().copied().find(|n| glob_match(r.pattern, n)))
    };
    pick(platform.arch).or_else(|| {
        (matches!(platform.os, Os::Mac | Os::Windows) && platform.arch == Arch::Arm64)
            .then(|| pick(Arch::X64))
            .flatten()
    })
}

/// Case-insensitive glob with `*` wildcards only.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_ascii_lowercase().chars().collect();
    let t: Vec<char> = text.to_ascii_lowercase().chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && p[pi] != '*' && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC_ARM: Platform = Platform { os: Os::Mac, arch: Arch::Arm64 };
    const MAC_X64: Platform = Platform { os: Os::Mac, arch: Arch::X64 };
    const LINUX_X64: Platform = Platform { os: Os::Linux, arch: Arch::X64 };
    const LINUX_ARM: Platform = Platform { os: Os::Linux, arch: Arch::Arm64 };
    const WIN: Platform = Platform { os: Os::Windows, arch: Arch::X64 };

    #[test]
    fn glob() {
        assert!(glob_match(
            "lua-language-server-*-darwin-arm64.tar.gz",
            "lua-language-server-3.13.5-darwin-arm64.tar.gz"
        ));
        assert!(!glob_match(
            "lua-language-server-*-darwin-arm64.tar.gz",
            "lua-language-server-3.13.5-darwin-x64.tar.gz"
        ));
        assert!(glob_match("clangd-mac-*.zip", "CLANGD-MAC-19.1.2.ZIP"));
        assert!(glob_match("*", ""));
        assert!(glob_match("a*b*c", "aXXbYYc"));
        assert!(!glob_match("a*b*c", "aXXbYY"));
        assert!(glob_match("marksman-macos", "marksman-macos"));
        assert!(!glob_match("marksman-macos", "marksman-macos.sha256"));
    }

    #[test]
    fn lua_assets() {
        let names = [
            "lua-language-server-3.13.5-darwin-arm64.tar.gz",
            "lua-language-server-3.13.5-darwin-x64.tar.gz",
            "lua-language-server-3.13.5-linux-x64.tar.gz",
            "lua-language-server-3.13.5-linux-arm64.tar.gz",
            "lua-language-server-3.13.5-win32-x64.zip",
        ];
        let spec = crate::registry::find("lua-language-server").unwrap();
        let rules = spec.asset_rules();
        assert_eq!(select_asset(&names, rules, MAC_ARM), Some(names[0]));
        assert_eq!(select_asset(&names, rules, MAC_X64), Some(names[1]));
        assert_eq!(select_asset(&names, rules, LINUX_X64), Some(names[2]));
        assert_eq!(select_asset(&names, rules, LINUX_ARM), Some(names[3]));
        assert_eq!(select_asset(&names, rules, WIN), Some(names[4]));
    }

    #[test]
    fn rosetta_fallback_and_missing() {
        let names = ["zls-x86_64-macos.tar.xz", "zls-x86_64-linux.tar.xz", "zls-x86_64-windows.zip"];
        let rules = crate::registry::find("zls").unwrap().asset_rules();
        assert_eq!(select_asset(&names, rules, MAC_ARM), Some(names[0]));
        assert_eq!(select_asset(&names, rules, LINUX_ARM), None);
        assert_eq!(select_asset(&names, rules, WIN), Some(names[2]));
    }

    #[test]
    fn checksum_files_are_not_picked() {
        let names = ["marksman-macos.sha256", "marksman-macos", "marksman-linux-x64", "marksman.exe"];
        let rules = crate::registry::find("marksman").unwrap().asset_rules();
        assert_eq!(select_asset(&names, rules, MAC_ARM), Some("marksman-macos"));
        assert_eq!(select_asset(&names, rules, WIN), Some("marksman.exe"));
    }

    #[test]
    fn rule_order_prefers_earlier_patterns() {
        let names = ["codelldb-aarch64-darwin.vsix", "codelldb-darwin-arm64.vsix", "codelldb-darwin-x64.vsix"];
        let rules = crate::registry::find("codelldb").unwrap().asset_rules();
        assert_eq!(select_asset(&names, rules, MAC_ARM), Some("codelldb-darwin-arm64.vsix"));
        let old = ["codelldb-aarch64-darwin.vsix", "codelldb-x86_64-linux.vsix"];
        assert_eq!(select_asset(&old, rules, MAC_ARM), Some("codelldb-aarch64-darwin.vsix"));
        assert_eq!(select_asset(&old, rules, LINUX_X64), Some("codelldb-x86_64-linux.vsix"));
    }

    #[test]
    fn arm64_native_then_emulated_assets() {
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            let rules = [rule(os, Arch::X64, "tool-x64"), rule(os, Arch::Arm64, "tool-arm64")];
            let platform = Platform { os, arch: Arch::Arm64 };
            assert_eq!(select_asset(&["tool-x64", "tool-arm64"], &rules, platform), Some("tool-arm64"));
            let fallback = if os == Os::Linux { None } else { Some("tool-x64") };
            assert_eq!(select_asset(&["tool-x64"], &rules, platform), fallback);
            assert_eq!(select_asset(&[], &rules, platform), None);
        }
    }

    #[test]
    fn native_windows_release_rules() {
        let platform = Platform { os: Os::Windows, arch: Arch::Arm64 };
        for (tool, asset) in [
            ("zls", "zls-aarch64-windows.zip"),
            ("terraform-ls", "terraform-ls_0.39.1_windows_arm64.zip"),
            ("taplo", "taplo-windows-aarch64.zip"),
            ("buf", "buf-Windows-arm64.zip"),
            ("texlab", "texlab-aarch64-windows.zip"),
            ("neocmakelsp", "neocmakelsp-aarch64-pc-windows-msvc.zip"),
        ] {
            assert_eq!(
                select_asset(&[asset], crate::registry::find(tool).unwrap().asset_rules(), platform),
                Some(asset)
            );
        }
    }

    #[test]
    fn exe_suffix() {
        assert_eq!(WIN.exe("clangd"), "clangd.exe");
        assert_eq!(WIN.exe("jdtls.bat"), "jdtls.bat");
        assert_eq!(MAC_ARM.exe("clangd"), "clangd");
    }
}
