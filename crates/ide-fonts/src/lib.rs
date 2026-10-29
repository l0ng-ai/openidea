//! The font families installed on this machine, for the font pickers in
//! Settings (editor, typography fallback, terminal, UI font).
//!
//! Each platform asks the font system the WebView itself resolves CSS
//! `font-family` names against, so every listed name renders: CoreText on
//! macOS, DirectWrite on Windows, fontconfig (`fc-list`) on Linux and the BSDs.
//! The list is read on first use and cached until explicitly refreshed; the
//! query can take a few hundred milliseconds, so callers run it off the UI and
//! command threads.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// One installed family. `monospaced` is the font system's own flag (fixed
/// pitch; on Linux also fontconfig's dual-width CJK monospace).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    pub monospaced: bool,
}

type Cache = Mutex<Option<Arc<[FontFamily]>>>;

/// The installed families, sorted case-insensitively, read on first use and
/// re-queried when `refresh` is true.
pub fn families(refresh: bool) -> Arc<[FontFamily]> {
    static CACHE: Cache = Mutex::new(None);
    cached(&CACHE, refresh, imp::list)
}

fn cached(cache: &Cache, refresh: bool, list: impl FnOnce(bool) -> Vec<(String, bool)>) -> Arc<[FontFamily]> {
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if !refresh && let Some(families) = guard.as_ref() {
        return Arc::clone(families);
    }
    let families: Arc<[FontFamily]> = normalize(list(refresh)).into();
    *guard = Some(Arc::clone(&families));
    families
}

/// Merges the per-face records a font system reports into one entry per
/// family: trimmed, without empty or hidden (`.`-prefixed system UI) names,
/// monospaced when any face is, sorted case-insensitively.
pub fn normalize(faces: impl IntoIterator<Item = (String, bool)>) -> Vec<FontFamily> {
    let mut by_key: BTreeMap<(String, String), bool> = BTreeMap::new();
    for (name, mono) in faces {
        let name = name.trim();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        *by_key.entry((name.to_lowercase(), name.to_owned())).or_default() |= mono;
    }
    let mut out: Vec<FontFamily> = Vec::with_capacity(by_key.len());
    for ((key, name), monospaced) in by_key {
        // Same family under two casings (one font file each): keep the first.
        if let Some(last) = out.last_mut()
            && last.name.to_lowercase() == key
        {
            last.monospaced |= monospaced;
            continue;
        }
        out.push(FontFamily { name, monospaced });
    }
    out
}

/// Parses `fc-list -f '%{family[0]}\t%{spacing}\n'`: one line per face, the
/// spacing empty (proportional) or fontconfig's number or name for it.
pub fn parse_fc_list(output: &str) -> Vec<(String, bool)> {
    output
        .lines()
        .filter_map(|line| {
            let (family, spacing) = line.split_once('\t').unwrap_or((line, ""));
            let family = family.replace("\\-", "-");
            let mono = match spacing.trim() {
                "dual" | "mono" | "charcell" => true,
                s => s.parse::<u32>().is_ok_and(|n| n >= 90),
            };
            (!family.trim().is_empty()).then_some((family, mono))
        })
        .collect()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFString, CFType};
    use objc2_core_text::{
        CTFontCollection, CTFontDescriptor, CTFontSymbolicTraits, kCTFontFamilyNameAttribute, kCTFontSymbolicTrait,
        kCTFontTraitsAttribute,
    };

    /// Every face CoreText makes available to this process, as (family, fixed pitch).
    pub(crate) fn list(_refresh: bool) -> Vec<(String, bool)> {
        // SAFETY: CoreText's documented types: the matching descriptors array
        // holds CTFontDescriptors and the traits dictionary maps CFString keys.
        unsafe {
            let collection = CTFontCollection::from_available_fonts(None);
            let Some(descriptors) = collection.matching_font_descriptors() else {
                return Vec::new();
            };
            let descriptors: &CFArray<CTFontDescriptor> = descriptors.cast_unchecked();
            descriptors
                .iter()
                .filter_map(|d| {
                    let name = d.attribute(kCTFontFamilyNameAttribute)?.downcast::<CFString>().ok()?.to_string();
                    let traits = d
                        .attribute(kCTFontTraitsAttribute)
                        .and_then(|t| t.downcast::<CFDictionary>().ok())
                        .and_then(|t| t.cast_unchecked::<CFString, CFType>().get(kCTFontSymbolicTrait))
                        .and_then(|n| n.downcast::<CFNumber>().ok())
                        .and_then(|n| n.as_i64())
                        .unwrap_or(0);
                    Some((name, traits as u32 & CTFontSymbolicTraits::TraitMonoSpace.0 != 0))
                })
                .collect()
        }
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Graphics::DirectWrite::{
        DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_NORMAL,
        DWriteCreateFactory, IDWriteFactory, IDWriteFont1, IDWriteLocalizedStrings,
    };
    use windows::core::{BOOL, Interface, w};

    /// The system font collection's families, named in English when the
    /// family has an English name (what CSS matches), else its first name.
    pub(crate) fn list(refresh: bool) -> Vec<(String, bool)> {
        // SAFETY: plain DirectWrite COM calls on interfaces we own.
        unsafe { read(refresh) }.unwrap_or_default()
    }

    unsafe fn read(refresh: bool) -> windows::core::Result<Vec<(String, bool)>> {
        let factory: IDWriteFactory = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }?;
        let mut collection = None;
        unsafe { factory.GetSystemFontCollection(&mut collection, refresh) }?;
        let Some(collection) = collection else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for i in 0..unsafe { collection.GetFontFamilyCount() } {
            let Ok(family) = (unsafe { collection.GetFontFamily(i) }) else {
                continue;
            };
            let Some(name) = unsafe { family.GetFamilyNames() }.ok().and_then(|n| unsafe { english(&n) }) else {
                continue;
            };
            let mono = unsafe {
                family.GetFirstMatchingFont(
                    DWRITE_FONT_WEIGHT_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    DWRITE_FONT_STYLE_NORMAL,
                )
            }
            .ok()
            .and_then(|f| f.cast::<IDWriteFont1>().ok())
            .is_some_and(|f| unsafe { f.IsMonospacedFont() }.as_bool());
            out.push((name, mono));
        }
        Ok(out)
    }

    unsafe fn english(names: &IDWriteLocalizedStrings) -> Option<String> {
        let mut index = 0u32;
        let mut exists = BOOL(0);
        unsafe { names.FindLocaleName(w!("en-us"), &mut index, &mut exists) }.ok()?;
        if !exists.as_bool() {
            index = 0;
        }
        let len = unsafe { names.GetStringLength(index) }.ok()? as usize;
        let mut buf = vec![0u16; len + 1];
        unsafe { names.GetString(index, &mut buf) }.ok()?;
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::process::{Command, Stdio};

    /// fontconfig's view, which WebKitGTK resolves names with. Empty when
    /// `fc-list` isn't installed.
    pub(crate) fn list(_refresh: bool) -> Vec<(String, bool)> {
        Command::new("fc-list")
            .args(["-f", "%{family[0]}\t%{spacing}\n"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| super::parse_fc_list(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    pub(crate) fn list(_refresh: bool) -> Vec<(String, bool)> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fam(name: &str, monospaced: bool) -> FontFamily {
        FontFamily { name: name.into(), monospaced }
    }

    #[test]
    fn normalize_merges_faces_sorts_and_drops_hidden() {
        let faces = [
            ("Menlo", true),
            ("Arial", false),
            ("Menlo", true),
            (".SF NS Mono", true),
            ("  ", false),
            ("arial", false),
            ("PingFang SC", false),
            ("Courier New", false),
            ("Courier New", true),
            ("andale mono", true),
        ]
        .map(|(n, m)| (n.to_owned(), m));
        assert_eq!(
            normalize(faces),
            vec![
                fam("andale mono", true),
                fam("Arial", false),
                fam("Courier New", true),
                fam("Menlo", true),
                fam("PingFang SC", false),
            ]
        );
    }

    #[test]
    fn fc_list_spacing_marks_monospace() {
        let out = "DejaVu Sans Mono\t100\nDejaVu Sans\t\nNoto Sans Mono CJK SC\t90\nTerminus\t110\nCantarell\nFira\\-Code\tmono\n\t100\n";
        assert_eq!(
            parse_fc_list(out),
            [
                ("DejaVu Sans Mono", true),
                ("DejaVu Sans", false),
                ("Noto Sans Mono CJK SC", true),
                ("Terminus", true),
                ("Cantarell", false),
                ("Fira-Code", true),
            ]
            .map(|(n, m)| (n.to_owned(), m))
        );
    }

    #[test]
    fn caches_until_refresh_requested() {
        let cache = Mutex::new(None);
        let calls = AtomicUsize::new(0);
        let lister = |refresh: bool| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            vec![(format!("Font {n} (refresh={refresh})"), n.is_multiple_of(2))]
        };

        let first = cached(&cache, false, lister);
        assert_eq!(&*first, &[fam("Font 0 (refresh=false)", true)]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let second = cached(&cache, false, lister);
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let refreshed = cached(&cache, true, lister);
        assert_eq!(&*refreshed, &[fam("Font 1 (refresh=true)", false)]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        let after_refresh = cached(&cache, false, lister);
        assert!(Arc::ptr_eq(&refreshed, &after_refresh));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// The real font system: every desktop OS ships some fonts, at least one
    /// of them monospaced, and the list comes back sorted without duplicates.
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn lists_installed_families() {
        let list = families(false);
        assert!(list.len() > 20, "only {} families", list.len());
        assert!(list.iter().any(|f| f.monospaced));
        assert!(list.iter().any(|f| !f.monospaced));
        let keys: Vec<String> = list.iter().map(|f| f.name.to_lowercase()).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
        #[cfg(target_os = "macos")]
        {
            let menlo = list.iter().find(|f| f.name == "Menlo").expect("Menlo ships with macOS");
            assert!(menlo.monospaced);
            assert!(list.iter().any(|f| f.name == "Helvetica Neue" && !f.monospaced));
        }
        assert_eq!(&*families(true), &*list);
    }
}
