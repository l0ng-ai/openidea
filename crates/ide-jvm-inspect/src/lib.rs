//! Types and the [`JvmInspector`] trait for reading live JVM objects while a debug session is
//! suspended. Implementations live elsewhere (jdtls bundle for Java, JDWP link for Kotlin).

mod names;

pub use names::{is_boxed, name_to_signature, signature_to_name, string_length};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use specta::Type;

/// JDWP object id; only valid within the stop (`VmTarget::generation`) it was read in.
pub type ObjectId = u64;

pub const MAX_INSTANCES: u32 = 1000;
pub const DEFAULT_REFERRERS: u32 = 50;
pub const MAX_REFERRERS: u32 = 200;
/// Leading array elements expanded when listing an array's fields.
pub const ARRAY_PREVIEW: u32 = 100;
/// `String` text is read only up to this many characters.
pub const STRING_PREVIEW_CHARS: u32 = 1000;
/// Referrer arrays larger than this are not searched for the index that points at the object.
pub const REFERRER_ARRAY_SCAN: u32 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JvmValue {
    Null,
    Primitive {
        type_name: String,
        text: String,
    },
    /// `text` is `None` when `length` exceeds [`STRING_PREVIEW_CHARS`].
    #[serde(rename = "string")]
    Str {
        id: ObjectId,
        text: Option<String>,
        length: u32,
    },
    Boxed {
        id: ObjectId,
        type_name: String,
        text: String,
    },
    Object {
        id: ObjectId,
        type_name: String,
    },
    Array {
        id: ObjectId,
        type_name: String,
        length: u32,
    },
}

impl JvmValue {
    pub fn object_id(&self) -> Option<ObjectId> {
        match self {
            Self::Null | Self::Primitive { .. } => None,
            Self::Str { id, .. } | Self::Boxed { id, .. } | Self::Object { id, .. } | Self::Array { id, .. } => {
                Some(*id)
            }
        }
    }
}

/// For arrays `name` is `"[i]"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmField {
    pub name: String,
    pub value: JvmValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmReferrer {
    pub value: JvmValue,
    /// Field names, or `"[i]"` for array slots, through which `value` points at the object.
    pub via: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClassCount {
    /// Display form, as in the class histogram (`int[]`, `com.x.Foo$Bar`).
    pub name: String,
    pub instances: u64,
}

/// Identifies one JVM and one stop. Not serialized: the IPC layer builds its JSON by hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmTarget {
    pub pid: Option<u32>,
    pub attach_host: Option<String>,
    pub attach_port: Option<u16>,
    /// Session `stop_seq`; objects are valid only for the generation they were read in.
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum InspectError {
    #[error("the debuggee is not suspended")]
    NotSuspended,
    #[error("the object belongs to an earlier stop")]
    Stale,
    #[error("the object was garbage collected")]
    Collected,
    #[error("the class is not loaded")]
    ClassNotLoaded,
    #[error("no matching JVM found")]
    VmNotFound,
    #[error("not supported by this debug adapter: {0}")]
    Unsupported(String),
    #[error("the request timed out")]
    TimedOut,
    #[error("the connection was closed")]
    Closed,
    #[error("{0}")]
    Failed(String),
}

pub type InspectFuture<'a, T> = BoxFuture<'a, Result<T, InspectError>>;

pub trait JvmInspector: Send + Sync {
    fn class_counts<'a>(&'a self, target: &'a VmTarget) -> InspectFuture<'a, Vec<ClassCount>>;
    fn instances<'a>(
        &'a self,
        target: &'a VmTarget,
        class_name: &'a str,
        limit: u32,
    ) -> InspectFuture<'a, Vec<JvmValue>>;
    fn fields<'a>(&'a self, target: &'a VmTarget, object: ObjectId) -> InspectFuture<'a, Vec<JvmField>>;
    fn referrers<'a>(
        &'a self,
        target: &'a VmTarget,
        object: ObjectId,
        limit: u32,
    ) -> InspectFuture<'a, Vec<JvmReferrer>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_json_shape() {
        let v = JvmValue::Str { id: 7, text: None, length: 50_000_000 };
        assert_eq!(
            serde_json::to_value(&v).unwrap(),
            serde_json::json!({"kind": "string", "id": 7, "text": null, "length": 50000000})
        );
        assert_eq!(JvmValue::Null.object_id(), None);
        assert_eq!(JvmValue::Array { id: 3, type_name: "int[]".into(), length: 2 }.object_id(), Some(3));
    }
}
