//! The object layout rules of the JVM that wrote a dump.

use std::collections::HashMap;

use crate::hprof::BasicType;

/// Object layout of the JVM that wrote the dump.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VmLayout {
    pub header: u8,
    /// Bytes of a reference: 4 with compressed oops.
    pub ref_size: u8,
    /// Offset of the length field of an array.
    pub length_offset: u8,
    /// JDK 21 and older put array elements at the next 8-byte boundary after the length, later
    /// JDKs at the next boundary of the element size.
    pub legacy_array_base: bool,
    pub alignment: u16,
    /// The JDK the flags came from; `None` when nothing is known about the JVM.
    pub java_major: Option<u32>,
}

impl VmLayout {
    pub const DEFAULT: VmLayout = VmLayout {
        header: 12,
        ref_size: 4,
        length_offset: 12,
        legacy_array_base: false,
        alignment: 8,
        java_major: None,
    };

    /// `flags` is the output of `VM.flags`, which lists the flags set on this run. Compressed oops
    /// are off by default and only switched on by ergonomics, so `-XX:+UseCompressedOops` is
    /// printed exactly when references take 4 bytes; a heap too big for them prints no such flag.
    /// Before JDK 15 compressed class pointers follow the same rule. Flags without any `-XX:`
    /// option (an external dump) give [`Self::DEFAULT`] with the array base of `java_major` and an
    /// unknown JDK, since the reference size is a guess.
    /// An `ObjectAlignmentInBytes` that is not a power of two in `8..=256` is ignored.
    pub fn from_vm_flags(flags: &str, java_major: u32) -> Self {
        let legacy_array_base = java_major <= 21;
        let flags = parse_flags(flags);
        if flags.is_empty() {
            return VmLayout { legacy_array_base, ..Self::DEFAULT };
        }
        let on = |name: &str| flags.get(name) == Some(&"true");
        let compressed_classes = if java_major >= 15 {
            flags.get("UseCompressedClassPointers") != Some(&"false")
        } else {
            on("UseCompressedClassPointers")
        };
        let (header, length_offset) = if on("UseCompactObjectHeaders") {
            (8, 8)
        } else if compressed_classes {
            (12, 12)
        } else {
            (16, 16)
        };
        let alignment = flags
            .get("ObjectAlignmentInBytes")
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|a| (8..=256).contains(a) && a.is_power_of_two())
            .unwrap_or(Self::DEFAULT.alignment);
        VmLayout {
            header,
            ref_size: if on("UseCompressedOops") { 4 } else { 8 },
            length_offset,
            legacy_array_base,
            alignment,
            java_major: Some(java_major),
        }
    }

    /// Size of an instance whose fields (its class and every superclass) take `field_bytes`.
    pub fn instance_size(&self, field_bytes: u64) -> u64 {
        let smallest = if self.header == 8 { 8 } else { 16 };
        self.align(u64::from(self.header) + field_bytes).max(smallest)
    }

    pub fn array_size(&self, ty: BasicType, len: u64) -> u64 {
        let element = ty.heap_size(self.ref_size);
        let base_alignment = if self.legacy_array_base { 8 } else { element };
        let base = align_to(u64::from(self.length_offset) + 4, base_alignment);
        self.align(base + element * len)
    }

    /// `value` rounded up to the object alignment.
    pub(super) fn align(&self, value: u64) -> u64 {
        align_to(value, u64::from(self.alignment))
    }
}

fn align_to(value: u64, to: u64) -> u64 {
    value.div_ceil(to.max(1)) * to.max(1)
}

/// `-XX:+Name` / `-XX:-Name` / `-XX:Name=value` tokens by name; booleans become `"true"` / `"false"`.
/// A flag given twice keeps its last value, as in the JVM.
fn parse_flags(flags: &str) -> HashMap<&str, &str> {
    let mut parsed = HashMap::new();
    for token in flags.split_whitespace() {
        let Some(body) = token.strip_prefix("-XX:") else { continue };
        if let Some(name) = body.strip_prefix('+') {
            parsed.insert(name, "true");
        } else if let Some(name) = body.strip_prefix('-') {
            parsed.insert(name, "false");
        } else if let Some((name, value)) = body.split_once('=') {
            parsed.insert(name, value);
        }
    }
    parsed
}
