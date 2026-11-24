//! Queue-to-filter correctness comparisons, without timing or OS delivery.

use super::*;
use notify::event::{CreateKind, Flag, RemoveKind};

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

// Preserve the pre-change queue and drain operation for the comparison.
fn original(input: &[Event], filter: &EventFilter) -> (usize, FsBatch) {
    let mut queue = Vec::new();
    for event in input {
        queue.push((event.clone(), Instant::now()));
    }
    let retained = queue.len();
    let events: Vec<Event> = std::mem::take(&mut queue).into_iter().map(|(event, _)| event).collect();
    (retained, filter.batch(&events))
}

fn compact(input: &[Event], filter: &EventFilter) -> (usize, FsBatch) {
    let mut queue = PendingEvents::default();
    for event in input {
        let mut changes = QueuedChanges::default();
        queue_changes(filter, event, &mut changes);
        queue.add(changes, Instant::now());
    }
    let queued = queue.changes.values().map(Vec::len).sum::<usize>();
    (queued, filter.batch(&queue.into_events()))
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

fn pair(input: &[Event], root: &Path, warm: bool, reverse: bool) -> (usize, usize) {
    let excludes = vec!["excluded".to_owned()];
    let a = EventFilter::new(root.to_path_buf(), &excludes);
    let b = EventFilter::new(root.to_path_buf(), &excludes);
    if warm {
        compare_batches(&a.batch(input), &b.batch(input));
    }
    let (a_retained, a_batch, b_retained, b_batch) = if reverse {
        let (b_retained, b_batch) = compact(input, &b);
        let (a_retained, a_batch) = original(input, &a);
        (a_retained, a_batch, b_retained, b_batch)
    } else {
        let (a_retained, a_batch) = original(input, &a);
        let (b_retained, b_batch) = compact(input, &b);
        (a_retained, a_batch, b_retained, b_batch)
    };
    compare_batches(&a_batch, &b_batch);
    (a_retained, b_retained)
}

#[test]
fn pipeline_comparison_preserves_batches_and_rule_changes() {
    let tmp = fixture(32);
    let root = dunce::canonicalize(tmp.path()).unwrap();
    for (name, input) in cases(&root, 32) {
        for warm in [false, true] {
            for reverse in [false, true] {
                let (old, new) = pair(&input, &root, warm, reverse);
                assert_eq!(old, 32);
                // The queue holds exactly one merged change per distinct changed path;
                // the batch `pair` already checked is identical to the un-coalesced one.
                let filter = EventFilter::new(root.clone(), &["excluded".to_owned()]);
                let mut queued = PendingEvents::default();
                for event in &input {
                    let mut changes = QueuedChanges::default();
                    queue_changes(&filter, event, &mut changes);
                    queued.add(changes, Instant::now());
                }
                assert_eq!(new, queued.changes.values().map(Vec::len).sum::<usize>(), "{name}");
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
    assert_eq!(old, special.len());
    // Attributes no longer keep identical paths apart: one merged change per path.
    let mut queued = QueuedChanges::default();
    let filter = EventFilter::new(root.clone(), &[]);
    for event in &special {
        queue_changes(&filter, event, &mut queued);
    }
    assert_eq!(new, queued.paths.values().map(Vec::len).sum::<usize>());
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
