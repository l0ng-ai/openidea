//! Class table rows, pages of the dominator tree and single object rows.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use super::{HeapClassRow, HeapIndex, HeapObjectPage, HeapObjectRef, HeapObjectRow, HeapSummary, MAX_PAGE};
use crate::column::NONE;
use crate::hprof::HeapRecord;
use crate::strings::string_preview;

const PREVIEW_CHARS: usize = 100;

impl HeapIndex {
    pub fn summary(&self) -> &HeapSummary {
        &self.summary
    }

    /// Types that have objects, by retained size descending, then by name.
    pub fn class_rows(&self) -> Vec<HeapClassRow> {
        let class_slots = &self.classes[..self.class_info.len().min(self.classes.len())];
        let mut names: HashMap<&str, u32> = HashMap::with_capacity(class_slots.len());
        for class in class_slots {
            *names.entry(class.name.as_str()).or_default() += 1;
        }
        let mut rows: Vec<HeapClassRow> = self
            .classes
            .iter()
            .enumerate()
            .filter(|(_, c)| c.count > 0 || c.unreachable_count > 0)
            .map(|(slot, c)| HeapClassRow {
                class_index: slot as u32,
                name: c.name.clone(),
                count: c.count,
                shallow: c.shallow,
                retained: c.retained,
                unreachable_count: c.unreachable_count,
                // Primitive array slots have no class dump and so no second loader.
                ambiguous: slot < class_slots.len() && names[c.name.as_str()] > 1,
            })
            .collect();
        rows.sort_by(|a, b| b.retained.cmp(&a.retained).then_with(|| a.name.cmp(&b.name)));
        rows
    }

    /// A page of objects by retained size descending, then by index:
    ///
    /// - no `parent`, no `class_index`: the children of the super-root, class objects left out;
    /// - `parent`: its children in the dominator tree, of type `class_index` if given;
    /// - `class_index` only: every reachable object of that type.
    ///
    /// `limit` is clamped to [`MAX_PAGE`]. A `parent` or `class_index` that names nothing gives an
    /// empty page.
    pub fn dominated(
        &self,
        parent: Option<HeapObjectRef>,
        class_index: Option<u32>,
        offset: u32,
        limit: u32,
    ) -> HeapObjectPage {
        let limit = limit.min(MAX_PAGE);
        let root = self.root();
        if class_index.is_some_and(|c| c as usize >= self.classes.len()) {
            return HeapObjectPage { rows: Vec::new(), total: 0 };
        }
        match (parent, class_index) {
            (Some(HeapObjectRef(p)), _) if p >= root => HeapObjectPage { rows: Vec::new(), total: 0 },
            (Some(HeapObjectRef(p)), class) => self.page(
                self.children(p).filter(|&v| class.is_none_or(|c| self.types[v as usize] == c)),
                offset,
                limit,
            ),
            (None, None) => {
                self.page(self.children(root).filter(|&v| self.types[v as usize] != self.class_slot), offset, limit)
            }
            (None, Some(class)) => self.largest_of(class, offset, limit),
        }
    }

    /// `None` for a ref that names no object, the super-root included.
    pub fn object_row(&self, object: HeapObjectRef) -> Option<HeapObjectRow> {
        let v = object.0;
        if v >= self.root() {
            return None;
        }
        let i = v as usize;
        let slot = self.types[i];
        let preview = if slot == self.class_slot {
            self.class_of_object(v).and_then(|c| self.classes.get(c)).map(|c| c.name.clone())
        } else {
            string_preview(self, v, PREVIEW_CHARS)
        };
        Some(HeapObjectRow {
            object,
            class_name: self.classes.get(slot as usize).map(|c| c.name.clone()).unwrap_or_default(),
            address: format!("{:#x}", self.ids.id_at(v)),
            shallow: u64::from(self.shallow8[i]) * 8,
            retained: self.retained[i],
            has_children: self.kids_start[i + 1] > self.kids_start[i],
            preview,
        })
    }

    /// The record of object `v`, or `None` when it cannot be read.
    pub(crate) fn record(&self, v: u32) -> Option<HeapRecord<'_>> {
        let at = usize::try_from(*self.offsets.get(v as usize)?).ok()?;
        crate::hprof::record_at(&self.hprof, at, self.id_size).ok()
    }

    /// The class slot a class object stands for.
    pub(crate) fn class_of_object(&self, v: u32) -> Option<usize> {
        if v >= self.root() {
            return None;
        }
        let id = self.ids.id_at(v);
        self.class_info.iter().position(|c| c.id == id && c.id != 0)
    }

    /// Children of node `v` in the dominator tree, already in page order.
    fn children(&self, v: u32) -> impl Iterator<Item = u32> + '_ {
        let v = v as usize;
        self.kids[self.kids_start[v] as usize..self.kids_start[v + 1] as usize].iter().copied()
    }

    fn page(&self, objects: impl Iterator<Item = u32>, offset: u32, limit: u32) -> HeapObjectPage {
        let mut rows = Vec::new();
        let mut total = 0u32;
        for v in objects {
            if total >= offset && total - offset < limit {
                rows.extend(self.object_row(HeapObjectRef(v)));
            }
            total = total.saturating_add(1);
        }
        HeapObjectPage { rows, total }
    }

    /// Scans every object: the top `offset + limit` stay in a heap whose top is the smallest.
    fn largest_of(&self, class: u32, offset: u32, limit: u32) -> HeapObjectPage {
        let count = self.classes[class as usize].count;
        let total = u32::try_from(count).unwrap_or(u32::MAX);
        let keep = match offset.checked_add(limit) {
            Some(keep) if offset < total && limit > 0 => keep.min(total) as usize,
            _ => return HeapObjectPage { rows: Vec::new(), total },
        };
        let mut top: BinaryHeap<Reverse<(u64, Reverse<u32>)>> = BinaryHeap::with_capacity(keep + 1);
        for v in 0..self.root() {
            let i = v as usize;
            if self.types[i] != class || self.idom[i] == NONE {
                continue;
            }
            top.push(Reverse((self.retained[i], Reverse(v))));
            if top.len() > keep {
                top.pop();
            }
        }
        // Ascending `Reverse` order is descending retained, then ascending index.
        let rows = top
            .into_sorted_vec()
            .into_iter()
            .skip(offset as usize)
            .filter_map(|Reverse((_, Reverse(v)))| self.object_row(HeapObjectRef(v)))
            .collect();
        HeapObjectPage { rows, total }
    }
}
