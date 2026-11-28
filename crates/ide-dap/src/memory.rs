//! Raw memory of a native program (DAP `readMemory`), for the Memory View.

use base64::Engine;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// The most bytes one read asks for: a few pages of the view, never a whole mapping.
pub const MAX_READ: u32 = 64 * 1024;

/// Answer of `readMemory`: `data` starts at `address`; the `unreadable_bytes` after it could not be read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBlock {
    /// Address of the first byte, as the adapter writes it (`0x7ffd…`; may be wider than 53 bits).
    pub address: String,
    pub data: Vec<u8>,
    pub unreadable_bytes: u32,
}

/// `readMemory`'s body for a read of `count` bytes. Adapters leave `data` out (or empty) when
/// nothing could be read; the bytes asked for then count as unreadable.
pub(crate) fn memory_block(body: &Value, count: u32) -> IdeResult<MemoryBlock> {
    let address = match body.get("address") {
        Some(Value::String(a)) if !a.is_empty() => a.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return Err(IdeError::internal("the debug adapter answered readMemory without an address")),
    };
    let mut data = match body.get("data").and_then(Value::as_str) {
        Some(b64) if !b64.is_empty() => base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| IdeError::internal(format!("the debug adapter sent memory that is not base64: {e}")))?,
        _ => Vec::new(),
    };
    data.truncate(count as usize);
    // At most the rest of what was asked for (the data is never more than that).
    let rest = count - data.len() as u32;
    let unreadable_bytes = match body.get("unreadableBytes").and_then(Value::as_u64) {
        Some(n) => n.min(u64::from(rest)) as u32,
        None if data.is_empty() => count,
        None => 0,
    };
    Ok(MemoryBlock { address, data, unreadable_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_the_bytes_and_keeps_the_address_as_written() {
        // The reporter's `&msg[0]` (#5921): "Hello, World!\n" and its terminator.
        let body = json!({"address": "0x000000016FDFE9A0", "data": "SGVsbG8sIFdvcmxkIQoA"});
        let block = memory_block(&body, 15).unwrap();
        assert_eq!(block.address, "0x000000016FDFE9A0");
        assert_eq!(block.data, b"Hello, World!\n\0");
        assert_eq!(block.unreadable_bytes, 0);
    }

    #[test]
    fn missing_data_is_unreadable_not_empty() {
        let block = memory_block(&json!({"address": "0x0"}), 256).unwrap();
        assert!(block.data.is_empty());
        assert_eq!(block.unreadable_bytes, 256);
        let block = memory_block(&json!({"address": "0x0", "data": "", "unreadableBytes": 16}), 256).unwrap();
        assert_eq!(block.unreadable_bytes, 16);
    }

    #[test]
    fn a_partial_read_reports_the_rest_as_unreadable() {
        let block = memory_block(&json!({"address": "0x1000", "data": "AAEC", "unreadableBytes": 13}), 16).unwrap();
        assert_eq!((block.data.as_slice(), block.unreadable_bytes), (&[0u8, 1, 2][..], 13));
        // Counts that disagree with the request are clamped to it.
        let block = memory_block(&json!({"address": "0x1000", "data": "AAEC", "unreadableBytes": 99}), 16).unwrap();
        assert_eq!(block.unreadable_bytes, 13);
        let block = memory_block(&json!({"address": "0x1000", "data": "AAECAw=="}), 2).unwrap();
        assert_eq!((block.data.as_slice(), block.unreadable_bytes), (&[0u8, 1][..], 0));
    }

    #[test]
    fn rejects_answers_without_an_address_or_with_bad_data() {
        assert!(memory_block(&json!({"data": "AA=="}), 1).is_err());
        assert!(memory_block(&json!({"address": "0x10", "data": "not base64!"}), 1).is_err());
        assert_eq!(memory_block(&json!({"address": 4096, "data": "AA=="}), 1).unwrap().address, "4096");
    }
}
