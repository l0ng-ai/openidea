/// Offsets (`at`) are byte positions in the `.hprof` file.
#[derive(Debug, thiserror::Error)]
pub enum HeapError {
    #[error("the dump ends early at byte {at}")]
    Truncated { at: u64 },
    #[error("not a heap dump (no JAVA PROFILE header)")]
    NotHprof,
    #[error("unsupported identifier size {0}")]
    UnsupportedIdSize(u32),
    #[error("unknown heap sub-record tag {tag:#04x} at byte {at}")]
    UnknownSubRecord { tag: u8, at: u64 },
    #[error("unknown value type {ty} at byte {at}")]
    UnknownType { ty: u8, at: u64 },
    #[error("class {id:#x} used at byte {at} is not in the dump")]
    MissingClass { id: u64, at: u64 },
    #[error("the heap has too many objects to analyze")]
    TooLarge,
    #[error("the dump's class and field names are too long; it is not a dump a JVM wrote")]
    NamesTooLarge,
    #[error("not enough disk space: {needed} bytes needed, {available} free")]
    NotEnoughDiskSpace { needed: u64, available: u64 },
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}
