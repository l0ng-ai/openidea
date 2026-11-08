//! Maps hprof object ids (addresses) to dense `u32` indices in ascending address order.
//!
//! Object ids are addresses and objects are at least 8 bytes apart, so one bit per 8-byte slot
//! ranks ids at about a byte per object. Addresses are grouped in 1 MiB chunks of
//! [`WORDS_PER_CHUNK`] words; only chunks holding an id get words, and a dense table maps a chunk
//! to its first word. The rank of an id is the number of set bits before its word plus the set
//! bits below it in the word. Ids that are not multiples of 8, or that span too wide an address
//! range for the table, use a sorted array and binary search instead.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::io;

use crate::column::{Column, NONE, Store};

const SLOT_SHIFT: u32 = 3;
const CHUNK_SLOT_BITS: u32 = 17;
const WORD_BITS: u64 = 64;
const WORDS_PER_CHUNK: usize = (1 << CHUNK_SLOT_BITS) / WORD_BITS as usize;
/// Widest chunk range the dense table covers (256 MiB of table at most).
const MAX_CHUNK_SPAN: u64 = 1 << 26;
/// Chunks whose first word index still fits in the table's `u32`.
const MAX_CHUNKS: usize = (NONE as usize - 1) / WORDS_PER_CHUNK;
/// Largest object count: `NONE` and the one after it stay free as sentinels for the columns above.
const MAX_IDS: u64 = NONE as u64 - 2;

const BITS_FILE: &str = "ids.bits.u64";
const WRANK_FILE: &str = "ids.wrank.u32";
const TABLE_FILE: &str = "ids.table.u32";
const CHUNKS_FILE: &str = "ids.chunks.u32";
const SORTED_FILE: &str = "ids.sorted.u64";

/// Chunk numbers are already well spread by a multiplicative hash; SipHash would dominate the
/// per-insert cost on a 100M-object heap.
#[derive(Default)]
struct ChunkHasher(u64);

impl Hasher for ChunkHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(self.0.rotate_left(8) ^ u64::from(b));
        }
    }

    fn write_u64(&mut self, n: u64) {
        self.0 = n.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}

enum Collected {
    Bits(BitChunks),
    Sorted(Vec<u64>),
}

struct BitChunks {
    /// Chunk number → position in `words`.
    index: HashMap<u64, usize, BuildHasherDefault<ChunkHasher>>,
    words: Vec<Box<[u64]>>,
    min: u64,
    max: u64,
    /// The chunk of the previous insert; ids usually arrive in runs.
    last: Option<(u64, usize)>,
}

impl BitChunks {
    fn new() -> Self {
        Self { index: HashMap::default(), words: Vec::new(), min: u64::MAX, max: 0, last: None }
    }

    /// `false` when the chunk would not fit the dense table; the caller then switches to the
    /// sorted layout.
    fn insert(&mut self, id: u64) -> bool {
        let slot = id >> SLOT_SHIFT;
        let chunk = slot >> CHUNK_SLOT_BITS;
        let at = match self.last {
            Some((c, at)) if c == chunk => at,
            _ => match self.index.get(&chunk) {
                Some(&at) => at,
                None => {
                    let (min, max) = (self.min.min(chunk), self.max.max(chunk));
                    if self.words.len() >= MAX_CHUNKS || max - min >= MAX_CHUNK_SPAN {
                        return false;
                    }
                    (self.min, self.max) = (min, max);
                    self.words.push(vec![0u64; WORDS_PER_CHUNK].into_boxed_slice());
                    self.index.insert(chunk, self.words.len() - 1);
                    self.words.len() - 1
                }
            },
        };
        self.last = Some((chunk, at));
        let word = (slot >> 6) as usize % WORDS_PER_CHUNK;
        self.words[at][word] |= 1 << (slot & 63);
        true
    }

    fn into_ids(self) -> Vec<u64> {
        let mut chunks: Vec<(u64, usize)> = self.index.into_iter().collect();
        chunks.sort_unstable();
        let mut ids = Vec::new();
        for (chunk, at) in chunks {
            for (w, &word) in self.words[at].iter().enumerate() {
                let base = (chunk << CHUNK_SLOT_BITS) + w as u64 * WORD_BITS;
                let mut bits = word;
                while bits != 0 {
                    ids.push((base + u64::from(bits.trailing_zeros())) << SLOT_SHIFT);
                    bits &= bits - 1;
                }
            }
        }
        ids
    }
}

pub struct IdMapBuilder {
    collected: Collected,
}

impl Default for IdMapBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl IdMapBuilder {
    pub fn new() -> Self {
        Self { collected: Collected::Bits(BitChunks::new()) }
    }

    /// Inserting an id twice is the same as once.
    pub fn insert(&mut self, id: u64) {
        match &mut self.collected {
            Collected::Bits(bits) => {
                if id & 7 == 0 && bits.insert(id) {
                    return;
                }
                let Collected::Bits(bits) = std::mem::replace(&mut self.collected, Collected::Sorted(Vec::new()))
                else {
                    unreachable!()
                };
                let mut ids = bits.into_ids();
                ids.push(id);
                self.collected = Collected::Sorted(ids);
            }
            Collected::Sorted(ids) => ids.push(id),
        }
    }

    /// Fails with `InvalidInput` when there are more than `u32::MAX - 2` distinct ids.
    pub fn build(self, store: &Store) -> io::Result<IdMap> {
        let sorted = match self.collected {
            Collected::Bits(bits) if !bits.words.is_empty() => return IdMap::from_bits(bits, store),
            Collected::Bits(_) => Vec::new(),
            Collected::Sorted(mut ids) => {
                ids.sort_unstable();
                ids.dedup();
                ids
            }
        };
        if sorted.len() as u64 > MAX_IDS {
            return Err(too_many());
        }
        let mut column = store.column(SORTED_FILE, sorted.len(), 0u64)?;
        column.copy_from_slice(&sorted);
        Ok(IdMap { repr: Repr::Sorted(column) })
    }
}

fn too_many() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "too many object ids for 32-bit indices")
}

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
    fn from_bits(bits: BitChunks, store: &Store) -> io::Result<Self> {
        let total: u64 = bits.words.iter().flat_map(|w| w.iter()).map(|w| u64::from(w.count_ones())).sum();
        if total > MAX_IDS {
            return Err(too_many());
        }
        let mut chunks: Vec<(u64, usize)> = bits.index.into_iter().collect();
        chunks.sort_unstable();
        let span = (bits.max - bits.min + 1) as usize;
        let mut words = store.column(BITS_FILE, chunks.len() * WORDS_PER_CHUNK, 0u64)?;
        let mut wrank = store.column(WRANK_FILE, chunks.len() * WORDS_PER_CHUNK, 0u32)?;
        let mut table = store.column(TABLE_FILE, span, NONE)?;
        let mut chunk_offsets = store.column(CHUNKS_FILE, chunks.len(), 0u32)?;
        let mut before = 0u32;
        for (ordinal, &(chunk, at)) in chunks.iter().enumerate() {
            let first = ordinal * WORDS_PER_CHUNK;
            let offset = (chunk - bits.min) as usize;
            table[offset] = first as u32;
            chunk_offsets[ordinal] = offset as u32;
            for (w, &word) in bits.words[at].iter().enumerate() {
                words[first + w] = word;
                wrank[first + w] = before;
                before += word.count_ones();
            }
        }
        Ok(Self { repr: Repr::Bits { min_chunk: bits.min, words, wrank, table, chunk_offsets, len: before } })
    }

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
    use super::*;

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
        builder.build(store).unwrap()
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
        let map = builder.build(&Store::Ram).unwrap();
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
