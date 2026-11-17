//! The fields of an object or the leading elements of an array.

use super::LinkInspector;
use crate::codec::Value;
use ide_jvm_inspect::{ARRAY_PREVIEW, InspectError, JvmField};

impl LinkInspector {
    /// The previewed fields, `[i]` for the first [`ARRAY_PREVIEW`] elements of an array.
    pub(super) async fn list_fields(&self, object: u64) -> Result<Vec<JvmField>, InspectError> {
        let class = self.class_of(object).await?;
        let named = if self.class_name(class).await?.ends_with("[]") {
            let length = self.array_length(object).await?;
            let elements = self.array_elements(object, 0, length.min(ARRAY_PREVIEW)).await?;
            index_names(elements)
        } else {
            self.instance_fields(object, class).await?
        };
        let mut out = Vec::with_capacity(named.len());
        for (name, value) in named {
            out.push(JvmField { name, value: self.preview(value).await? });
        }
        Ok(out)
    }

    /// Every instance field of `object`, its own class first, then each superclass; static
    /// fields are skipped. Values are not previewed.
    pub(super) async fn instance_fields(&self, object: u64, class: u64) -> Result<Vec<(String, Value)>, InspectError> {
        let mut names = Vec::new();
        let mut ids = Vec::new();
        let mut current = class;
        while current != 0 {
            for field in self.declared_fields(current).await?.iter().filter(|f| !f.is_static) {
                names.push(field.name.clone());
                ids.push(field.id);
            }
            current = self.superclass_of(current).await?;
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let values = self.read_values(object, &ids).await?;
        Ok(names.into_iter().zip(values).collect())
    }
}

pub(super) fn index_names(elements: Vec<Value>) -> Vec<(String, Value)> {
    elements.into_iter().enumerate().map(|(i, value)| (format!("[{i}]"), value)).collect()
}
