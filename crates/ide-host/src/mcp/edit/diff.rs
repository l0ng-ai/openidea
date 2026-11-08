// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/UnifiedDiffSupport.kt), Apache-2.0.
//! The unified diff tools answer with, so an agent sees what the IDE changed
//! without reading the files again. Capped, so a large change cannot flood the
//! agent's context.

/// Unchanged lines kept around each change, as in a standard unified diff.
const CONTEXT_LINES: usize = 3;

/// The default cap on diff lines.
pub const MAX_DIFF_LINES: usize = 200;

/// The smallest useful hunk: the `@@` header line and one line under it.
const MIN_HUNK_LINES: usize = 2;

/// Beyond this many differing lines (after the common head and tail) the
/// diff is not computed: the file is reported as too large to diff.
const MAX_EDIT_DISTANCE: usize = 2000;

/// One file a tool processed: the requested path, the text before and after.
/// `None` texts are reported as unavailable, never as "nothing changed".
pub struct ChangedFileText {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// A unified diff of the changes in `files`, at most `max_lines` diff lines;
/// `None` when nothing changed. A file goes in whole, or the footer names it.
pub fn build_unified_diff(files: &[ChangedFileText], max_lines: usize) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut omitted_files = Vec::new();
    let mut omitted_lines = 0usize;
    for file in files {
        let Some(diff) = file_diff(file) else { continue };
        // A header with no hunk under it helps nobody.
        if !lines.is_empty() && max_lines.saturating_sub(lines.len()) < diff.header.len() + MIN_HUNK_LINES {
            omitted_files.push(diff.path.clone());
            omitted_lines += diff.line_count();
            continue;
        }
        lines.extend(diff.header.iter().cloned());
        for (index, hunk) in diff.hunks.iter().enumerate() {
            let room = max_lines as isize - lines.len() as isize - 1;
            if room < 1 && index > 0 {
                omitted_lines += diff.hunks[index..].iter().map(Hunk::line_count).sum::<usize>();
                break;
            }
            // The first hunk always keeps one line, so its file header never stands alone.
            let body = room.max(1) as usize;
            lines.extend(hunk.render(body));
            omitted_lines += hunk.body.len().saturating_sub(body);
        }
    }
    if lines.is_empty() {
        return None;
    }
    let mut out = lines.join("\n");
    if omitted_lines > 0 {
        out.push_str(&format!("\n… and {omitted_lines} more diff line(s) omitted."));
    }
    if !omitted_files.is_empty() {
        out.push_str(&format!("\n… The diff leaves out these file(s): {}.", omitted_files.join(", ")));
    }
    Some(out)
}

struct FileDiff {
    path: String,
    header: Vec<String>,
    hunks: Vec<Hunk>,
}

impl FileDiff {
    fn line_count(&self) -> usize {
        self.header.len() + self.hunks.iter().map(Hunk::line_count).sum::<usize>()
    }
}

/// One hunk: where it starts on each side (0-based), and its `-`, `+` and context lines.
struct Hunk {
    start0: usize,
    start1: usize,
    body: Vec<String>,
}

impl Hunk {
    fn line_count(&self) -> usize {
        self.body.len() + 1
    }

    /// The hunk with at most `max_body` body lines; the header counts the lines it prints.
    fn render(&self, max_body: usize) -> Vec<String> {
        let printed = &self.body[..self.body.len().min(max_body)];
        let count0 = printed.iter().filter(|l| l.starts_with(' ') || l.starts_with('-')).count();
        let count1 = printed.iter().filter(|l| l.starts_with(' ') || l.starts_with('+')).count();
        // An empty range names the line before it, so it keeps the 0-based value.
        let start = |s: usize, count: usize| if count == 0 { s } else { s + 1 };
        let mut out =
            vec![format!("@@ -{},{count0} +{},{count1} @@", start(self.start0, count0), start(self.start1, count1))];
        out.extend(printed.iter().cloned());
        out
    }
}

/// A line of the text, and whether it ends without a line separator (the last line).
type DiffLine<'a> = (&'a str, bool);

fn file_diff(file: &ChangedFileText) -> Option<FileDiff> {
    let path = file.path.replace('\\', "/");
    let header = vec![format!("--- a/{path}"), format!("+++ b/{path}")];
    let note = |text: &str| {
        let mut header = header.clone();
        header.push(format!("({text})"));
        Some(FileDiff { path: path.clone(), header, hunks: Vec::new() })
    };
    let (Some(before), Some(after)) = (&file.before, &file.after) else {
        return note(
            "the content of this file is not available, so the diff cannot report what changed; read the file again",
        );
    };
    if before == after {
        return None;
    }
    let old = split_lines(before);
    let new = split_lines(after);
    let Some(changes) = changes(&old, &new) else { return note("this file changed, but it is too large to diff") };
    // The texts differ but the lines are equal: only the line separators changed.
    if changes.is_empty() {
        return note("only the line separators of this file changed");
    }
    let hunks = group(&changes).into_iter().map(|g| build_hunk(g, &old, &new)).collect();
    Some(FileDiff { path, header, hunks })
}

/// The lines a diff compares: no extra empty line after a final separator; a
/// last line without one is marked, so a change of the final separator alone counts.
fn split_lines(text: &str) -> Vec<DiffLine<'_>> {
    if text.is_empty() {
        return Vec::new();
    }
    let ends_with_newline = text.ends_with('\n');
    let mut lines: Vec<DiffLine> = text.split('\n').map(|l| (l.strip_suffix('\r').unwrap_or(l), false)).collect();
    if ends_with_newline {
        lines.pop();
    } else if let Some(last) = lines.last_mut() {
        last.1 = true;
    }
    lines
}

/// A run of changed lines: at `line0` in the old text `deleted` lines, at `line1` in the new one `inserted`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Change {
    line0: usize,
    line1: usize,
    deleted: usize,
    inserted: usize,
}

/// The changes from `a` to `b` (Myers' algorithm), `None` when they differ too much.
fn changes(a: &[DiffLine], b: &[DiffLine]) -> Option<Vec<Change>> {
    let head = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let tail = a[head..].iter().rev().zip(b[head..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (a_mid, b_mid) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
    let script = myers(a_mid, b_mid)?;
    // `script`: per step, true = equal (both advance), Some side otherwise.
    let mut out: Vec<Change> = Vec::new();
    let (mut i, mut j) = (head, head);
    for step in script {
        match step {
            Step::Equal => {
                i += 1;
                j += 1;
                continue;
            }
            Step::Delete => {
                match out.last_mut() {
                    Some(c) if c.line0 + c.deleted == i && c.line1 + c.inserted == j => c.deleted += 1,
                    _ => out.push(Change { line0: i, line1: j, deleted: 1, inserted: 0 }),
                }
                i += 1;
            }
            Step::Insert => {
                match out.last_mut() {
                    Some(c) if c.line0 + c.deleted == i && c.line1 + c.inserted == j => c.inserted += 1,
                    _ => out.push(Change { line0: i, line1: j, deleted: 0, inserted: 1 }),
                }
                j += 1;
            }
        }
    }
    Some(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Equal,
    Delete,
    Insert,
}

/// The shortest edit script from `a` to `b`, deletions before insertions in each run.
fn myers(a: &[DiffLine], b: &[DiffLine]) -> Option<Vec<Step>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max = (n + m) as usize;
    let limit = max.min(MAX_EDIT_DISTANCE) as isize;
    let off = max as isize + 1;
    let mut v = vec![0isize; 2 * max + 3];
    // V after each round d, for diagonals -d..=d.
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut end = None;
    'rounds: for d in 0..=limit {
        for k in (-d..=d).step_by(2) {
            let at = |k: isize| (off + k) as usize;
            let mut x =
                if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) { v[at(k + 1)] } else { v[at(k - 1)] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[at(k)] = x;
            if x >= n && y >= m {
                trace.push(v[at(-d)..=at(d)].to_vec());
                end = Some(d);
                break 'rounds;
            }
        }
        trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
    }
    let d_end = end?;
    let mut steps = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (1..=d_end).rev() {
        let prev = &trace[(d - 1) as usize];
        let get = |k: isize| prev[(k + d - 1) as usize];
        let k = x - y;
        let insert = k == -d || (k != d && get(k - 1) < get(k + 1));
        let prev_k = if insert { k + 1 } else { k - 1 };
        let prev_x = get(prev_k);
        let prev_y = prev_x - prev_k;
        let (mid_x, mid_y) = if insert { (prev_x, prev_y + 1) } else { (prev_x + 1, prev_y) };
        while x > mid_x && y > mid_y {
            steps.push(Step::Equal);
            x -= 1;
            y -= 1;
        }
        steps.push(if insert { Step::Insert } else { Step::Delete });
        (x, y) = (prev_x, prev_y);
    }
    steps.extend(std::iter::repeat_n(Step::Equal, x as usize));
    steps.reverse();
    // Within a run of changes, deletions first (as `-` lines precede `+` lines).
    let mut i = 0;
    while i < steps.len() {
        if steps[i] == Step::Equal {
            i += 1;
            continue;
        }
        let end = steps[i..].iter().position(|s| *s == Step::Equal).map_or(steps.len(), |p| i + p);
        steps[i..end].sort_by_key(|s| *s == Step::Insert);
        i = end;
    }
    Some(steps)
}

/// Changes whose context lines touch share a hunk.
fn group(changes: &[Change]) -> Vec<&[Change]> {
    let mut out: Vec<&[Change]> = Vec::new();
    let mut start = 0;
    for i in 1..changes.len() {
        let prev = changes[i - 1];
        if changes[i].line0 - (prev.line0 + prev.deleted) > CONTEXT_LINES * 2 {
            out.push(&changes[start..i]);
            start = i;
        }
    }
    if !changes.is_empty() {
        out.push(&changes[start..]);
    }
    out
}

fn build_hunk(group: &[Change], old: &[DiffLine], new: &[DiffLine]) -> Hunk {
    let (first, last) = (group[0], group[group.len() - 1]);
    // One clamp for both sides, so the two starts in the header stay in step.
    let leading = CONTEXT_LINES.min(first.line0).min(first.line1);
    let (start0, start1) = (first.line0 - leading, first.line1 - leading);
    let (end0, end1) = (last.line0 + last.deleted, last.line1 + last.inserted);
    let trailing = CONTEXT_LINES.min(old.len() - end0).min(new.len() - end1);
    let mut body = Vec::new();
    let push = |body: &mut Vec<String>, prefix: char, (text, no_newline): DiffLine| {
        body.push(format!("{prefix}{text}"));
        if no_newline {
            body.push("\\ No newline at end of file".into());
        }
    };
    let mut line0 = start0;
    for c in group {
        while line0 < c.line0 {
            push(&mut body, ' ', old[line0]);
            line0 += 1;
        }
        for &l in &old[c.line0..c.line0 + c.deleted] {
            push(&mut body, '-', l);
        }
        for &l in &new[c.line1..c.line1 + c.inserted] {
            push(&mut body, '+', l);
        }
        line0 = c.line0 + c.deleted;
    }
    while line0 < end0 + trailing {
        push(&mut body, ' ', old[line0]);
        line0 += 1;
    }
    Hunk { start0, start1, body }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(before: &str, after: &str) -> Option<String> {
        build_unified_diff(
            &[ChangedFileText { path: "src/A.java".into(), before: Some(before.into()), after: Some(after.into()) }],
            MAX_DIFF_LINES,
        )
    }

    #[test]
    fn diffs_a_reformat_like_jetbrains() {
        let out = diff("public class DiffTarget {\nint a;\n}\n", "public class DiffTarget {\n    int a;\n}\n").unwrap();
        assert_eq!(
            out,
            "--- a/src/A.java\n+++ b/src/A.java\n@@ -1,3 +1,3 @@\n public class DiffTarget {\n-int a;\n+    int a;\n }"
        );
        assert_eq!(diff("same\n", "same\n"), None);
    }

    #[test]
    fn splits_far_changes_into_hunks_and_marks_the_final_newline() {
        let before: String = (1..=20).map(|i| format!("{i}\n")).collect();
        let after: String = (1..=20)
            .map(|i| match i {
                2 => "two\n".to_owned(),
                19 => "nineteen\n".to_owned(),
                i => format!("{i}\n"),
            })
            .collect();
        let out = diff(&before, &after).unwrap();
        assert!(out.contains("@@ -1,5 +1,5 @@\n 1\n-2\n+two\n 3\n 4\n 5\n"), "{out}");
        assert!(out.contains("@@ -16,5 +16,5 @@\n 16\n 17\n 18\n-19\n+nineteen\n 20"), "{out}");
        let out = diff("a\nb", "a\nb\n").unwrap();
        assert!(out.ends_with("@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b"), "{out}");
        let out = diff("a\r\n", "a\n").unwrap();
        assert!(out.ends_with("(only the line separators of this file changed)"), "{out}");
        let out = diff("", "x\n").unwrap();
        assert!(out.ends_with("@@ -0,0 +1,1 @@\n+x"), "{out}");
        let out = diff("import a;\n\nclass X {}\n", "\nclass X {}\n").unwrap();
        assert!(out.ends_with("@@ -1,3 +1,2 @@\n-import a;\n \n class X {}"), "{out}");
    }

    #[test]
    fn caps_the_diff_and_names_what_it_leaves_out() {
        let before: String = (0..300).map(|i| format!("{i}\n")).collect();
        let after: String = (0..300).map(|i| format!("x{i}\n")).collect();
        let files = [
            ChangedFileText { path: "a.txt".into(), before: Some(before.clone()), after: Some(after.clone()) },
            ChangedFileText { path: "b.txt".into(), before: Some(before), after: Some(after) },
            ChangedFileText { path: "c.bin".into(), before: None, after: None },
        ];
        let out = build_unified_diff(&files, 50).unwrap();
        assert_eq!(out.lines().filter(|l| !l.starts_with('…')).count(), 50, "{out}");
        // 553 lines of a.txt's hunk, 603 of b.txt, 3 of c.bin's note.
        assert!(out.contains("… and 1159 more diff line(s) omitted."), "{out}");
        assert!(out.ends_with("… The diff leaves out these file(s): b.txt, c.bin."), "{out}");
        // The cut hunk's header counts what it prints.
        assert!(out.contains("@@ -1,47 +0,0 @@"), "{out}");
    }
}
