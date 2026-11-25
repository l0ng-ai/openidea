//! Checks `resolve` against parent links a real JVM produced (`fixtures/java/TraceOracle.java`).

use std::path::{Path, PathBuf};
use std::process::Command;

use ide_streams::{BoxKind, Record, TraceValue, resolve, step_kind};

/// How the debuggee would identify the same oracle element.
#[derive(Clone, Copy, Debug)]
enum Mode {
    /// User objects: one id per object.
    Ref,
    /// `Stream<Integer>`: `valueOf` shares boxes inside the Integer cache.
    Boxed,
    /// `IntStream`: every `peek` boxes again, so outside the cache each record has its own box.
    Prim,
}

const MODES: [Mode; 3] = [Mode::Ref, Mode::Boxed, Mode::Prim];
const CACHED_BOX_IDS: u64 = 1 << 32;
const FRESH_BOX_IDS: u64 = 1 << 40;

struct Chain {
    ops: Vec<String>,
    /// `(stage, object id, value)` in time order.
    records: Vec<(u16, u64, i32)>,
    truth: Vec<Option<u32>>,
}

fn parse(line: &str) -> Chain {
    let json: serde_json::Value = serde_json::from_str(line).expect("oracle line is JSON");
    let ops = json["ops"].as_array().expect("ops").iter().map(|o| o.as_str().expect("op").to_owned()).collect();
    let records = json["records"]
        .as_array()
        .expect("records")
        .iter()
        .map(|r| {
            let field = |i: usize| r[i].as_i64().expect("record field");
            (field(0) as u16, field(1) as u64, field(2) as i32)
        })
        .collect();
    let truth = json["truth"]
        .as_array()
        .expect("truth")
        .iter()
        .map(|t| u32::try_from(t.as_i64().expect("truth")).ok())
        .collect();
    Chain { ops, records, truth }
}

fn records(chain: &Chain, mode: Mode) -> Vec<Record> {
    chain
        .records
        .iter()
        .enumerate()
        .map(|(i, &(step, object, v))| {
            let shared = u8::try_from(v + 128).ok().map(|slot| CACHED_BOX_IDS + u64::from(slot));
            let value = match mode {
                Mode::Ref => TraceValue::Object { id: object, class: "TraceOracle$Item".into() },
                Mode::Boxed => {
                    TraceValue::Boxed { id: shared.unwrap_or(object), class: BoxKind::Int, value: v.to_string() }
                }
                Mode::Prim => TraceValue::Boxed {
                    id: shared.unwrap_or(FRESH_BOX_IDS + i as u64),
                    class: BoxKind::Int,
                    value: v.to_string(),
                },
            };
            Record { step, value }
        })
        .collect()
}

#[derive(Default)]
struct Tally {
    links: u64,
    wrong: u64,
    first_wrong: Option<String>,
}

fn check<'a>(lines: impl Iterator<Item = &'a str>) -> [Tally; 3] {
    let mut tallies: [Tally; 3] = Default::default();
    for line in lines.filter(|l| !l.is_empty()) {
        let chain = parse(line);
        let kinds: Vec<_> =
            chain.ops.iter().map(|op| step_kind(op).unwrap_or_else(|| panic!("{op} is a step"))).collect();
        for (mode, tally) in MODES.iter().zip(&mut tallies) {
            let links = resolve(&kinds, &records(&chain, *mode));
            let wrong = links.iter().zip(&chain.truth).filter(|(link, truth)| link.parent != **truth).count() as u64;
            tally.links += chain.records.iter().filter(|r| r.0 > 0).count() as u64;
            tally.wrong += wrong;
            if wrong > 0 && tally.first_wrong.is_none() {
                tally.first_wrong = Some(line.to_owned());
            }
        }
    }
    tallies
}

#[track_caller]
fn assert_all_right(tallies: &[Tally; 3], min_links: u64) {
    for (mode, tally) in MODES.iter().zip(tallies) {
        println!("{mode:?}: {} links, {} wrong", tally.links, tally.wrong);
        assert_eq!(tally.wrong, 0, "{mode:?} mislinks, first in: {}", tally.first_wrong.as_deref().unwrap_or_default());
        assert!(tally.links >= min_links, "{mode:?}: only {} links", tally.links);
    }
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn oracle_fixture_resolves_without_error() {
    let text = std::fs::read_to_string(fixtures().join("resolver/oracle-jdk21-seed1.jsonl")).expect("fixture");
    assert_all_right(&check(text.lines()), 2000);
}

#[test]
#[ignore = "needs a real JDK >= 11: set OPENIDEA_TEST_JAVA to its bin/java"]
fn oracle_on_real_jdk() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let out = Command::new(java)
        .arg(fixtures().join("java/TraceOracle.java"))
        .args(["1", "20000"])
        .output()
        .expect("java starts");
    assert!(out.status.success(), "oracle failed: {}", String::from_utf8_lossy(&out.stderr));
    let tallies = check(std::str::from_utf8(&out.stdout).expect("UTF-8").lines());
    println!("total: {} links", tallies.iter().map(|t| t.links).sum::<u64>());
    assert_all_right(&tallies, 2000);
}
