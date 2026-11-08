//! Dominator tree of the object graph, by semi-NCA with no recursion: the DFS "stack" is the chain
//! of DFS parents, and path compression keeps its path in a reused heap `Vec`.
//!
//! Between the DFS and the final translation every array is indexed by DFS number, so the root is
//! 0 and a vertex's DFS ancestors all have smaller numbers.

use ide_core::CancellationToken;

use crate::column::{Column, NONE, Store};
use crate::error::HeapError;
use crate::graph::accumulate;
use crate::progress::{HeapPhase, Progress};

const IDOM_FILE: &str = "idom.u32";
const PHASE: HeapPhase = HeapPhase::Dominators;

pub struct Dominators {
    /// Immediate dominator of each node, saved as `idom.u32` in the store; [`NONE`] for
    /// unreachable nodes, `root` for `root`.
    pub idom: Column<u32>,
    /// Nodes in DFS preorder from `root`, `reachable` entries.
    pub preorder: Column<u32>,
    pub reachable: u32,
}

/// The dominators of the graph whose node `v` has targets `out[out_start[v]..out_start[v + 1]]`,
/// from `root` (which must be a node). `progress` gets `Dominators` from `(0, total)` to
/// `(total, total)`; an `Err` from it stops the computation with that error.
pub fn dominators(
    out_start: &[u32],
    out: &[u32],
    root: u32,
    store: &Store,
    progress: &dyn Fn(HeapPhase, u64, u64) -> Result<(), HeapError>,
    cancel: &CancellationToken,
) -> Result<Dominators, HeapError> {
    let progress = Progress::new(progress, cancel);
    let nodes = out_start.len().saturating_sub(1);
    if nodes >= NONE as usize {
        return Err(HeapError::TooLarge);
    }
    assert!((root as usize) < nodes, "root {root} is not one of the {nodes} nodes");
    // Three walks of at most `nodes` steps each: DFS, semidominators, immediate dominators.
    let span = nodes as u64;
    let total = 3 * span;
    progress.report(PHASE, 0, total)?;

    // DFS: `pre` maps nodes to DFS numbers and `vertex` back; `cursor[d]` is the next edge of
    // DFS vertex d to follow.
    let mut pre = store.scratch::<u32>(nodes, NONE)?;
    let mut vertex = store.scratch::<u32>(nodes, 0)?;
    let mut parent = store.scratch::<u32>(nodes, 0)?;
    let mut cursor = store.scratch::<u32>(nodes, 0)?;
    pre[root as usize] = 0;
    vertex[0] = root;
    cursor[0] = out_start[root as usize];
    let (mut reachable, mut d, mut step) = (1u32, 0u32, 0u64);
    loop {
        progress.step(step, PHASE, u64::from(reachable), total)?;
        step += 1;
        let edge = cursor[d as usize];
        if edge < out_start[vertex[d as usize] as usize + 1] {
            cursor[d as usize] = edge + 1;
            let w = out[edge as usize] as usize;
            if pre[w] == NONE {
                let next = reachable as usize;
                pre[w] = reachable;
                vertex[next] = w as u32;
                parent[next] = d;
                cursor[next] = out_start[w];
                d = reachable;
                reachable += 1;
            }
        } else if d == 0 {
            break;
        } else {
            d = parent[d as usize];
        }
    }
    let r = reachable as usize;
    progress.report(PHASE, span, total)?;

    // Predecessors by DFS number, as CSR: counted into `starts[w + 1]`, then filled through
    // `starts[w]` as a cursor, which leaves it at w's end until the column is shifted one slot.
    let mut semi = cursor;
    let mut label = store.scratch::<u32>(r, 0)?;
    let mut starts = store.scratch::<u32>(r + 1, 0)?;
    for d in 0..r {
        progress.step(d as u64, PHASE, span, total)?;
        semi[d] = d as u32;
        label[d] = d as u32;
        for &w in targets(out_start, out, vertex[d]) {
            starts[pre[w as usize] as usize + 1] += 1;
        }
    }
    let edges = accumulate(&mut starts, cancel)?;
    let mut preds = store.scratch::<u32>(edges as usize, 0)?;
    for d in 0..r {
        progress.step(d as u64, PHASE, span, total)?;
        for &w in targets(out_start, out, vertex[d]) {
            let slot = &mut starts[pre[w as usize] as usize];
            preds[*slot as usize] = d as u32;
            *slot += 1;
        }
    }
    starts.copy_within(0..r, 1);
    starts[0] = 0;
    drop(pre);

    // Semidominators, in reverse preorder; `ancestor` links each finished vertex to its parent.
    let mut ancestor = store.scratch::<u32>(r, NONE)?;
    let mut path = Vec::new();
    for (step, w) in (1..r).rev().enumerate() {
        progress.step(step as u64, PHASE, span + step as u64, total)?;
        let mut s = semi[w];
        for &v in &preds[starts[w] as usize..starts[w + 1] as usize] {
            let u = if ancestor[v as usize] == NONE { v } else { eval(v, &mut ancestor, &mut label, &semi, &mut path) };
            s = s.min(semi[u as usize]);
        }
        semi[w] = s;
        ancestor[w] = parent[w];
    }
    drop((label, starts, preds, path));
    progress.report(PHASE, 2 * span, total)?;

    // Immediate dominators, in preorder so every candidate's own is already known, translated
    // back to nodes as they are found.
    let mut idom = ancestor;
    let mut node_idom = store.column::<u32>(IDOM_FILE, nodes, NONE)?;
    let mut preorder = store.scratch::<u32>(r, 0)?;
    idom[0] = 0;
    node_idom[root as usize] = root;
    preorder[0] = root;
    for w in 1..r {
        progress.step(w as u64, PHASE, 2 * span + w as u64, total)?;
        let mut x = parent[w];
        while x > semi[w] {
            x = idom[x as usize];
        }
        idom[w] = x;
        node_idom[vertex[w] as usize] = vertex[x as usize];
        preorder[w] = vertex[w];
    }
    progress.report(PHASE, total, total)?;
    Ok(Dominators { idom: node_idom, preorder, reachable })
}

fn targets<'a>(out_start: &[u32], out: &'a [u32], v: u32) -> &'a [u32] {
    let v = v as usize;
    &out[out_start[v] as usize..out_start[v + 1] as usize]
}

/// The vertex of smallest semidominator on the forest path from linked vertex `v` up to, not
/// including, its tree's root, compressing that path so the root is every vertex's ancestor.
fn eval(v: u32, ancestor: &mut [u32], label: &mut [u32], semi: &[u32], path: &mut Vec<u32>) -> u32 {
    let mut x = v;
    while ancestor[ancestor[x as usize] as usize] != NONE {
        path.push(x);
        x = ancestor[x as usize];
    }
    // Nearest the root first, so each vertex folds in an ancestor that is already compressed.
    while let Some(y) = path.pop() {
        let (y, a) = (y as usize, ancestor[y as usize] as usize);
        if semi[label[a] as usize] < semi[label[y] as usize] {
            label[y] = label[a];
        }
        ancestor[y] = ancestor[a];
    }
    label[v as usize]
}

#[cfg(test)]
mod tests;
