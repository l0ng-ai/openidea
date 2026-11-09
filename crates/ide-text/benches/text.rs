//! `cargo bench -p ide-text`: change sets and coordinate conversion on a 1 MB document.

use criterion::{BatchSize, Criterion, black_box, criterion_group, criterion_main};
use ide_core::{ChangeSet, Pos, TextChange};
use ide_text::Document;

/// ~1 MB of code-like text with some non-ASCII content.
fn sample_text() -> String {
    let mut s = String::with_capacity(1 << 20);
    let mut i = 0u32;
    while s.len() < 1 << 20 {
        s.push_str(&format!("    let value_{i} = compute(\"héllo 😀\", {i}) + other_{i};\n"));
        i += 1;
    }
    s
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self, n: u32) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % n.max(1) as u64) as u32
    }
}

fn change_set(doc: &Document, rng: &mut Lcg, n: usize) -> ChangeSet {
    let len = doc.len_utf16();
    let mut points: Vec<u32> = (0..n * 2).map(|_| rng.next(len)).collect();
    points.sort_unstable();
    // Snap to char boundaries so the set is valid.
    let changes = points
        .chunks(2)
        .map(|p| {
            let from = doc.pos_to_offset(doc.offset_to_pos(p[0]));
            let to = doc.pos_to_offset(doc.offset_to_pos(p[1])).max(from);
            TextChange { from, to: to.min(from + 8), insert: "x_y\n".into() }
        })
        .collect::<Vec<_>>();
    // Keep the set sorted and non-overlapping after clamping.
    let mut out: Vec<TextChange> = Vec::with_capacity(changes.len());
    for c in changes {
        if out.last().is_none_or(|l| c.from >= l.to) {
            out.push(c);
        }
    }
    ChangeSet { changes: out }
}

fn bench(c: &mut Criterion) {
    let text = sample_text();
    c.bench_function("text/open_1mb", |b| b.iter(|| Document::new(black_box(&text))));

    let base = Document::new(&text);
    c.bench_function("text/apply_keystroke_1mb", |b| {
        let mut rng = Lcg(7);
        b.iter_batched_ref(
            || {
                let cs = change_set(&base, &mut rng, 1);
                (base.clone(), cs)
            },
            |(doc, cs)| doc.apply_detailed(0, cs).unwrap(),
            BatchSize::SmallInput,
        )
    });
    c.bench_function("text/apply_100_changes_1mb", |b| {
        let mut rng = Lcg(11);
        b.iter_batched_ref(
            || {
                let cs = change_set(&base, &mut rng, 100);
                (base.clone(), cs)
            },
            |(doc, cs)| doc.apply_detailed(0, cs).unwrap(),
            BatchSize::SmallInput,
        )
    });
    let two_edits = text.replacen("value_100 ", "renamed_100 ", 1).replacen("value_9000 ", "renamed_9000 ", 1);
    c.bench_function("text/diff_two_edits_1mb", |b| b.iter(|| base.diff(black_box(&two_edits))));
    let every_line = text.replace("compute", "calculate");
    c.bench_function("text/diff_every_line_1mb", |b| b.iter(|| base.diff(black_box(&every_line))));
    c.bench_function("text/offset_to_pos_round_trip", |b| {
        let mut rng = Lcg(3);
        let len = base.len_utf16();
        b.iter(|| {
            let pos = base.offset_to_pos(rng.next(len));
            black_box(base.pos_to_offset(pos))
        })
    });
    c.bench_function("text/pos_to_byte", |b| {
        let mut rng = Lcg(5);
        let lines = base.line_count();
        b.iter(|| black_box(base.pos_to_byte(Pos::new(rng.next(lines), rng.next(60)))))
    });
    c.bench_function("text/text_for_save_crlf_1mb", |b| {
        let mut doc = base.clone();
        doc.set_line_ending(ide_text::LineEnding::CrLf);
        b.iter(|| black_box(doc.text_for_save().len()))
    });
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(30).measurement_time(std::time::Duration::from_secs(3));
    targets = bench
}
criterion_main!(benches);
