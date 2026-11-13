//! JUnit XML test reports (Maven Surefire / Failsafe `TEST-*.xml`, Gradle
//! `build/test-results/**`): one result per test case, including the passed
//! ones that console output does not list.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TestCaseStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestCaseReport {
    /// Fully qualified class (`com.acme.OrderTest`, nested: `com.acme.OrderTest$Nested`).
    pub class_name: String,
    /// Method name without `()`.
    pub name: String,
    pub status: TestCaseStatus,
    pub duration_ms: Option<f64>,
    /// Failure / error / skip message.
    pub message: Option<String>,
    /// Failure / error stack trace.
    pub output: Option<String>,
    /// What the test printed (`<system-out>`, `<system-err>`).
    pub stdout: Option<String>,
}

fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.find(';').filter(|e| *e <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let ch = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e if e.starts_with("#x") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn attrs(tag: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = tag;
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim().rsplit(char::is_whitespace).next().unwrap_or_default().to_owned();
        let after = rest[eq + 1..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
        let body = &after[1..];
        let Some(close) = body.find(quote) else { break };
        out.push((name, decode(&body[..close])));
        rest = &body[close + 1..];
    }
    out
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn push_text(buf: &mut Option<String>, text: &str) {
    if let Some(b) = buf {
        b.push_str(text);
    }
}

/// Test cases of one report file.
pub fn parse_report(xml: &str) -> Vec<TestCaseReport> {
    let mut out = Vec::new();
    let mut current: Option<TestCaseReport> = None;
    // Text of the open <failure>/<error>/<skipped>/<system-out>/<system-err> element.
    let mut text: Option<String> = None;
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        push_text(&mut text, &decode(&rest[..lt]));
        rest = &rest[lt..];
        if let Some(body) = rest.strip_prefix("<![CDATA[") {
            let end = body.find("]]>").unwrap_or(body.len());
            push_text(&mut text, &body[..end]);
            rest = body.get(end + 3..).unwrap_or_default();
            continue;
        }
        if rest.starts_with("<!--") {
            rest = rest.find("-->").map(|e| &rest[e + 3..]).unwrap_or_default();
            continue;
        }
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[1..gt];
        rest = &rest[gt + 1..];
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            match name.trim() {
                "testcase" => out.extend(current.take()),
                name @ ("failure" | "error" | "rerunFailure" | "rerunError" | "skipped" | "system-out"
                | "system-err") => {
                    if let (Some(t), Some(c)) = (text.take(), current.as_mut()) {
                        let t = t.trim_matches('\n');
                        if !t.trim().is_empty() {
                            let field = if name.starts_with("system-") { &mut c.stdout } else { &mut c.output };
                            let o = field.get_or_insert_with(String::new);
                            if !o.is_empty() {
                                o.push('\n');
                            }
                            o.push_str(t);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let self_closing = tag.ends_with('/');
        let tag = tag.trim_end_matches('/');
        let name = tag.split(char::is_whitespace).next().unwrap_or_default();
        let a = attrs(&tag[name.len()..]);
        match name {
            "testcase" => {
                out.extend(current.take());
                let class_name = attr(&a, "classname").unwrap_or_default().to_owned();
                let test = attr(&a, "name").unwrap_or_default();
                // JUnit 5 display names may carry the signature: `shouldX()`, `add(int, int)[1]`.
                let base = test.split('(').next().unwrap_or(test).trim().to_owned();
                let duration_ms =
                    attr(&a, "time").and_then(|t| t.replace(',', "").parse::<f64>().ok()).map(|s| s * 1000.0);
                let case = TestCaseReport {
                    class_name,
                    name: if base.is_empty() { test.to_owned() } else { base },
                    status: TestCaseStatus::Passed,
                    duration_ms,
                    message: None,
                    output: None,
                    stdout: None,
                };
                if self_closing {
                    out.push(case);
                } else {
                    current = Some(case);
                }
            }
            "failure" | "error" | "skipped" => {
                if let Some(c) = current.as_mut() {
                    c.status = if name == "skipped" { TestCaseStatus::Skipped } else { TestCaseStatus::Failed };
                    c.message = attr(&a, "message").map(str::to_owned).or_else(|| c.message.take());
                    if !self_closing {
                        text = Some(String::new());
                    }
                }
            }
            // Flaky reruns: the test eventually passed; output only.
            "rerunFailure" | "rerunError" | "system-out" | "system-err" if !self_closing && current.is_some() => {
                text = Some(String::new());
            }
            _ => {}
        }
    }
    out.extend(current.take());
    out
}

/// Report directories of a module: Surefire, Failsafe and Gradle test results.
pub fn report_dirs(module_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![module_dir.join("target/surefire-reports"), module_dir.join("target/failsafe-reports")];
    if let Ok(rd) = std::fs::read_dir(module_dir.join("build/test-results")) {
        let mut tasks: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        tasks.sort();
        dirs.extend(tasks);
    }
    dirs
}

/// Test cases from every `TEST-*.xml` in `dirs` written at or after `since`
/// (reports of earlier runs are ignored).
pub fn read_reports(dirs: &[PathBuf], since: SystemTime) -> Vec<TestCaseReport> {
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("TEST-") && name.ends_with(".xml")) {
                continue;
            }
            let fresh = e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t >= since);
            if fresh {
                files.push(path);
            }
        }
    }
    files.sort();
    files.iter().filter_map(|f| std::fs::read_to_string(f).ok()).flat_map(|xml| parse_report(&xml)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUREFIRE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="com.example.demo.todo.TodoServiceTests" time="0.05" tests="4" errors="0" skipped="1" failures="1">
  <properties>
    <property name="java.version" value="21"/>
  </properties>
  <testcase name="createsAndCompletesTodos" classname="com.example.demo.todo.TodoServiceTests" time="0.031"/>
  <testcase name="deleteReturnsFalseForUnknownId()" classname="com.example.demo.todo.TodoServiceTests" time="0.002">
    <system-out><![CDATA[hello <world>
]]></system-out>
  </testcase>
  <testcase name="fails" classname="com.example.demo.todo.TodoServiceTests" time="1,234.5">
    <failure message="expected: &lt;1&gt; but was: &lt;2&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <1> but was: <2>
	at com.example.demo.todo.TodoServiceTests.fails(TodoServiceTests.java:30)
]]></failure>
    <system-out><![CDATA[printed before failing
]]></system-out>
  </testcase>
  <testcase name="later" classname="com.example.demo.todo.TodoServiceTests" time="0">
    <skipped message="not yet"/>
  </testcase>
</testsuite>
"#;

    #[test]
    fn parses_surefire_reports() {
        let cases = parse_report(SUREFIRE);
        assert_eq!(cases.len(), 4);
        assert_eq!(cases[0].name, "createsAndCompletesTodos");
        assert_eq!(cases[0].class_name, "com.example.demo.todo.TodoServiceTests");
        assert_eq!(cases[0].status, TestCaseStatus::Passed);
        assert_eq!(cases[0].duration_ms, Some(31.0));
        assert_eq!(cases[1].name, "deleteReturnsFalseForUnknownId");
        assert_eq!(cases[1].stdout.as_deref(), Some("hello <world>"));
        assert_eq!(cases[1].output, None);
        assert_eq!(cases[2].status, TestCaseStatus::Failed);
        assert_eq!(cases[2].message.as_deref(), Some("expected: <1> but was: <2>"));
        assert!(cases[2].output.as_deref().unwrap().contains("TodoServiceTests.java:30"));
        assert!(!cases[2].output.as_deref().unwrap().contains("printed"));
        assert_eq!(cases[2].stdout.as_deref(), Some("printed before failing"));
        assert_eq!(cases[2].duration_ms, Some(1_234_500.0));
        assert_eq!(cases[3].status, TestCaseStatus::Skipped);
        assert_eq!(cases[3].message.as_deref(), Some("not yet"));
    }

    #[test]
    fn errors_reruns_and_entities() {
        let xml = r#"<testsuite><testcase classname="a.B$Inner" name="x(int)[1]" time="0.1"><error message="boom &amp; bust">trace &#65;&#x42;</error></testcase>
<testcase classname="a.B" name="flaky" time="0.2"><rerunFailure message="first">t1</rerunFailure></testcase>
<!-- <testcase classname="c.D" name="commented"/> --></testsuite>"#;
        let cases = parse_report(xml);
        assert_eq!(cases.len(), 2);
        assert_eq!(cases[0].class_name, "a.B$Inner");
        assert_eq!(cases[0].name, "x");
        assert_eq!(cases[0].status, TestCaseStatus::Failed);
        assert_eq!(cases[0].message.as_deref(), Some("boom & bust"));
        assert_eq!(cases[0].output.as_deref(), Some("trace AB"));
        assert_eq!(cases[1].status, TestCaseStatus::Passed, "passed on rerun");
        assert!(parse_report("not xml").is_empty());
    }

    #[test]
    fn reads_only_fresh_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let module = tmp.path();
        let dir = module.join("target/surefire-reports");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(module.join("build/test-results/test")).unwrap();
        std::fs::write(dir.join("TEST-a.B.xml"), SUREFIRE).unwrap();
        std::fs::write(dir.join("a.B.txt"), "ignored").unwrap();
        std::fs::write(module.join("build/test-results/test/TEST-c.D.xml"), r#"<testcase classname="c.D" name="g"/>"#)
            .unwrap();
        let dirs = report_dirs(module);
        assert!(dirs.contains(&module.join("build/test-results/test")));
        let all = read_reports(&dirs, SystemTime::UNIX_EPOCH);
        assert_eq!(all.len(), 5);
        let future = SystemTime::now() + std::time::Duration::from_secs(3600);
        assert!(read_reports(&dirs, future).is_empty());
    }
}
