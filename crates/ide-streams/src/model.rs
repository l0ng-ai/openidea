use serde::{Deserialize, Serialize};
use specta::Type;

/// Wrapper class of a boxed primitive; serialises as the primitive name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum BoxKind {
    Boolean,
    Byte,
    Char,
    Short,
    Int,
    Long,
    Float,
    Double,
}

/// An element as the debuggee reported it. `id` is the JDI unique object id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TraceValue {
    Null,
    Object {
        id: u64,
        /// Binary class name.
        class: String,
    },
    Boxed {
        id: u64,
        class: BoxKind,
        /// The primitive's textual form.
        value: String,
    },
    Str {
        id: u64,
        value: String,
        truncated: bool,
    },
}

/// One recorded element. Time order is the position in the owning `Vec`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub step: u16,
    pub value: TraceValue,
}

/// How a step's output elements relate to its input elements.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    /// Output order follows input order, so elements can be linked by position.
    Sync,
    /// Output is reordered; elements are linked by identity.
    Reorder,
    /// No usable relation between input and output.
    Unlinked,
}

/// Link from an output element to the input element it came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub parent: Option<u32>,
    pub ambiguous: bool,
}

/// An element `distinct` discarded, with the kept element equal to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DistinctDrop {
    pub dropped: u32,
    pub same_as: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_value_json_shape() {
        let v = TraceValue::Boxed { id: 7, class: BoxKind::Int, value: "5".into() };
        assert_eq!(serde_json::to_string(&v).unwrap(), r#"{"kind":"boxed","id":7,"class":"int","value":"5"}"#);
    }
}
