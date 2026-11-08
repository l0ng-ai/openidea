//! Shallow sizes: the bytes each object takes in the JVM heap, from the object layout rules, the
//! JVM's own class histogram, or the distances between object addresses in the dump.

mod layout;
mod mirrors;

use std::collections::HashMap;

use ide_core::CancellationToken;
use serde::{Deserialize, Serialize};

pub use self::layout::VmLayout;
use self::mirrors::Mirrors;
use crate::error::HeapError;
use crate::graph::{ClassInfo, HeapGraph};
use crate::hprof::BasicType;
use crate::names::display_name;
use crate::progress::CHECK_EVERY;

/// How far past the layout size an address gap may be and still count as an object size.
const GAP_SLACK: u64 = 64;
/// Share of the instance types that can have a gap (two or more instances), in tenths, that must
/// take their size from address gaps for the sizes to be reported as coming from them.
const GAP_TRUST_TENTHS: usize = 9;

/// Where the sizes of instances came from.
///
/// Class objects (mirrors) are approximate in every case: HotSpot leaves the fields it injects
/// into `java.lang.Class` out of the dump, so their layout size is short by a fixed amount per
/// mirror. With a histogram that amount is fitted to its `java.lang.Class` row; without one it is
/// 0, because it differs between JDK versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SizeSource {
    /// The JVM's class histogram from the capture.
    Jvm,
    /// The smallest distance between neighbouring objects of a type, in a dump the IDE did not
    /// capture.
    AddressGaps,
    Layout,
}

/// A row of the JVM's class histogram.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistogramEntry {
    /// Display form: `java.lang.String`, `int[]`, `Gen$$Lambda/0x…`.
    pub name: String,
    pub instances: u64,
    pub bytes: u64,
}

enum TypeSize {
    Fixed(u64),
    ObjectArray,
    /// Class objects are sized one by one; this is for an instance of `java.lang.Class` that is
    /// not a class object.
    ClassObject(u64),
}

/// Shallow size of every object of a [`HeapGraph`]. Instances of a type share one size; arrays
/// follow the layout; class objects add their statics to the size of `java.lang.Class`.
pub struct ShallowModel {
    pub source: SizeSource,
    layout: VmLayout,
    /// Per type slot of a class; primitive array slots follow and have no entry.
    types: Vec<TypeSize>,
    /// `(node, size)` of each class object, by node.
    class_objects: Vec<(u32, u64)>,
    /// Per class slot: another class has the same display name.
    ambiguous: Vec<bool>,
}

impl ShallowModel {
    /// `histogram` is the JVM's class histogram of the same stop as the dump, when the IDE captured
    /// it. Without it, sizes come from address gaps where they agree with the layout.
    ///
    /// A name shared by several classes (several class loaders) never takes a histogram size,
    /// since the name is the only link between the dump and the histogram; see
    /// [`Self::is_ambiguous`]. `java.lang.Class` never does either, because mirror sizes vary with
    /// their statics; the histogram only tells how many bytes HotSpot adds to each mirror.
    pub fn new(
        graph: &HeapGraph,
        layout: VmLayout,
        histogram: Option<&[HistogramEntry]>,
        cancel: &CancellationToken,
    ) -> Result<Self, HeapError> {
        if cancel.is_cancelled() {
            return Err(HeapError::Cancelled);
        }
        let classes = &graph.classes;
        let field_bytes = field_bytes(classes, layout);
        let by_layout: Vec<u64> = field_bytes.iter().map(|&bytes| layout.instance_size(bytes)).collect();
        let names: Vec<String> = classes.iter().map(|c| display_name(&c.name)).collect();
        let ambiguous = ambiguous_names(&names);

        let class_slot = graph.class_slot as usize;
        let mirrors = Mirrors::collect(graph, by_layout[class_slot], layout);
        let mut injected = 0;
        if let Some(rows) = histogram
            && !ambiguous[class_slot]
        {
            let mut class_rows = rows.iter().filter(|row| row.name == names[class_slot]);
            if let (Some(row), None) = (class_rows.next(), class_rows.next()) {
                injected = mirrors.fit_injected(graph, layout, by_layout[class_slot], row, cancel)?;
            }
        }

        let mut types: Vec<TypeSize> = classes
            .iter()
            .enumerate()
            .map(|(slot, class)| {
                if class.name.starts_with('[') {
                    TypeSize::ObjectArray
                } else if slot == class_slot {
                    TypeSize::ClassObject(layout.align(by_layout[slot] + injected))
                } else {
                    TypeSize::Fixed(by_layout[slot])
                }
            })
            .collect();
        let source = match histogram {
            Some(rows) => {
                apply_histogram(&mut types, &names, &ambiguous, rows);
                SizeSource::Jvm
            }
            None => apply_address_gaps(&mut types, graph, &by_layout, cancel)?,
        };
        Ok(Self { source, layout, types, class_objects: mirrors.sizes(layout, injected), ambiguous })
    }

    /// Shallow size of `object` (a node of the graph); 0 for the super-root.
    pub fn size_of(&self, graph: &HeapGraph, object: u32) -> u64 {
        let Some(&slot) = graph.types.get(object as usize) else { return 0 };
        match self.types.get(slot as usize) {
            Some(&TypeSize::Fixed(size)) => size,
            Some(TypeSize::ObjectArray) => self.array_size(BasicType::Object, graph.lens[object as usize]),
            Some(&TypeSize::ClassObject(fallback)) => self
                .class_objects
                .binary_search_by_key(&object, |&(node, _)| node)
                .map_or(fallback, |at| self.class_objects[at].1),
            None => match graph.prim_type(slot) {
                Some(ty) => self.array_size(ty, graph.lens[object as usize]),
                None => 0,
            },
        }
    }

    /// Whether another class has the same display name as the class in `slot`. Sizes of such
    /// classes come from the layout, and anything joined to them by name (histogram rows, a
    /// second snapshot) cannot tell them apart.
    pub fn is_ambiguous(&self, slot: u32) -> bool {
        self.ambiguous.get(slot as usize).copied().unwrap_or(false)
    }

    fn array_size(&self, ty: BasicType, len: u32) -> u64 {
        self.layout.array_size(ty, u64::from(len))
    }
}

/// Bytes of instance fields per class, its superclasses included. Super chains always end
/// (`ClassInfo::super_index` has its cycles cut).
fn field_bytes(classes: &[ClassInfo], layout: VmLayout) -> Vec<u64> {
    let mut total: Vec<Option<u64>> = vec![None; classes.len()];
    let mut path = Vec::new();
    for start in 0..classes.len() {
        let mut cursor = Some(start);
        let mut below = 0;
        while let Some(c) = cursor {
            if let Some(known) = total[c] {
                below = known;
                break;
            }
            path.push(c);
            cursor = classes[c].super_index.map(|s| s as usize);
        }
        while let Some(c) = path.pop() {
            let own: u64 = classes[c].fields.iter().map(|(_, ty)| ty.heap_size(layout.ref_size)).sum();
            below += own;
            total[c] = Some(below);
        }
    }
    total.into_iter().map(Option::unwrap_or_default).collect()
}

fn ambiguous_names(names: &[String]) -> Vec<bool> {
    let mut counts: HashMap<&str, u32> = HashMap::with_capacity(names.len());
    for name in names {
        *counts.entry(name).or_default() += 1;
    }
    names.iter().map(|name| counts[name.as_str()] > 1).collect()
}

/// `bytes / instances` for each plain class with a histogram row of its name. A name that is
/// ambiguous in the dump or repeated in the histogram, or a row that is not a whole number of
/// objects, keeps its layout size.
fn apply_histogram(types: &mut [TypeSize], names: &[String], ambiguous: &[bool], rows: &[HistogramEntry]) {
    let mut per_object: HashMap<&str, Option<u64>> = HashMap::with_capacity(rows.len());
    for row in rows {
        let size = row.bytes.checked_div(row.instances).filter(|&s| s > 0 && row.bytes % row.instances == 0);
        per_object.entry(&row.name).and_modify(|seen| *seen = None).or_insert(size);
    }
    for (slot, ty) in types.iter_mut().enumerate() {
        if let TypeSize::Fixed(size) = ty
            && !ambiguous[slot]
            && let Some(&Some(from_histogram)) = per_object.get(names[slot].as_str())
        {
            *size = from_histogram;
        }
    }
}

/// Takes the smallest distance from an instance to the next object in address order as the size
/// of its type, for types with two or more instances where that distance is no smaller than the
/// layout size and at most [`GAP_SLACK`] bigger. The result says [`SizeSource::AddressGaps`] when
/// nine in ten of the types with two or more instances did; types with one instance have no gap
/// to measure, so they neither count for nor against.
fn apply_address_gaps(
    types: &mut [TypeSize],
    graph: &HeapGraph,
    by_layout: &[u64],
    cancel: &CancellationToken,
) -> Result<SizeSource, HeapError> {
    let slots = types.len();
    let mut instances = vec![0u32; slots];
    let mut smallest_gap = vec![u64::MAX; slots];
    let mut ids = graph.ids.ids();
    let mut current = ids.next();
    let mut object = 0usize;
    while let Some(id) = current {
        if (object as u64).is_multiple_of(CHECK_EVERY) && cancel.is_cancelled() {
            return Err(HeapError::Cancelled);
        }
        let next = ids.next();
        let slot = graph.types[object] as usize;
        if matches!(types.get(slot), Some(TypeSize::Fixed(_))) {
            instances[slot] = instances[slot].saturating_add(1);
            if let Some(next) = next.filter(|&n| n > id) {
                smallest_gap[slot] = smallest_gap[slot].min(next - id);
            }
        }
        current = next;
        object += 1;
    }

    let (mut measurable, mut by_gap) = (0usize, 0usize);
    for (slot, ty) in types.iter_mut().enumerate() {
        let TypeSize::Fixed(size) = ty else { continue };
        if instances[slot] < 2 {
            continue;
        }
        measurable += 1;
        let gap = smallest_gap[slot];
        if (by_layout[slot]..=by_layout[slot] + GAP_SLACK).contains(&gap) {
            *size = gap;
            by_gap += 1;
        }
    }
    let trusted = measurable > 0 && by_gap * 10 >= measurable * GAP_TRUST_TENTHS;
    Ok(if trusted { SizeSource::AddressGaps } else { SizeSource::Layout })
}

#[cfg(test)]
mod tests;
