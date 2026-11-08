//! Dominator tree of the object graph, by Lengauer–Tarjan with path compression and no recursion:
//! the DFS "stack" is the chain of DFS parents, and `eval` reverses the links of the path it
//! compresses instead of keeping a stack.
//!
//! Between the DFS and the final translation every array is indexed by DFS number, so the root is
//! 0 and a vertex's DFS ancestors all have smaller numbers.

use ide_core::CancellationToken;

use crate::column::{Column, NONE, Store};
use crate::error::HeapError;
use crate::graph::accumulate;
use crate::progress::{CHECK_EVERY, HeapPhase, Progress};

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
    compute(out_start, out, root, store, progress, cancel).map(|(dominators, _)| dominators)
}

/// [`dominators`], plus the number of steps of work it took.
fn compute(
    out_start: &[u32],
    out: &[u32],
    root: u32,
    store: &Store,
    progress: &dyn Fn(HeapPhase, u64, u64) -> Result<(), HeapError>,
    cancel: &CancellationToken,
) -> Result<(Dominators, u64), HeapError> {
    let nodes = out_start.len().saturating_sub(1);
    if nodes >= NONE as usize {
        return Err(HeapError::TooLarge);
    }
    assert!((root as usize) < nodes, "root {root} is not one of the {nodes} nodes");
    // Three walks of at most `nodes` vertices each: DFS, semidominators, immediate dominators.
    let span = nodes as u64;
    let mut work = Work::new(Progress::new(progress, cancel), 3 * span);
    work.report(0)?;

    // DFS: `pre` maps nodes to DFS numbers and `vertex` back; `cursor[d]` is the next edge of
    // DFS vertex d to follow.
    let mut pre = store.scratch::<u32>(nodes, NONE)?;
    let mut vertex = store.scratch::<u32>(nodes, 0)?;
    let mut parent = store.scratch::<u32>(nodes, 0)?;
    let mut cursor = store.scratch::<u32>(nodes, 0)?;
    pre[root as usize] = 0;
    vertex[0] = root;
    cursor[0] = out_start[root as usize];
    let (mut reachable, mut d) = (1u32, 0u32);
    loop {
        work.tick()?;
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
                work.done = u64::from(reachable);
            }
        } else if d == 0 {
            break;
        } else {
            d = parent[d as usize];
        }
    }
    let r = reachable as usize;
    work.report(span)?;

    // Predecessors by DFS number, as CSR: counted into `starts[w + 1]`, then filled through
    // `starts[w]` as a cursor, which leaves it at w's end until the column is shifted one slot.
    let mut semi = cursor;
    let mut label = store.scratch::<u32>(r, 0)?;
    let mut starts = store.scratch::<u32>(r + 1, 0)?;
    for d in 0..r {
        work.tick()?;
        semi[d] = d as u32;
        label[d] = d as u32;
        for &w in targets(out_start, out, vertex[d]) {
            work.tick()?;
            starts[pre[w as usize] as usize + 1] += 1;
        }
    }
    let edges = accumulate(&mut starts, cancel)?;
    let mut preds = store.scratch::<u32>(edges as usize, 0)?;
    for d in 0..r {
        work.tick()?;
        for &w in targets(out_start, out, vertex[d]) {
            work.tick()?;
            let slot = &mut starts[pre[w as usize] as usize];
            preds[*slot as usize] = d as u32;
            *slot += 1;
        }
    }
    starts.copy_within(0..r, 1);
    starts[0] = 0;
    drop(pre);
    work.report(span)?;

    // Semidominators in reverse preorder, linking each finished vertex to its parent. Vertex w
    // waits in its semidominator's bucket until a child of that semidominator is linked; then
    // `eval` gives w's idom, or a vertex whose idom is also w's, fixed up in preorder below.
    // `idom[v]` is the next vertex in v's bucket until v leaves the bucket.
    let mut ancestor = store.scratch::<u32>(r, NONE)?;
    let mut bucket = store.scratch::<u32>(r, NONE)?;
    let mut idom = store.scratch::<u32>(r, NONE)?;
    for w in (1..r).rev() {
        work.done = span + (r - w) as u64;
        work.tick()?;
        let mut s = semi[w];
        for &v in &preds[starts[w] as usize..starts[w + 1] as usize] {
            work.tick()?;
            let u = eval(v, &mut ancestor, &mut label, &semi, &mut work)?;
            s = s.min(semi[u as usize]);
        }
        semi[w] = s;
        idom[w] = bucket[s as usize];
        bucket[s as usize] = w as u32;
        let p = parent[w];
        ancestor[w] = p;
        let mut v = std::mem::replace(&mut bucket[p as usize], NONE);
        while v != NONE {
            work.tick()?;
            let next = idom[v as usize];
            let u = eval(v, &mut ancestor, &mut label, &semi, &mut work)?;
            idom[v as usize] = if semi[u as usize] < semi[v as usize] { u } else { p };
            v = next;
        }
    }
    drop((label, starts, preds, ancestor, bucket, parent));
    work.report(2 * span)?;

    // Immediate dominators, translated back to nodes; in preorder, so a deferred vertex's
    // stand-in already has its final idom.
    let mut node_idom = store.column::<u32>(IDOM_FILE, nodes, NONE)?;
    let mut preorder = store.scratch::<u32>(r, 0)?;
    idom[0] = 0;
    node_idom[root as usize] = root;
    preorder[0] = root;
    for w in 1..r {
        work.done = 2 * span + w as u64;
        work.tick()?;
        if idom[w] != semi[w] {
            idom[w] = idom[idom[w] as usize];
        }
        node_idom[vertex[w] as usize] = vertex[idom[w] as usize];
        preorder[w] = vertex[w];
    }
    work.report(3 * span)?;
    Ok((Dominators { idom: node_idom, preorder, reachable }, work.steps))
}

fn targets<'a>(out_start: &[u32], out: &'a [u32], v: u32) -> &'a [u32] {
    let v = v as usize;
    &out[out_start[v] as usize..out_start[v + 1] as usize]
}

/// Counts steps of work and reports progress, which also looks at the cancellation token, at
/// every phase boundary and after every [`CHECK_EVERY`] steps, whichever loop they are in.
struct Work<'a> {
    progress: Progress<'a>,
    total: u64,
    /// Progress to report at the next check; the loops keep it current.
    done: u64,
    steps: u64,
    next_report: u64,
}

impl<'a> Work<'a> {
    fn new(progress: Progress<'a>, total: u64) -> Self {
        Self { progress, total, done: 0, steps: 0, next_report: CHECK_EVERY }
    }

    fn report(&mut self, done: u64) -> Result<(), HeapError> {
        self.done = done;
        self.next_report = self.steps + CHECK_EVERY;
        self.progress.report(PHASE, done, self.total)
    }

    #[inline]
    fn tick(&mut self) -> Result<(), HeapError> {
        self.steps += 1;
        if self.steps < self.next_report { Ok(()) } else { self.report(self.done) }
    }
}

/// The vertex of smallest semidominator on the forest path from `v` up to, not including, its
/// tree's root (`v` itself when it is a root), compressing that path so the root becomes the
/// ancestor of every vertex on it. The walk up reverses the `ancestor` links so the walk down can
/// fold labels nearest-root first, as the recursive compress does, without a stack.
fn eval(v: u32, ancestor: &mut [u32], label: &mut [u32], semi: &[u32], work: &mut Work) -> Result<u32, HeapError> {
    let at = |x: u32| x as usize;
    if ancestor[at(v)] == NONE {
        return Ok(v);
    }
    let (mut x, mut below) = (v, NONE);
    while ancestor[at(ancestor[at(x)])] != NONE {
        work.tick()?;
        let up = ancestor[at(x)];
        ancestor[at(x)] = below;
        below = x;
        x = up;
    }
    // `x` is the root's child, already compressed; `below` is the vertex under it.
    let root = ancestor[at(x)];
    let mut best = label[at(x)];
    while below != NONE {
        work.tick()?;
        let y = at(below);
        if semi[at(best)] < semi[at(label[y])] {
            label[y] = best;
        } else {
            best = label[y];
        }
        below = ancestor[y];
        ancestor[y] = root;
    }
    Ok(label[at(v)])
}

#[cfg(test)]
mod tests;
