//! Paths to GC roots, along the BFS tree of `gc_parent`.

use super::{HeapEdge, HeapIndex, HeapObjectRef, HeapPathStep, HeapRootPath, id_value, instance_fields};
use crate::column::NONE;
use crate::hprof::{BasicType, HeapRecord, HeapRootKind};
use crate::strings::{char_array_text, string_preview};

const THREAD_NAME_CHARS: usize = 100;

/// Steps a long path keeps at each end: one deep in a long linked list would otherwise send
/// every node over IPC.
const PATH_END_STEPS: u32 = 500;

impl HeapIndex {
    /// From `object` up to its GC root, each step with how the next one holds it; past 1000
    /// steps, only the 500 at each end. `None` for an unreachable object or a ref that names no
    /// object.
    pub fn path_to_root(&self, object: HeapObjectRef) -> Option<HeapRootPath> {
        let root = self.root();
        let mut v = object.0;
        if v >= root || self.gc_parent[v as usize] == NONE {
            return None;
        }
        let len = self.path_len(v)?;
        let end = PATH_END_STEPS;
        let cut = len > 2 * end;
        let mut steps = Vec::with_capacity(len.min(2 * end) as usize);
        for i in 0..len {
            let parent = self.gc_parent[v as usize];
            if !cut || i < end || i >= len - end {
                let via = if parent == root { self.root_edge(v) } else { self.edge(parent, v) };
                steps.push(HeapPathStep { object: self.object_row(HeapObjectRef(v))?, via });
            }
            v = parent;
        }
        let omitted = if cut { len - 2 * end } else { 0 };
        Some(HeapRootPath { steps, omitted, omitted_after: if cut { end } else { 0 } })
    }

    /// Steps from `v` to the root; `None` when `gc_parent` leads nowhere.
    fn path_len(&self, mut v: u32) -> Option<u32> {
        let root = self.root();
        // A BFS tree has no cycles; the bound only stops a corrupt column from looping.
        for len in 1..=root {
            let parent = self.gc_parent[v as usize];
            if parent == root {
                return Some(len);
            }
            if parent > root {
                return None;
            }
            v = parent;
        }
        None
    }

    fn root_edge(&self, v: u32) -> HeapEdge {
        let (kind, serial) = self.roots.get(&v).copied().unwrap_or((HeapRootKind::Unknown, None));
        let thread = serial.and_then(|s| self.thread_objects.get(&s)).and_then(|&t| self.thread_name(t));
        HeapEdge::Root { root: kind, thread }
    }

    /// `Thread.name`: a String, or a `char[]` before JDK 9.
    fn thread_name(&self, thread: u32) -> Option<String> {
        let Some(HeapRecord::Instance { data, .. }) = self.record(thread) else { return None };
        let fields = instance_fields(self, *self.types.get(thread as usize)?, data);
        let name = fields.iter().find(|f| f.name == "name" && f.ty == BasicType::Object)?;
        let target = self.ids.rank(id_value(name.bytes)?)?;
        string_preview(self, target, THREAD_NAME_CHARS).or_else(|| char_array_text(self, target, THREAD_NAME_CHARS))
    }

    /// How `parent` refers to `child`, checked in the order the graph's edges were made. A strong
    /// edge from `parent` always exists; the empty field name only covers a dump that changed.
    fn edge(&self, parent: u32, child: u32) -> HeapEdge {
        self.find_edge(parent, self.ids.id_at(child)).unwrap_or(HeapEdge::Field { name: String::new() })
    }

    fn find_edge(&self, parent: u32, child_id: u64) -> Option<HeapEdge> {
        match self.record(parent)? {
            HeapRecord::Instance { data, .. } => {
                let class = self.types[parent as usize];
                let field = instance_fields(self, class, data)
                    .into_iter()
                    .find(|f| !f.weak && f.ty == BasicType::Object && id_value(f.bytes) == Some(child_id));
                match field {
                    Some(f) => Some(HeapEdge::Field { name: f.name.to_owned() }),
                    None => (self.class_info.get(class as usize)?.id == child_id).then_some(HeapEdge::ClassOf),
                }
            }
            HeapRecord::ObjectArray { data, .. } => {
                let index =
                    data.chunks_exact(usize::from(self.id_size)).position(|item| id_value(item) == Some(child_id))?;
                Some(HeapEdge::Element { index: u32::try_from(index).ok()? })
            }
            HeapRecord::Class(dump) if dump.super_id == child_id => Some(HeapEdge::SuperClass),
            HeapRecord::Class(dump) if dump.loader_id == child_id => Some(HeapEdge::ClassLoader),
            HeapRecord::Class(_) => {
                let info = self.class_info.get(self.class_of_object(parent)?)?;
                let (name, _) = info.statics.iter().find(|(_, object)| *object == child_id)?;
                Some(HeapEdge::Static { name: name.clone() })
            }
            HeapRecord::Root { .. } | HeapRecord::PrimitiveArray { .. } => None,
        }
    }
}
