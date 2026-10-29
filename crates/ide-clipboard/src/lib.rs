//! The file list on the OS clipboard: what Explorer copies when the user
//! copies files, so the project view can paste them, and what the project view
//! writes so Explorer can paste the files it copied (IDEA does both).
//!
//! Windows keeps it as `CF_HDROP`: a `DROPFILES` header and a double-NUL
//! terminated list of absolute paths, wide when `fWide` is set. The data is set
//! in full rather than rendered on demand, so no window or message loop is
//! needed and the list survives after `CloseClipboard`.
//!
//! macOS keeps one `public.file-url` item per file on the general
//! `NSPasteboard`; `NSURL` reads and writes them, so Finder's copies paste here
//! and ours paste in Finder.
//!
//! Other platforms (`text/uri-list` on X11) are not wired up: [`files`] is
//! empty and [`set_files`] fails there.

use std::path::PathBuf;

/// Size of `DROPFILES`: `pFiles`, `pt` (two `LONG`s), `fNC`, `fWide`.
const HEADER: usize = 20;

/// The absolute paths on the clipboard, empty when it holds no file list.
pub fn files() -> Vec<PathBuf> {
    imp::files()
}

/// Whether the clipboard holds a file list, without reading it.
pub fn has_files() -> bool {
    imp::has_files()
}

/// Replaces the clipboard with `paths`. False when it is busy or holds nothing
/// to write; the clipboard is a shared resource, so callers treat this as
/// best-effort.
pub fn set_files(paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return false;
    }
    imp::set_files(paths)
}

/// `DROPFILES` for `paths`, in the wide form so names outside the ANSI code
/// page survive. Empty paths are skipped.
pub fn encode(paths: &[PathBuf]) -> Vec<u8> {
    let mut units: Vec<u16> = Vec::new();
    for path in paths {
        let path = path.to_string_lossy();
        if path.is_empty() {
            continue;
        }
        units.extend(path.encode_utf16());
        units.push(0);
    }
    // The list ends with an empty string: with one path, two NULs in a row.
    units.push(0);
    let mut out = Vec::with_capacity(HEADER + units.len() * 2);
    out.extend_from_slice(&(HEADER as u32).to_le_bytes()); // pFiles: list starts after the header
    out.extend_from_slice(&[0u8; 8]); // pt: the drop point, unused
    out.extend_from_slice(&0u32.to_le_bytes()); // fNC: not a file manager drop
    out.extend_from_slice(&1u32.to_le_bytes()); // fWide: UTF-16 paths
    for unit in units {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// The paths of a `DROPFILES` block, stopping at the empty string that ends the
/// list. An ANSI list (pre-Unicode writers) is decoded as UTF-8, lossily.
pub fn decode(bytes: &[u8]) -> Vec<PathBuf> {
    if bytes.len() < HEADER {
        return Vec::new();
    }
    let offset = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let wide = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) != 0;
    if offset >= bytes.len() {
        return Vec::new();
    }
    let body = &bytes[offset..];
    let mut out = Vec::new();
    if wide {
        let mut current: Vec<u16> = Vec::new();
        for chunk in body.as_chunks::<2>().0 {
            let unit = u16::from_le_bytes(*chunk);
            if unit != 0 {
                current.push(unit);
            } else if current.is_empty() {
                break;
            } else {
                out.push(PathBuf::from(String::from_utf16_lossy(&current)));
                current.clear();
            }
        }
    } else {
        for part in body.split(|b| *b == 0) {
            if part.is_empty() {
                break;
            }
            out.push(PathBuf::from(String::from_utf8_lossy(part).into_owned()));
        }
    }
    out
}

#[cfg(windows)]
mod imp {
    use super::{HEADER, decode, encode};
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::ptr;
    use std::time::Duration;

    /// `CF_HDROP`, the clipboard format holding a file list.
    const CF_HDROP: u32 = 15;

    /// An `HGLOBAL` or a `HANDLE`: both are opaque pointers here.
    type Handle = *mut c_void;

    const GMEM_MOVEABLE: u32 = 0x0002;
    /// Another process holds the clipboard only while it copies; retrying beats
    /// reporting "no files" for a paste the user just made.
    const OPEN_ATTEMPTS: usize = 10;
    const OPEN_RETRY: Duration = Duration::from_millis(20);

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(owner: Handle) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn GetClipboardData(format: u32) -> Handle;
        fn SetClipboardData(format: u32, memory: Handle) -> Handle;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        fn GlobalLock(memory: Handle) -> *mut c_void;
        fn GlobalUnlock(memory: Handle) -> i32;
        fn GlobalFree(memory: Handle) -> Handle;
        fn GlobalSize(memory: Handle) -> usize;
    }

    /// Opens the clipboard as its owner: the list is written in full, so no
    /// owning window is needed.
    fn open() -> bool {
        for _ in 0..OPEN_ATTEMPTS {
            if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
                return true;
            }
            std::thread::sleep(OPEN_RETRY);
        }
        false
    }

    pub fn has_files() -> bool {
        (unsafe { IsClipboardFormatAvailable(CF_HDROP) }) != 0
    }

    pub fn files() -> Vec<PathBuf> {
        if !has_files() || !open() {
            return Vec::new();
        }
        let memory = unsafe { GetClipboardData(CF_HDROP) };
        let paths = if memory.is_null() {
            Vec::new()
        } else {
            // SAFETY: the clipboard keeps the block alive while it is open, and
            // `GlobalSize` bounds the bytes read from it.
            unsafe {
                let data = GlobalLock(memory);
                if data.is_null() {
                    Vec::new()
                } else {
                    let bytes = std::slice::from_raw_parts(data as *const u8, GlobalSize(memory));
                    let paths = decode(bytes);
                    GlobalUnlock(memory);
                    paths
                }
            }
        };
        unsafe { CloseClipboard() };
        paths
    }

    pub fn set_files(paths: &[PathBuf]) -> bool {
        let bytes = encode(paths);
        if bytes.len() <= HEADER {
            return false;
        }
        // SAFETY: the block is allocated, filled, handed to the clipboard and
        // freed only on the paths where the clipboard did not take ownership.
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            if memory.is_null() {
                return false;
            }
            let data = GlobalLock(memory);
            if data.is_null() {
                GlobalFree(memory);
                return false;
            }
            ptr::copy_nonoverlapping(bytes.as_ptr(), data as *mut u8, bytes.len());
            GlobalUnlock(memory);
            if !open() {
                GlobalFree(memory);
                return false;
            }
            // Replacing the list also drops the text the user copied before.
            if EmptyClipboard() == 0 {
                CloseClipboard();
                GlobalFree(memory);
                return false;
            }
            let taken = !SetClipboardData(CF_HDROP, memory).is_null();
            CloseClipboard();
            if !taken {
                GlobalFree(memory);
            }
            taken
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::ClassType;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyClass, AnyObject, ProtocolObject};
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardReadingOptionKey, NSPasteboardURLReadingFileURLsOnlyKey, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSURL};
    use std::path::PathBuf;

    /// `NSURL` as the one class to read, limited to file URLs: a web link the
    /// user copied is not a file to paste.
    fn read_file_urls<R>(
        f: impl FnOnce(&NSPasteboard, &NSArray<AnyClass>, &NSDictionary<NSPasteboardReadingOptionKey, AnyObject>) -> R,
    ) -> R {
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            let classes = NSArray::from_slice(&[NSURL::class()]);
            let yes = NSNumber::new_bool(true);
            // SAFETY: the key is an AppKit constant, valid for the process' lifetime.
            let key = unsafe { NSPasteboardURLReadingFileURLsOnlyKey };
            let options = NSDictionary::from_slices(&[key], &[yes.as_ref() as &AnyObject]);
            f(&board, &classes, &options)
        })
    }

    pub fn has_files() -> bool {
        // SAFETY: the class list holds `NSURL`, which reads from pasteboards,
        // and the option takes an `NSNumber`.
        read_file_urls(|board, classes, options| unsafe {
            board.canReadObjectForClasses_options(classes, Some(options))
        })
    }

    pub fn files() -> Vec<PathBuf> {
        read_file_urls(|board, classes, options| {
            // SAFETY: as in `has_files`; every object read for `NSURL` is one.
            let Some(objects) = (unsafe { board.readObjectsForClasses_options(classes, Some(options)) }) else {
                return Vec::new();
            };
            objects
                .iter()
                .filter_map(|object| object.downcast::<NSURL>().ok())
                .filter_map(|url| url.to_file_path())
                // Finder ends a folder's URL in `/`; the project view names it without.
                .map(|path| path.components().collect())
                .collect()
        })
    }

    pub fn set_files(paths: &[PathBuf]) -> bool {
        autoreleasepool(|_| {
            // Folders get a directory URL (ending in `/`), as Finder writes them.
            let urls: Vec<Retained<NSURL>> = paths
                .iter()
                .filter_map(|p| if p.is_dir() { NSURL::from_directory_path(p) } else { NSURL::from_file_path(p) })
                .collect();
            if urls.is_empty() {
                return false;
            }
            let writers: Vec<&ProtocolObject<dyn NSPasteboardWriting>> =
                urls.iter().map(|url| ProtocolObject::from_ref(&**url)).collect();
            let board = NSPasteboard::generalPasteboard();
            // Replacing the list also drops the text the user copied before.
            board.clearContents();
            board.writeObjects(&NSArray::from_slice(&writers))
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use std::path::PathBuf;

    pub fn has_files() -> bool {
        false
    }

    pub fn files() -> Vec<PathBuf> {
        Vec::new()
    }

    pub fn set_files(_paths: &[PathBuf]) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn a_written_list_reads_back_unchanged() {
        let list = paths(&["C:/work/project/a.txt", "C:/work/project/sub"]);
        assert_eq!(decode(&encode(&list)), list);
    }

    #[test]
    fn the_header_says_where_the_paths_start_and_that_they_are_wide() {
        let bytes = encode(&paths(&["C:/a"]));
        assert_eq!(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]), HEADER as u32);
        assert_eq!(u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]), 1);
        // `C:/a` plus its NUL, then the empty string that ends the list.
        assert_eq!(bytes.len(), HEADER + (4 + 1 + 1) * 2);
        assert_eq!(&bytes[HEADER + 6..HEADER + 8], b"a\0");
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
    }

    #[test]
    fn names_outside_the_ansi_code_page_survive() {
        let list = paths(&["C:/工作/文档/测试.txt", "C:/a/"]);
        assert_eq!(decode(&encode(&list)), list);
    }

    #[test]
    fn an_empty_list_has_no_paths() {
        assert_eq!(decode(&encode(&[])), Vec::<PathBuf>::new());
        // A lone terminator is enough for the reader to stop.
        assert_eq!(decode(&[0u8; HEADER]), Vec::<PathBuf>::new());
    }

    #[test]
    fn a_truncated_or_foreign_block_reads_as_no_paths() {
        assert_eq!(decode(&[]), Vec::<PathBuf>::new());
        assert_eq!(decode(&[1, 2, 3]), Vec::<PathBuf>::new());
        let mut far = encode(&paths(&["C:/a"]));
        far[0] = 0xff; // pFiles past the end
        assert_eq!(decode(&far), Vec::<PathBuf>::new());
    }

    #[test]
    fn an_ansi_list_is_still_read_before_the_terminator() {
        let mut bytes = vec![0u8; HEADER];
        bytes[..4].copy_from_slice(&(HEADER as u32).to_le_bytes());
        bytes[16] = 0; // fWide: the list is single-byte
        bytes.extend_from_slice(b"C:\\a\\b.txt\0C:\\c\0\0");
        assert_eq!(decode(&bytes), paths(&["C:\\a\\b.txt", "C:\\c"]));
    }
}
