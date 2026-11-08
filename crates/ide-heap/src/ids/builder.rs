//! Collects object ids in any order and lays them out as an [`IdMap`].

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

use ide_core::CancellationToken;

use super::{CHUNK_SLOT_BITS, IdMap, Repr, SLOT_SHIFT, WORD_BITS, WORDS_PER_CHUNK};
use crate::column::{NONE, Store};
use crate::error::HeapError;

/// Widest chunk range the dense table covers (256 MiB of table at most).
const MAX_CHUNK_SPAN: u64 = 1 << 26;
/// Chunks whose first word index still fits in the table's `u32`.
const MAX_CHUNKS: usize = (NONE as usize - 1) / WORDS_PER_CHUNK;
/// Largest object count: `NONE` and the one after it stay free as sentinels for the columns above.
const MAX_IDS: u64 = NONE as u64 - 2;

const CHUNK_BYTES: u64 = (WORDS_PER_CHUNK * size_of::<u64>()) as u64;
/// The bitmaps may take this much before any id is inserted, then this many bytes per distinct id.
/// A heap that fits in 4 GiB of address space never reaches the base allowance whatever the
/// insertion order; sparse input (one id per chunk) is moved to plain `u64` ids, 8 bytes each,
/// after at most `BITMAP_BASE_BYTES + BITMAP_BYTES_PER_ID * ids` of bitmaps, so builder memory is
/// bounded by the number of ids rather than by the address range they spread over.
const BITMAP_BASE_BYTES: u64 = 64 << 20;
const BITMAP_BYTES_PER_ID: u64 = 32;

/// Longest stretch of work between two looks at the cancellation token.
const CHECK_EVERY: usize = 1 << 20;

const BITS_FILE: &str = "ids.bits.u64";
const WRANK_FILE: &str = "ids.wrank.u32";
const TABLE_FILE: &str = "ids.table.u32";
const CHUNKS_FILE: &str = "ids.chunks.u32";
const SORTED_FILE: &str = "ids.sorted.u64";

/// Chunk numbers are already well spread by a multiplicative hash; SipHash would dominate the
/// per-insert cost on a 100M-object heap. The product keeps the low zero bits of its input, so
/// the high half is folded down for the bucket index. The graph builder keys class and string
/// ids (addresses) with it for the same reason.
#[derive(Default)]
pub(crate) struct ChunkHasher(u64);

impl Hasher for ChunkHasher {
    fn finish(&self) -> u64 {
        self.0 ^ (self.0 >> 32)
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

struct BitChunks {
    /// Chunk number → position in `words`.
    index: HashMap<u64, usize, BuildHasherDefault<ChunkHasher>>,
    words: Vec<Box<[u64]>>,
    min: u64,
    max: u64,
    /// The chunk of the previous insert; ids usually arrive in runs.
    last: Option<(u64, usize)>,
    distinct: u64,
}

impl BitChunks {
    fn new() -> Self {
        Self { index: HashMap::default(), words: Vec::new(), min: u64::MAX, max: 0, last: None, distinct: 0 }
    }

    /// `false` when the id's chunk does not fit the dense table or the bitmap budget; the id is
    /// then not recorded and the caller moves to plain ids.
    fn insert(&mut self, id: u64) -> bool {
        let slot = id >> SLOT_SHIFT;
        let chunk = slot >> CHUNK_SLOT_BITS;
        let at = match self.last {
            Some((c, at)) if c == chunk => at,
            _ => match self.index.get(&chunk) {
                Some(&at) => at,
                None => {
                    let (min, max) = (self.min.min(chunk), self.max.max(chunk));
                    let bitmap_bytes = (self.words.len() as u64 + 1) * CHUNK_BYTES;
                    if self.words.len() >= MAX_CHUNKS
                        || max - min >= MAX_CHUNK_SPAN
                        || bitmap_bytes > BITMAP_BASE_BYTES + BITMAP_BYTES_PER_ID * self.distinct
                    {
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
        let word = &mut self.words[at][(slot >> 6) as usize % WORDS_PER_CHUNK];
        let bit = 1u64 << (slot & 63);
        if *word & bit == 0 {
            *word |= bit;
            self.distinct += 1;
        }
        true
    }

    /// `(chunk number, position in words)` in ascending address order.
    fn sorted_chunks(&self) -> Vec<(u64, usize)> {
        let mut chunks: Vec<_> = self.index.iter().map(|(&chunk, &at)| (chunk, at)).collect();
        chunks.sort_unstable();
        chunks
    }

    /// The recorded ids, ascending.
    fn ids(&self) -> BitIds<'_> {
        BitIds { chunks: self.sorted_chunks(), words: &self.words, chunk: 0, word: 0, base: 0, rest: 0 }
    }
}

struct BitIds<'a> {
    chunks: Vec<(u64, usize)>,
    words: &'a [Box<[u64]>],
    chunk: usize,
    word: usize,
    /// Slot number of bit 0 of the word `rest` came from.
    base: u64,
    rest: u64,
}

impl Iterator for BitIds<'_> {
    type Item = u64;

    fn next(&mut self) -> Option<u64> {
        loop {
            if self.rest != 0 {
                let bit = u64::from(self.rest.trailing_zeros());
                self.rest &= self.rest - 1;
                return Some((self.base + bit) << SLOT_SHIFT);
            }
            let &(chunk, at) = self.chunks.get(self.chunk)?;
            self.rest = self.words[at][self.word];
            self.base = (chunk << CHUNK_SLOT_BITS) + self.word as u64 * WORD_BITS;
            self.word += 1;
            if self.word == WORDS_PER_CHUNK {
                self.word = 0;
                self.chunk += 1;
            }
        }
    }
}

pub struct IdMapBuilder {
    bits: BitChunks,
    /// Set once an id cannot go into `bits`; every later id goes here, and `bits` keeps what it
    /// had. Unsorted, with duplicates.
    plain: Option<Vec<u64>>,
    max_ids: u64,
}

impl Default for IdMapBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl IdMapBuilder {
    pub fn new() -> Self {
        Self::with_limit(MAX_IDS)
    }

    /// `max_ids` is a parameter so tests can reach the too-large path without billions of inserts.
    fn with_limit(max_ids: u64) -> Self {
        Self { bits: BitChunks::new(), plain: None, max_ids }
    }

    /// Inserting an id twice is the same as once.
    pub fn insert(&mut self, id: u64) {
        match &mut self.plain {
            Some(plain) => plain.push(id),
            None => {
                if id & 7 != 0 || !self.bits.insert(id) {
                    self.plain = Some(vec![id]);
                }
            }
        }
    }

    /// Fails with [`HeapError::TooLarge`] when there are more than `u32::MAX - 2` distinct ids,
    /// and with [`HeapError::Cancelled`] when `cancel` fires (checked at least every `1 << 20`
    /// steps).
    pub fn build(self, store: &Store, cancel: &CancellationToken) -> Result<IdMap, HeapError> {
        match self.plain {
            None if self.bits.words.is_empty() => sorted_map(store, &[]),
            None => bit_map(&self.bits, store, self.max_ids, cancel),
            Some(plain) => merged_map(&self.bits, plain, store, self.max_ids, cancel),
        }
    }

    #[cfg(test)]
    fn allocated_bytes(&self) -> u64 {
        self.bits.words.len() as u64 * CHUNK_BYTES
            + self.plain.as_ref().map_or(0, |p| (p.capacity() * size_of::<u64>()) as u64)
    }
}

fn check(cancel: &CancellationToken) -> Result<(), HeapError> {
    if cancel.is_cancelled() { Err(HeapError::Cancelled) } else { Ok(()) }
}

fn sorted_map(store: &Store, ids: &[u64]) -> Result<IdMap, HeapError> {
    let mut column = store.column(SORTED_FILE, ids.len(), 0u64)?;
    column.copy_from_slice(ids);
    Ok(IdMap { repr: Repr::Sorted(column) })
}

fn bit_map(bits: &BitChunks, store: &Store, max_ids: u64, cancel: &CancellationToken) -> Result<IdMap, HeapError> {
    if bits.distinct > max_ids {
        return Err(HeapError::TooLarge);
    }
    let chunks = bits.sorted_chunks();
    let span = (bits.max - bits.min + 1) as usize;
    let mut words = store.column(BITS_FILE, chunks.len() * WORDS_PER_CHUNK, 0u64)?;
    let mut wrank = store.column(WRANK_FILE, chunks.len() * WORDS_PER_CHUNK, 0u32)?;
    let mut table = store.column(TABLE_FILE, span, NONE)?;
    let mut chunk_offsets = store.column(CHUNKS_FILE, chunks.len(), 0u32)?;
    let mut before = 0u32;
    for (ordinal, &(chunk, at)) in chunks.iter().enumerate() {
        check(cancel)?;
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
    Ok(IdMap { repr: Repr::Bits { min_chunk: bits.min, words, wrank, table, chunk_offsets, len: before } })
}

enum Source<'a> {
    Bits(BitIds<'a>),
    Run(std::iter::Copied<std::slice::Iter<'a, u64>>),
}

impl Iterator for Source<'_> {
    type Item = u64;

    fn next(&mut self) -> Option<u64> {
        match self {
            Source::Bits(it) => it.next(),
            Source::Run(it) => it.next(),
        }
    }
}

/// Sorts `plain` in runs and merges the runs with the ids already in `bits` (itself a sorted
/// source), dropping duplicates. A single `sort_unstable` of a very large vector could not be
/// interrupted.
fn merged_map(
    bits: &BitChunks,
    mut plain: Vec<u64>,
    store: &Store,
    max_ids: u64,
    cancel: &CancellationToken,
) -> Result<IdMap, HeapError> {
    for run in plain.chunks_mut(CHECK_EVERY) {
        check(cancel)?;
        run.sort_unstable();
    }
    let mut sources = vec![Source::Bits(bits.ids())];
    sources.extend(plain.chunks(CHECK_EVERY).map(|run| Source::Run(run.iter().copied())));
    let mut heap = BinaryHeap::with_capacity(sources.len());
    for (i, source) in sources.iter_mut().enumerate() {
        if let Some(id) = source.next() {
            heap.push(Reverse((id, i)));
        }
    }

    let upper_bound = bits.distinct as usize + plain.len();
    let mut merged = store.scratch::<u64>(upper_bound, 0)?;
    let mut count = 0usize;
    let mut steps = 0usize;
    while let Some(Reverse((id, i))) = heap.pop() {
        steps += 1;
        if steps.is_multiple_of(CHECK_EVERY) {
            check(cancel)?;
        }
        if let Some(next) = sources[i].next() {
            heap.push(Reverse((next, i)));
        }
        if count > 0 && merged[count - 1] == id {
            continue;
        }
        if count as u64 >= max_ids {
            return Err(HeapError::TooLarge);
        }
        merged[count] = id;
        count += 1;
    }

    let mut column = store.column(SORTED_FILE, count, 0u64)?;
    for (to, from) in column.chunks_mut(CHECK_EVERY).zip(merged[..count].chunks(CHECK_EVERY)) {
        check(cancel)?;
        to.copy_from_slice(from);
    }
    Ok(IdMap { repr: Repr::Sorted(column) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_all(builder: &mut IdMapBuilder, ids: &[u64]) {
        for &id in ids {
            builder.insert(id);
        }
    }

    #[test]
    fn too_many_ids_is_too_large() {
        // Dense layout, then the merged layout (one unaligned id); the duplicate does not count.
        for unaligned in [false, true] {
            let filled = |limit| {
                let mut builder = IdMapBuilder::with_limit(limit);
                insert_all(&mut builder, &[0x1000, 0x1008, 0x1010, 0x1010]);
                if unaligned {
                    builder.insert(0x1_0004);
                }
                builder
            };
            let distinct = if unaligned { 4 } else { 3 };
            let map = filled(distinct).build(&Store::Ram, &CancellationToken::new()).unwrap();
            assert_eq!(u64::from(map.len()), distinct);
            let err = filled(distinct - 1).build(&Store::Ram, &CancellationToken::new()).err().unwrap();
            assert!(matches!(err, HeapError::TooLarge), "{err}");
        }
    }

    #[test]
    fn cancelled_build_returns_cancelled() {
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let mut dense = IdMapBuilder::new();
        insert_all(&mut dense, &[0x1000, 0x1008, 0x20_0000]);
        assert!(matches!(dense.build(&Store::Ram, &cancelled), Err(HeapError::Cancelled)));

        let mut merged = IdMapBuilder::new();
        insert_all(&mut merged, &[0x1000, 0x1004, 0x20_0000]);
        assert!(matches!(merged.build(&Store::Ram, &cancelled), Err(HeapError::Cancelled)));

        let mut ok = IdMapBuilder::new();
        insert_all(&mut ok, &[0x1000, 0x1004]);
        assert_eq!(ok.build(&Store::Ram, &CancellationToken::new()).unwrap().len(), 2);
    }

    #[test]
    fn sparse_ids_do_not_amplify_builder_memory() {
        const IDS: u64 = 2_000_000;
        let mut builder = IdMapBuilder::new();
        let mut peak = 0;
        for i in 0..IDS {
            builder.insert(0x1_0000_0000 + (i << 20));
            if i % 1024 == 0 {
                peak = peak.max(builder.allocated_bytes());
            }
        }
        peak = peak.max(builder.allocated_bytes());
        // Bitmaps up to the budget, plus the plain ids' vector, which may have doubled its capacity.
        let budget = BITMAP_BASE_BYTES + (BITMAP_BYTES_PER_ID + 2 * size_of::<u64>() as u64) * IDS;
        assert!(peak <= budget, "peak {peak} bytes, budget {budget}");
        // One bitmap per id would have taken 16 KiB each.
        assert!(peak < IDS * CHUNK_BYTES / 100, "peak {peak} bytes");
        assert!(builder.plain.is_some(), "sparse input must have left the bitmaps");

        let map = builder.build(&Store::Ram, &CancellationToken::new()).unwrap();
        assert_eq!(map.len() as u64, IDS);
        assert_eq!(map.rank(0x1_0000_0000 + (1_234_567 << 20)), Some(1_234_567));
        assert_eq!(map.rank(0x1_0000_0000 + (1_234_567 << 20) + 8), None);
    }

    #[test]
    fn dense_input_in_any_order_stays_in_bitmaps() {
        // 4 GiB of address space is the base allowance; random order must not trip the budget.
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut builder = IdMapBuilder::new();
        for _ in 0..300_000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            builder.insert((0x7_0000_0000 + (state % (4 << 30))) & !7);
        }
        assert!(builder.plain.is_none());
        assert!(builder.allocated_bytes() <= BITMAP_BASE_BYTES);
    }

    #[test]
    fn chunk_hasher_spreads_chunks_that_share_low_zero_bits() {
        let buckets: std::collections::HashSet<u64> = (0..1024u64)
            .map(|i| {
                let mut hasher = ChunkHasher::default();
                hasher.write_u64(i << 12);
                hasher.finish() & 1023
            })
            .collect();
        assert!(buckets.len() > 500, "{} buckets for 1024 keys", buckets.len());
    }
}
