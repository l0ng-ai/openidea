//! Bek branch partitioning and bottom-up block merge.
//! Adapted from JetBrains intellij-community BekBranchCreator/BekBranch/Merger,
//! Copyright 2000-2026 JetBrains s.r.o. and contributors, Apache-2.0.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

pub(crate) fn sort(parents: &[Vec<usize>], times: &[i64], heads: &[usize]) -> Vec<usize> {
    let n = parents.len();
    let mut children = vec![Vec::new(); n];
    for (i, ps) in parents.iter().enumerate() {
        for &p in ps {
            children[p].push(i);
        }
    }
    let mut layout = vec![0usize; n];
    let mut important = Vec::new();
    let mut next_layout = 1;
    for &head in heads {
        if layout[head] != 0 {
            continue;
        }
        important.push(head);
        let mut stack = vec![head];
        while let Some(&node) = stack.last() {
            let first = layout[node] == 0;
            if first {
                layout[node] = next_layout;
            }
            if let Some(&p) = parents[node].iter().find(|&&p| layout[p] == 0) {
                stack.push(p);
            } else {
                if first {
                    next_layout += 1;
                }
                stack.pop();
            }
        }
    }
    let mut done = vec![false; n];
    let mut restrictions = vec![HashSet::new(); n];
    let mut releases = vec![Vec::new(); n];
    let mut branches = Vec::new();
    for head in important {
        if done[head] {
            continue;
        }
        let start = layout[head];
        done[head] = true;
        let mut branch = vec![head];
        let mut stack = vec![head];
        while let Some(&node) = stack.last() {
            let mut next = None;
            for &p in parents[node].iter().rev() {
                if done[p] {
                    if layout[p] < start && restrictions[node].insert(p) {
                        releases[p].push(node);
                    }
                } else if layout[node] <= layout[p] && !children[p].iter().any(|&c| !done[c] && layout[c] <= layout[p])
                {
                    next = Some(p);
                    break;
                }
            }
            if let Some(p) = next {
                done[p] = true;
                branch.push(p);
                stack.push(p);
            } else {
                stack.pop();
            }
        }
        branches.push(branch);
    }
    let mut owner = vec![0usize; n];
    for (b, nodes) in branches.iter().enumerate() {
        for &node in nodes {
            owner[node] = b;
        }
    }
    let mut remaining: Vec<_> = branches.iter().map(Vec::len).collect();
    let mut prepared = vec![None; branches.len()];
    let mut queue = BinaryHeap::new();
    let prepare = |b: usize,
                   remaining: &[usize],
                   restrictions: &[HashSet<usize>],
                   prepared: &mut [Option<usize>],
                   queue: &mut BinaryHeap<Reverse<(i64, usize)>>| {
        let end = remaining[b];
        if end == 0 || prepared[b].is_some() || !restrictions[branches[b][end - 1]].is_empty() {
            return;
        }
        let mut start = end - 1;
        while start > 0 {
            let up = branches[b][start - 1];
            let down = branches[b][start];
            if !restrictions[up].is_empty() {
                break;
            }
            let connects = parents[up].contains(&down);
            if !(parents[up].len() > 1 && connects) {
                if !connects {
                    break;
                }
                let delta = times[up].abs_diff(times[down]);
                if delta > 3 * 24 * 3600 || (start + 20 < end && delta > 4 * 3600) {
                    break;
                }
            }
            start -= 1;
        }
        prepared[b] = Some(start);
        queue.push(Reverse((times[branches[b][start]], b)));
    };
    for b in 0..branches.len() {
        prepare(b, &remaining, &restrictions, &mut prepared, &mut queue);
    }
    let mut result = vec![0; n];
    let mut offset = n;
    while let Some(Reverse((_, b))) = queue.pop() {
        let start = prepared[b].take().unwrap();
        let part = &branches[b][start..remaining[b]];
        offset -= part.len();
        result[offset..offset + part.len()].copy_from_slice(part);
        remaining[b] = start;
        let mut released = HashSet::from([b]);
        for &node in part {
            for &up in &releases[node] {
                restrictions[up].remove(&node);
                let branch = owner[up];
                if restrictions[up].is_empty() && remaining[branch] > 0 && branches[branch][remaining[branch] - 1] == up
                {
                    released.insert(branch);
                }
            }
        }
        for branch in released {
            prepare(branch, &remaining, &restrictions, &mut prepared, &mut queue);
        }
    }
    debug_assert_eq!(offset, 0, "Bek must place every node");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn branch_blocks_preserve_every_edge_under_clock_skew_and_interleaved_refs() {
        let mut seed = 17u64;
        let mut random = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            seed as usize
        };
        for _ in 0..200 {
            let n = 70;
            let parents: Vec<Vec<usize>> = (0..n)
                .map(|i| {
                    let mut ps = Vec::new();
                    if i + 1 < n {
                        for _ in 0..(random() % 3 + 1) {
                            let p = i + 1 + random() % (n - i - 1);
                            if !ps.contains(&p) {
                                ps.push(p);
                            }
                        }
                    }
                    ps
                })
                .collect();
            let times: Vec<_> = (0..n).map(|_| (random() % 1_000_000) as i64).collect();
            let mut children = vec![0; n];
            for ps in &parents {
                for &p in ps {
                    children[p] += 1;
                }
            }
            let mut heads: Vec<_> = (0..n).filter(|&i| children[i] == 0 || i % 11 == 0).collect();
            heads.sort_by_cached_key(|_| random());
            let result = sort(&parents, &times, &heads);
            assert_eq!(result.iter().copied().collect::<HashSet<_>>().len(), n);
            let mut positions = vec![0; n];
            for (i, &node) in result.iter().enumerate() {
                positions[node] = i;
            }
            for (node, ps) in parents.iter().enumerate() {
                for &p in ps {
                    assert!(positions[node] < positions[p]);
                }
            }
        }
    }
}
