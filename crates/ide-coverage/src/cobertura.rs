//! Cobertura XML reports (`coverage xml` of coverage.py, and many other tools):
//!
//! ```xml
//! <coverage>
//!   <sources><source>/home/runner/work/app/app</source></sources>
//!   <packages><package name="calc"><classes>
//!     <class filename="src/calc/__init__.py">
//!       <methods/>
//!       <lines>
//!         <line number="2" hits="1" branch="true" condition-coverage="50% (1/2)"/>
//! ```
//!
//! A relative `filename` belongs to the first `<source>` it exists under, else to the
//! first `<source>` (whose path may be another machine's; the importer relocates it).
//! Lines repeated under `<methods>` are skipped so their hits don't count twice.

use crate::Accumulator;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::path::{Path, PathBuf};

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == name)
        .and_then(|a| a.normalized_value(XmlVersion::Implicit1_0).ok())
        .map(Into::into)
}

/// `"50% (1/2)"` → `(1, 2)`.
fn conditions(text: &str) -> Option<(u32, u32)> {
    let (_, rest) = text.split_once('(')?;
    let (covered, total) = rest.trim_end_matches(')').split_once('/')?;
    Some((covered.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// `sources` pairs each `<source>` with whether it exists here (asked once: another
/// machine's `/home/…` is slow to look up on macOS).
fn resolve(filename: &str, sources: &[(PathBuf, bool)], base: &Path) -> PathBuf {
    let p = Path::new(filename);
    if p.has_root() {
        return p.to_path_buf();
    }
    sources
        .iter()
        .filter(|(_, here)| *here)
        .map(|(s, _)| s.join(p))
        .find(|c| c.is_file())
        .unwrap_or_else(|| sources.first().map_or_else(|| base.join(p), |(s, _)| s.join(p)))
}

/// Relative sources (and filenames without sources) resolve against `base`.
pub(crate) fn parse(xml: &str, base: &Path) -> Result<Accumulator, quick_xml::Error> {
    let mut reader = Reader::from_str(xml);
    let mut acc = Accumulator::default();
    let mut sources: Vec<(PathBuf, bool)> = Vec::new();
    let mut source: Option<String> = None;
    let mut file: Option<PathBuf> = None;
    let mut in_methods = false;
    loop {
        match reader.read_event()? {
            Event::Start(e) if e.name().as_ref() == "methods" => in_methods = true,
            Event::Start(e) | Event::Empty(e) => match e.name().as_ref() {
                "source" => source = Some(String::new()),
                "class" => {
                    let path = resolve(&attr(&e, "filename").unwrap_or_default(), &sources, base);
                    acc.file(&path);
                    file = Some(path);
                }
                "line" if !in_methods => {
                    let Some(path) = &file else { continue };
                    let Some(number) = attr(&e, "number").and_then(|n| n.parse::<u32>().ok()) else { continue };
                    let line = number.saturating_sub(1);
                    acc.line(path, line, attr(&e, "hits").and_then(|h| h.parse().ok()).unwrap_or(0));
                    if attr(&e, "branch").as_deref() == Some("true")
                        && let Some((covered, total)) = attr(&e, "condition-coverage").as_deref().and_then(conditions)
                    {
                        acc.has_branches = true;
                        for i in 0..total {
                            acc.branch(path, line, i.to_string(), i < covered);
                        }
                    }
                }
                _ => {}
            },
            Event::Text(t) => {
                if let Some(s) = &mut source {
                    s.push_str(t.as_ref());
                }
            }
            Event::GeneralRef(r) => {
                if let Some(s) = &mut source {
                    s.push('&');
                    s.push_str(r.as_ref());
                    s.push(';');
                }
            }
            Event::End(e) => match e.name().as_ref() {
                "source" => {
                    let raw = source.take().unwrap_or_default();
                    let text = quick_xml::escape::unescape(raw.trim()).map(|t| t.into_owned()).unwrap_or(raw);
                    if !text.is_empty() {
                        let path = Path::new(&text);
                        // Joining a drive-less foreign root on Windows would add the checkout's drive.
                        let dir = if path.has_root() { path.to_path_buf() } else { base.join(path) };
                        let here = dir.is_dir();
                        sources.push((dir, here));
                    }
                }
                "methods" => in_methods = false,
                "class" => file = None,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lines_branches_and_skips_method_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let second = tmp.path().join("b&c");
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(second.join("m.py"), "").unwrap();
        let xml = format!(
            r#"<?xml version="1.0" ?>
<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage><sources><source>/elsewhere/a</source><source>{}</source></sources>
<packages><package name="p"><classes>
  <class name="m" filename="m.py">
    <methods><method name="f"><lines><line number="2" hits="5"/></lines></method></methods>
    <lines>
      <line number="1" hits="1"/>
      <line number="2" hits="5" branch="true" condition-coverage="50% (1/2)" missing-branches="3"/>
      <line number="3" hits="0"/>
    </lines>
  </class>
  <class name="n" filename="n.py"><lines><line number="1" hits="0"/></lines></class>
  <class name="abs" filename="/abs/x.py"><lines><line number="7" hits="2"/></lines></class>
</classes></package></packages></coverage>"#,
            tmp.path().join("b&amp;c").display()
        );
        let suite = parse(&xml, tmp.path()).unwrap().finish("Cobertura");
        assert!(suite.has_branches);
        assert_eq!(suite.files.len(), 3);
        let file = |path: &Path| suite.files.iter().find(|f| f.path.as_ref() as &Path == path).unwrap();
        // `m.py` exists under the second source; `n.py` falls back to the first.
        let m = file(&second.join("m.py"));
        assert_eq!(file(Path::new("/elsewhere/a/n.py")).lines[0].hits, 0);
        assert_eq!(
            m.lines.iter().map(|l| (l.line, l.hits, l.branches_total, l.branches_covered)).collect::<Vec<_>>(),
            [(0, 1, 0, 0), (1, 5, 2, 1), (2, 0, 0, 0)]
        );
        assert!(m.lines[1].partial());
        assert_eq!(file(Path::new("/abs/x.py")).lines[0].line, 6);
        assert!(parse("<coverage><packages></coverage>", Path::new("/root")).is_err());
    }

    #[test]
    fn filenames_without_sources_resolve_against_the_base() {
        let xml = r#"<coverage><packages><package><classes><class filename="a/b.py"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>"#;
        let suite = parse(xml, Path::new("/root")).unwrap().finish("Cobertura");
        assert_eq!(suite.files[0].path.as_ref() as &Path, Path::new("/root/a/b.py"));
        assert!(!suite.has_branches);
        assert_eq!(conditions("100% (4/4)"), Some((4, 4)));
        assert_eq!(conditions("100%"), None);
    }
}
