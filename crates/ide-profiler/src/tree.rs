//! Building the call tree from stacks.

use crate::{MethodStat, Profile, ProfileFrame, ProfileFrameKind, ProfileMode, ProfileNode};
use std::collections::HashMap;
use std::path::PathBuf;

/// Identity of a frame; `kind` keeps an allocated type apart from a function of the same name.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct FrameKey {
    pub name: String,
    pub file: Option<PathBuf>,
    pub line: Option<u32>,
    pub kind: ProfileFrameKind,
}

impl FrameKey {
    pub fn named(name: impl Into<String>) -> Self {
        Self { name: name.into(), file: None, line: None, kind: ProfileFrameKind::Code }
    }

    pub fn allocated(name: impl Into<String>) -> Self {
        Self { kind: ProfileFrameKind::AllocatedType, ..Self::named(name) }
    }
}

struct NodeAcc {
    frame: u32,
    self_weight: f64,
    children: HashMap<u32, u32>,
}

/// Accumulates root-first stacks into a call tree (node 0 is the synthetic root).
pub(crate) struct TreeBuilder {
    frames: Vec<FrameKey>,
    frame_ids: HashMap<FrameKey, u32>,
    nodes: Vec<NodeAcc>,
}

impl TreeBuilder {
    pub fn new() -> Self {
        let mut b = Self { frames: Vec::new(), frame_ids: HashMap::new(), nodes: Vec::new() };
        let root = b.frame(FrameKey::named("all"));
        b.nodes.push(NodeAcc { frame: root, self_weight: 0.0, children: HashMap::new() });
        b
    }

    pub fn frame(&mut self, key: FrameKey) -> u32 {
        if let Some(id) = self.frame_ids.get(&key) {
            return *id;
        }
        let id = self.frames.len() as u32;
        self.frames.push(key.clone());
        self.frame_ids.insert(key, id);
        id
    }

    /// The child of `node` for `frame` (created on demand).
    pub fn child(&mut self, node: u32, frame: u32) -> u32 {
        if let Some(c) = self.nodes[node as usize].children.get(&frame) {
            return *c;
        }
        let id = self.nodes.len() as u32;
        self.nodes.push(NodeAcc { frame, self_weight: 0.0, children: HashMap::new() });
        self.nodes[node as usize].children.insert(frame, id);
        id
    }

    pub fn add_self(&mut self, node: u32, weight: f64) {
        self.nodes[node as usize].self_weight += weight;
    }

    /// Adds one root-first stack with `weight`.
    pub fn add_stack(&mut self, stack: impl IntoIterator<Item = FrameKey>, weight: f64) {
        let mut node = 0;
        for key in stack {
            let f = self.frame(key);
            node = self.child(node, f);
        }
        self.add_self(node, weight);
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.len() <= 1 && self.nodes[0].self_weight == 0.0
    }

    pub fn finish(self, profiler: &str, unit: &str, mode: ProfileMode) -> Profile {
        let n = self.nodes.len();
        // Renumber in depth-first order, children by total weight (heaviest first).
        // Children are always created after their parent, so a reverse sweep sums bottom-up.
        let mut totals = vec![0.0; n];
        for i in (0..n).rev() {
            totals[i] =
                self.nodes[i].self_weight + self.nodes[i].children.values().map(|c| totals[*c as usize]).sum::<f64>();
        }
        let mut order: Vec<usize> = Vec::with_capacity(n);
        let mut stack = vec![0usize];
        let mut new_id = vec![0u32; n];
        while let Some(i) = stack.pop() {
            new_id[i] = order.len() as u32;
            order.push(i);
            let mut kids: Vec<usize> = self.nodes[i].children.values().map(|c| *c as usize).collect();
            kids.sort_by(|a, b| totals[*a].total_cmp(&totals[*b]).then(a.cmp(b)));
            stack.extend(kids); // lightest pushed first → heaviest popped first
        }
        let nodes: Vec<ProfileNode> = order
            .iter()
            .map(|&i| {
                let mut kids: Vec<usize> = self.nodes[i].children.values().map(|c| *c as usize).collect();
                kids.sort_by(|a, b| totals[*b].total_cmp(&totals[*a]).then(a.cmp(b)));
                ProfileNode {
                    frame: self.nodes[i].frame,
                    total: totals[i],
                    self_weight: self.nodes[i].self_weight,
                    children: kids.into_iter().map(|k| new_id[k]).collect(),
                }
            })
            .collect();
        let frames: Vec<ProfileFrame> = self
            .frames
            .into_iter()
            .map(|k| ProfileFrame { name: k.name, file: k.file.map(Into::into), line: k.line, kind: k.kind })
            .collect();
        let methods = methods(&nodes, frames.len());
        Profile { profiler: profiler.to_owned(), unit: unit.to_owned(), mode, total: totals[0], frames, nodes, methods }
    }
}

/// Self and total weight per frame; a recursive frame's total counts each sample once.
fn methods(nodes: &[ProfileNode], frame_count: usize) -> Vec<MethodStat> {
    let mut self_w = vec![0.0; frame_count];
    let mut total_w = vec![0.0; frame_count];
    let mut on_stack = vec![0u32; frame_count];
    // Iterative DFS: (node, entering).
    let mut stack = vec![(0u32, true)];
    while let Some((i, enter)) = stack.pop() {
        let node = &nodes[i as usize];
        let f = node.frame as usize;
        if enter {
            self_w[f] += node.self_weight;
            if on_stack[f] == 0 {
                total_w[f] += node.total;
            }
            on_stack[f] += 1;
            stack.push((i, false));
            stack.extend(node.children.iter().map(|c| (*c, true)));
        } else {
            on_stack[f] -= 1;
        }
    }
    let root_frame = nodes.first().map(|n| n.frame as usize);
    let mut out: Vec<MethodStat> = (0..frame_count)
        .filter(|f| Some(*f) != root_frame && total_w[*f] > 0.0)
        .map(|f| MethodStat { frame: f as u32, self_weight: self_w[f], total: total_w[f] })
        .collect();
    out.sort_by(|a, b| b.self_weight.total_cmp(&a.self_weight).then(b.total.total_cmp(&a.total)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack(names: &[&str]) -> Vec<FrameKey> {
        names.iter().map(|n| FrameKey::named(*n)).collect()
    }

    #[test]
    fn builds_sorted_tree_and_method_stats() {
        let mut b = TreeBuilder::new();
        b.add_stack(stack(&["main", "a"]), 1.0);
        b.add_stack(stack(&["main", "b"]), 3.0);
        b.add_stack(stack(&["main", "b", "b"]), 2.0);
        b.add_stack(stack(&["main"]), 1.0);
        let p = b.finish("t", "samples", crate::ProfileMode::Cpu);
        assert_eq!(p.total, 7.0);
        let name = |n: &ProfileNode| p.frames[n.frame as usize].name.as_str();
        let root = &p.nodes[0];
        assert_eq!(name(root), "all");
        let main = &p.nodes[root.children[0] as usize];
        assert_eq!((name(main), main.total, main.self_weight), ("main", 7.0, 1.0));
        let first = &p.nodes[main.children[0] as usize];
        assert_eq!((name(first), first.total), ("b", 5.0), "heaviest child first");
        // Recursion: b's total is 5, not 7.
        let b_stat = p.methods.iter().find(|m| p.frames[m.frame as usize].name == "b").unwrap();
        assert_eq!((b_stat.self_weight, b_stat.total), (5.0, 5.0));
        assert_eq!(p.frames[p.methods[0].frame as usize].name, "b", "sorted by self weight");
        assert!(p.methods.iter().all(|m| p.frames[m.frame as usize].name != "all"));
    }
}
