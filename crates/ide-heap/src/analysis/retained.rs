//! Shallow and retained sizes, and the dominator tree as child lists sorted by retained size.

use std::cmp::Reverse;

use super::Meter;
use crate::column::{Column, NONE, Store};
use crate::error::HeapError;
use crate::files::{KIDS_FILE, KIDS_START_FILE, RETAINED_FILE, SHALLOW8_FILE};
use crate::graph::{HeapGraph, accumulate};
use crate::progress::CHECK_EVERY;
use crate::shallow::ShallowModel;

/// The dominator tree with sizes; see [`crate::HeapIndex`] for each column.
pub(super) struct Tree {
    pub(super) idom: Column<u32>,
    pub(super) shallow8: Column<u32>,
    pub(super) retained: Column<u64>,
    pub(super) kids_start: Column<u32>,
    pub(super) kids: Column<u32>,
}

/// `(shallow8, retained)` of every node, the root included. `preorder` is the DFS preorder of the
/// reachable nodes, from the root.
pub(super) fn sizes(
    graph: &HeapGraph,
    model: &ShallowModel,
    idom: &[u32],
    preorder: &[u32],
    store: &Store,
    meter: &mut Meter,
) -> Result<(Column<u32>, Column<u64>), HeapError> {
    let nodes = idom.len();
    let mut shallow8 = store.column::<u32>(SHALLOW8_FILE, nodes, 0)?;
    let mut retained = store.column::<u64>(RETAINED_FILE, nodes, 0)?;
    meter.begin_loop()?;
    for v in 0..graph.root {
        meter.tick()?;
        let units = u32::try_from(model.size_of(graph, v).div_ceil(8)).unwrap_or(u32::MAX);
        shallow8[v as usize] = units;
        if idom[v as usize] != NONE {
            retained[v as usize] = u64::from(units) * 8;
        }
    }
    // A dominator is a DFS ancestor, so in reverse preorder every node is complete before it is
    // added to its dominator.
    meter.begin_loop()?;
    for &v in preorder.iter().skip(1).rev() {
        meter.tick()?;
        let own = retained[v as usize];
        retained[idom[v as usize] as usize] += own;
    }
    Ok((shallow8, retained))
}

/// `(kids_start, kids)`: the children of every reachable node in the dominator tree, as CSR.
pub(super) fn children(
    idom: &[u32],
    retained: &[u64],
    root: u32,
    store: &Store,
    meter: &mut Meter,
) -> Result<(Column<u32>, Column<u32>), HeapError> {
    let nodes = idom.len();
    // Counted into `starts[d + 1]`; filled through `starts[d]` as a cursor, which leaves it at d's
    // end until the column is shifted one slot.
    let mut starts = store.column::<u32>(KIDS_START_FILE, nodes + 1, 0)?;
    let mut longest = 0;
    meter.begin_loop()?;
    for (v, &d) in idom.iter().enumerate() {
        meter.tick()?;
        if d != NONE && v != root as usize {
            let count = &mut starts[d as usize + 1];
            *count += 1;
            longest = longest.max(*count);
        }
    }
    let total = accumulate(&mut starts, meter.token())?;
    let mut kids = store.column::<u32>(KIDS_FILE, total as usize, 0)?;
    meter.begin_loop()?;
    for (v, &d) in idom.iter().enumerate() {
        meter.tick()?;
        if d != NONE && v != root as usize {
            let cursor = &mut starts[d as usize];
            kids[*cursor as usize] = v as u32;
            *cursor += 1;
        }
    }
    starts.copy_within(0..nodes, 1);
    starts[0] = 0;
    sort_children(&mut kids, &starts, retained, longest as usize, CHECK_EVERY as usize, store, meter)?;
    Ok((starts, kids))
}

/// Sorts each child list by retained size descending, then by node. A list longer than `run` is
/// sorted in runs of `run` that are then merged, so no single step takes longer than one run.
fn sort_children(
    kids: &mut [u32],
    starts: &[u32],
    retained: &[u64],
    longest: usize,
    run: usize,
    store: &Store,
    meter: &mut Meter,
) -> Result<(), HeapError> {
    let key = |&k: &u32| (Reverse(retained[k as usize]), k);
    let mut buffer = if longest > run { store.scratch::<u32>(longest, 0)? } else { Column::ram(0, 0) };
    meter.begin_loop()?;
    for v in 0..starts.len() - 1 {
        meter.tick()?;
        let list = &mut kids[starts[v] as usize..starts[v + 1] as usize];
        if list.len() <= run {
            list.sort_unstable_by_key(key);
            meter.advance(list.len() as u64)?;
            continue;
        }
        for chunk in list.chunks_mut(run) {
            meter.begin_loop()?;
            chunk.sort_unstable_by_key(key);
            meter.advance(chunk.len() as u64)?;
        }
        let len = list.len();
        let (mut from, mut to) = (list, &mut buffer[..len]);
        let mut in_buffer = false;
        let mut width = run;
        while width < len {
            meter.begin_loop()?;
            for start in (0..len).step_by(2 * width) {
                let mid = (start + width).min(len);
                let end = (start + 2 * width).min(len);
                merge(&from[start..mid], &from[mid..end], &mut to[start..end], &key, meter)?;
            }
            std::mem::swap(&mut from, &mut to);
            in_buffer = !in_buffer;
            width *= 2;
        }
        if in_buffer {
            to.copy_from_slice(from);
        }
    }
    Ok(())
}

fn merge<K: Ord>(
    left: &[u32],
    right: &[u32],
    out: &mut [u32],
    key: &impl Fn(&u32) -> K,
    meter: &mut Meter,
) -> Result<(), HeapError> {
    let (mut i, mut j) = (0, 0);
    for slot in out.iter_mut() {
        meter.tick()?;
        let take_left = j == right.len() || (i < left.len() && key(&left[i]) <= key(&right[j]));
        if take_left {
            *slot = left[i];
            i += 1;
        } else {
            *slot = right[j];
            j += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ide_core::CancellationToken;

    use super::*;
    use crate::error::HeapError;
    use crate::progress::{HeapPhase, Progress};
    use crate::testing::XorShift;

    fn sorted_with_run(lists: &[Vec<u32>], retained: &[u64], run: usize) -> Vec<u32> {
        let report = |_, _, _| Ok::<(), HeapError>(());
        let cancel = CancellationToken::new();
        let progress = Progress::new(&report, &cancel);
        let mut meter = Meter::start(&progress, HeapPhase::Retained, 1).unwrap();
        let mut starts = vec![0u32];
        for list in lists {
            starts.push(starts.last().unwrap() + list.len() as u32);
        }
        let mut kids: Vec<u32> = lists.concat();
        let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
        sort_children(&mut kids, &starts, retained, longest, run, &Store::Ram, &mut meter).unwrap();
        kids
    }

    #[test]
    fn long_child_lists_are_merged_from_sorted_runs() {
        let mut rng = XorShift::new(7);
        let retained: Vec<u64> = (0..500).map(|_| u64::from(rng.below(40))).collect();
        let mut nodes: Vec<u32> = (0..500).collect();
        for i in (1..nodes.len()).rev() {
            nodes.swap(i, rng.below(i as u32 + 1) as usize);
        }
        // Lists below, at and above the run length, and one that ends on a partial run.
        let lists = vec![nodes[..3].to_vec(), nodes[3..7].to_vec(), nodes[7..400].to_vec(), nodes[400..].to_vec()];
        for run in [1, 4, 7, 64, 1000] {
            let mut expected = Vec::new();
            for list in &lists {
                let mut list = list.clone();
                list.sort_by_key(|&k| (Reverse(retained[k as usize]), k));
                expected.extend(list);
            }
            assert_eq!(sorted_with_run(&lists, &retained, run), expected, "run {run}");
        }
    }
}
