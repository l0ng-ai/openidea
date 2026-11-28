//! Machine code of a native program (DAP `disassemble`), for the Disassembly view.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// The most instructions one request asks for.
pub const MAX_INSTRUCTIONS: u32 = 1000;

/// One disassembled instruction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Instruction {
    /// Address as the adapter writes it (`0x5555…`); also a memory reference for the next request.
    pub address: String,
    /// The instruction in the adapter's syntax (`mov    -0x28(%rbp),%rax`).
    pub instruction: String,
    /// Its machine code as hex (`488b45d8`), when the adapter sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub bytes: Option<String>,
    /// The function it belongs to, when the adapter names it (often on the first instruction only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub symbol: Option<String>,
}

/// `disassemble`'s instructions in order; `None` for the padding adapters put where there is no
/// code (`presentationHint: "invalid"`, or no address).
pub(crate) fn instructions(body: &Value) -> Vec<Option<Instruction>> {
    let text = |i: &Value, k: &str| i.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let Some(list) = body.get("instructions").and_then(Value::as_array) else { return Vec::new() };
    list.iter()
        .map(|i| {
            if i.get("presentationHint").and_then(Value::as_str) == Some("invalid") {
                return None;
            }
            Some(Instruction {
                address: text(i, "address")?,
                instruction: text(i, "instruction").unwrap_or_default(),
                bytes: text(i, "instructionBytes"),
                symbol: text(i, "symbol"),
            })
        })
        .collect()
}

/// A memory reference or address as a number (`0x7ffd…` or decimal).
pub(crate) fn address(reference: &str) -> Option<u128> {
    let r = reference.trim();
    match r.strip_prefix("0x").or_else(|| r.strip_prefix("0X")) {
        Some(hex) => u128::from_str_radix(hex, 16).ok(),
        None => r.parse().ok(),
    }
}

/// Whether the instruction at `index` is the one at `reference`. References that are not
/// addresses cannot be checked and pass.
pub(crate) fn at_index(instructions: &[Option<Instruction>], reference: &str, index: usize) -> bool {
    let Some(want) = address(reference) else { return instructions.len() > index };
    instructions.get(index).and_then(Option::as_ref).and_then(|i| address(&i.address)) == Some(want)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_gdbs_instructions() {
        // GDB 17.1 at the reporter-style C fixture's loop line.
        let body = json!({"instructions": [
            {"address": "0x5555555551f5", "instruction": "mov    -0x2c(%rbp),%eax", "instructionBytes": "8b45d4", "line": 14},
            {"address": "0x5555555551f8", "instruction": "cltq", "instructionBytes": "4898", "symbol": "sum"},
        ]});
        let got = instructions(&body);
        assert_eq!(
            got[0],
            Some(Instruction {
                address: "0x5555555551f5".into(),
                instruction: "mov    -0x2c(%rbp),%eax".into(),
                bytes: Some("8b45d4".into()),
                symbol: None,
            })
        );
        assert_eq!(got[1].as_ref().unwrap().symbol.as_deref(), Some("sum"));
    }

    #[test]
    fn padding_is_not_an_instruction() {
        let body = json!({"instructions": [
            {"address": "0xfff0", "instruction": "", "presentationHint": "invalid"},
            {"instruction": "??"},
            {"address": "0x10000", "instruction": "nop"},
        ]});
        let got = instructions(&body);
        assert_eq!((got[0].is_none(), got[1].is_none(), got[2].is_some()), (true, true, true));
        assert!(instructions(&json!({})).is_empty());
    }

    #[test]
    fn finds_the_reference_by_its_address() {
        let list = instructions(&json!({"instructions": [
            {"address": "0x00001000", "instruction": "push %rbp"},
            {"address": "0x1001", "instruction": "mov %rsp,%rbp"},
        ]}));
        assert!(at_index(&list, "0x1001", 1));
        assert!(at_index(&list, "4097", 1));
        assert!(at_index(&list, "0X1000", 0));
        assert!(!at_index(&list, "0x1001", 0));
        assert!(!at_index(&list, "0x1001", 2));
        assert!(at_index(&list, "frame-3", 1), "opaque references cannot be checked");
        assert_eq!(address("0xffffffffffffffff1"), Some(0xffffffffffffffff1));
    }
}
