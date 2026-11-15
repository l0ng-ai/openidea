//! The file list on the OS clipboard: what Explorer copies when the user
//! copies files, so the project view can paste them, and what the project view
//! writes so Explorer can paste the files it copied (IDEA does both). The
//! written list comes with the file names as text, so a paste into an editor
//! inserts them instead of doing nothing (#1878).
//!
//! Windows keeps it as `CF_HDROP`: a `DROPFILES` header and a double-NUL
//! terminated list of absolute paths, wide when `fWide` is set. The data is set
//! in full rather than rendered on demand, so no window or message loop is
//! needed and the list survives after `CloseClipboard`.
//!
//! macOS keeps one `public.file-url` item per file on the general
//! `NSPasteboard`; `NSURL` reads and writes them, so Finder's copies paste here
//! and ours paste in Finder.
//! On macOS, [`files`], [`has_files`] and [`set_files`] must run on the main
//! thread: AppKit and WebKit also access the general pasteboard there, and its
//! mutable type cache cannot be protected by a mutex in this crate.
//!
//! Other platforms (`text/uri-list` on X11) are not wired up: [`files`] is
//! empty and [`set_files`] fails there.
//!
//! [`png`] reads an image (a screenshot) for the project view's Paste, which
//! saves it as a file: `public.png` or `public.tiff` on macOS, the registered
//! `PNG` format or `CF_DIB` on Windows. Linux reads it through GTK in the app.

use std::path::PathBuf;

/// Replaces every clipboard flavor with plain text. `owner` is the calling window
/// handle on Windows, ignored elsewhere. Call on the main thread on macOS and Linux.
pub fn set_text(text: &str, owner: usize) -> std::io::Result<()> {
    imp::set_text(text, owner)
}

/// The clipboard's plain text, None when it holds none. macOS only (main thread);
/// Linux reads it asynchronously through GTK in the app, Windows through the WebView.
#[cfg(target_os = "macos")]
pub fn text() -> Option<String> {
    imp::text()
}

/// The clipboard's image as PNG bytes, None when it holds none. Call on the main
/// thread on macOS.
#[cfg(any(windows, target_os = "macos"))]
pub fn png() -> Option<Vec<u8>> {
    imp::png()
}

/// Whether the clipboard holds an image, without reading it. Call on the main
/// thread on macOS and Linux.
pub fn has_image() -> bool {
    imp::has_image()
}

/// Size of `DROPFILES`: `pFiles`, `pt` (two `LONG`s), `fNC`, `fWide`.
const HEADER: usize = 20;

/// The absolute paths on the clipboard, empty when it holds no file list.
/// Read failures remain errors so callers can retain an internal copy.
pub fn files() -> std::io::Result<Vec<PathBuf>> {
    imp::files()
}

/// Whether the clipboard holds a file list, without reading it.
pub fn has_files() -> bool {
    imp::has_files()
}

/// Replaces the clipboard with `paths`. True only when the file list was
/// accepted; writing just the accompanying text is not a successful hand-off.
pub fn set_files(paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return false;
    }
    imp::set_files(paths)
}

/// The text flavor written beside the file list: the files' names, one per
/// line. An editor paste inserts names, not the absolute paths the file list
/// keeps for Explorer (#1878; IDEA's text flavor is names too). A path with no
/// file name (a root like `C:\`) keeps its whole path.
#[cfg(any(windows, target_os = "macos", test))]
fn names_text(paths: &[PathBuf], separator: &str) -> String {
    paths
        .iter()
        .map(|p| {
            p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>()
        .join(separator)
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

/// `BI_RGB` and `BI_BITFIELDS`: uncompressed pixels, the forms screenshots take.
#[cfg(any(windows, test))]
const BI_RGB: u32 = 0;
#[cfg(any(windows, test))]
const BI_BITFIELDS: u32 = 3;

/// A packed DIB (`BITMAPINFOHEADER` or a later header, then the pixels) as PNG.
/// Only 24- and 32-bit uncompressed bitmaps, which is what screenshots and
/// copied images are; None for anything else. A 32-bit bitmap whose alpha is
/// all zero (most writers leave it unset) is opaque.
#[cfg(any(windows, test))]
fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    let u32_at = |at: usize| dib.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let header = u32_at(0)? as usize;
    let width = u32_at(4)? as i32;
    let height = u32_at(8)? as i32;
    let bits = u16::from_le_bytes([*dib.get(14)?, *dib.get(15)?]);
    let compression = u32_at(16)?;
    if header < 40 || width <= 0 || height == 0 || !matches!(bits, 24 | 32) {
        return None;
    }
    if compression != BI_RGB && !(compression == BI_BITFIELDS && bits == 32) {
        return None;
    }
    // A `BITMAPINFOHEADER` keeps the three bitfield masks after it; later
    // headers hold them inside. Masks other than BGRA's are not supported.
    let masks = if compression == BI_BITFIELDS && header == 40 { 12 } else { 0 };
    let colors = u32_at(32)? as usize;
    let (width, rows) = (width as usize, height.unsigned_abs() as usize);
    let stride = (width * bits as usize).div_ceil(32) * 4;
    let start = header + masks + colors * 4;
    let pixels = dib.get(start..start.checked_add(stride.checked_mul(rows)?)?)?;
    let step = bits as usize / 8;
    let mut rgba = Vec::with_capacity(width * rows * 4);
    for row in 0..rows {
        // A positive height stores the bottom row first.
        let source = if height > 0 { rows - 1 - row } else { row };
        let line = &pixels[source * stride..source * stride + width * step];
        for px in line.chunks_exact(step) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], if step == 4 { px[3] } else { 255 }]);
        }
    }
    if step == 4 && rgba.as_chunks::<4>().0.iter().all(|px| px[3] == 0) {
        rgba.as_chunks_mut::<4>().0.iter_mut().for_each(|px| px[3] = 255);
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width as u32, rows as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
    Some(out)
}

#[cfg(windows)]
mod imp {
    use super::{HEADER, decode, dib_to_png, encode, names_text};
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::ptr;
    use std::time::Duration;

    /// `CF_HDROP`, the clipboard format holding a file list.
    const CF_HDROP: u32 = 15;
    /// `CF_UNICODETEXT`, so an editor paste of copied files inserts the paths.
    const CF_UNICODETEXT: u32 = 13;

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
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
    }

    /// `CF_DIB`: Windows synthesizes it from `CF_BITMAP` and `CF_DIBV5`, so every
    /// bitmap on the clipboard reads as one.
    const CF_DIB: u32 = 8;

    /// The `PNG` format browsers and the Snipping Tool add beside the bitmap; it
    /// keeps transparency, so it is read first.
    fn png_format() -> u32 {
        let name: Vec<u16> = "PNG\0".encode_utf16().collect();
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }

    pub fn has_image() -> bool {
        let png = png_format();
        (png != 0 && unsafe { IsClipboardFormatAvailable(png) } != 0)
            || unsafe { IsClipboardFormatAvailable(CF_DIB) } != 0
    }

    /// A copy of the clipboard's `format` block. Call with the clipboard open.
    fn read_block(format: u32) -> Option<Vec<u8>> {
        // SAFETY: the clipboard keeps the block alive while it is open, and
        // `GlobalSize` bounds the bytes read from it.
        unsafe {
            let memory = GetClipboardData(format);
            if memory.is_null() {
                return None;
            }
            let data = GlobalLock(memory);
            if data.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(data as *const u8, GlobalSize(memory)).to_vec();
            GlobalUnlock(memory);
            Some(bytes)
        }
    }

    pub fn png() -> Option<Vec<u8>> {
        if !open() {
            return None;
        }
        let png = png_format();
        let image = if png != 0 && unsafe { IsClipboardFormatAvailable(png) } != 0 {
            read_block(png)
        } else if unsafe { IsClipboardFormatAvailable(CF_DIB) } != 0 {
            read_block(CF_DIB).and_then(|dib| dib_to_png(&dib))
        } else {
            None
        };
        unsafe { CloseClipboard() };
        image
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
        open_for(ptr::null_mut())
    }

    fn open_for(owner: Handle) -> bool {
        for _ in 0..OPEN_ATTEMPTS {
            if unsafe { OpenClipboard(owner) } != 0 {
                return true;
            }
            std::thread::sleep(OPEN_RETRY);
        }
        false
    }

    pub fn has_files() -> bool {
        (unsafe { IsClipboardFormatAvailable(CF_HDROP) }) != 0
    }

    pub fn files() -> std::io::Result<Vec<PathBuf>> {
        if !open() {
            return Err(std::io::Error::last_os_error());
        }
        if !has_files() {
            unsafe { CloseClipboard() };
            return Ok(Vec::new());
        }
        let memory = unsafe { GetClipboardData(CF_HDROP) };
        let paths = if memory.is_null() {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: the clipboard keeps the block alive while it is open, and
            // `GlobalSize` bounds the bytes read from it.
            unsafe {
                let data = GlobalLock(memory);
                if data.is_null() {
                    Err(std::io::Error::last_os_error())
                } else {
                    let bytes = std::slice::from_raw_parts(data as *const u8, GlobalSize(memory));
                    let paths = decode(bytes);
                    GlobalUnlock(memory);
                    Ok(paths)
                }
            }
        };
        unsafe { CloseClipboard() };
        paths
    }

    /// An `HGLOBAL` holding `text` as UTF-16 with a terminating NUL, and its
    /// byte size. Null when the allocation failed.
    fn global_text(text: &str) -> (Handle, usize) {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        let bytes = units.len() * 2;
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if memory.is_null() {
                return (ptr::null_mut(), 0);
            }
            let data = GlobalLock(memory);
            if data.is_null() {
                GlobalFree(memory);
                return (ptr::null_mut(), 0);
            }
            ptr::copy_nonoverlapping(units.as_ptr() as *const u8, data as *mut u8, bytes);
            GlobalUnlock(memory);
            (memory, bytes)
        }
    }

    pub fn set_text(text: &str, owner: usize) -> std::io::Result<()> {
        let (memory, _) = global_text(text);
        if memory.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: ownership transfers only on success; otherwise we free the allocation.
        unsafe {
            if !open_for(owner as Handle) {
                GlobalFree(memory);
                return Err(std::io::Error::last_os_error());
            }
            let taken = EmptyClipboard() != 0 && !SetClipboardData(CF_UNICODETEXT, memory).is_null();
            let error = std::io::Error::last_os_error();
            CloseClipboard();
            if taken {
                Ok(())
            } else {
                GlobalFree(memory);
                Err(error)
            }
        }
    }

    pub fn set_files(paths: &[PathBuf]) -> bool {
        let bytes = encode(paths);
        if bytes.len() <= HEADER {
            return false;
        }
        // The file names as text: the file list keeps the absolute paths for
        // Explorer, while an editor paste inserts the names (#1878).
        let text = names_text(paths, "\r\n");
        // SAFETY: the blocks are allocated, filled, handed to the clipboard and
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
            // Replacing the list also drops the text the user copied before;
            // the file names are set back with it.
            if EmptyClipboard() == 0 {
                CloseClipboard();
                GlobalFree(memory);
                return false;
            }
            let taken = !SetClipboardData(CF_HDROP, memory).is_null();
            if !taken {
                GlobalFree(memory);
            }
            let (text_memory, _) = global_text(&text);
            if !text_memory.is_null() {
                // The text alone still pastes somewhere useful.
                let text_taken = !SetClipboardData(CF_UNICODETEXT, text_memory).is_null();
                if !text_taken {
                    GlobalFree(text_memory);
                }
            }
            CloseClipboard();
            taken
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyClass, AnyObject, ProtocolObject};
    use objc2::{ClassType, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardReadingOptionKey, NSPasteboardTypePNG,
        NSPasteboardTypeString, NSPasteboardTypeTIFF, NSPasteboardURLReadingFileURLsOnlyKey, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};
    use std::path::PathBuf;

    use super::names_text;

    /// `NSURL` as the one class to read, limited to file URLs: a web link the
    /// user copied is not a file to paste.
    fn read_file_urls<R>(
        f: impl FnOnce(&NSPasteboard, &NSArray<AnyClass>, &NSDictionary<NSPasteboardReadingOptionKey, AnyObject>) -> R,
    ) -> R {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
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

    pub fn files() -> std::io::Result<Vec<PathBuf>> {
        read_file_urls(|board, classes, options| {
            // SAFETY: as in `has_files`; every object read for `NSURL` is one.
            let Some(objects) = (unsafe { board.readObjectsForClasses_options(classes, Some(options)) }) else {
                return if unsafe { board.canReadObjectForClasses_options(classes, Some(options)) } {
                    Err(std::io::Error::other("Cannot read clipboard files"))
                } else {
                    Ok(Vec::new())
                };
            };
            Ok(objects
                .iter()
                .filter_map(|object| object.downcast::<NSURL>().ok())
                .filter_map(|url| url.to_file_path())
                // Finder ends a folder's URL in `/`; the project view names it without.
                .map(|path| path.components().collect())
                .collect())
        })
    }

    pub fn has_image() -> bool {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            // SAFETY: the types are AppKit constants, valid for the process' lifetime.
            let types = NSArray::from_slice(&[unsafe { NSPasteboardTypePNG }, unsafe { NSPasteboardTypeTIFF }]);
            NSPasteboard::generalPasteboard().availableTypeFromArray(&types).is_some()
        })
    }

    /// PNG as copied, else TIFF (what macOS screenshots and most apps write) converted.
    pub fn png() -> Option<Vec<u8>> {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            // SAFETY: the types are AppKit constants, valid for the process' lifetime.
            if let Some(png) = board.dataForType(unsafe { NSPasteboardTypePNG }) {
                return Some(png.to_vec());
            }
            let tiff = board.dataForType(unsafe { NSPasteboardTypeTIFF })?;
            let image = NSBitmapImageRep::imageRepWithData(&tiff)?;
            // SAFETY: an empty property dictionary is valid for every file type.
            let png =
                unsafe { image.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
            Some(png.to_vec())
        })
    }

    pub fn text() -> Option<String> {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            // SAFETY: the type is an AppKit constant, valid for the process' lifetime.
            NSPasteboard::generalPasteboard().stringForType(unsafe { NSPasteboardTypeString }).map(|s| s.to_string())
        })
    }

    pub fn set_text(text: &str, _owner: usize) -> std::io::Result<()> {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            board.clearContents();
            if board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
                Ok(())
            } else {
                Err(std::io::Error::other("Cannot write clipboard text"))
            }
        })
    }

    pub fn set_files(paths: &[PathBuf]) -> bool {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
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
            // Replacing the list also drops the text the user copied before;
            // the file names are set back as text, so an editor paste inserts
            // names, not paths (#1878).
            board.clearContents();
            let written = board.writeObjects(&NSArray::from_slice(&writers));
            let text = NSString::from_str(&names_text(paths, "\n"));
            board.setString_forType(&text, unsafe { NSPasteboardTypeString });
            written
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use std::path::PathBuf;

    pub fn set_text(text: &str, _owner: usize) -> std::io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).set_text(text);
            Ok(())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = text;
            Err(std::io::Error::other("Clipboard text is unavailable on this platform"))
        }
    }

    pub fn has_files() -> bool {
        false
    }

    pub fn has_image() -> bool {
        #[cfg(target_os = "linux")]
        {
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).wait_is_image_available()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    pub fn files() -> std::io::Result<Vec<PathBuf>> {
        Ok(Vec::new())
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
    fn the_text_flavor_is_the_file_names() {
        assert_eq!(names_text(&paths(&["C:/work/project/a.txt", "C:/work/project/sub"]), "\r\n"), "a.txt\r\nsub");
        // A path with no file name (the filesystem root) keeps its whole path.
        let root = PathBuf::from("/");
        assert!(root.file_name().is_none());
        assert_eq!(names_text(std::slice::from_ref(&root), "\n"), root.to_string_lossy());
    }

    #[test]
    fn an_ansi_list_is_still_read_before_the_terminator() {
        let mut bytes = vec![0u8; HEADER];
        bytes[..4].copy_from_slice(&(HEADER as u32).to_le_bytes());
        bytes[16] = 0; // fWide: the list is single-byte
        bytes.extend_from_slice(b"C:\\a\\b.txt\0C:\\c\0\0");
        assert_eq!(decode(&bytes), paths(&["C:\\a\\b.txt", "C:\\c"]));
    }

    /// A `BITMAPINFOHEADER` DIB of `width` × `height` (positive: bottom-up).
    fn dib(width: i32, height: i32, bits: u16, compression: u32, rows: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&bits.to_le_bytes());
        out.extend_from_slice(&compression.to_le_bytes());
        out.extend_from_slice(&[0u8; 20]);
        if compression == super::BI_BITFIELDS {
            for mask in [0x00ff_0000u32, 0x0000_ff00, 0x0000_00ff] {
                out.extend_from_slice(&mask.to_le_bytes());
            }
        }
        for row in rows {
            out.extend_from_slice(row);
        }
        out
    }

    fn decode_png(png: &[u8]) -> (u32, u32, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        (info.width, info.height, buf)
    }

    #[test]
    fn a_bottom_up_24_bit_bitmap_becomes_an_upright_opaque_png() {
        // Rows are padded to 4 bytes; the first stored row is the bottom one.
        let bottom: &[u8] = &[255, 0, 0, 0, 255, 0, 0, 0];
        let top: &[u8] = &[0, 0, 255, 255, 255, 255, 0, 0];
        let png = super::dib_to_png(&dib(2, 2, 24, super::BI_RGB, &[bottom, top])).unwrap();
        let (w, h, rgba) = decode_png(&png);
        assert_eq!((w, h), (2, 2));
        assert_eq!(rgba, [255, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn a_32_bit_bitmap_keeps_its_alpha_unless_none_was_written() {
        let row: &[u8] = &[10, 20, 30, 0, 40, 50, 60, 0];
        let (_, _, rgba) = decode_png(&super::dib_to_png(&dib(2, -1, 32, super::BI_BITFIELDS, &[row])).unwrap());
        assert_eq!(rgba, [30, 20, 10, 255, 60, 50, 40, 255]);
        let row: &[u8] = &[10, 20, 30, 128, 40, 50, 60, 0];
        let (_, _, rgba) = decode_png(&super::dib_to_png(&dib(2, -1, 32, super::BI_RGB, &[row])).unwrap());
        assert_eq!(rgba, [30, 20, 10, 128, 60, 50, 40, 0]);
    }

    #[test]
    fn unsupported_or_truncated_bitmaps_are_not_images() {
        let row: &[u8] = &[1, 2, 3, 4];
        assert!(super::dib_to_png(&dib(4, 1, 8, super::BI_RGB, &[row])).is_none());
        assert!(super::dib_to_png(&dib(2, 2, 24, super::BI_RGB, &[row])).is_none());
        assert!(super::dib_to_png(&[0; 10]).is_none());
    }
}
