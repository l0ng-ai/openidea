//! Manual queue-to-filter comparison. No OS delivery, locks, wakeups, or consumers.

use super::*;
use notify::event::{CreateKind, Flag, RemoveKind};
use std::hint::black_box;

#[derive(Debug)]
struct Sample {
    retained: usize,
    enqueue: Duration,
    drain: Duration,
    classify: Duration,
    cleanup: Duration,
    total: Duration,
}

fn compare_batches(left: &FsBatch, right: &FsBatch) {
    assert_eq!(
        (
            &left.created,
            &left.modified,
            &left.removed,
            &left.vcs,
            &left.excluded_dirs,
            &left.ignored,
            &left.ignore_rules
        ),
        (
            &right.created,
            &right.modified,
            &right.removed,
            &right.vcs,
            &right.excluded_dirs,
            &right.ignored,
            &right.ignore_rules
        )
    );
}

// Preserve the pre-change queue and drain operation rather than benchmarking a
// different pre-coalesced baseline. Both sides pay for incoming event clones.
fn original(input: &[Event], filter: &EventFilter) -> (Sample, FsBatch) {
    let start = Instant::now();
    let mut queue = Vec::new();
    for event in input {
        queue.push((black_box(event.clone()), Instant::now()));
    }
    let enqueue = start.elapsed();
    let retained = queue.len();
    let phase = Instant::now();
    let drained = std::mem::take(&mut queue);
    let events: Vec<Event> = drained.into_iter().map(|(event, _)| event).collect();
    let drain = phase.elapsed();
    let phase = Instant::now();
    let (batch, rule_dirs) = filter.batch_detailed(black_box(&events));
    let classify = phase.elapsed();
    let phase = Instant::now();
    drop(events);
    drop(queue);
    drop(rule_dirs);
    let cleanup = phase.elapsed();
    let total = start.elapsed();
    (Sample { retained, enqueue, drain, classify, cleanup, total }, batch)
}

fn compact(input: &[Event], filter: &EventFilter) -> (Sample, FsBatch) {
    let start = Instant::now();
    let mut queue = PendingEvents::default();
    for event in input {
        queue.push(black_box(event.clone()), Instant::now());
    }
    let enqueue = start.elapsed();
    let retained = queue.events.len();
    let phase = Instant::now();
    let events = std::mem::take(&mut queue);
    let drain = phase.elapsed();
    let phase = Instant::now();
    let (batch, rule_dirs) = filter.batch_detailed(black_box(&events.events));
    let classify = phase.elapsed();
    let phase = Instant::now();
    drop(events);
    drop(queue);
    drop(rule_dirs);
    let cleanup = phase.elapsed();
    let total = start.elapsed();
    (Sample { retained, enqueue, drain, classify, cleanup, total }, batch)
}

fn event(kind: EventKind, root: &Path, rel: &str) -> Event {
    Event::new(kind).add_path(root.join(rel))
}

fn modify(root: &Path, n: usize) -> Event {
    event(EventKind::Modify(ModifyKind::Any), root, &format!("src/{n}.rs"))
}

fn fixture(files: usize) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    for dir in ["src", "excluded", ".git/info", "renamed"] {
        std::fs::create_dir_all(tmp.path().join(dir)).unwrap();
    }
    std::fs::write(tmp.path().join(".gitignore"), "*.ignored\n").unwrap();
    std::fs::write(tmp.path().join("file.ignored"), "x").unwrap();
    for n in 0..files {
        std::fs::write(tmp.path().join(format!("src/{n}.rs")), "x").unwrap();
        if n % 8 == 4 {
            std::fs::write(tmp.path().join(format!("excluded/{n}.js")), "x").unwrap();
        }
    }
    tmp
}

fn cases(root: &Path, count: usize) -> Vec<(&'static str, Vec<Event>)> {
    let repeated = vec![modify(root, 0); count];
    let distinct = (0..count).map(|n| modify(root, n)).collect();
    let interleaved = (0..count).map(|n| modify(root, n % 2)).collect();
    let pairs = (0..count).map(|n| modify(root, n / 2)).collect();
    let runs = (0..count).map(|n| modify(root, n / 10)).collect();
    let mixed = (0..count)
        .map(|n| match n % 8 {
            0 | 1 => modify(root, n / 8),
            2 => event(EventKind::Create(CreateKind::File), root, &format!("src/{}.rs", n / 8)),
            3 => event(EventKind::Remove(RemoveKind::File), root, &format!("gone/{n}.rs")),
            4 => event(EventKind::Create(CreateKind::File), root, &format!("excluded/{n}.js")),
            5 => event(EventKind::Remove(RemoveKind::File), root, &format!("excluded/{n}.js")),
            6 => event(EventKind::Modify(ModifyKind::Any), root, "file.ignored"),
            _ => event(EventKind::Modify(ModifyKind::Any), root, ".git/HEAD"),
        })
        .collect();
    vec![
        ("repeated", repeated),
        ("distinct", distinct),
        ("interleaved", interleaved),
        ("pairs", pairs),
        ("runs10", runs),
        ("mixed", mixed),
    ]
}

fn pair(input: &[Event], root: &Path, warm: bool, reverse: bool) -> (Sample, Sample) {
    let excludes = vec!["excluded".to_owned()];
    let a = EventFilter::new(root.to_path_buf(), &excludes);
    let b = EventFilter::new(root.to_path_buf(), &excludes);
    if warm {
        compare_batches(&a.batch(input), &b.batch(input));
    }
    let (a_sample, a_batch, b_sample, b_batch) = if reverse {
        let (b_sample, b_batch) = compact(input, &b);
        let (a_sample, a_batch) = original(input, &a);
        (a_sample, a_batch, b_sample, b_batch)
    } else {
        let (a_sample, a_batch) = original(input, &a);
        let (b_sample, b_batch) = compact(input, &b);
        (a_sample, a_batch, b_sample, b_batch)
    };
    compare_batches(&a_batch, &b_batch);
    (a_sample, b_sample)
}

#[test]
fn pipeline_comparison_preserves_batches_and_rule_changes() {
    let tmp = fixture(32);
    let root = dunce::canonicalize(tmp.path()).unwrap();
    for (name, input) in cases(&root, 32) {
        for warm in [false, true] {
            for reverse in [false, true] {
                let (old, new) = pair(&input, &root, warm, reverse);
                assert_eq!(old.retained, 32);
                let expected = match name {
                    "repeated" => 1,
                    "distinct" | "interleaved" => 32,
                    "pairs" => 16,
                    "runs10" => 4,
                    "mixed" => 28,
                    _ => unreachable!(),
                };
                assert_eq!(new.retained, expected, "{name}");
            }
        }
    }
    let mut special = vec![
        modify(&root, 0).set_flag(Flag::Rescan),
        modify(&root, 0).set_flag(Flag::Rescan),
        modify(&root, 0).set_tracker(1),
        modify(&root, 0).set_tracker(2),
        modify(&root, 0).set_process_id(1),
        modify(&root, 0).set_process_id(2),
        modify(&root, 0).add_path(root.join("src/1.rs")),
    ];
    for mode in [RenameMode::Both, RenameMode::From, RenameMode::To] {
        let rename = event(EventKind::Modify(ModifyKind::Name(mode)), &root, "old.rs");
        special.push(if mode == RenameMode::Both { rename.add_path(root.join("src/0.rs")) } else { rename });
    }
    let (old, new) = pair(&special, &root, true, false);
    assert_eq!(old.retained, special.len());
    assert_eq!(new.retained, special.len());
    for rule in [".gitignore", ".ignore", ".git/info/exclude"] {
        let tmp = fixture(1);
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::write(root.join(".gitignore"), "").unwrap();
        std::fs::write(root.join(rule), "").unwrap();
        let a = EventFilter::new(root.clone(), &[]);
        let b = EventFilter::new(root.clone(), &[]);
        let touch = event(EventKind::Modify(ModifyKind::Any), &root, "file.ignored");
        for filter in [&a, &b] {
            assert_eq!(filter.batch(std::slice::from_ref(&touch)).modified, vec![root.join("file.ignored")]);
        }
        std::fs::write(root.join(rule), "*.ignored\n").unwrap();
        let change = event(EventKind::Modify(ModifyKind::Any), &root, rule);
        let input = [touch.clone(), touch, change.clone(), change];
        let (_, old) = original(&input, &a);
        let (_, new) = compact(&input, &b);
        compare_batches(&old, &new);
        assert_eq!(new.ignored, vec![root.join("file.ignored")]);
        assert_eq!(new.ignore_rules, vec![root]);
    }
}

#[test]
#[ignore = "manual release queue-to-filter benchmark; requires a quiet machine"]
fn pending_pipeline_benchmark() {
    // Fail only when this ignored benchmark is invoked, not during debug builds.
    #[allow(clippy::assertions_on_constants)]
    {
        assert!(!cfg!(debug_assertions), "run with cargo test --release");
    }
    const COUNT: usize = 10_000;
    const ROUNDS: usize = 8;
    let tmp = fixture(COUNT);
    let root = dunce::canonicalize(tmp.path()).unwrap();
    for (name, input) in cases(&root, COUNT) {
        for warm in [false, true] {
            // Prime code and filesystem pages, not the measured filter instances.
            pair(&input, &root, warm, false);
            pair(&input, &root, warm, true);
            let mut old = Vec::new();
            let mut new = Vec::new();
            for round in 0..ROUNDS {
                let (a, b) = pair(&input, &root, warm, round % 2 == 1);
                for (variant, sample) in [("original", &a), ("compact", &b)] {
                    eprintln!(
                        "{}",
                        serde_json::json!({
                            "case": name, "warm_rules": warm, "round": round, "variant": variant,
                            "events": input.len(), "retained": sample.retained,
                            "enqueue_ns": sample.enqueue.as_nanos(), "drain_ns": sample.drain.as_nanos(),
                            "classify_ns": sample.classify.as_nanos(), "cleanup_ns": sample.cleanup.as_nanos(),
                            "total_ns": sample.total.as_nanos(),
                        })
                    );
                }
                old.push(a.total.as_nanos());
                new.push(b.total.as_nanos());
            }
            old.sort();
            new.sort();
            eprintln!(
                "{}",
                serde_json::json!({
                    "summary": name, "warm_rules": warm,
                    "original_median_ns": (old[3] + old[4]) / 2,
                    "compact_median_ns": (new[3] + new[4]) / 2,
                    "original_min_ns": old[0], "original_max_ns": old[ROUNDS - 1],
                    "compact_min_ns": new[0], "compact_max_ns": new[ROUNDS - 1],
                })
            );
        }
    }
}
