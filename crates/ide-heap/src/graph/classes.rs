//! Class dumps resolved into [`ClassInfo`]s, plus where the references sit in instance data.

use std::collections::HashMap;
use std::hash::BuildHasherDefault;

use super::{ClassInfo, PRIM_SLOTS};
use crate::column::NONE;
use crate::error::HeapError;
use crate::hprof::{BasicType, ClassDump};
use crate::ids::ChunkHasher;

/// Keyed by hprof id (an address).
pub(super) type IdHash<V> = HashMap<u64, V, BuildHasherDefault<ChunkHasher>>;

const REFERENCE: &str = "java.lang.ref.Reference";
const JAVA_LANG_CLASS: &str = "java.lang.Class";
/// Not computed yet, in [`ClassTable::fielded`].
const UNSET: u32 = NONE - 1;

pub(super) struct ClassTable {
    pub(super) classes: Vec<ClassInfo>,
    /// Class id → class index.
    pub(super) by_id: IdHash<u32>,
    pub(super) class_slot: u32,
    /// Per class: `(offset, is the referent)` of each reference field in the class's own part of
    /// the instance data.
    pub(super) refs: Vec<Vec<(usize, bool)>>,
    /// Per class: bytes of its own part of the instance data.
    pub(super) own_bytes: Vec<usize>,
    /// Per class: the nearest class up its chain (itself included) whose own part is not empty, or
    /// `NONE`. Walking these instead of every super keeps a walk bounded by the data it reads.
    pub(super) fielded: Vec<u32>,
}

/// `dumps` holds one dump per class id, and `by_id` its position; `names` are the UTF8 records
/// and `class_names` the LOAD CLASS class id → name id pairs.
pub(super) fn resolve(
    dumps: Vec<ClassDump>,
    by_id: IdHash<u32>,
    names: &IdHash<&[u8]>,
    class_names: &IdHash<u64>,
    id_size: u8,
) -> Result<ClassTable, HeapError> {
    // Room for the synthetic java.lang.Class and the primitive slots in a `u32` type id.
    if dumps.len() > (u32::MAX - PRIM_SLOTS - 1) as usize {
        return Err(HeapError::TooLarge);
    }
    let text = |id: u64| names.get(&id).map(|t| String::from_utf8_lossy(t).into_owned()).unwrap_or_default();
    let mut supers: Vec<Option<u32>> =
        dumps.iter().map(|d| if d.super_id == 0 { None } else { by_id.get(&d.super_id).copied() }).collect();
    cut_super_cycles(&mut supers);

    let mut classes = Vec::with_capacity(dumps.len() + 1);
    let mut refs = Vec::with_capacity(dumps.len() + 1);
    let mut own_bytes = Vec::with_capacity(dumps.len() + 1);
    for (dump, super_index) in dumps.into_iter().zip(supers) {
        let name = match class_names.get(&dump.id) {
            Some(&name_id) if names.contains_key(&name_id) => text(name_id).replace('/', "."),
            _ => format!("{:#x}", dump.id),
        };
        let fields: Vec<(String, BasicType)> = dump.fields.iter().map(|&(n, ty)| (text(n), ty)).collect();
        let weak_field = if name == REFERENCE {
            fields.iter().position(|(n, ty)| n == "referent" && *ty == BasicType::Object)
        } else {
            None
        };
        let mut offset = 0;
        let mut class_refs = Vec::new();
        for (k, &(_, ty)) in fields.iter().enumerate() {
            if ty == BasicType::Object {
                class_refs.push((offset, weak_field == Some(k)));
            }
            offset += ty.hprof_size(id_size);
        }
        refs.push(class_refs);
        own_bytes.push(offset);
        classes.push(ClassInfo {
            id: dump.id,
            name,
            super_index,
            fields,
            statics: dump.statics.iter().map(|&(n, object)| (text(n), object)).collect(),
            static_bytes: dump.static_bytes,
            weak_field,
        });
    }

    let class_slot = match classes.iter().position(|c| c.name == JAVA_LANG_CLASS) {
        Some(slot) => slot as u32,
        None => {
            classes.push(ClassInfo {
                id: 0,
                name: JAVA_LANG_CLASS.to_owned(),
                super_index: None,
                fields: Vec::new(),
                statics: Vec::new(),
                static_bytes: 0,
                weak_field: None,
            });
            refs.push(Vec::new());
            own_bytes.push(0);
            classes.len() as u32 - 1
        }
    };
    let fielded = nearest_fielded(&classes, &own_bytes);
    Ok(ClassTable { classes, by_id, class_slot, refs, own_bytes, fielded })
}

/// A dump may claim `A extends B extends A`; the edge that closes a cycle is dropped so every
/// walk up the chain ends. Iterative, so a long chain cannot overflow the stack.
fn cut_super_cycles(supers: &mut [Option<u32>]) {
    const NEW: u8 = 0;
    const ON_PATH: u8 = 1;
    const DONE: u8 = 2;
    let mut state = vec![NEW; supers.len()];
    let mut path = Vec::new();
    for start in 0..supers.len() {
        let mut c = start;
        while state[c] == NEW {
            state[c] = ON_PATH;
            path.push(c);
            match supers[c] {
                Some(s) if state[s as usize] == ON_PATH => {
                    supers[c] = None;
                    break;
                }
                Some(s) => c = s as usize,
                None => break,
            }
        }
        for p in path.drain(..) {
            state[p] = DONE;
        }
    }
}

fn nearest_fielded(classes: &[ClassInfo], own_bytes: &[usize]) -> Vec<u32> {
    let mut fielded: Vec<u32> =
        own_bytes.iter().enumerate().map(|(c, &b)| if b > 0 { c as u32 } else { UNSET }).collect();
    let mut path = Vec::new();
    for start in 0..classes.len() {
        let mut c = start;
        let found = loop {
            if fielded[c] != UNSET {
                break fielded[c];
            }
            path.push(c);
            match classes[c].super_index {
                Some(s) => c = s as usize,
                None => break NONE,
            }
        };
        for p in path.drain(..) {
            fielded[p] = found;
        }
    }
    fielded
}
