//! Turns one heap sub-record into its node (index, type, length) and its outgoing edges. Both
//! linking passes go through here, so the degrees counted in the first match the edges written
//! in the second.

use super::classes::ClassTable;
use crate::column::NONE;
use crate::error::HeapError;
use crate::hprof::{BasicType, HeapRecord};
use crate::ids::IdMap;

pub(super) struct Node {
    pub(super) index: u32,
    pub(super) ty: u32,
    pub(super) len: u32,
}

pub(super) struct Linker<'a> {
    ids: &'a IdMap,
    table: &'a ClassTable,
    /// Per class: the node of its class object, `NONE` for the synthetic `java.lang.Class`.
    class_objects: Vec<u32>,
    id_size: u8,
}

impl<'a> Linker<'a> {
    pub(super) fn new(ids: &'a IdMap, table: &'a ClassTable, id_size: u8) -> Self {
        let class_objects =
            table.classes.iter().map(|c| if c.id == 0 { NONE } else { ids.rank(c.id).unwrap_or(NONE) }).collect();
        Self { ids, table, class_objects, id_size }
    }

    /// `None` for root records. `at` is the record's offset, for the error of an instance or array
    /// whose class is not in the dump.
    pub(super) fn node(&self, at: usize, record: &HeapRecord<'_>) -> Result<Option<Node>, HeapError> {
        let class_index = |class_id: u64| {
            self.table.by_id.get(&class_id).copied().ok_or(HeapError::MissingClass { id: class_id, at: at as u64 })
        };
        let (id, ty, len) = match record {
            HeapRecord::Root { .. } => return Ok(None),
            HeapRecord::Class(c) => (c.id, self.table.class_slot, 0),
            HeapRecord::Instance { id, class_id, .. } => (*id, class_index(*class_id)?, 0),
            HeapRecord::ObjectArray { id, class_id, len, .. } => (*id, class_index(*class_id)?, *len),
            HeapRecord::PrimitiveArray { id, ty, len, .. } => {
                let prim_base = self.table.classes.len() as u32;
                (*id, prim_base + (*ty as u32 - BasicType::Boolean as u32), *len)
            }
        };
        Ok(self.ids.rank(id).map(|index| Node { index, ty, len }))
    }

    /// Calls `edge(target, is_referent)` for every reference to an object in the dump, in field
    /// order; `is_referent` marks `Reference.referent`, which callers leave out of the graph.
    pub(super) fn edges(&self, record: &HeapRecord<'_>, edge: &mut impl FnMut(u32, bool)) {
        let mut to = |id: u64, weak: bool| {
            if let Some(target) = self.target(id) {
                edge(target, weak);
            }
        };
        match record {
            HeapRecord::Root { .. } | HeapRecord::PrimitiveArray { .. } => {}
            HeapRecord::Class(c) => {
                to(c.super_id, false);
                to(c.loader_id, false);
                for &(_, object) in &c.statics {
                    to(object, false);
                }
            }
            HeapRecord::ObjectArray { data, .. } => {
                for item in data.chunks_exact(usize::from(self.id_size)) {
                    to(read_id(item, 0, self.id_size).unwrap_or(0), false);
                }
            }
            HeapRecord::Instance { class_id, data, .. } => {
                let Some(&class) = self.table.by_id.get(class_id) else { return };
                let mut base = 0;
                let mut next = self.table.fielded[class as usize];
                'chain: while next != NONE && base < data.len() {
                    let c = next as usize;
                    for &(offset, weak) in &self.table.refs[c] {
                        let Some(id) = read_id(data, base + offset, self.id_size) else { break 'chain };
                        to(id, weak);
                    }
                    base += self.table.own_bytes[c];
                    next = self.table.classes[c].super_index.map_or(NONE, |s| self.table.fielded[s as usize]);
                }
                let object = self.class_objects[class as usize];
                if object != NONE {
                    edge(object, false);
                }
            }
        }
    }

    /// Id 0 is null; ids not in the dump have no node.
    fn target(&self, id: u64) -> Option<u32> {
        if id == 0 { None } else { self.ids.rank(id) }
    }
}

/// The big-endian id at `at`, or `None` when `data` ends first.
fn read_id(data: &[u8], at: usize, id_size: u8) -> Option<u64> {
    let bytes = data.get(at..at.checked_add(usize::from(id_size))?)?;
    Some(match *bytes {
        [a, b, c, d] => u64::from(u32::from_be_bytes([a, b, c, d])),
        _ => u64::from_be_bytes(bytes.try_into().ok()?),
    })
}
