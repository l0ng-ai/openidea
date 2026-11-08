//! The class table and the instances of one class.

use super::{COUNTS_TIMEOUT, LinkInspector, wire};
use crate::ids::ReplyIds;
use ide_jvm_inspect::{ClassCount, InspectError, JvmValue, MAX_INSTANCES, name_to_signature, signature_to_name};

impl LinkInspector {
    /// Every loaded class with at least one instance, from one `InstanceCounts` for all of them.
    pub(super) async fn counts(&self) -> Result<Vec<ClassCount>, InspectError> {
        let sizes = self.sizes()?;
        let reply = self.call(1, 3, Vec::new(), ReplyIds::None).await?;
        let classes = wire::all_classes(&reply, &sizes)?;
        if classes.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<u64> = classes.iter().map(|(id, _)| *id).collect();
        let body = wire::instance_counts_body(&ids, &sizes);
        let reply = self.call_within(1, 21, body, ReplyIds::None, COUNTS_TIMEOUT).await?;
        let counts = wire::instance_counts(&reply)?;
        if counts.len() != classes.len() {
            return Err(InspectError::Failed(format!("{} counts for {} classes", counts.len(), classes.len())));
        }
        let mut out = Vec::new();
        for ((_, signature), instances) in classes.into_iter().zip(counts) {
            if instances == 0 {
                continue;
            }
            let name = signature_to_name(&signature)
                .ok_or_else(|| InspectError::Failed(format!("malformed class signature {signature:?}")))?;
            out.push(ClassCount { name, instances });
        }
        Ok(out)
    }

    /// Up to `min(limit, MAX_INSTANCES)` instances. One that was collected before its preview
    /// is left out; any other error fails the list.
    pub(super) async fn list_instances(&self, class_name: &str, limit: u32) -> Result<Vec<JvmValue>, InspectError> {
        let signature = name_to_signature(class_name).ok_or(InspectError::ClassNotLoaded)?;
        let sizes = self.sizes()?;
        let reply = self.call(1, 2, wire::signature_body(&signature), ReplyIds::None).await?;
        let classes = wire::classes_by_signature(&reply, &sizes)?;
        if classes.is_empty() {
            return Err(InspectError::ClassNotLoaded);
        }
        let wanted = limit.min(MAX_INSTANCES) as usize;
        let mut ids = Vec::new();
        for class in classes {
            // JDWP reads a maximum of 0 as "all of them".
            let remaining = wanted - ids.len();
            if remaining == 0 {
                break;
            }
            let body = wire::id_ints_body(class, sizes.reference_type, &[remaining as u32]);
            let reply = self.call(2, 16, body, ReplyIds::TaggedObjects).await?;
            ids.extend(wire::tagged_objects(&reply, &sizes)?.into_iter().take(remaining));
        }
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            match self.preview_object(id).await {
                Ok(value) => out.push(value),
                Err(InspectError::Collected) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }
}
