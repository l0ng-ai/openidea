//! One-line previews of values. They only read: no `toString`.

use super::{LinkInspector, wire};
use crate::codec::{Value, primitive_text};
use crate::ids::ReplyIds;
use ide_jvm_inspect::{InspectError, JvmValue, STRING_PREVIEW_CHARS, is_boxed, signature_to_name, string_length};

const STRING: &str = "java.lang.String";

impl LinkInspector {
    pub(super) async fn preview(&self, value: Value) -> Result<JvmValue, InspectError> {
        match value {
            Value::Null => Ok(JvmValue::Null),
            Value::Primitive { tag, raw } => primitive(tag, raw),
            Value::Object { id, .. } => self.preview_object(id).await,
        }
    }

    /// `Err(Collected)` when the object is gone.
    pub(super) async fn preview_object(&self, id: u64) -> Result<JvmValue, InspectError> {
        let class = self.class_of(id).await?;
        let type_name = self.class_name(class).await?;
        if type_name.ends_with("[]") {
            let length = self.array_length(id).await?;
            return Ok(JvmValue::Array { id, type_name, length });
        }
        if type_name == STRING {
            return self.preview_string(id, class).await;
        }
        if is_boxed(&type_name) {
            let text = self.boxed_text(id, class).await?;
            return Ok(JvmValue::Boxed { id, type_name, text });
        }
        Ok(JvmValue::Object { id, type_name })
    }

    /// Reads the length of the backing array, and the text only when it is short.
    async fn preview_string(&self, id: u64, class: u64) -> Result<JvmValue, InspectError> {
        let fields = self.declared_fields(class).await?;
        let field = |name: &str| fields.iter().find(|f| f.name == name && !f.is_static).map(|f| f.id);
        let value = field("value").ok_or_else(|| InspectError::Failed(format!("{STRING} has no value field")))?;
        // JDK 8 has no `coder`: one `char` per element.
        let wanted: Vec<u64> = std::iter::once(value).chain(field("coder")).collect();
        let read = self.read_values(id, &wanted).await?;
        let array_length = match read[0] {
            Value::Object { id: array, .. } => self.array_length(array).await?,
            _ => 0,
        };
        let coder = match read.get(1) {
            None => None,
            Some(Value::Primitive { raw, .. }) => Some(*raw as u8),
            Some(other) => return Err(InspectError::Failed(format!("unexpected String.coder {other:?}"))),
        };
        let length = string_length(array_length, coder);
        let text = if length <= STRING_PREVIEW_CHARS {
            let sizes = self.sizes()?;
            Some(wire::string(&self.call(10, 1, wire::id_body(id, sizes.object), ReplyIds::None).await?)?)
        } else {
            None
        };
        Ok(JvmValue::Str { id, text, length })
    }

    async fn boxed_text(&self, id: u64, class: u64) -> Result<String, InspectError> {
        let fields = self.declared_fields(class).await?;
        let value = fields
            .iter()
            .find(|f| f.name == "value" && !f.is_static)
            .ok_or_else(|| InspectError::Failed("a boxed type has no value field".into()))?;
        match self.read_values(id, &[value.id]).await?[0] {
            Value::Primitive { tag, raw } => Ok(primitive_text(tag, raw)),
            other => Err(InspectError::Failed(format!("unexpected boxed value {other:?}"))),
        }
    }
}

fn primitive(tag: u8, raw: u64) -> Result<JvmValue, InspectError> {
    let type_name = signature_to_name(&char::from(tag).to_string())
        .ok_or_else(|| InspectError::Failed(format!("unknown primitive tag {tag:#04x}")))?;
    Ok(JvmValue::Primitive { type_name, text: primitive_text(tag, raw) })
}
