//! Projects that live inside a WSL distro are reached from Windows through the
//! `\\wsl.localhost\<distro>` (or legacy `\\wsl$\<distro>`) share.

use std::path::Path;

/// The WSL launcher on Windows.
pub const EXE: &str = "wsl.exe";

/// A location inside a WSL distro.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WslPath {
    pub distro: String,
    /// Absolute Linux path, e.g. `/home/me/app`.
    pub path: String,
}

/// Splits a WSL share path into distro and Linux path. Pure string work, so it
/// accepts every spelling the UI and the OS produce: `\\wsl.localhost\X\a`,
/// `//wsl$/X/a` and the verbatim `\\?\UNC\wsl.localhost\X\a`.
pub fn parse(path: &Path) -> Option<WslPath> {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = match s.strip_prefix("//?/UNC/") {
        Some(rest) => format!("//{rest}"),
        None => s,
    };
    let rest = s.strip_prefix("//")?;
    let (host, rest) = rest.split_once('/')?;
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let (distro, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if distro.is_empty() {
        return None;
    }
    Some(WslPath { distro: distro.to_owned(), path: format!("/{}", tail.trim_end_matches('/')) })
}

/// A distro name `wsl.exe -d` can be given safely: Windows creates them from letters, digits,
/// `.`, `_` and `-`. A leading `-` would be read as an option, so it is refused too.
pub fn is_valid_distro(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Text of `wsl.exe`'s own output: UTF-16LE (with or without BOM) for its management commands
/// and its error messages, UTF-8 for what a command inside the distro prints.
pub fn decode_output(raw: &[u8]) -> String {
    if raw.starts_with(&[0xff, 0xfe]) || raw.get(1) == Some(&0) {
        let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(raw).into_owned()
    }
}

/// Distro names from the output of `wsl.exe -l -q`. That output is UTF-16LE (UTF-8 when
/// `WSL_UTF8=1`), one name per line; names that fail [`is_valid_distro`] are dropped, which also
/// removes the localized "no installed distributions" message `wsl.exe` prints when there are none.
pub fn parse_distro_list(raw: &[u8]) -> Vec<String> {
    let text = decode_output(raw);
    let mut names: Vec<String> = Vec::new();
    for line in text.lines() {
        let name = line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        if is_valid_distro(name) && !names.iter().any(|n| n == name) {
            names.push(name.to_owned());
        }
    }
    names
}

/// Installed WSL distros. Empty off Windows, when WSL is not installed or when `wsl.exe` fails.
pub fn list_distros() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new(EXE);
        cmd.args(["-l", "-q"]);
        crate::process::prepare(&mut cmd);
        return match cmd.output() {
            Ok(out) if out.status.success() => parse_distro_list(&out.stdout),
            _ => Vec::new(),
        };
    }
    #[cfg(not(windows))]
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Option<(String, String)> {
        parse(Path::new(s)).map(|w| (w.distro, w.path))
    }

    #[test]
    fn every_spelling_of_the_share_is_recognised() {
        let want = Some(("Ubuntu-24.04".to_owned(), "/home/me/app".to_owned()));
        assert_eq!(p(r"\\wsl.localhost\Ubuntu-24.04\home\me\app"), want);
        assert_eq!(p("//wsl.localhost/Ubuntu-24.04/home/me/app"), want);
        assert_eq!(p(r"\\wsl$\Ubuntu-24.04\home\me\app\"), want);
        assert_eq!(p(r"\\?\UNC\WSL.LOCALHOST\Ubuntu-24.04\home\me\app"), want);
    }

    #[test]
    fn distro_root_and_foreign_paths() {
        assert_eq!(p(r"\\wsl.localhost\Debian"), Some(("Debian".to_owned(), "/".to_owned())));
        assert_eq!(p(r"\\server\share\a"), None);
        assert_eq!(p(r"\\wsl.localhost\"), None);
        assert_eq!(p("C:/Users/me"), None);
        assert_eq!(p("/home/me"), None);
    }

    fn utf16(s: &str) -> Vec<u8> {
        std::iter::once(0xfeffu16).chain(s.encode_utf16()).flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn distro_list_is_decoded_from_utf16_and_utf8() {
        let want = vec!["Ubuntu-24.04".to_owned(), "Debian".to_owned()];
        assert_eq!(parse_distro_list(&utf16("Ubuntu-24.04\r\nDebian\r\n\r\n")), want);
        assert_eq!(parse_distro_list(b"Ubuntu-24.04\nDebian\nDebian\n"), want);
        assert!(
            parse_distro_list(&utf16("Windows Subsystem for Linux has no installed distributions.\r\n")).is_empty()
        );
        assert!(parse_distro_list(b"").is_empty());
    }

    #[test]
    fn distro_names_cannot_smuggle_options_or_paths() {
        for bad in ["", "-d", "--exec", "a b", "a/b", r"a\b", "a;b", "a$(x)", "a\"b"] {
            assert!(!is_valid_distro(bad), "{bad}");
        }
        assert!(is_valid_distro("Ubuntu-22.04") && is_valid_distro("docker_desktop"));
    }
}
