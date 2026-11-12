//! Parallel walk + per-file search.

use crate::iter::for_each_match;
use crate::line::line_match;
use crate::mask::FileMask;
use crate::pattern::ScopePattern;
use crate::query::{Compiled, line_terminator};
use crate::{
    FileMatches, LineMatch, LiteralKind, LiteralRange, Literals, PathFilter, SearchContext, SearchScope, SearchSummary,
    TextSource,
};
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ide_core::{CancellationToken, IdeError, IdeResult};
use ignore::{WalkBuilder, WalkState};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::time::Instant;

pub(crate) const DEFAULT_MAX_MATCHES: u32 = 10_000;
/// How many matched lines a sink handles between cancellation-token checks
/// (reads from disk check on every buffer refill).
const CANCEL_CHECK_LINES: u32 = 256;

pub(crate) struct Request<'a> {
    pub root: &'a Path,
    pub scope: &'a SearchScope,
    pub compiled: Compiled,
    pub mask: FileMask,
    pub pattern: Option<ScopePattern>,
    pub filter: Option<PathFilter<'a>>,
    pub context: SearchContext,
    pub literals: Option<Literals<'a>>,
    pub max_matches: u32,
    pub text: TextSource<'a>,
    pub cancel: &'a CancellationToken,
    pub on_file: &'a (dyn Fn(FileMatches) + Sync),
}

/// Shared state of one search across worker threads.
struct Control<'a> {
    cancel: &'a CancellationToken,
    stop: AtomicBool,
    cancelled: AtomicBool,
    limit_hit: AtomicBool,
    matches: AtomicU32,
    files: AtomicU32,
    max: u32,
}

impl Control<'_> {
    /// Cheap check of the shared stop flag only.
    #[inline]
    fn stopped(&self) -> bool {
        self.stop.load(Relaxed)
    }

    /// Also polls the cancellation token (which takes a lock).
    fn should_stop(&self) -> bool {
        if self.stopped() {
            return true;
        }
        if self.cancel.is_cancelled() {
            self.cancelled.store(true, Relaxed);
            self.stop.store(true, Relaxed);
            return true;
        }
        false
    }

    fn remaining(&self) -> u32 {
        self.max.saturating_sub(self.matches.load(Relaxed))
    }

    /// Atomically claims up to `n` matches from the global budget.
    fn reserve(&self, n: u32) -> u32 {
        let mut cur = self.matches.load(Relaxed);
        loop {
            let granted = n.min(self.max.saturating_sub(cur));
            if granted == 0 {
                break 0;
            }
            match self.matches.compare_exchange_weak(cur, cur + granted, Relaxed, Relaxed) {
                Ok(_) => break granted,
                Err(actual) => cur = actual,
            }
        }
    }
}

struct Ctx<'a> {
    root: &'a Path,
    mask: &'a FileMask,
    pattern: Option<&'a ScopePattern>,
    filter: Option<PathFilter<'a>>,
    context: SearchContext,
    literals: Option<Literals<'a>>,
    text: TextSource<'a>,
    on_file: &'a (dyn Fn(FileMatches) + Sync),
    ctl: Control<'a>,
}

pub(crate) fn run(req: Request<'_>) -> IdeResult<SearchSummary> {
    let started = Instant::now();
    let roots = roots(req.root, req.scope)?;
    let ctx = Ctx {
        root: req.root,
        mask: &req.mask,
        pattern: req.pattern.as_ref(),
        filter: req.filter,
        context: req.context,
        literals: if req.context == SearchContext::Any { None } else { req.literals },
        text: req.text,
        on_file: req.on_file,
        ctl: Control {
            cancel: req.cancel,
            stop: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            limit_hit: AtomicBool::new(false),
            matches: AtomicU32::new(0),
            files: AtomicU32::new(0),
            max: if req.max_matches == 0 { DEFAULT_MAX_MATCHES } else { req.max_matches },
        },
    };
    let mut searcher_builder = SearcherBuilder::new();
    searcher_builder
        .line_terminator(line_terminator())
        .line_number(true)
        .multi_line(req.compiled.multi_line)
        .binary_detection(BinaryDetection::quit(0));
    let matcher = &req.compiled.matcher;

    // Explicitly listed files that only exist as unsaved buffers.
    let mut on_disk = Vec::with_capacity(roots.len());
    for path in roots {
        if !path.exists() && matches!(req.scope, SearchScope::Files { .. }) {
            let mut searcher = searcher_builder.build();
            ctx.search_file(&path, matcher, &mut searcher);
        } else {
            on_disk.push(path);
        }
    }

    if !ctx.ctl.should_stop() {
        walk_files(&on_disk, || {
            let mut searcher = searcher_builder.build();
            let matcher = matcher.clone();
            let ctx = &ctx;
            Box::new(move |path| {
                if ctx.ctl.should_stop() {
                    return WalkState::Quit;
                }
                ctx.search_file(path, &matcher, &mut searcher);
                if ctx.ctl.stopped() { WalkState::Quit } else { WalkState::Continue }
            })
        });
    }

    let cancelled = ctx.ctl.cancelled.load(Relaxed) || req.cancel.is_cancelled();
    Ok(SearchSummary {
        files: ctx.ctl.files.load(Relaxed),
        matches: ctx.ctl.matches.load(Relaxed),
        limit_hit: ctx.ctl.limit_hit.load(Relaxed),
        cancelled,
        elapsed_ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
    })
}

/// A per-thread file visitor of [`walk_files`].
pub(crate) type VisitFile<'s> = Box<dyn FnMut(&Path) -> WalkState + Send + 's>;

/// Visits the files below `roots` (and the roots that are files) in parallel,
/// the way IDEA's project scope sees them: directories ignored by
/// `.gitignore` / `.ignore` / `info/exclude` are skipped with everything in
/// them, while ignored files elsewhere (`.env`) and hidden files and folders
/// (`.github`, `.eslintrc`) are visited. `.git`, symlinks and archives (jar,
/// zip: browsed, not searched) are never visited.
pub(crate) fn walk_files<'s>(roots: &[PathBuf], mut visitor: impl FnMut() -> VisitFile<'s> + Send) {
    let Some((first, rest)) = roots.split_first() else { return };
    let mut walk = WalkBuilder::new(first);
    for path in rest {
        walk.add(path);
    }
    walk.hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(ide_core::ignored::inside_git_repo(first))
        .follow_links(false)
        .threads(std::thread::available_parallelism().map_or(4, |n| n.get()).min(12))
        .filter_entry(|e| e.file_name() != ".git");
    walk.build_parallel().run(|| {
        let mut visit = visitor();
        Box::new(move |entry| {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    tracing::debug!("search walk: {err}");
                    return WalkState::Continue;
                }
            };
            let Some(file_type) = entry.file_type() else { return WalkState::Continue };
            if file_type.is_dir() {
                // The walker drops ignored files unseen, so the files of every walked
                // directory come from listing it; the walker only picks the directories.
                let Ok(children) = std::fs::read_dir(entry.path()) else { return WalkState::Continue };
                for child in children.flatten() {
                    let path = child.path();
                    if child.file_name() != ".git"
                        && child.file_type().is_ok_and(|t| t.is_file())
                        && !ide_vfs::is_archive_file(&path)
                        && matches!(visit(&path), WalkState::Quit)
                    {
                        return WalkState::Quit;
                    }
                }
                WalkState::Continue
            } else if file_type.is_file() && entry.depth() == 0 && !ide_vfs::is_archive_file(entry.path()) {
                // A root that is a file (an explicit file list); files below roots come from listings.
                visit(entry.path())
            } else {
                WalkState::Continue
            }
        })
    });
}

/// Walk roots for a scope; relative paths are resolved against `root`.
pub(crate) fn roots(root: &Path, scope: &SearchScope) -> IdeResult<Vec<PathBuf>> {
    let dir = |path: &Path| -> IdeResult<PathBuf> {
        let path = root.join(path);
        if path.is_dir() {
            Ok(path)
        } else {
            Err(IdeError::not_found(format!("directory not found: {}", path.display())))
        }
    };
    Ok(match scope {
        SearchScope::Project | SearchScope::FileSet { .. } | SearchScope::Pattern { .. } => vec![dir(Path::new(""))?],
        SearchScope::Directory { path } => vec![dir(path)?],
        SearchScope::Files { paths } => {
            let mut out: Vec<PathBuf> = Vec::with_capacity(paths.len());
            for path in paths {
                let path = root.join(path);
                if !out.contains(&path) {
                    out.push(path);
                }
            }
            out
        }
    })
}

/// `path` relative to `root` with `/` separators (or the full path when it
/// lies outside the root).
pub(crate) fn rel_path(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut out = String::with_capacity(rel.as_os_str().len());
    for (i, c) in rel.components().enumerate() {
        if i > 0 && !out.ends_with('/') {
            out.push('/');
        }
        out.push_str(&c.as_os_str().to_string_lossy());
    }
    out
}

impl Ctx<'_> {
    fn search_file(&self, path: &Path, matcher: &RegexMatcher, searcher: &mut Searcher) {
        let rel = rel_path(self.root, path);
        if !self.mask.matches(&rel)
            || self.pattern.is_some_and(|p| !p.matches(&rel))
            || self.filter.is_some_and(|keep| !keep(&rel))
        {
            return;
        }
        // The search context needs the whole text to find comments and string literals.
        let in_context = match self.literals {
            Some(literals) => {
                let text = match (self.text.overlay)(path) {
                    Some(text) => text,
                    None => match std::fs::read(path) {
                        Ok(bytes) => match String::from_utf8(bytes) {
                            Ok(text) => text,
                            // Binary content has nothing to classify.
                            Err(e) => match (self.text.decode)(path, e.as_bytes()) {
                                Some(text) => text,
                                None => return,
                            },
                        },
                        Err(_) => return,
                    },
                };
                let ranges = literals(path, &text);
                if ranges.is_none() && self.context.needs_literals() {
                    return;
                }
                Some((text, ranges.unwrap_or_default()))
            }
            None => None,
        };
        let context = in_context.as_ref().map(|(_, ranges)| (self.context, ranges.as_slice()));
        let mut sink = FileSink::new(matcher, &self.ctl, context);
        let result = match &in_context {
            Some((text, _)) => searcher.search_slice(matcher, text.as_bytes(), &mut sink),
            None => match (self.text.overlay)(path) {
                Some(text) => searcher.search_slice(matcher, text.as_bytes(), &mut sink),
                None => self.search_disk(path, matcher, searcher, &mut sink),
            },
        };
        if let Err(err) = result {
            if !self.ctl.stopped() {
                tracing::debug!("search {}: {err}", path.display());
            }
            if sink.lines.is_empty() || self.ctl.cancelled.load(Relaxed) {
                return;
            }
        }
        if sink.binary || sink.lines.is_empty() || self.ctl.cancelled.load(Relaxed) {
            return;
        }
        let found = u32::try_from(sink.count).unwrap_or(u32::MAX);
        let granted = self.ctl.reserve(found);
        if granted < found {
            self.ctl.limit_hit.store(true, Relaxed);
            self.ctl.stop.store(true, Relaxed);
            truncate(&mut sink.lines, granted as usize);
        }
        if sink.lines.is_empty() {
            return;
        }
        self.ctl.files.fetch_add(1, Relaxed);
        (self.on_file)(FileMatches { path: path.into(), rel_path: rel, matches: sink.lines });
    }

    /// Streams the file's bytes; a file that turns out not to be UTF-8 (GBK,
    /// UTF-16 …) is searched again in the text `decode` gives it.
    fn search_disk<'s>(
        &'s self,
        path: &Path,
        matcher: &'s RegexMatcher,
        searcher: &mut Searcher,
        sink: &mut FileSink<'s>,
    ) -> io::Result<()> {
        let mut reader = Utf8Probe::new(StopReader { inner: std::fs::File::open(path)?, ctl: &self.ctl });
        let result = searcher.search_reader(matcher, &mut reader, &mut *sink);
        // NUL bytes in the head of UTF-16 text stop the byte search; later ones mark binary.
        let decode = if sink.binary {
            reader.head.contains(&0) && !ide_vfs::looks_binary(&reader.head)
        } else {
            !reader.is_utf8()
        };
        if !decode || self.ctl.stopped() {
            return result;
        }
        let Some(text) = (self.text.decode)(path, &std::fs::read(path)?) else {
            sink.binary = true;
            return Ok(());
        };
        *sink = FileSink::new(matcher, &self.ctl, None);
        searcher.search_slice(matcher, text.as_bytes(), sink)
    }
}

/// Keeps the first `budget` match ranges.
fn truncate(lines: &mut Vec<LineMatch>, mut budget: usize) {
    lines.retain_mut(|line| {
        line.ranges.truncate(budget);
        budget -= line.ranges.len();
        !line.ranges.is_empty()
    });
}

struct FileSink<'a> {
    matcher: &'a RegexMatcher,
    ctl: &'a Control<'a>,
    lines: Vec<LineMatch>,
    /// Match ranges collected so far.
    count: usize,
    binary: bool,
    ticks: u32,
    /// Scratch buffers reused across lines.
    found: Vec<(usize, usize)>,
    ranges: Vec<(usize, usize)>,
    /// Search context filter and the file's comments / string literals.
    context: Option<(SearchContext, &'a [LiteralRange])>,
}

impl<'a> FileSink<'a> {
    fn new(
        matcher: &'a RegexMatcher,
        ctl: &'a Control<'a>,
        context: Option<(SearchContext, &'a [LiteralRange])>,
    ) -> Self {
        Self {
            matcher,
            ctl,
            lines: Vec::new(),
            count: 0,
            binary: false,
            ticks: 0,
            found: Vec::new(),
            ranges: Vec::new(),
            context,
        }
    }
}

/// Kind of the comment or string literal containing byte `pos` (`literals` sorted).
fn literal_at(literals: &[LiteralRange], pos: usize) -> Option<LiteralKind> {
    let i = literals.partition_point(|l| l.start <= pos);
    literals[..i].last().filter(|l| pos < l.end).map(|l| l.kind)
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, m: &SinkMatch<'_>) -> Result<bool, io::Error> {
        self.ticks += 1;
        if self.ctl.stopped() || (self.ticks.is_multiple_of(CANCEL_CHECK_LINES) && self.ctl.should_stop()) {
            return Ok(false);
        }
        let buffer = m.buffer();
        let range = m.bytes_range_in_buffer();
        let block = &buffer[range.clone()];
        let first_line = m.line_number().map_or(0, |n| n.saturating_sub(1));

        // Matches in the block, as offsets relative to the block. Searching the
        // whole buffer from the block start keeps look-behind context intact.
        let mut found = std::mem::take(&mut self.found);
        let mut ranges = std::mem::take(&mut self.ranges);
        found.clear();
        for_each_match(self.matcher, &buffer[..range.end], range.start, |mm| {
            found.push((mm.start() - range.start, mm.end() - range.start));
        });
        if let Some((context, literals)) = self.context {
            let block_start = usize::try_from(m.absolute_byte_offset()).unwrap_or(usize::MAX);
            found.retain(|&(a, _)| context.accepts(literal_at(literals, block_start.saturating_add(a))));
        }

        let mut next = found.iter().copied().peekable();
        let mut line_start = 0;
        let mut line_no = first_line;
        while line_start < block.len() && next.peek().is_some() {
            let line_end_incl = memchr::memchr(b'\n', &block[line_start..]).map_or(block.len(), |i| line_start + i + 1);
            let mut content_end = line_end_incl;
            if content_end > line_start && block[content_end - 1] == b'\n' {
                content_end -= 1;
                if content_end > line_start && block[content_end - 1] == b'\r' {
                    content_end -= 1;
                }
            }
            ranges.clear();
            while let Some(&(a, b)) = next.peek() {
                if a >= line_end_incl {
                    break;
                }
                next.next();
                let a = a.min(content_end);
                let b = b.clamp(a, content_end);
                ranges.push((a - line_start, b - line_start));
            }
            if !ranges.is_empty() {
                self.count += ranges.len();
                let line_no = u32::try_from(line_no).unwrap_or(u32::MAX);
                self.lines.push(line_match(line_no, &block[line_start..content_end], &ranges));
            }
            line_start = line_end_incl;
            line_no += 1;
        }
        self.found = found;
        self.ranges = ranges;
        // One match beyond the remaining budget is enough to know the limit is hit.
        Ok(self.count <= self.ctl.remaining() as usize)
    }

    fn binary_data(&mut self, _searcher: &Searcher, _offset: u64) -> Result<bool, io::Error> {
        self.binary = true;
        Ok(false)
    }
}

/// Aborts disk reads once the search is stopped or cancelled.
struct StopReader<'a, R> {
    inner: R,
    ctl: &'a Control<'a>,
}

impl<R: Read> Read for StopReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.ctl.should_stop() {
            return Err(io::Error::other("search stopped"));
        }
        self.inner.read(buf)
    }
}

/// How many leading bytes [`Utf8Probe`] keeps for the binary check.
const HEAD_LEN: usize = 8 * 1024;

/// Passes bytes through while checking that they are UTF-8, keeping the head
/// of the file.
struct Utf8Probe<R> {
    inner: R,
    head: Vec<u8>,
    /// Bytes of a character split across reads.
    partial: Vec<u8>,
    invalid: bool,
}

impl<R> Utf8Probe<R> {
    fn new(inner: R) -> Self {
        Self { inner, head: Vec::new(), partial: Vec::new(), invalid: false }
    }

    /// Whether everything read so far was UTF-8 (a truncated final character
    /// is not).
    fn is_utf8(&self) -> bool {
        !self.invalid && self.partial.is_empty()
    }

    fn check(&mut self, mut bytes: &[u8]) {
        if self.invalid {
            return;
        }
        if let Some(&lead) = self.partial.first() {
            let width = utf8_width(lead);
            let take = (width - self.partial.len()).min(bytes.len());
            self.partial.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.partial.len() < width {
                return;
            }
            if std::str::from_utf8(&self.partial).is_err() {
                self.invalid = true;
                return;
            }
            self.partial.clear();
        }
        match std::str::from_utf8(bytes) {
            Ok(_) => {}
            Err(e) if e.error_len().is_none() => self.partial.extend_from_slice(&bytes[e.valid_up_to()..]),
            Err(_) => self.invalid = true,
        }
    }
}

/// Encoded length of a UTF-8 sequence starting with `lead` (a valid lead byte
/// of an incomplete sequence).
fn utf8_width(lead: u8) -> usize {
    match lead {
        0xF0.. => 4,
        0xE0.. => 3,
        _ => 2,
    }
}

impl<R: Read> Read for Utf8Probe<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        let read = &buf[..n];
        if self.head.len() < HEAD_LEN {
            let take = (HEAD_LEN - self.head.len()).min(n);
            self.head.extend_from_slice(&read[..take]);
        }
        self.check(read);
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Probe;
    use std::io::Read;

    /// Reads `bytes` through a probe in chunks of `chunk` bytes.
    fn probe(bytes: &[u8], chunk: usize) -> bool {
        let mut probe = Utf8Probe::new(bytes);
        let mut buf = vec![0; chunk];
        while probe.read(&mut buf).unwrap() > 0 {}
        probe.is_utf8()
    }

    #[test]
    fn checks_utf8_across_read_boundaries() {
        let utf8 = "a中文😀b".as_bytes();
        let (gbk, _, _) = encoding_rs::GBK.encode("a中文b");
        for chunk in 1..=utf8.len() {
            assert!(probe(utf8, chunk), "chunk {chunk}");
            assert!(!probe(&gbk, chunk), "chunk {chunk}");
            assert!(!probe(&utf8[..utf8.len() - 2], chunk), "truncated, chunk {chunk}");
        }
    }
}
