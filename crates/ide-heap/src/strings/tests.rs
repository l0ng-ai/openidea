use super::*;
use crate::hprof::{BasicType, HeapRootKind};
use crate::test_index::{analyzed, obj};
use crate::testing::{MiniHeap, sample_with_string};

const AT: u64 = 0x1000;
const ARRAY: u64 = 0x2000;
const JDK9: [(&str, BasicType); 2] = [("value", BasicType::Object), ("coder", BasicType::Byte)];

fn preview(heap: &MiniHeap, addr: u64) -> Option<String> {
    let index = analyzed(heap);
    string_preview(&index, obj(&index, addr).0, 100)
}

fn text(text: &str, latin1: bool) -> Option<String> {
    let mut heap = MiniHeap::new();
    heap.string(AT, text, latin1).root(HeapRootKind::JniGlobal, AT);
    preview(&heap, AT)
}

/// A `java.lang.String` class with `fields`, and one String at [`AT`] with `values`.
fn custom(fields: &[(&str, BasicType)], values: &[(&str, u64)], array: impl FnOnce(&mut MiniHeap)) -> Option<String> {
    let mut heap = MiniHeap::new();
    heap.class("java.lang.String", Some("java.lang.Object"), fields);
    array(&mut heap);
    heap.object(AT, "java.lang.String", values);
    preview(&heap, AT)
}

#[test]
fn string_preview_latin1_and_utf16() {
    assert_eq!(preview(&sample_with_string(), 0x1800).as_deref(), Some("v42"));
    assert_eq!(text("hé", false).as_deref(), Some("hé"));
    assert_eq!(text("ÿ é", true).as_deref(), Some("ÿ é"));
    assert_eq!(text("", true).as_deref(), Some(""));

    let long = "a".repeat(150);
    assert_eq!(text(&long, true), Some(format!("{}…", "a".repeat(100))));
    assert_eq!(text(&long, false), Some(format!("{}…", "a".repeat(100))));
    let exactly = "b".repeat(100);
    assert_eq!(text(&exactly, true), Some(exactly));
}

#[test]
fn truncation_keeps_surrogate_pairs_whole() {
    let s = format!("{}😀{}", "a".repeat(99), "b".repeat(50));
    assert_eq!(text(&s, false), Some(format!("{}😀…", "a".repeat(99))));
    // A lone surrogate becomes the replacement character.
    let lone: Vec<u8> = [0x68u16, 0xD800, 0x69].iter().flat_map(|u| u.to_le_bytes()).collect();
    let got = custom(&JDK9, &[("value", ARRAY), ("coder", 1)], |h| {
        h.prim_bytes(ARRAY, BasicType::Byte, &lone);
    });
    assert_eq!(got.as_deref(), Some("h\u{FFFD}i"));
}

#[test]
fn jdk8_strings_hold_big_endian_chars() {
    let chars: Vec<u8> = "hé".encode_utf16().flat_map(u16::to_be_bytes).collect();
    let fields = [("value", BasicType::Object), ("hash", BasicType::Int)];
    let got = custom(&fields, &[("value", ARRAY)], |h| {
        h.prim_bytes(ARRAY, BasicType::Char, &chars);
    });
    assert_eq!(got.as_deref(), Some("hé"));
}

#[test]
fn malformed_strings_have_no_preview() {
    let odd = custom(&JDK9, &[("value", ARRAY), ("coder", 1)], |h| {
        h.prim_bytes(ARRAY, BasicType::Byte, &[0x68, 0, 0x69]);
    });
    assert_eq!(odd, None);
    let bad_coder = custom(&JDK9, &[("value", ARRAY), ("coder", 2)], |h| {
        h.prim_bytes(ARRAY, BasicType::Byte, b"hi");
    });
    assert_eq!(bad_coder, None);
    let no_value = custom(&[("coder", BasicType::Byte)], &[], |_| {});
    assert_eq!(no_value, None);
    let no_coder = custom(&[("value", BasicType::Object)], &[("value", ARRAY)], |h| {
        h.prim_bytes(ARRAY, BasicType::Byte, b"hi");
    });
    assert_eq!(no_coder, None);
    let null_value = custom(&JDK9, &[], |_| {});
    assert_eq!(null_value, None);
    let int_array = custom(&JDK9, &[("value", ARRAY)], |h| {
        h.prim(ARRAY, BasicType::Int, 2);
    });
    assert_eq!(int_array, None);
    let not_an_array = custom(&JDK9, &[("value", ARRAY)], |h| {
        h.object(ARRAY, "java.lang.Object", &[]);
    });
    assert_eq!(not_an_array, None);
    // `value` stored as a long instead of a reference.
    let wrong_type = custom(&[("value", BasicType::Long), ("coder", BasicType::Byte)], &[("value", ARRAY)], |h| {
        h.prim_bytes(ARRAY, BasicType::Byte, b"hi");
    });
    assert_eq!(wrong_type, None);
}

#[test]
fn only_strings_have_a_preview() {
    let mut heap = MiniHeap::new();
    heap.class("Text", Some("java.lang.Object"), &JDK9).prim_bytes(ARRAY, BasicType::Byte, b"hi").object(
        AT,
        "Text",
        &[("value", ARRAY)],
    );
    assert_eq!(preview(&heap, AT), None);
    assert_eq!(preview(&heap, ARRAY), None);
    let index = analyzed(&heap);
    for bad in [index.root(), u32::MAX] {
        assert_eq!(string_preview(&index, bad, 100), None);
    }
}
