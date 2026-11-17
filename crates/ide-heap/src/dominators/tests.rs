use std::cell::RefCell;
use std::time::Instant;

use proptest::collection::vec;
use proptest::prelude::*;

use super::*;
use crate::NONE;
use crate::graph::build_graph;
use crate::testing::{XorShift, sample};

fn no_progress(_: HeapPhase, _: u64, _: u64) -> Result<(), HeapError> {
    Ok(())
}

/// CSR of `edges` over `n` nodes, targets in edge order.
fn csr(n: usize, edges: &[(u32, u32)]) -> (Vec<u32>, Vec<u32>) {
    let mut start = vec![0u32; n + 1];
    for &(from, _) in edges {
        start[from as usize + 1] += 1;
    }
    for v in 0..n {
        start[v + 1] += start[v];
    }
    let mut cursor = start.clone();
    let mut out = vec![0u32; edges.len()];
    for &(from, to) in edges {
        out[cursor[from as usize] as usize] = to;
        cursor[from as usize] += 1;
    }
    (start, out)
}

fn run(n: usize, edges: &[(u32, u32)], root: u32) -> Dominators {
    let (start, out) = csr(n, edges);
    dominators(&start, &out, root, &Store::Ram, &no_progress, &CancellationToken::new()).unwrap()
}

fn preds(n: usize, edges: &[(u32, u32)]) -> Vec<Vec<u32>> {
    let mut preds = vec![Vec::new(); n];
    for &(from, to) in edges {
        preds[to as usize].push(from);
    }
    preds
}

/// Immediate dominators from iterated `Dom` sets (one `u64` bitset per node, `n <= 64`).
fn dataflow_idom(n: usize, edges: &[(u32, u32)], root: u32) -> Vec<u32> {
    let (start, out) = csr(n, edges);
    let mut reachable = vec![false; n];
    let mut todo = vec![root];
    reachable[root as usize] = true;
    while let Some(v) = todo.pop() {
        for &w in &out[start[v as usize] as usize..start[v as usize + 1] as usize] {
            if !std::mem::replace(&mut reachable[w as usize], true) {
                todo.push(w);
            }
        }
    }
    let preds = preds(n, edges);
    let mut dom = vec![u64::MAX; n];
    dom[root as usize] = 1 << root;
    let mut changed = true;
    while changed {
        changed = false;
        for v in (0..n).filter(|&v| reachable[v] && v != root as usize) {
            let meet =
                preds[v].iter().filter(|&&p| reachable[p as usize]).fold(u64::MAX, |acc, &p| acc & dom[p as usize]);
            let next = meet | 1 << v;
            if next != dom[v] {
                dom[v] = next;
                changed = true;
            }
        }
    }
    (0..n)
        .map(|v| {
            if !reachable[v] {
                NONE
            } else if v == root as usize {
                root
            } else {
                // The strict dominator dominated by all the others has the most dominators itself.
                let strict = dom[v] & !(1 << v);
                (0..n as u32).filter(|&d| strict & 1 << d != 0).max_by_key(|&d| dom[d as usize].count_ones()).unwrap()
            }
        })
        .collect()
}

/// Cooper–Harvey–Kennedy iteration over reverse postorder from an explicit-stack DFS.
fn chk_idom(n: usize, edges: &[(u32, u32)], root: u32) -> Vec<u32> {
    let (start, out) = csr(n, edges);
    let mut post_number = vec![NONE; n];
    let mut postorder = Vec::new();
    let mut seen = vec![false; n];
    let mut stack = vec![(root, start[root as usize])];
    seen[root as usize] = true;
    while let Some(&mut (v, ref mut next)) = stack.last_mut() {
        if *next < start[v as usize + 1] {
            let w = out[*next as usize];
            *next += 1;
            if !std::mem::replace(&mut seen[w as usize], true) {
                stack.push((w, start[w as usize]));
            }
        } else {
            post_number[v as usize] = postorder.len() as u32;
            postorder.push(v);
            stack.pop();
        }
    }
    let preds = preds(n, edges);
    let mut idom = vec![NONE; n];
    idom[root as usize] = root;
    let intersect = |idom: &[u32], mut a: u32, mut b: u32| {
        while a != b {
            while post_number[a as usize] < post_number[b as usize] {
                a = idom[a as usize];
            }
            while post_number[b as usize] < post_number[a as usize] {
                b = idom[b as usize];
            }
        }
        a
    };
    let mut changed = true;
    while changed {
        changed = false;
        for &v in postorder.iter().rev().filter(|&&v| v != root) {
            let mut new = NONE;
            for &p in &preds[v as usize] {
                if idom[p as usize] != NONE {
                    new = if new == NONE { p } else { intersect(&idom, p, new) };
                }
            }
            if new != idom[v as usize] {
                idom[v as usize] = new;
                changed = true;
            }
        }
    }
    idom
}

#[test]
fn diamond() {
    let d = run(5, &[(0, 1), (0, 2), (1, 3), (2, 3), (3, 4)], 0);
    assert_eq!(&*d.idom, &[0, 0, 0, 0, 3]);
    assert_eq!(d.reachable, 5);
    assert_eq!(&*d.preorder, &[0, 1, 3, 4, 2]);
}

#[test]
fn unreachable_is_none() {
    let d = run(6, &[(0, 1), (0, 2), (1, 3), (2, 3), (3, 4), (5, 3)], 0);
    assert_eq!(&*d.idom, &[0, 0, 0, 0, 3, NONE]);
    assert_eq!(d.reachable, 5);
    assert_eq!(d.preorder.len(), 5);
}

#[test]
fn cycle_back_to_root() {
    let d = run(3, &[(0, 1), (1, 2), (2, 1), (2, 0)], 0);
    assert_eq!(&*d.idom, &[0, 0, 1]);
}

#[test]
fn root_need_not_be_node_zero() {
    let d = run(4, &[(3, 1), (1, 0), (3, 2), (2, 0), (0, 3)], 3);
    assert_eq!(&*d.idom, &[3, 3, 3, 3]);
    assert_eq!(d.preorder[0], 3);
}

#[test]
fn sample_heap_dominators() {
    let bytes = sample().bytes();
    let g = build_graph(&bytes, &Store::Ram, &no_progress, &CancellationToken::new()).unwrap();
    let d = dominators(&g.out_start, &g.out, g.root, &Store::Ram, &no_progress, &CancellationToken::new()).unwrap();
    let node = |id: u64| g.ids.rank(id).unwrap();
    let idom_of = |id: u64| d.idom[node(id) as usize];
    assert_eq!(idom_of(0x1100), node(0x1000), "N1 → H");
    assert_eq!(idom_of(0x1200), node(0x1000), "N2 → H");
    assert_eq!(idom_of(0x1300), g.root, "N3 → root");
    assert_eq!(idom_of(0x1400), node(0x1300), "L → N3");
    assert_eq!(idom_of(0x1500), NONE, "R is unreachable");
    assert_eq!(idom_of(0x1700), NONE, "N4 only through the weak referent");
    assert_eq!(d.idom[g.root as usize], g.root);
}

#[test]
fn idom_is_written_to_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let (start, out) = csr(3, &[(0, 1), (1, 2)]);
    let store = Store::Dir(dir.path().to_path_buf());
    let d = dominators(&start, &out, 0, &store, &no_progress, &CancellationToken::new()).unwrap();
    drop(d);
    assert_eq!(&*Column::<u32>::open(&dir.path().join("idom.u32")).unwrap(), &[0, 0, 1]);
    let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["idom.u32"], "scratch columns leave no files");
}

#[test]
fn reports_dominators_progress_and_stops_on_cancel() {
    let (start, out) = csr(3, &[(0, 1), (1, 2)]);
    let calls = RefCell::new(Vec::new());
    let record = |phase, done, total| {
        calls.borrow_mut().push((phase, done, total));
        Ok(())
    };
    dominators(&start, &out, 0, &Store::Ram, &record, &CancellationToken::new()).unwrap();
    let calls = calls.into_inner();
    let total = calls[0].2;
    assert_eq!(calls.first(), Some(&(HeapPhase::Dominators, 0, total)));
    assert_eq!(calls.last(), Some(&(HeapPhase::Dominators, total, total)));
    assert!(calls.windows(2).all(|w| w[0].1 <= w[1].1), "progress never goes back: {calls:?}");

    let cancel = CancellationToken::new();
    let cancel_on_first = |_, _, _| {
        cancel.cancel();
        Ok(())
    };
    let result = dominators(&start, &out, 0, &Store::Ram, &cancel_on_first, &cancel);
    assert!(matches!(result, Err(HeapError::Cancelled)));

    let refuse = |_, _, _| Err(HeapError::TooLarge);
    let result = dominators(&start, &out, 0, &Store::Ram, &refuse, &CancellationToken::new());
    assert!(matches!(result, Err(HeapError::TooLarge)));
}

#[test]
fn cancel_during_idom_phase() {
    // Long enough that the last phase alone passes a check interval.
    const NODES: u32 = (CHECK_EVERY + CHECK_EVERY / 2) as u32;
    let edges: Vec<_> = (1..NODES).map(|v| (v - 1, v)).collect();
    let (start, out) = csr(NODES as usize, &edges);
    let span = u64::from(NODES);
    let cancel = CancellationToken::new();
    let calls = RefCell::new(Vec::new());
    let cancel_past_semidominators = |_, done, _| {
        calls.borrow_mut().push(done);
        if done > 2 * span {
            cancel.cancel();
        }
        Ok(())
    };
    let result = dominators(&start, &out, 0, &Store::Ram, &cancel_past_semidominators, &cancel);
    assert!(matches!(result, Err(HeapError::Cancelled)));
    let calls = calls.into_inner();
    assert!(calls.contains(&(2 * span)), "the semidominator phase finished: {calls:?}");
    let last = *calls.last().unwrap();
    assert!(last > 2 * span && last < 3 * span, "stopped inside the idom phase: {calls:?}");
}

proptest! {
    #[test]
    fn matches_dataflow_on_random_graphs(n in 2usize..64, edges in vec((0u32..64, 0u32..64), 0..192)) {
        let edges: Vec<_> = edges.into_iter().map(|(a, b)| (a % n as u32, b % n as u32)).collect();
        let d = run(n, &edges, 0);
        prop_assert_eq!(d.idom.to_vec(), dataflow_idom(n, &edges, 0));
        prop_assert_eq!(d.preorder.len(), d.reachable as usize);
    }
}

#[test]
fn matches_chk_on_a_large_random_graph() {
    const NODES: u32 = 200_000;
    const EXTRA_EDGES: u32 = 100_000;
    let mut rng = XorShift::new(0x5EED_D0D0);
    let mut edges: Vec<_> = (1..NODES).map(|v| (rng.below(v), v)).collect();
    edges.extend((0..EXTRA_EDGES).map(|_| (rng.below(NODES), rng.below(NODES))));
    // Visit edges in a scrambled order so the DFS tree differs from the generating tree.
    for i in (1..edges.len()).rev() {
        edges.swap(i, rng.below(i as u32 + 1) as usize);
    }
    let started = Instant::now();
    let d = run(NODES as usize, &edges, 0);
    let elapsed = started.elapsed();
    let expected = chk_idom(NODES as usize, &edges, 0);
    let mismatches = d.idom.iter().zip(&expected).filter(|(a, b)| a != b).count();
    assert_eq!(mismatches, 0);
    assert_eq!(d.reachable, NODES);
    eprintln!("dominators of {NODES} random nodes: {elapsed:?}");
}

/// A doubly linked list whose items an array list also holds: super-root 0 → list 1 → node 0,
/// 0 → array list 2 → element array 3 → every item; node j → item j, next, prev.
fn shared_list_and_array(k: u32) -> (usize, Vec<(u32, u32)>) {
    let node = |j: u32| 4 + 2 * j;
    let item = |j: u32| 5 + 2 * j;
    let mut edges = vec![(0, 1), (0, 2), (2, 3), (1, node(0))];
    for j in 0..k {
        edges.push((node(j), item(j)));
        if j + 1 < k {
            edges.push((node(j), node(j + 1)));
        }
        if j > 0 {
            edges.push((node(j), node(j - 1)));
        }
        edges.push((3, item(j)));
    }
    ((4 + 2 * k) as usize, edges)
}

#[test]
fn shared_list_and_array_is_near_linear() {
    let (n, edges) = shared_list_and_array(29);
    assert_eq!(run(n, &edges, 0).idom.to_vec(), dataflow_idom(n, &edges, 0));
    let (n, edges) = shared_list_and_array(3_000);
    assert_eq!(run(n, &edges, 0).idom.to_vec(), chk_idom(n, &edges, 0));

    const K: u32 = 200_000;
    let (n, edges) = shared_list_and_array(K);
    let (start, out) = csr(n, &edges);
    let started = Instant::now();
    let (d, steps) = compute(&start, &out, 0, &Store::Ram, &no_progress, &CancellationToken::new()).unwrap();
    let elapsed = started.elapsed();
    let item = |j: u32| (5 + 2 * j) as usize;
    assert!((0..K).all(|j| d.idom[item(j)] == 0), "every item is held by both collections");
    let m = edges.len() as u64;
    let bound = (n as u64 + m) * u64::from(n.ilog2());
    eprintln!("shared list k={K}: {steps} steps (n={n}, m={m}, bound {bound}), {elapsed:?}");
    assert!(steps <= bound, "{steps} steps for n={n}, m={m}");
}

#[test]
fn deep_chain_has_linear_dominators() {
    // A small stack proves the algorithm does not recurse along the chain.
    std::thread::Builder::new()
        .stack_size(256 << 10)
        .spawn(|| {
            const NODES: u32 = 1_000_000;
            let mut edges: Vec<_> = (1..NODES).map(|v| (v - 1, v)).collect();
            edges.push((0, NODES - 1));
            // Makes `eval` compress the whole chain at once.
            edges.push((NODES - 1, 1));
            let started = Instant::now();
            let d = run(NODES as usize, &edges, 0);
            eprintln!("dominators of a {NODES}-node chain: {:?}", started.elapsed());
            assert_eq!(d.reachable, NODES);
            assert_eq!(d.idom[0], 0);
            assert_eq!(d.idom[NODES as usize - 1], 0);
            let wrong = (1..NODES - 1).filter(|&v| d.idom[v as usize] != v - 1).count();
            assert_eq!(wrong, 0);
        })
        .unwrap()
        .join()
        .unwrap();
}
