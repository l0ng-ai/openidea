//! Ties the passes together: graph, dominators, shallow and retained sizes, the class table and
//! paths to GC roots, into a [`HeapIndex`].

mod classes;
mod paths;
mod retained;

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::time::Instant;

use ide_core::CancellationToken;
use memmap2::Mmap;

use crate::column::Store;
use crate::dominators::{Dominators, dominators};
use crate::error::HeapError;
use crate::files::INDEX_FILES;
use crate::graph::{HeapGraph, build_graph};
use crate::index::{HeapIndex, HeapSummary, write_summary};
use crate::progress::{CHECK_EVERY, HeapPhase, Progress};
use crate::shallow::{HistogramEntry, ShallowModel, VmLayout};

#[derive(Clone, Debug, Default)]
pub struct AnalyzeOptions {
    /// The JVM's class histogram from the same stop as the dump.
    pub histogram: Option<Vec<HistogramEntry>>,
    /// `VM.flags` output of the JVM that wrote the dump.
    pub vm_flags: Option<String>,
    pub java_major: Option<u32>,
    /// Keep every array in RAM and write nothing to `index_dir`.
    pub in_memory: bool,
}

/// Analyzes the dump at `hprof`, writing the index columns and `summary.json` into `index_dir`
/// (which must exist and may hold the dump itself). `progress` gets every [`HeapPhase`] in order;
/// an `Err` from it, a cancel or any other error removes every index file from `index_dir` and
/// leaves the rest of the directory alone.
pub fn analyze(
    hprof: &Path,
    index_dir: &Path,
    opts: AnalyzeOptions,
    progress: &dyn Fn(HeapPhase, u64, u64) -> Result<(), HeapError>,
    cancel: &CancellationToken,
) -> Result<HeapIndex, HeapError> {
    let store = if opts.in_memory { Store::Ram } else { Store::Dir(index_dir.to_path_buf()) };
    let result = run(hprof, &store, opts, progress, cancel);
    // `run` has dropped every column by now: Windows cannot delete a mapped file.
    if result.is_err() && !matches!(store, Store::Ram) {
        remove_index_files(index_dir);
    }
    result
}

fn run(
    hprof: &Path,
    store: &Store,
    opts: AnalyzeOptions,
    report: &dyn Fn(HeapPhase, u64, u64) -> Result<(), HeapError>,
    cancel: &CancellationToken,
) -> Result<HeapIndex, HeapError> {
    let started = Instant::now();
    let progress = Progress::new(report, cancel);
    let file = File::open(hprof)?;
    // SAFETY: nothing writes the dump while it is analyzed or viewed: a capture finishes writing
    // it before analysis and deletes it only with the snapshot that holds this index.
    let dump = unsafe { Mmap::map(&file)? };
    let graph = build_graph(&dump, store, report, cancel)?;
    let Dominators { idom, preorder, .. } =
        dominators(&graph.out_start, &graph.out, graph.root, store, report, cancel)?;

    let nodes = u64::from(graph.root) + 1;
    // Seven walks over the nodes, roughly: sizes, retained, child counts, child sorting, class
    // counts and the tree walk, which visits every node twice.
    let mut meter = Meter::start(&progress, HeapPhase::Retained, 7 * nodes)?;
    let layout = VmLayout::from_vm_flags(opts.vm_flags.as_deref().unwrap_or(""), opts.java_major);
    let model = ShallowModel::new(&graph, layout, opts.histogram.as_deref(), cancel)?;
    let (shallow8, retained) = retained::sizes(&graph, &model, &idom, &preorder, store, &mut meter)?;
    drop(preorder);
    let (kids_start, kids) = retained::children(&idom, &retained, graph.root, store, &mut meter)?;
    let tree = retained::Tree { idom, shallow8, retained, kids_start, kids };
    let (classes, totals) = classes::table(&graph, &tree, store, &mut meter)?;
    meter.finish()?;

    let mut meter = Meter::start(&progress, HeapPhase::Paths, nodes + graph.out.len() as u64)?;
    let gc_parent = paths::gc_parents(&graph, store, &mut meter)?;
    meter.finish()?;

    progress.report(HeapPhase::Saving, 0, 1)?;
    let HeapGraph {
        ids,
        types,
        offsets,
        roots,
        classes: class_info,
        class_slot,
        thread_objects,
        weak_edges_skipped,
        id_size,
        ..
    } = graph;
    let summary = HeapSummary {
        objects: totals.reachable_objects + totals.unreachable_objects,
        reachable_objects: totals.reachable_objects,
        reachable_bytes: totals.reachable_bytes,
        unreachable_objects: totals.unreachable_objects,
        unreachable_bytes: totals.unreachable_bytes,
        classes: class_info.iter().filter(|c| c.id != 0).count() as u32,
        weak_edges_skipped,
        size_source: model.source,
        analysis_ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
    };
    if let Store::Dir(dir) = store {
        write_summary(dir, &summary)?;
    }
    let mut root_kinds = HashMap::with_capacity(roots.len());
    for (object, kind, serial) in roots {
        root_kinds.entry(object).or_insert((kind, serial));
    }
    progress.report(HeapPhase::Saving, 1, 1)?;

    let retained::Tree { idom, shallow8, retained, kids_start, kids } = tree;
    Ok(HeapIndex {
        hprof: dump,
        ids,
        types,
        offsets,
        shallow8,
        retained,
        idom,
        kids_start,
        kids,
        gc_parent,
        classes,
        class_info,
        class_slot,
        roots: root_kinds,
        thread_objects,
        id_size,
        summary,
    })
}

/// Removes what an analysis may have written; a file that is not there is fine.
fn remove_index_files(dir: &Path) {
    for name in INDEX_FILES {
        let path = dir.join(name);
        if let Err(err) = std::fs::remove_file(&path)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!("could not remove {}: {err}", path.display());
        }
    }
}

/// Steps of one phase: reports progress every [`CHECK_EVERY`] steps, and each loop looks at the
/// token before its first step.
pub(super) struct Meter<'a> {
    progress: &'a Progress<'a>,
    phase: HeapPhase,
    /// An estimate; `done` is clamped to it.
    total: u64,
    done: u64,
    next_report: u64,
}

impl<'a> Meter<'a> {
    fn start(progress: &'a Progress<'a>, phase: HeapPhase, total: u64) -> Result<Self, HeapError> {
        progress.report(phase, 0, total)?;
        Ok(Self { progress, phase, total, done: 0, next_report: CHECK_EVERY })
    }

    pub(super) fn begin_loop(&self) -> Result<(), HeapError> {
        self.progress.check()
    }

    pub(super) fn token(&self) -> &'a CancellationToken {
        self.progress.token()
    }

    #[inline]
    pub(super) fn tick(&mut self) -> Result<(), HeapError> {
        self.advance(1)
    }

    pub(super) fn advance(&mut self, steps: u64) -> Result<(), HeapError> {
        self.done += steps;
        if self.done < self.next_report {
            return Ok(());
        }
        self.next_report = self.done + CHECK_EVERY;
        self.progress.report(self.phase, self.done.min(self.total), self.total)
    }

    fn finish(self) -> Result<(), HeapError> {
        self.progress.report(self.phase, self.total, self.total)
    }
}

#[cfg(test)]
mod tests;
