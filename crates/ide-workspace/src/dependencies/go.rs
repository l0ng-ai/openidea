use super::ManifestDependency;

fn module_path(path: &str) -> bool {
    let Some(domain) = path.split('/').next() else { return false };
    path.len() <= 512
        && domain.contains('.')
        && !domain.starts_with(['.', '-'])
        && path.split('/').all(|part| {
            !part.is_empty()
                && !part.ends_with('.')
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || b"-._~".contains(&c))
        })
}

/// Finds the version at a UTF-16 offset, including incomplete require lines.
pub fn dependency_at(text: &str, offset: u32) -> Option<ManifestDependency> {
    let mut block = None;
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let line_len = line.encode_utf16().count() as u32;
        let code = line.split("//").next()?.trim_end_matches(['\r', '\n']);
        let trimmed = code.trim();
        if offset < start + line_len || offset == start + line_len && !line.ends_with('\n') {
            let body = match block {
                Some("require") => code.trim_start(),
                None => code.trim_start().strip_prefix("require")?.strip_prefix([' ', '\t'])?.trim_start(),
                _ => return None,
            };
            let (path, rest) = body.split_once([' ', '\t'])?;
            let package = path.trim_matches('"');
            if !module_path(package) {
                return None;
            }
            let version = rest.trim_start();
            let token = version.split_ascii_whitespace().next().unwrap_or_default();
            let from = start + code[..code.len() - version.len()].encode_utf16().count() as u32;
            let (requirement, from) = match token.strip_prefix('"') {
                Some(quoted) => (quoted.strip_suffix('"').unwrap_or(quoted), from + 1),
                None => (token, from),
            };
            let to = from + requirement.encode_utf16().count() as u32;
            return (from <= offset && offset <= to).then(|| ManifestDependency {
                package: package.to_owned(),
                requirement: requirement.to_owned(),
                from,
                to,
            });
        }
        if trimmed == ")" {
            block = None;
        } else if block.is_none() {
            block = trimmed.strip_suffix('(').map(str::trim);
        }
        start += line_len;
    }
    None
}

/// Go lists versions in ascending semantic order. Ignore tool output unrelated to versions.
pub fn listed_versions(output: &str) -> Vec<String> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.strip_prefix('v').is_some_and(|version| semver::Version::parse(version).is_ok()))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_blank_partial_and_quoted_require_versions() {
        for (text, package, version) in [
            ("module example.com/m\nrequire golang.org/x/text |", "golang.org/x/text", ""),
            (
                "// 中文 😀\r\nrequire (\r\n\tgithub.com/Org/Lib/v2 v2.|1.0 // indirect\r\n)\r\n",
                "github.com/Org/Lib/v2",
                "v2.1.0",
            ),
            ("require \"rsc.io/quote\" \"v1.|2.0\"", "rsc.io/quote", "v1.2.0"),
        ] {
            let offset = text.split_once('|').unwrap().0.encode_utf16().count() as u32;
            let text = text.replace('|', "");
            let item = dependency_at(&text, offset).unwrap();
            assert_eq!(item.package, package);
            assert_eq!(item.requirement, version);
            let units: Vec<_> = text.encode_utf16().collect();
            assert_eq!(String::from_utf16(&units[item.from as usize..item.to as usize]).unwrap(), version);
        }
    }

    #[test]
    fn ignores_comments_other_directives_and_non_module_arguments() {
        for text in [
            "// require rsc.io/quote v|",
            "require rsc.io/quote v1.2.0 // in|direct",
            "require rsc.io/qu|ote v1.2.0",
            "replace (\n\trsc.io/quote v|\n)",
            "require ../quote v|",
            "require -flag.example v|",
            "require rsc.io/quote@latest v|",
        ] {
            let offset = text.split_once('|').unwrap().0.encode_utf16().count() as u32;
            assert!(dependency_at(&text.replace('|', ""), offset).is_none(), "{text}");
        }
    }

    #[test]
    fn keeps_go_version_spelling_and_prefers_newer_versions() {
        assert_eq!(
            listed_versions("go: notice\nv1.9.0\nv1.10.0-rc.1\nv2.0.0+incompatible\n"),
            ["v2.0.0+incompatible", "v1.10.0-rc.1", "v1.9.0"]
        );
    }
}
