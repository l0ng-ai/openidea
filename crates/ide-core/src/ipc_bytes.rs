//! Binary arguments of IPC commands travel as base64 text: [`IpcBytes`] is a `Vec<u8>` that
//! serializes as a standard padded base64 string and is a plain `string` in the generated
//! bindings.
//!
//! A plain `Vec<u8>` is a JSON array of numbers, 3.6 times the size of the bytes, and parsing it
//! into a `serde_json::Value` (the remote protocol and Tauri both do) takes about 50 times the
//! bytes in memory: 20 MB become about 1 GB. Base64 is 1.33 times the size and one string.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::ops::Deref;

/// A binary argument or result of an IPC command.
#[derive(Clone, Default, PartialEq, Eq, specta::Type)]
#[specta(transparent)]
pub struct IpcBytes(#[specta(type = String)] pub Vec<u8>);

impl IpcBytes {
    pub fn into_vec(self) -> Vec<u8> {
        self.0
    }
}

impl fmt::Debug for IpcBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "IpcBytes({} bytes)", self.0.len())
    }
}

impl Serialize for IpcBytes {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for IpcBytes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Base64;
        impl Visitor<'_> for Base64 {
            type Value = IpcBytes;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a base64 string")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<IpcBytes, E> {
                STANDARD.decode(v).map(IpcBytes).map_err(|e| E::custom(format!("invalid base64: {e}")))
            }
        }
        d.deserialize_str(Base64)
    }
}

impl Deref for IpcBytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl From<Vec<u8>> for IpcBytes {
    fn from(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn round_trip(bytes: Vec<u8>) {
        let value = serde_json::to_value(IpcBytes(bytes.clone())).unwrap();
        let text = value.as_str().expect("serializes as a string");
        assert_eq!(text.len(), bytes.len().div_ceil(3) * 4);
        assert_eq!(serde_json::from_value::<IpcBytes>(value).unwrap().into_vec(), bytes);
    }

    #[test]
    fn round_trips_empty_every_byte_and_large_input() {
        round_trip(Vec::new());
        round_trip((0..=255).collect());
        round_trip((0..=255).rev().cycle().take(5 * 1024 * 1024 + 1).collect());
    }

    #[test]
    fn round_trips_through_a_json_document() {
        let bytes: Vec<u8> = (0..=255).collect();
        let text = serde_json::to_string(&json!({ "data": IpcBytes(bytes.clone()) })).unwrap();
        #[derive(Deserialize)]
        struct Args {
            data: IpcBytes,
        }
        assert_eq!(serde_json::from_str::<Args>(&text).unwrap().data.into_vec(), bytes);
    }

    /// The old wire form of a `Vec<u8>`: 3.6 times the bytes. The string must stay near 4/3.
    #[test]
    fn serialized_form_is_a_string_about_a_third_larger_than_the_bytes() {
        let bytes: Vec<u8> = (0..=255).cycle().take(1_000_000).collect();
        let json = serde_json::to_string(&IpcBytes(bytes.clone())).unwrap();
        assert!(json.starts_with('"') && json.ends_with('"'));
        assert!(json.len() <= bytes.len().div_ceil(3) * 4 + 2, "{} bytes for {}", json.len(), bytes.len());
        let as_array = serde_json::to_string(&bytes).unwrap();
        assert!(json.len() * 2 < as_array.len(), "{} vs {}", json.len(), as_array.len());
    }

    #[test]
    fn rejects_what_is_not_base64() {
        for bad in [json!([1, 2, 3]), json!(7), Value::Null, json!("not base64!"), json!("QQ"), json!("QQ=a")] {
            assert!(serde_json::from_value::<IpcBytes>(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn debug_does_not_print_the_bytes() {
        assert_eq!(format!("{:?}", IpcBytes(vec![0; 3])), "IpcBytes(3 bytes)");
    }
}
