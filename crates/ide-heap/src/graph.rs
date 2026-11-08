//! The object graph of a heap dump in CSR form: one node per object, plus a super-root.

mod classes;
mod link;

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use ide_core::CancellationToken;

use self::classes::{ClassTable, IdHash};
use self::link::Linker;
use crate::column::{Column, Store};
use crate::error::HeapError;
use crate::hprof::{BasicType, HeapRecord, HeapRootKind, Record, parse_header, scan, scan_segment};
use crate::ids::{IdMap, IdMapBuilder};
use crate::progress::{CHECK_EVERY, HeapPhase, Progress};

const TYPES_FILE: &str = "types.u32";
const OFFSETS_FILE: &str = "offsets.u64";

/// Number of primitive array type slots, one per non-object [`BasicType`].
pub const PRIM_SLOTS: u32 = 8;

pub struct ClassInfo {
    pub id: u64,
    /// The hprof name with `/` turned into `.` (`java.lang.String`, `[Ljava.lang.Object;`).
    pub name: String,
    /// Index in [`HeapGraph::classes`]. Chains always end: a super cycle in the dump is cut where it closes.
    pub super_index: Option<u32>,
    /// This class's own instance fields, in dump order.
    pub fields: Vec<(String, BasicType)>,
    /// `(name, object id)` of reference statics; a null static has object id 0.
    pub statics: Vec<(String, u64)>,
    pub static_bytes: u64,
    /// Index in `fields` of `java.lang.ref.Reference.referent`, on that class only.
    pub weak_field: Option<usize>,
}

pub struct HeapGraph {
    pub ids: IdMap,
    /// Type slot of each object: class index for instances and object arrays,
    /// [`Self::class_slot`] for class objects, [`Self::prim_slot`] for primitive arrays.
    pub types: Column<u32>,
    /// Array length, 0 for instances and classes.
    pub lens: Column<u32>,
    /// File offset of each object's record, for [`crate::record_at`].
    pub offsets: Column<u64>,
    /// `n + 2` entries: node `v`'s targets are `out[out_start[v]..out_start[v + 1]]`.
    pub out_start: Column<u32>,
    pub out: Column<u32>,
    /// The super-root, node `n`, with an edge to every rooted object.
    pub root: u32,
    /// `(object, kind, thread serial)` of every root record whose object is in the dump.
    pub roots: Vec<(u32, HeapRootKind, Option<u32>)>,
    /// Class dumps in dump order, then a synthetic `java.lang.Class` when the dump has none.
    pub classes: Vec<ClassInfo>,
    /// Type slot of class objects (`java.lang.Class`).
    pub class_slot: u32,
    /// Thread serial → thread object, from `ROOT THREAD OBJECT` records.
    pub thread_objects: HashMap<u32, u32>,
    /// `Reference.referent` edges left out of the graph.
    pub weak_edges_skipped: u64,
    pub id_size: u8,
    pub timestamp_ms: u64,
}

impl HeapGraph {
    pub fn prim_slot(&self, ty: BasicType) -> u32 {
        self.classes.len() as u32 + (ty as u32 - BasicType::Boolean as u32)
    }

    /// The element type of primitive array slot `slot`, or `None` for a class slot.
    pub fn prim_type(&self, slot: u32) -> Option<BasicType> {
        let offset = slot.checked_sub(self.classes.len() as u32).filter(|&o| o < PRIM_SLOTS)?;
        BasicType::from_u8(offset as u8 + BasicType::Boolean as u8)
    }

    pub fn out_edges(&self, v: u32) -> &[u32] {
        let v = v as usize;
        &self.out[self.out_start[v] as usize..self.out_start[v + 1] as usize]
    }
}

/// Builds the graph of the dump in `buf`. Strong edges only: `Reference.referent` is counted in
/// [`HeapGraph::weak_edges_skipped`] instead. `progress` gets `Reading` by bytes, then
/// `Linking` by objects, starting with `(Linking, 0, objects)` once the object count is known;
/// an `Err` from it stops the build with that error.
pub fn build_graph(
    buf: &[u8],
    store: &Store,
    progress: &dyn Fn(HeapPhase, u64, u64) -> Result<(), HeapError>,
    cancel: &CancellationToken,
) -> Result<HeapGraph, HeapError> {
    let progress = Progress::new(progress, cancel);
    let header = parse_header(buf)?;
    let id_size = header.id_size;
    let len = buf.len() as u64;

    // Pass 1: names, classes, roots and every object id.
    progress.report(HeapPhase::Reading, 0, len)?;
    let mut names: IdHash<&[u8]> = IdHash::default();
    let mut class_names: IdHash<u64> = IdHash::default();
    let mut dumps = Vec::new();
    let mut class_by_id: IdHash<u32> = IdHash::default();
    let mut raw_roots = Vec::new();
    let mut segments = Vec::new();
    let mut builder = IdMapBuilder::new();
    let (mut step, mut pos) = (0, header.body_start as u64);
    scan(buf, &header, &mut |record| {
        progress.step(step, HeapPhase::Reading, pos, len)?;
        step += 1;
        match record {
            Record::Utf8 { id, text } => {
                names.insert(id, text);
            }
            Record::LoadClass { class_id, name_id } => {
                class_names.insert(class_id, name_id);
            }
            Record::Segment(range) => {
                pos = range.start as u64;
                segments.push(range);
            }
            Record::Heap { at, record } => {
                pos = at as u64;
                match record {
                    HeapRecord::Root { kind, id, thread_serial } => raw_roots.push((id, kind, thread_serial)),
                    HeapRecord::Class(dump) => {
                        builder.insert(dump.id);
                        if let Entry::Vacant(slot) = class_by_id.entry(dump.id) {
                            slot.insert(dumps.len() as u32);
                            dumps.push(dump);
                        }
                    }
                    HeapRecord::Instance { id, .. }
                    | HeapRecord::ObjectArray { id, .. }
                    | HeapRecord::PrimitiveArray { id, .. } => builder.insert(id),
                }
            }
        }
        Ok(())
    })?;
    progress.report(HeapPhase::Reading, len, len)?;

    let ids = builder.build(store, cancel)?;
    let table = classes::resolve(dumps, class_by_id, &names, &class_names, id_size)?;
    drop((names, class_names));
    let n = ids.len();
    let objects = u64::from(n);
    progress.report(HeapPhase::Linking, 0, objects)?;

    let mut roots = Vec::new();
    let mut root_targets = Vec::new();
    let mut thread_objects = HashMap::new();
    let (mut seen_records, mut seen_targets) = (HashSet::new(), HashSet::new());
    for (i, &(id, kind, serial)) in raw_roots.iter().enumerate() {
        progress.step(i as u64, HeapPhase::Linking, 0, objects)?;
        let Some(object) = ids.rank(id).filter(|_| id != 0) else { continue };
        if seen_records.insert((object, kind as u8, serial)) {
            roots.push((object, kind, serial));
        }
        if seen_targets.insert(object) {
            root_targets.push(object);
        }
        if let (HeapRootKind::ThreadObject, Some(serial)) = (kind, serial) {
            thread_objects.entry(serial).or_insert(object);
        }
    }
    drop((raw_roots, seen_records, seen_targets));

    let linker = Linker::new(&ids, &table, id_size);
    let nodes = n as usize;
    let mut types = store.column::<u32>(TYPES_FILE, nodes, 0)?;
    let mut lens = store.scratch::<u32>(nodes, 0)?;
    let mut offsets = store.column::<u64>(OFFSETS_FILE, nodes, 0)?;
    let mut out_start = store.scratch::<u32>(nodes + 2, 0)?;
    // Both passes visit every object record once; report them as one walk over the objects.
    let mut visited = 0u64;
    let tick = |visited: &mut u64| {
        let result = progress.step(*visited, HeapPhase::Linking, (*visited / 2).min(objects), objects);
        *visited += 1;
        result
    };

    // Pass 2: node columns and out-degrees, counted into `out_start[v + 1]`.
    let mut weak_edges_skipped = 0;
    for segment in &segments {
        scan_segment(buf, segment.clone(), id_size, &mut |at, record| {
            let Some(node) = linker.node(at, &record)? else { return Ok(()) };
            tick(&mut visited)?;
            let v = node.index as usize;
            types[v] = node.ty;
            lens[v] = node.len;
            offsets[v] = at as u64;
            let mut degree = 0u64;
            linker.edges(&record, &mut |_, weak| {
                if weak {
                    weak_edges_skipped += 1;
                } else {
                    degree += 1;
                }
            });
            let count = &mut out_start[v + 1];
            *count = u32::try_from(u64::from(*count) + degree).map_err(|_| HeapError::TooLarge)?;
            Ok(())
        })?;
    }
    out_start[nodes + 1] = u32::try_from(root_targets.len()).map_err(|_| HeapError::TooLarge)?;
    let edges = accumulate(&mut out_start, cancel)?;

    // Pass 3: `out_start[v]` is node v's write cursor; once filled it holds v's end, so the
    // column is shifted one slot right to become the starts again.
    let mut out = store.scratch::<u32>(edges as usize, 0)?;
    for segment in &segments {
        scan_segment(buf, segment.clone(), id_size, &mut |at, record| {
            let Some(node) = linker.node(at, &record)? else { return Ok(()) };
            tick(&mut visited)?;
            let v = node.index as usize;
            let mut cursor = out_start[v] as usize;
            linker.edges(&record, &mut |target, weak| {
                if !weak && let Some(slot) = out.get_mut(cursor) {
                    *slot = target;
                    cursor += 1;
                }
            });
            out_start[v] = cursor as u32;
            Ok(())
        })?;
    }
    let first_root_edge = out_start[nodes] as usize;
    for (slot, &target) in out[first_root_edge..].iter_mut().zip(&root_targets) {
        *slot = target;
    }
    out_start[nodes] = edges;
    out_start.copy_within(0..nodes + 1, 1);
    out_start[0] = 0;
    progress.report(HeapPhase::Linking, objects, objects)?;

    drop(linker);
    let ClassTable { classes, class_slot, .. } = table;
    Ok(HeapGraph {
        ids,
        types,
        lens,
        offsets,
        out_start,
        out,
        root: n,
        roots,
        classes,
        class_slot,
        thread_objects,
        weak_edges_skipped,
        id_size,
        timestamp_ms: header.timestamp_ms,
    })
}

/// Turns per-node counts into running totals in place (`counts[k]` becomes the sum of
/// `counts[..=k]`) and returns the last one; past `u32::MAX` the graph is `TooLarge`.
fn accumulate(counts: &mut [u32], cancel: &CancellationToken) -> Result<u32, HeapError> {
    let mut sum = 0u32;
    for chunk in counts.chunks_mut(CHECK_EVERY as usize) {
        if cancel.is_cancelled() {
            return Err(HeapError::Cancelled);
        }
        for count in chunk {
            sum = sum.checked_add(*count).ok_or(HeapError::TooLarge)?;
            *count = sum;
        }
    }
    Ok(sum)
}

#[cfg(test)]
mod tests;
