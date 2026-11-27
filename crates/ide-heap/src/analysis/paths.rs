//! Parents on shortest paths from the GC roots, by breadth-first search over strong edges.

use super::Meter;
use crate::column::{Column, NONE, Store};
use crate::error::HeapError;
use crate::files::GC_PARENT_FILE;
use crate::graph::HeapGraph;

pub(super) fn gc_parents(graph: &HeapGraph, store: &Store, meter: &mut Meter) -> Result<Column<u32>, HeapError> {
    let root = graph.root;
    let nodes = root as usize + 1;
    let mut parent = store.column::<u32>(GC_PARENT_FILE, nodes, NONE)?;
    let mut queue = store.scratch::<u32>(nodes, 0)?;
    parent[root as usize] = root;
    queue[0] = root;
    let (mut head, mut tail) = (0, 1);
    meter.begin_loop()?;
    while head < tail {
        meter.tick()?;
        let v = queue[head];
        head += 1;
        for &w in graph.out_edges(v) {
            meter.tick()?;
            if parent[w as usize] == NONE {
                parent[w as usize] = v;
                queue[tail] = w;
                tail += 1;
            }
        }
    }
    Ok(parent)
}
