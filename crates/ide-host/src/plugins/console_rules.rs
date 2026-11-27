//! Console highlight rules (API 1.12, `ui.set-console-rules`): validated here,
//! matched by the windows with JavaScript's backtracking `RegExp`. A rule is
//! refused unless its worst case on a line of [`LINE_LEN`] characters stays
//! within [`MAX_STEPS`] backtracking steps, estimated from its structure.

use ide_plugin::ConsoleRule;
use regex_syntax::hir::{Class, ClassUnicode, ClassUnicodeRange, Hir, HirKind, Look};

pub(crate) const MAX_RULES: usize = 100;
/// The characters of a line the windows match rules against (`src/ui/consoleRules.ts`).
const LINE_LEN: u64 = 2000;
/// About 4 · 2000², a few milliseconds of `RegExp` work for one line.
const MAX_STEPS: u64 = 4 * LINE_LEN * LINE_LEN;

const COLORS: &[&str] = &["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const STYLES: &[&str] = &["bold", "italic", "underline", "strikethrough", "dim"];

/// Validates every rule and drops colours and styles this host doesn't know.
pub(crate) fn normalize(rules: Vec<ConsoleRule>) -> Result<Vec<ConsoleRule>, String> {
    if rules.len() > MAX_RULES {
        return Err(format!("at most {MAX_RULES} console rules"));
    }
    rules
        .into_iter()
        .enumerate()
        .map(|(i, rule)| {
            validate_pattern(&rule.pattern, rule.ignore_case).map_err(|e| format!("console rule {i}: {e}"))?;
            let mut styles: Vec<String> = Vec::new();
            for style in rule.styles {
                if STYLES.contains(&style.as_str()) && !styles.contains(&style) {
                    styles.push(style);
                }
            }
            Ok(ConsoleRule {
                foreground: rule.foreground.filter(|c| known_color(c)),
                background: rule.background.filter(|c| known_color(c)),
                styles,
                ..rule
            })
        })
        .collect()
}

fn known_color(name: &str) -> bool {
    COLORS.contains(&name.strip_prefix("bright-").unwrap_or(name))
}

fn validate_pattern(pattern: &str, ignore_case: bool) -> Result<(), String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    if pattern.len() > super::icon_patterns::MAX_PATTERN_LEN {
        return Err(format!("pattern {pattern:?} is too long (max {})", super::icon_patterns::MAX_PATTERN_LEN));
    }
    if let Some(construct) = super::icon_patterns::unsupported_construct(pattern) {
        return Err(format!("pattern {pattern:?}: {construct} is not supported"));
    }
    let parse = |p: &str| {
        regex_syntax::ParserBuilder::new()
            .case_insensitive(ignore_case)
            .build()
            .parse(p)
            .map_err(|e| format!("invalid pattern {pattern:?}: {e}"))
    };
    parse(pattern)?;
    let hir = parse(&javascript_classes(pattern))?;
    let anchored = starts_anchored(&hir);
    let cost = cost(&hir, &ClassUnicode::empty(), true)
        .map_err(|why| format!("pattern {pattern:?}: {why} is not supported"))?;
    let starts = if anchored { 1 } else { LINE_LEN };
    if cost.work.saturating_mul(starts) > MAX_STEPS {
        return Err(format!(
            "pattern {pattern:?} could take too long on a long line: avoid two repetitions that can match the same text (`.*a.*b`, `\\w+\\w+`); a class such as `[^)]*` often helps"
        ));
    }
    Ok(())
}

fn starts_anchored(hir: &Hir) -> bool {
    match hir.kind() {
        HirKind::Look(Look::Start) => true,
        HirKind::Capture(c) => starts_anchored(&c.sub),
        HirKind::Concat(items) => items.first().is_some_and(starts_anchored),
        HirKind::Alternation(items) => items.iter().all(starts_anchored),
        _ => false,
    }
}

/// From one start: `ways` the expression can end (each a backtracking point for
/// what follows) and the `work` of trying them all when what follows fails.
/// `scan`: the work is one pass over a run of characters.
#[derive(Clone, Copy)]
struct Cost {
    ways: u64,
    work: u64,
    scan: bool,
}

const ONE: Cost = Cost { ways: 1, work: 1, scan: false };

/// `follow`: the characters what comes after `hir` can start with (empty when
/// only assertions follow). `last`: nothing follows, so the first way to end is the match.
fn cost(hir: &Hir, follow: &ClassUnicode, last: bool) -> Result<Cost, &'static str> {
    match hir.kind() {
        HirKind::Empty | HirKind::Literal(_) | HirKind::Class(_) | HirKind::Look(_) => Ok(ONE),
        HirKind::Capture(c) => cost(&c.sub, follow, last),
        HirKind::Concat(items) => {
            let mut total = Cost { ways: 1, work: 0, scan: false };
            let mut fixed = false;
            let mut scanned = None;
            for (i, item) in items.iter().enumerate() {
                let rest = &items[i + 1..];
                // Nothing after this can fail: the first way to end is the match.
                if last && rest.is_empty() && nullable(item) {
                    total.work = total.work.saturating_add(total.ways);
                    break;
                }
                let next = first_of_seq(rest, follow);
                let c = cost(item, &next, last && rest.is_empty())?;
                // In a run of single characters (`[Ee][Rr]…`) only the first one is tried each way,
                // and runs of one way cover different parts of the line: one pass in all.
                let single = c.ways == 1 && c.work == 1;
                let rescan = c.scan && scanned == Some(total.ways);
                if !(single && fixed) && !rescan {
                    total.work = total.work.saturating_add(total.ways.saturating_mul(c.work));
                }
                fixed = single;
                if c.scan {
                    scanned = Some(total.ways);
                }
                total.ways = total.ways.saturating_mul(c.ways);
            }
            Ok(Cost { ways: total.ways, work: total.work.max(1), scan: false })
        }
        HirKind::Alternation(items) => items.iter().try_fold(Cost { ways: 0, work: 0, scan: false }, |acc, h| {
            let c = cost(h, follow, last)?;
            Ok(Cost { ways: acc.ways.saturating_add(c.ways), work: acc.work.saturating_add(c.work), scan: false })
        }),
        HirKind::Repetition(r) => match r.max {
            None if matches!(r.sub.kind(), HirKind::Literal(_) | HirKind::Class(_)) => {
                // A run that what follows can't start inside ends in one place.
                let ways = if overlaps(&first(&r.sub), follow) { LINE_LEN } else { 1 };
                Ok(Cost { ways, work: LINE_LEN, scan: true })
            }
            None => Err("a repeated group (`(…)*`, `(…)+`)"),
            Some(max) => {
                // Each copy may end in `c.ways` places, and the count itself may vary.
                let c = cost(&r.sub, &union(&first(&r.sub), follow), false)?;
                let ways = c.ways.saturating_pow(max).saturating_mul(u64::from(max - r.min) + 1);
                Ok(Cost { ways, work: ways.saturating_mul(c.work).saturating_add(u64::from(max)), scan: false })
            }
        },
    }
}

fn overlaps(a: &ClassUnicode, b: &ClassUnicode) -> bool {
    let mut both = a.clone();
    both.intersect(b);
    !both.ranges().is_empty()
}

/// `pattern` with JavaScript's ASCII-only `\w` and `\d` (Rust's are Unicode), so that
/// `\W` and `\D` include letters such as `é` as they do where the rules run.
fn javascript_classes(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('w') => out.push_str("[0-9A-Za-z_]"),
            Some('W') => out.push_str("[^0-9A-Za-z_]"),
            Some('d') => out.push_str("[0-9]"),
            Some('D') => out.push_str("[^0-9]"),
            Some(next) => {
                out.push('\\');
                out.push(next);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn nullable(hir: &Hir) -> bool {
    hir.properties().minimum_len() == Some(0)
}

/// The characters `hir` can start with (everything, for a byte class).
fn first(hir: &Hir) -> ClassUnicode {
    match hir.kind() {
        HirKind::Empty | HirKind::Look(_) => ClassUnicode::empty(),
        HirKind::Literal(lit) => match std::str::from_utf8(&lit.0).ok().and_then(|s| s.chars().next()) {
            Some(c) => ClassUnicode::new([ClassUnicodeRange::new(c, c)]),
            None => any(),
        },
        HirKind::Class(Class::Unicode(class)) => class.clone(),
        HirKind::Class(Class::Bytes(_)) => any(),
        HirKind::Capture(c) => first(&c.sub),
        HirKind::Repetition(r) => first(&r.sub),
        HirKind::Concat(items) => first_of_seq(items, &ClassUnicode::empty()),
        HirKind::Alternation(items) => items.iter().fold(ClassUnicode::empty(), |acc, h| union(&acc, &first(h))),
    }
}

/// The characters a sequence can start with, then `follow` if it may match nothing.
fn first_of_seq(items: &[Hir], follow: &ClassUnicode) -> ClassUnicode {
    let mut set = ClassUnicode::empty();
    for item in items {
        set = union(&set, &first(item));
        if !nullable(item) {
            return set;
        }
    }
    union(&set, follow)
}

fn union(a: &ClassUnicode, b: &ClassUnicode) -> ClassUnicode {
    let mut out = a.clone();
    out.union(b);
    out
}

fn any() -> ClassUnicode {
    ClassUnicode::new([ClassUnicodeRange::new('\0', char::MAX)])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(pattern: &str) -> ConsoleRule {
        ConsoleRule {
            pattern: pattern.into(),
            ignore_case: false,
            foreground: Some("red".into()),
            background: None,
            styles: Vec::new(),
            whole_line: false,
            enabled: true,
        }
    }

    fn err(pattern: &str) -> String {
        validate_pattern(pattern, false).unwrap_err()
    }

    #[test]
    fn accepts_typical_log_rules() {
        for pattern in [
            r"\[AUDIT\]",
            r"\[(AUDIT|METRIC|TASK-FAIL)\]",
            r"JOB-\d+",
            r"Exception in thread .*",
            r".*ERROR.*",
            r"took \d+(\.\d+)?ms",
            r"\d+\.\d+\.\d+\.\d+",
            r"\w+@\w+\.com",
            r"user=\S+\s+id=\d+",
            r#"^\s*at [^(]*\([^)]*\)$"#,
            r"^\[service-a\].*",
            r"SELECT .* FROM",
            r"\b(GET|POST|PUT|DELETE) /\S*",
            r"\d+(\.\d+){0,3}",
            r"\w+(-\w+){0,4}",
            r"(ERROR|WARN)\b.*$",
        ] {
            assert!(validate_pattern(pattern, false).is_ok(), "{pattern}: {:?}", validate_pattern(pattern, false));
            assert!(validate_pattern(pattern, true).is_ok(), "{pattern} (ignore case)");
        }
    }

    #[test]
    fn rejects_patterns_that_backtrack_for_too_long() {
        // Each takes seconds or more on a 2000-character line in V8.
        assert!(err(r"(a+)+$").contains("repeated group"));
        assert!(err(r"^(a|aa)+b$").contains("repeated group"));
        assert!(err(r"a*a*a*b").contains("too long"));
        assert!(err(r".*a.*b").contains("too long"));
        assert!(err(r"\w+\w+!").contains("too long"));
        assert!(err(r"^(a?){30}a{30}$").contains("too long"));
        // A group before `$` or `\b` is not the end of the pattern: those can still fail.
        assert!(err(r"(x(a+)*)$").contains("repeated group"));
        assert!(err(r"(?:foo|x(a+)*)\b").contains("repeated group"));
        assert!(err(r"^(x\w*\w*\w*)$").contains("too long"));
        // JavaScript's `\W` matches `é` and `\D` matches `٣`, Rust's don't.
        assert!(err(r"\W+é+!").contains("too long"));
        assert!(err(r"[\D]+[٣]+!").contains("too long"));
        assert!(validate_pattern(r"\\w+\\w+!", false).is_ok(), "an escaped backslash, then `w`");
        assert!(validate_pattern(r"[0-9a-f]{32}", false).is_ok());
        // Anchored, the same shape tries one start instead of every position.
        assert!(validate_pattern(r"^\w+\w+!", false).is_ok());
        assert!(err(r"^.*a.*b.*c").contains("too long"));
    }

    #[test]
    fn rejects_constructs_javascript_reads_differently() {
        for pattern in [r"(?i)error", r"(?P<n>a)", r"(?=a)", r"\Aerror", r"error\z", r"\p{L}", r"[[:alpha:]]"] {
            assert!(err(pattern).contains("not supported"), "{pattern}");
        }
        assert!(err("(").contains("invalid pattern"));
        assert!(err("").contains("empty"));
        assert!(err(&"a".repeat(513)).contains("too long"));
    }

    #[test]
    fn normalizing_keeps_known_colours_and_styles_and_bounds_the_list() {
        let mut r = rule("x");
        r.foreground = Some("bright-cyan".into());
        r.background = Some("#ff0000".into());
        r.styles = vec!["bold".into(), "blink".into(), "bold".into(), "dim".into()];
        let out = normalize(vec![r, ConsoleRule { foreground: Some("teal".into()), ..rule("y") }]).unwrap();
        assert_eq!(out[0].foreground.as_deref(), Some("bright-cyan"));
        assert_eq!(out[0].background, None);
        assert_eq!(out[0].styles, ["bold", "dim"]);
        assert_eq!(out[1].foreground, None);

        let e = normalize(vec![rule("ok"), rule(".*a.*b")]).unwrap_err();
        assert!(e.starts_with("console rule 1:"), "{e}");
        assert!(normalize(vec![rule("x"); MAX_RULES]).is_ok());
        assert!(normalize(vec![rule("x"); MAX_RULES + 1]).unwrap_err().contains("at most 100"));
    }
}
