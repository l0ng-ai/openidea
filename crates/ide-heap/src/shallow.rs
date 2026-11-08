//! Shallow sizes: the bytes each object takes in the JVM heap, from the object layout rules, the
//! JVM's own class histogram, or the distances between object addresses in the dump.

use std::collections::HashMap;

use ide_core::CancellationToken;
use serde::{Deserialize, Serialize};

use crate::error::HeapError;
use crate::graph::{ClassInfo, HeapGraph};
use crate::hprof::BasicType;
use crate::names::display_name;
use crate::progress::CHECK_EVERY;

/// How far past the layout size an address gap may be and still count as an object size.
const GAP_SLACK: u64 = 64;
/// Share of instance types (in tenths) that must take their size from address gaps for the
/// sizes to be reported as coming from them.
const GAP_TRUST_TENTHS: usize = 9;

/// Object layout of the JVM that wrote the dump.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VmLayout {
    pub header: u8,
    /// Bytes of a reference: 4 with compressed oops.
    pub ref_size: u8,
    /// Offset of the length field of an array.
    pub length_offset: u8,
    /// JDK 21 and older put array elements at the next 8-byte boundary after the length, later
    /// JDKs at the next boundary of the element size.
    pub legacy_array_base: bool,
    pub alignment: u8,
}

impl VmLayout {
    pub const DEFAULT: VmLayout =
        VmLayout { header: 12, ref_size: 4, length_offset: 12, legacy_array_base: false, alignment: 8 };

    /// `flags` is the output of `VM.flags`. An `ObjectAlignmentInBytes` that does not fit `u8` or
    /// is not a power of two of at least 8 is ignored: the JVM allows 256, which no dump this
    /// code has met uses.
    pub fn from_vm_flags(flags: &str, java_major: u32) -> Self {
        let flags = parse_flags(flags);
        let enabled = |name: &str, default: bool| flags.get(name).map_or(default, |&v| v == "true");
        let compressed_oops = enabled("UseCompressedOops", true);
        let compressed_classes = enabled("UseCompressedClassPointers", true) && (java_major >= 15 || compressed_oops);
        let (header, length_offset) = if enabled("UseCompactObjectHeaders", false) {
            (8, 8)
        } else if compressed_classes {
            (12, 12)
        } else {
            (16, 16)
        };
        let alignment = flags
            .get("ObjectAlignmentInBytes")
            .and_then(|v| v.parse::<u8>().ok())
            .filter(|a| *a >= 8 && a.is_power_of_two())
            .unwrap_or(Self::DEFAULT.alignment);
        VmLayout {
            header,
            ref_size: if compressed_oops { 4 } else { 8 },
            length_offset,
            legacy_array_base: java_major <= 21,
            alignment,
        }
    }

    /// Size of an instance whose fields (its class and every superclass) take `field_bytes`.
    pub fn instance_size(&self, field_bytes: u64) -> u64 {
        let smallest = if self.header == 8 { 8 } else { 16 };
        self.align(u64::from(self.header) + field_bytes).max(smallest)
    }

    pub fn array_size(&self, ty: BasicType, len: u64) -> u64 {
        let element = ty.heap_size(self.ref_size);
        let base_alignment = if self.legacy_array_base { 8 } else { element };
        let base = align_to(u64::from(self.length_offset) + 4, base_alignment);
        self.align(base + element * len)
    }

    fn align(&self, value: u64) -> u64 {
        align_to(value, u64::from(self.alignment))
    }
}

fn align_to(value: u64, to: u64) -> u64 {
    value.div_ceil(to.max(1)) * to.max(1)
}

/// `-XX:+Name` / `-XX:-Name` / `-XX:Name=value` tokens by name; booleans become `"true"` / `"false"`.
/// A flag given twice keeps its last value, as in the JVM.
fn parse_flags(flags: &str) -> HashMap<&str, &str> {
    let mut parsed = HashMap::new();
    for token in flags.split_whitespace() {
        let Some(body) = token.strip_prefix("-XX:") else { continue };
        if let Some(name) = body.strip_prefix('+') {
            parsed.insert(name, "true");
        } else if let Some(name) = body.strip_prefix('-') {
            parsed.insert(name, "false");
        } else if let Some((name, value)) = body.split_once('=') {
            parsed.insert(name, value);
        }
    }
    parsed
}

/// Where the sizes of instances came from.
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
    /// their statics.
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
        let mut types: Vec<TypeSize> = classes
            .iter()
            .enumerate()
            .map(|(slot, class)| {
                if class.name.starts_with('[') {
                    TypeSize::ObjectArray
                } else if slot == class_slot {
                    TypeSize::ClassObject(by_layout[slot])
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

        let mut class_objects: Vec<(u32, u64)> = classes
            .iter()
            .filter(|class| class.id != 0)
            .filter_map(|class| {
                let node = graph.ids.rank(class.id)?;
                Some((node, class_object_size(class, by_layout[class_slot], layout)))
            })
            .collect();
        class_objects.sort_unstable_by_key(|&(node, _)| node);
        Ok(Self { source, layout, types, class_objects, ambiguous })
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

/// `java.lang.Class` fields, plus room for the statics.
fn class_object_size(class: &ClassInfo, class_instance: u64, layout: VmLayout) -> u64 {
    let references = class.statics.len() as u64 * u64::from(layout.ref_size);
    layout.align(class_instance + class.static_bytes + references)
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
/// nine in ten instance types did.
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

    let (mut seen, mut by_gap) = (0usize, 0usize);
    for (slot, ty) in types.iter_mut().enumerate() {
        let TypeSize::Fixed(size) = ty else { continue };
        if instances[slot] == 0 {
            continue;
        }
        seen += 1;
        let gap = smallest_gap[slot];
        if instances[slot] >= 2 && (by_layout[slot]..=by_layout[slot] + GAP_SLACK).contains(&gap) {
            *size = gap;
            by_gap += 1;
        }
    }
    Ok(if seen > 0 && by_gap * 10 >= seen * GAP_TRUST_TENTHS { SizeSource::AddressGaps } else { SizeSource::Layout })
}

#[cfg(test)]
mod tests;
