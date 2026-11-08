//! Maps hprof object ids (addresses) to dense `u32` indices in ascending address order.
//!
//! Object ids are addresses and objects are at least 8 bytes apart, so one bit per 8-byte slot
//! ranks ids at about a byte per object. Addresses are grouped in 1 MiB chunks of
//! [`WORDS_PER_CHUNK`] words; only chunks holding an id get words, and a dense table maps a chunk
//! to its first word. The rank of an id is the number of set bits before its word plus the set
//! bits below it in the word. Ids that are not multiples of 8, or that span too wide an address
//! range for the table, use a sorted array and binary search instead.

mod builder;

pub use builder::IdMapBuilder;

use crate::column::{Column, NONE};

const SLOT_SHIFT: u32 = 3;
const CHUNK_SLOT_BITS: u32 = 17;
const WORD_BITS: u64 = 64;
const WORDS_PER_CHUNK: usize = (1 << CHUNK_SLOT_BITS) / WORD_BITS as usize;

enum Repr {
    Bits {
        /// Chunk number of the first table entry.
        min_chunk: u64,
        words: Column<u64>,
        /// Set bits before each word.
        wrank: Column<u32>,
        /// Per chunk from `min_chunk` up: index of its first word, or `NONE` when it has no id.
        table: Column<u32>,
        /// Per chunk that has words, in word order: its offset from `min_chunk`.
        chunk_offsets: Column<u32>,
        len: u32,
    },
    Sorted(Column<u64>),
}

/// Ids ranked in ascending address order: the index of an object is its position in the order.
pub struct IdMap {
    repr: Repr,
}

impl IdMap {
    pub fn len(&self) -> u32 {
        match &self.repr {
            Repr::Bits { len, .. } => *len,
            Repr::Sorted(ids) => ids.len() as u32,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The index of `id`, or `None` when it is not in the map.
    pub fn rank(&self, id: u64) -> Option<u32> {
        match &self.repr {
            Repr::Sorted(ids) => ids.binary_search(&id).ok().map(|r| r as u32),
            Repr::Bits { min_chunk, words, wrank, table, .. } => {
                if id & 7 != 0 {
                    return None;
                }
                let slot = id >> SLOT_SHIFT;
                let offset = (slot >> CHUNK_SLOT_BITS).checked_sub(*min_chunk)?;
                let first = *table.get(usize::try_from(offset).ok()?)?;
                if first == NONE {
                    return None;
                }
                let w = first as usize + (slot >> 6) as usize % WORDS_PER_CHUNK;
                let bit = slot & 63;
                let word = words[w];
                if word >> bit & 1 == 0 {
                    return None;
                }
                Some(wrank[w] + (word & ((1u64 << bit) - 1)).count_ones())
            }
        }
    }

    /// The id with index `rank`. Panics when `rank >= len()`.
    pub fn id_at(&self, rank: u32) -> u64 {
        match &self.repr {
            Repr::Sorted(ids) => ids[rank as usize],
            Repr::Bits { words, wrank, len, .. } => {
                assert!(rank < *len, "rank {rank} out of range for {len} ids");
                let w = wrank.partition_point(|&before| before <= rank) - 1;
                let mut word = words[w];
                for _ in 0..rank - wrank[w] {
                    word &= word - 1;
                }
                (self.word_first_slot(w) + u64::from(word.trailing_zeros())) << SLOT_SHIFT
            }
        }
    }

    /// All ids in ascending order.
    pub fn ids(&self) -> impl Iterator<Item = u64> + '_ {
        Ids { map: self, next: 0, slot_base: 0, rest: 0 }
    }

    /// Bytes of all the columns, in RAM or on disk.
    pub fn column_bytes(&self) -> u64 {
        match &self.repr {
            Repr::Sorted(ids) => std::mem::size_of_val(&**ids) as u64,
            Repr::Bits { words, wrank, table, chunk_offsets, .. } => {
                (std::mem::size_of_val(&**words)
                    + std::mem::size_of_val(&**wrank)
                    + std::mem::size_of_val(&**table)
                    + std::mem::size_of_val(&**chunk_offsets)) as u64
            }
        }
    }

    /// Slot number of bit 0 of word `w` (bitmap layout only).
    fn word_first_slot(&self, w: usize) -> u64 {
        let Repr::Bits { min_chunk, chunk_offsets, .. } = &self.repr else {
            unreachable!("sorted layout has no words")
        };
        let chunk = min_chunk + u64::from(chunk_offsets[w / WORDS_PER_CHUNK]);
        (chunk << CHUNK_SLOT_BITS) + (w % WORDS_PER_CHUNK) as u64 * WORD_BITS
    }
}

struct Ids<'a> {
    map: &'a IdMap,
    /// Next word (bitmap layout) or next id (sorted layout).
    next: usize,
    slot_base: u64,
    /// Bits of the current word not yielded yet.
    rest: u64,
}

impl Iterator for Ids<'_> {
    type Item = u64;

    fn next(&mut self) -> Option<u64> {
        match &self.map.repr {
            Repr::Sorted(ids) => {
                let id = *ids.get(self.next)?;
                self.next += 1;
                Some(id)
            }
            Repr::Bits { words, .. } => loop {
                if self.rest != 0 {
                    let bit = u64::from(self.rest.trailing_zeros());
                    self.rest &= self.rest - 1;
                    return Some((self.slot_base + bit) << SLOT_SHIFT);
                }
                self.rest = *words.get(self.next)?;
                self.slot_base = self.map.word_first_slot(self.next);
                self.next += 1;
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use ide_core::CancellationToken;

    use super::*;
    use crate::column::Store;

    /// Deterministic generator so failures replay; the crate has no `rand`.
    struct XorShift(u64);

    impl XorShift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    fn build(ids: &[u64], store: &Store) -> IdMap {
        let mut builder = IdMapBuilder::new();
        for &id in ids {
            builder.insert(id);
        }
        builder.build(store, &CancellationToken::new()).unwrap()
    }

    fn assert_matches_model(map: &IdMap, model: &[u64]) {
        assert_eq!(map.len() as usize, model.len());
        assert_eq!(map.ids().collect::<Vec<_>>(), model);
        for (rank, &id) in model.iter().enumerate() {
            assert_eq!(map.rank(id), Some(rank as u32), "rank of {id:#x}");
            assert_eq!(map.id_at(rank as u32), id, "id at {rank}");
            for near in [id.wrapping_sub(8), id.wrapping_add(8), id.wrapping_add(1), id.wrapping_add(4)] {
                if model.binary_search(&near).is_err() {
                    assert_eq!(map.rank(near), None, "{near:#x} was never inserted");
                }
            }
        }
    }

    #[test]
    fn rank_follows_address_order() {
        let map = build(&[0x2000, 0x1000, 0x1010, 0x7_0000_0000], &Store::Ram);
        assert_eq!(map.len(), 4);
        assert_eq!(
            [0x1000, 0x1010, 0x2000, 0x7_0000_0000].map(|id| map.rank(id)),
            [Some(0), Some(1), Some(2), Some(3)]
        );
        assert_eq!(map.rank(0x1008), None);
        assert_eq!(map.rank(0), None);
        assert_eq!(map.id_at(2), 0x2000);
        assert_eq!(map.ids().collect::<Vec<_>>(), [0x1000, 0x1010, 0x2000, 0x7_0000_0000]);
    }

    #[test]
    fn unaligned_ids_use_sorted_fallback() {
        let map = build(&[0x2000, 0x1004, 0x1000, 0x1010, 0x7_0000_0000], &Store::Ram);
        assert_eq!(
            [0x1000, 0x1004, 0x1010, 0x2000, 0x7_0000_0000].map(|id| map.rank(id)),
            [Some(0), Some(1), Some(2), Some(3), Some(4)]
        );
        assert_eq!(map.rank(0x1008), None);
        assert_eq!(map.id_at(1), 0x1004);
    }

    #[test]
    fn sparse_wide_span_uses_fallback() {
        let map = build(&[0x1000 + (1 << 50), 0x1000], &Store::Ram);
        assert_eq!(map.rank(0x1000), Some(0));
        assert_eq!(map.rank(0x1000 + (1 << 50)), Some(1));
        assert_eq!(map.rank(0x1008), None);
        assert!(map.column_bytes() < 64, "a two-id map must not allocate a chunk table");
    }

    #[test]
    fn ten_million_ids_cost_about_a_byte_each() {
        let mut builder = IdMapBuilder::new();
        for i in 0..10_000_000u64 {
            builder.insert(0x7_0000_0000 + i * 32);
        }
        let map = builder.build(&Store::Ram, &CancellationToken::new()).unwrap();
        assert_eq!(map.len(), 10_000_000);
        assert!(map.column_bytes() < 16_000_000, "{} bytes", map.column_bytes());
        assert_eq!(map.rank(0x7_0000_0000 + 9_999_999 * 32), Some(9_999_999));
        assert_eq!(map.id_at(5_000_000), 0x7_0000_0000 + 5_000_000 * 32);
    }

    #[test]
    fn empty_map_and_duplicates() {
        let map = build(&[], &Store::Ram);
        assert!(map.is_empty());
        assert_eq!(map.rank(0x1000), None);
        assert_eq!(map.ids().count(), 0);
        let map = build(&[0x1000, 0x1000, 0x1008, 0x1000], &Store::Ram);
        assert_eq!(map.len(), 2);
        assert_eq!(map.rank(0x1008), Some(1));
    }

    #[test]
    fn chunk_boundaries_and_gaps_between_chunks() {
        let ids = [0, 0xF_FFF8, 0x10_0000, 0x10_0008, 0x50_0000, 0x1_0000_0000];
        let mut model = ids.to_vec();
        model.sort_unstable();
        let map = build(&ids, &Store::Ram);
        assert_matches_model(&map, &model);
    }

    #[test]
    fn ids_outside_the_populated_chunks_are_absent() {
        let ids = [0x30_0000, 0x30_0008, 0x70_0000];
        let map = build(&ids, &Store::Ram);
        assert_matches_model(&map, &ids);
        // Chunk 5 lies between the lowest and highest chunk but holds nothing.
        assert_eq!(map.rank(0x50_0000), None);
        // Chunk 1 is below the lowest populated chunk.
        assert_eq!(map.rank(0x10_0000), None);
        // Chunk 9 is past the last table entry.
        assert_eq!(map.rank(0x900_0000), None);
        assert_eq!(map.rank(u64::MAX - 7), None);
    }

    #[test]
    fn highest_address_round_trips() {
        let map = build(&[0xFFFF_FFFF_FFFF_FFF8], &Store::Ram);
        assert_eq!(map.rank(0xFFFF_FFFF_FFFF_FFF8), Some(0));
        assert_eq!(map.id_at(0), 0xFFFF_FFFF_FFFF_FFF8);
        let map = build(&[0, 0xFFFF_FFFF_FFFF_FFF8], &Store::Ram);
        assert_matches_model(&map, &[0, 0xFFFF_FFFF_FFFF_FFF8]);
    }

    #[test]
    fn random_ids_match_a_sorted_model_in_ram_and_on_disk() {
        for seed in 1..=8u64 {
            let mut rng = XorShift(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let aligned = seed % 4 != 0;
            let wide = seed % 3 == 0;
            let ids: Vec<u64> = (0..3000)
                .map(|_| {
                    let r = rng.next();
                    let base = if wide { (r >> 20) << 12 } else { 0x6_0000_0000 + (r % (6 << 20)) };
                    if aligned { base & !7 } else { base }
                })
                .collect();
            let mut model = ids.clone();
            model.sort_unstable();
            model.dedup();
            let dir = tempfile::tempdir().unwrap();
            for store in [Store::Ram, Store::Dir(dir.path().to_path_buf())] {
                assert_matches_model(&build(&ids, &store), &model);
            }
        }
    }

    #[test]
    fn dir_store_keeps_the_index_columns_under_stable_names() {
        let dir = tempfile::tempdir().unwrap();
        let map = build(&[0x1000, 0x2000], &Store::Dir(dir.path().to_path_buf()));
        let mut names: Vec<_> =
            std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, ["ids.bits.u64", "ids.chunks.u32", "ids.table.u32", "ids.wrank.u32"]);
        assert_eq!(map.rank(0x2000), Some(1));
        let dir = tempfile::tempdir().unwrap();
        build(&[0x1004], &Store::Dir(dir.path().to_path_buf()));
        assert!(dir.path().join("ids.sorted.u64").exists());
    }
}
