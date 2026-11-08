//! The class table: counts and shallow sizes per type slot, retained sizes per type from a walk of
//! the dominator tree, and the reachable / unreachable totals of the summary.

use super::Meter;
use super::retained::Tree;
use crate::column::{NONE, Store};
use crate::error::HeapError;
use crate::graph::{HeapGraph, PRIM_SLOTS};
use crate::hprof::BasicType;
use crate::index::ClassStat;
use crate::names::display_name;

/// Instances and arrays only: class objects are left out.
#[derive(Default)]
pub(super) struct Totals {
    pub(super) reachable_objects: u64,
    pub(super) reachable_bytes: u64,
    pub(super) unreachable_objects: u64,
    pub(super) unreachable_bytes: u64,
}

pub(super) fn table(
    graph: &HeapGraph,
    tree: &Tree,
    store: &Store,
    meter: &mut Meter,
) -> Result<(Vec<ClassStat>, Totals), HeapError> {
    let slots = graph.classes.len() + PRIM_SLOTS as usize;
    let mut classes: Vec<ClassStat> = (0..slots as u32)
        .map(|slot| ClassStat { name: slot_name(graph, slot), count: 0, shallow: 0, retained: 0, unreachable_count: 0 })
        .collect();
    let mut totals = Totals::default();
    meter.begin_loop()?;
    for v in 0..graph.root as usize {
        meter.tick()?;
        let slot = graph.types[v];
        let bytes = u64::from(tree.shallow8[v]) * 8;
        let stat = &mut classes[slot as usize];
        let instance = slot != graph.class_slot;
        if tree.idom[v] == NONE {
            stat.unreachable_count += 1;
            if instance {
                totals.unreachable_objects += 1;
                totals.unreachable_bytes += bytes;
            }
        } else {
            stat.count += 1;
            stat.shallow += bytes;
            if instance {
                totals.reachable_objects += 1;
                totals.reachable_bytes += bytes;
            }
        }
    }
    retained_by_type(graph, tree, &mut classes, store, meter)?;
    Ok((classes, totals))
}

/// Adds to each type the retained size of its instances that have no instance of the same type
/// above them in the dominator tree. The walk keeps no stack: it goes up through `idom` and
/// resumes a node's children from `cursor`, while `active[t]` counts the instances of type `t` on
/// the path from the root.
fn retained_by_type(
    graph: &HeapGraph,
    tree: &Tree,
    classes: &mut [ClassStat],
    store: &Store,
    meter: &mut Meter,
) -> Result<(), HeapError> {
    let root = graph.root;
    let mut cursor = store.scratch::<u32>(root as usize + 1, 0)?;
    let mut active = vec![0u32; classes.len()];
    cursor[root as usize] = tree.kids_start[root as usize];
    let mut v = root;
    meter.begin_loop()?;
    loop {
        meter.tick()?;
        let next = cursor[v as usize];
        if next < tree.kids_start[v as usize + 1] {
            cursor[v as usize] = next + 1;
            let child = tree.kids[next as usize];
            let slot = graph.types[child as usize] as usize;
            if active[slot] == 0 {
                classes[slot].retained += tree.retained[child as usize];
            }
            active[slot] += 1;
            cursor[child as usize] = tree.kids_start[child as usize];
            v = child;
        } else if v == root {
            return Ok(());
        } else {
            active[graph.types[v as usize] as usize] -= 1;
            v = tree.idom[v as usize];
        }
    }
}

fn slot_name(graph: &HeapGraph, slot: u32) -> String {
    match graph.classes.get(slot as usize) {
        Some(class) => display_name(&class.name),
        None => graph.prim_type(slot).map_or_else(String::new, |ty| prim_array_name(ty).to_owned()),
    }
}

fn prim_array_name(ty: BasicType) -> &'static str {
    match ty {
        BasicType::Object => "java.lang.Object[]",
        BasicType::Boolean => "boolean[]",
        BasicType::Char => "char[]",
        BasicType::Float => "float[]",
        BasicType::Double => "double[]",
        BasicType::Byte => "byte[]",
        BasicType::Short => "short[]",
        BasicType::Int => "int[]",
        BasicType::Long => "long[]",
    }
}
