use regex_syntax::hir::{Hir, HirKind};

pub(crate) const MAX_PATTERN_LEN: usize = 512;
const NAME_LEN: u64 = 256;
const MAX_COST: u64 = 4 * NAME_LEN * NAME_LEN;

const UNSUPPORTED: &[(&str, &str)] = &[
    ("\\A", "\\A"),
    ("\\z", "\\z"),
    ("\\Z", "\\Z"),
    ("\\p", "\\p"),
    ("\\P", "\\P"),
    ("[[:", "a POSIX class"),
    ("&&", "class intersection"),
    ("~~", "class symmetric difference"),
];

pub(crate) fn validate_pattern(pattern: &str) -> Result<(), String> {
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(format!("pattern {pattern:?} is too long (max {MAX_PATTERN_LEN})"));
    }
    if let Some(construct) = unsupported_construct(pattern) {
        return Err(format!("pattern {pattern:?}: {construct} is not supported"));
    }
    let hir = regex_syntax::Parser::new().parse(pattern).map_err(|e| format!("invalid pattern {pattern:?}: {e}"))?;
    match cost(&hir) {
        Err(why) => Err(format!("pattern {pattern:?}: {why} is not supported")),
        Ok(c) if c > MAX_COST => Err(format!("pattern {pattern:?} is too complex: too many ways to match one name")),
        Ok(_) => Ok(()),
    }
}

fn unsupported_construct(pattern: &str) -> Option<&'static str> {
    if pattern.match_indices("(?").any(|(at, _)| !pattern[at + 2..].starts_with(':')) {
        return Some("an inline flag, lookaround or named group");
    }
    UNSUPPORTED.iter().find(|(needle, _)| pattern.contains(needle)).map(|(_, what)| *what)
}

fn cost(hir: &Hir) -> Result<u64, &'static str> {
    match hir.kind() {
        HirKind::Empty | HirKind::Literal(_) | HirKind::Class(_) | HirKind::Look(_) => Ok(1),
        HirKind::Capture(c) => cost(&c.sub),
        HirKind::Concat(items) => items.iter().try_fold(1u64, |acc, h| Ok(acc.saturating_mul(cost(h)?))),
        HirKind::Alternation(items) => items.iter().try_fold(0u64, |acc, h| Ok(acc.saturating_add(cost(h)?))),
        HirKind::Repetition(r) => match r.max {
            None if matches!(r.sub.kind(), HirKind::Literal(_) | HirKind::Class(_)) => Ok(NAME_LEN),
            None => Err("a repeated group (`(…)*`, `(…)+`)"),
            Some(max) => Ok(cost(&r.sub)?.saturating_add(1).saturating_pow(max)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(pattern: &str) -> String {
        validate_pattern(pattern).unwrap_err()
    }

    #[test]
    fn accepts_typical_file_name_patterns() {
        for pattern in [
            r"^(architecture|ARCHITECTURE)(\.(md|rst|txt))?$",
            r"(main|workflow|ci|release|build|config)\.ya?ml$",
            r"^[a-z]+\.d\.ts$",
            r"^\.?eslintrc(\.(js|cjs|json|ya?ml))?$",
            r"^.*\.config\.[cm]?[jt]s$",
            r"^.*-(test|spec)\..*$",
            r"^[0-9]{4}-[0-9]{2}\.log$",
        ] {
            assert!(validate_pattern(pattern).is_ok(), "{pattern}: {:?}", validate_pattern(pattern));
        }
    }

    #[test]
    fn rejects_patterns_that_backtrack_catastrophically() {
        assert!(err(r"(a+)+$").contains("repeated group"));
        assert!(err(r"(?:a*)*").contains("repeated group"));
        assert!(err(r"^(\w|\w\w)*!$").contains("repeated group"));
        assert!(err(r"^(a|aa)+$").contains("repeated group"));
        assert!(err(r"^.*.*.*x$").contains("too complex"));
        assert!(err(r"^(a?){30}a{30}$").contains("too complex"));
        assert!(err(&format!("^{}b$", "(a|aa)".repeat(20))).contains("too complex"));
        assert!(err(r"x{0,40}").contains("too complex"));
    }

    #[test]
    fn rejects_constructs_javascript_reads_differently() {
        assert!(err(r"(?i)readme").contains("not supported"));
        assert!(err(r"(?P<n>a)").contains("not supported"));
        assert!(err(r"\Areadme").contains("not supported"));
        assert!(err(r"readme\z").contains("not supported"));
        assert!(err(r"\p{L}").contains("not supported"));
        assert!(err(r"[[:alpha:]]").contains("not supported"));
        assert!(err(r"[a-z&&[^x]]").contains("not supported"));
    }

    #[test]
    fn rejects_invalid_and_oversized_patterns() {
        assert!(err("(").contains("invalid pattern"));
        assert!(err(&"a".repeat(MAX_PATTERN_LEN + 1)).contains("too long"));
    }
}
