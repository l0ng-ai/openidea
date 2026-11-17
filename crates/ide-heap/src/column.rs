//! Fixed-width arrays that live in RAM or in memory-mapped files, so the analysis arrays of a
//! large heap do not count against the process's anonymous memory.

use std::fs::{File, OpenOptions};
use std::io;
use std::marker::PhantomData;
use std::mem::size_of;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};

use memmap2::{Mmap, MmapMut};

/// Index value meaning "no object" in every `u32` column.
pub const NONE: u32 = u32::MAX;

/// # Safety
/// Every bit pattern of `Self` is a valid value and `Self` has no padding, so a mapped file's
/// bytes can be viewed as `[Self]` and a file can be written from one.
pub unsafe trait Pod: Copy + 'static {}

unsafe impl Pod for u8 {}
unsafe impl Pod for u32 {}
unsafe impl Pod for u64 {}

enum Backing<T> {
    Ram(Vec<T>),
    Map(MmapMut),
    ReadOnly(Mmap),
}

/// A fixed-length array of `T`. File contents use the machine's byte order: the arrays are a
/// cache for this machine and are never moved to another one.
pub struct Column<T: Pod> {
    backing: Backing<T>,
    /// Scratch file to delete on drop where it could not be unlinked while mapped.
    delete_on_drop: Option<PathBuf>,
    _marker: PhantomData<T>,
}

fn byte_len<T: Pod>(len: usize) -> io::Result<usize> {
    len.checked_mul(size_of::<T>())
        .filter(|&bytes| bytes <= isize::MAX as usize)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "column is too long"))
}

fn is_zero<T: Pod>(value: &T) -> bool {
    // SAFETY: `Pod` types have no padding, so all `size_of::<T>()` bytes are initialized.
    let bytes = unsafe { std::slice::from_raw_parts((value as *const T).cast::<u8>(), size_of::<T>()) };
    bytes.iter().all(|&b| b == 0)
}

impl<T: Pod> Column<T> {
    fn new(backing: Backing<T>, delete_on_drop: Option<PathBuf>) -> Self {
        Self { backing, delete_on_drop, _marker: PhantomData }
    }

    pub fn ram(len: usize, fill: T) -> Self {
        Self::new(Backing::Ram(vec![fill; len]), None)
    }

    /// Creates (or truncates) `path` and maps it; the file stays after the column is dropped.
    pub fn file(path: &Path, len: usize, fill: T) -> io::Result<Self> {
        let bytes = byte_len::<T>(len)?;
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path)?;
        match Self::map_new(&file, len, bytes, fill) {
            Ok(column) => Ok(column),
            Err(err) => {
                drop(file);
                let _ = std::fs::remove_file(path);
                Err(err)
            }
        }
    }

    /// A temporary column in `dir` that never outlives the process. On unix the file is unlinked
    /// right after mapping, so even a crash leaves nothing behind; elsewhere (Windows cannot delete
    /// a mapped file) it is deleted on drop.
    pub fn scratch(dir: &Path, len: usize, fill: T) -> io::Result<Self> {
        let bytes = byte_len::<T>(len)?;
        if bytes == 0 {
            return Ok(Self::ram(0, fill));
        }
        let path = dir.join(format!("scratch-{}.tmp", uuid::Uuid::new_v4().simple()));
        let file = OpenOptions::new().read(true).write(true).create_new(true).open(&path)?;
        let mut column = match Self::map_new(&file, len, bytes, fill) {
            Ok(column) => column,
            Err(err) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(err);
            }
        };
        // If the unlink fails the drop-time delete is the fallback, so the file is never left behind.
        if !cfg!(unix) || std::fs::remove_file(&path).is_err() {
            column.delete_on_drop = Some(path);
        }
        Ok(column)
    }

    /// Maps an existing file read-only; writing through the column panics.
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let bytes = file.metadata()?.len();
        if bytes % size_of::<T>() as u64 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} is {bytes} bytes, not a multiple of {}", path.display(), size_of::<T>()),
            ));
        }
        if bytes == 0 {
            return Ok(Self::ram(0, zero_value()));
        }
        // SAFETY: the file is private to the snapshot directory; nothing truncates it while mapped.
        let map = unsafe { Mmap::map(&file)? };
        Ok(Self::new(Backing::ReadOnly(map), None))
    }

    fn map_new(file: &File, len: usize, bytes: usize, fill: T) -> io::Result<Self> {
        if bytes == 0 {
            return Ok(Self::ram(0, fill));
        }
        file.set_len(bytes as u64)?;
        // SAFETY: as in `open`; the file was just created by this process.
        let map = unsafe { MmapMut::map_mut(file)? };
        let mut column = Self::new(Backing::Map(map), None);
        // A fresh file reads as zeros, and writing a zero fill would fault in every page.
        if !is_zero(&fill) {
            debug_assert_eq!(column.len(), len);
            column.fill(fill);
        }
        Ok(column)
    }
}

fn zero_value<T: Pod>() -> T {
    // SAFETY: every bit pattern of a `Pod` type is a valid value.
    unsafe { std::mem::zeroed() }
}

impl<T: Pod> Deref for Column<T> {
    type Target = [T];

    fn deref(&self) -> &[T] {
        match &self.backing {
            Backing::Ram(v) => v,
            // SAFETY: maps are page-aligned, `T` is `Pod` and the length is a multiple of its width.
            Backing::Map(m) => unsafe { std::slice::from_raw_parts(m.as_ptr().cast(), m.len() / size_of::<T>()) },
            Backing::ReadOnly(m) => unsafe { std::slice::from_raw_parts(m.as_ptr().cast(), m.len() / size_of::<T>()) },
        }
    }
}

impl<T: Pod> DerefMut for Column<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        match &mut self.backing {
            Backing::Ram(v) => v,
            // SAFETY: as in `deref`; `&mut self` makes the access exclusive.
            Backing::Map(m) => unsafe {
                std::slice::from_raw_parts_mut(m.as_mut_ptr().cast(), m.len() / size_of::<T>())
            },
            Backing::ReadOnly(_) => panic!("column opened from a file is read-only"),
        }
    }
}

impl<T: Pod> Drop for Column<T> {
    fn drop(&mut self) {
        if let Some(path) = self.delete_on_drop.take() {
            // Unmap before deleting: Windows refuses to delete a mapped file.
            self.backing = Backing::Ram(Vec::new());
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Where a computation puts its arrays: result columns are named files in `Dir`, temporary arrays
/// are scratch columns in the same directory.
pub enum Store {
    Ram,
    Dir(PathBuf),
}

impl Store {
    /// `name` is the whole file name (`types.u32`); it is used as given.
    pub fn column<T: Pod>(&self, name: &str, len: usize, fill: T) -> io::Result<Column<T>> {
        match self {
            Store::Ram => Ok(Column::ram(len, fill)),
            Store::Dir(dir) => Column::file(&dir.join(name), len, fill),
        }
    }

    pub fn scratch<T: Pod>(&self, len: usize, fill: T) -> io::Result<Column<T>> {
        match self {
            Store::Ram => Ok(Column::ram(len, fill)),
            Store::Dir(dir) => Column::scratch(dir, len, fill),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_is_empty(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().next().is_none()
    }

    #[test]
    fn file_column_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.u32");
        {
            let mut col = Column::<u32>::file(&path, 4, 7).unwrap();
            assert_eq!(&*col, &[7, 7, 7, 7]);
            col.copy_from_slice(&[1, 2, 3, 4]);
        }
        let col = Column::<u32>::open(&path).unwrap();
        assert_eq!(&*col, &[1, 2, 3, 4]);
    }

    #[test]
    fn scratch_column_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut col = Column::<u64>::scratch(dir.path(), 1024, 9).unwrap();
            col[1023] = 5;
            assert_eq!((col[0], col[1023]), (9, 5));
            // Windows cannot delete a mapped file, so only unix unlinks while the map is alive.
            #[cfg(unix)]
            assert!(dir_is_empty(dir.path()));
        }
        assert!(dir_is_empty(dir.path()));
    }

    #[test]
    fn zero_fill_and_non_zero_fill() {
        let dir = tempfile::tempdir().unwrap();
        let zeros = Column::<u64>::file(&dir.path().join("z.u64"), 3000, 0).unwrap();
        assert!(zeros.iter().all(|&v| v == 0));
        let ones = Column::<u8>::file(&dir.path().join("o.u8"), 10_000, 0xAB).unwrap();
        assert!(ones.iter().all(|&v| v == 0xAB));
        let ram = Column::<u32>::ram(5, NONE);
        assert_eq!(&*ram, &[NONE; 5]);
    }

    #[test]
    fn empty_columns_work_everywhere() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e.u32");
        assert_eq!(Column::<u32>::ram(0, 1).len(), 0);
        assert_eq!(Column::<u32>::file(&path, 0, 1).unwrap().len(), 0);
        assert_eq!(Column::<u32>::open(&path).unwrap().len(), 0);
        assert_eq!(Column::<u32>::scratch(dir.path(), 0, 1).unwrap().len(), 0);
    }

    #[test]
    fn open_rejects_a_length_that_is_not_a_multiple_of_the_width() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("odd.u32");
        std::fs::write(&path, [0u8; 6]).unwrap();
        let err = Column::<u32>::open(&path).err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn file_rejects_a_byte_length_that_overflows() {
        let dir = tempfile::tempdir().unwrap();
        let err = Column::<u64>::file(&dir.path().join("big.u64"), usize::MAX, 0).err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(dir_is_empty(dir.path()));
    }

    #[test]
    #[should_panic(expected = "read-only")]
    fn opened_columns_are_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.u32");
        drop(Column::<u32>::file(&path, 2, 0).unwrap());
        let mut col = Column::<u32>::open(&path).unwrap();
        col[0] = 1;
    }

    #[test]
    fn store_names_files_exactly_as_given() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::Dir(dir.path().to_path_buf());
        let mut col = store.column::<u32>("types.u32", 3, 0).unwrap();
        col[2] = 8;
        drop(col);
        let names: Vec<_> =
            std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names, ["types.u32"]);
        assert_eq!(&*Column::<u32>::open(&dir.path().join("types.u32")).unwrap(), &[0, 0, 8]);
    }

    #[test]
    fn store_scratch_is_anonymous_and_ram_store_touches_no_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::Dir(dir.path().to_path_buf());
        drop(store.scratch::<u32>(16, 1).unwrap());
        assert!(dir_is_empty(dir.path()));
        let ram = Store::Ram.column::<u8>("ignored.u8", 4, 2).unwrap();
        assert_eq!(&*ram, &[2; 4]);
        assert_eq!(&*Store::Ram.scratch::<u8>(2, 3).unwrap(), &[3, 3]);
    }
}
