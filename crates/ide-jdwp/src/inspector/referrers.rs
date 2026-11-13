//! The objects that refer to an object, and through which field or slot.

use super::{LinkInspector, fields::index_names, wire};
use crate::codec::Value;
use crate::ids::ReplyIds;
use ide_jvm_inspect::{InspectError, JvmReferrer, JvmValue, MAX_REFERRERS, REFERRER_ARRAY_SCAN};

impl LinkInspector {
    /// Up to `min(limit, MAX_REFERRERS)` referrers. One that was collected before it could be
    /// read is left out; any other error fails the list.
    pub(super) async fn list_referrers(&self, object: u64, limit: u32) -> Result<Vec<JvmReferrer>, InspectError> {
        let wanted = limit.min(MAX_REFERRERS);
        // JDWP reads a maximum of 0 as "all of them".
        if wanted == 0 {
            return Ok(Vec::new());
        }
        let sizes = self.sizes()?;
        let body = wire::id_ints_body(object, sizes.object, &[wanted]);
        let reply = self.call(9, 10, body, ReplyIds::TaggedObjects).await?;
        let ids = wire::tagged_objects(&reply, &sizes)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids.into_iter().take(wanted as usize) {
            match self.referrer(id, object).await {
                Ok(referrer) => out.push(referrer),
                Err(InspectError::Collected) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    async fn referrer(&self, id: u64, target: u64) -> Result<JvmReferrer, InspectError> {
        let value = self.preview_object(id).await?;
        let slots = match &value {
            JvmValue::Array { length, .. } if *length <= REFERRER_ARRAY_SCAN => {
                index_names(self.array_elements(id, 0, *length).await?)
            }
            // too large to look for the index
            JvmValue::Array { .. } => Vec::new(),
            _ => {
                let class = self.class_of(id).await?;
                self.instance_fields(id, class).await?
            }
        };
        let via = slots
            .into_iter()
            .filter(|(_, slot)| matches!(slot, Value::Object { id, .. } if *id == target))
            .map(|(name, _)| name)
            .collect();
        Ok(JvmReferrer { value, via })
    }
}
