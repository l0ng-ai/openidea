//! Names of the files an analysis writes into its index directory. They live in one list so a
//! failed analysis removes exactly these and never the dump or anything else sharing the directory.

pub(crate) const IDS_BITS_FILE: &str = "ids.bits.u64";
pub(crate) const IDS_WRANK_FILE: &str = "ids.wrank.u32";
pub(crate) const IDS_TABLE_FILE: &str = "ids.table.u32";
pub(crate) const IDS_CHUNKS_FILE: &str = "ids.chunks.u32";
pub(crate) const IDS_SORTED_FILE: &str = "ids.sorted.u64";
pub(crate) const TYPES_FILE: &str = "types.u32";
pub(crate) const OFFSETS_FILE: &str = "offsets.u64";
pub(crate) const IDOM_FILE: &str = "idom.u32";
pub(crate) const SHALLOW8_FILE: &str = "shallow8.u32";
pub(crate) const RETAINED_FILE: &str = "retained.u64";
pub(crate) const KIDS_START_FILE: &str = "kids_start.u32";
pub(crate) const KIDS_FILE: &str = "kids.u32";
pub(crate) const GC_PARENT_FILE: &str = "gc_parent.u32";
pub(crate) const SUMMARY_FILE: &str = "summary.json";

pub(crate) const INDEX_FILES: &[&str] = &[
    IDS_BITS_FILE,
    IDS_WRANK_FILE,
    IDS_TABLE_FILE,
    IDS_CHUNKS_FILE,
    IDS_SORTED_FILE,
    TYPES_FILE,
    OFFSETS_FILE,
    IDOM_FILE,
    SHALLOW8_FILE,
    RETAINED_FILE,
    KIDS_START_FILE,
    KIDS_FILE,
    GC_PARENT_FILE,
    SUMMARY_FILE,
];
