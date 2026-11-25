//! Single JDWP lookups. Class facts are cached for the stop they were read in.

use super::{LinkInspector, wire};
use crate::codec::Value;
use crate::ids::ReplyIds;
use ide_jvm_inspect::{InspectError, signature_to_name};
use std::sync::{Arc, PoisonError};
use wire::FieldInfo;

impl LinkInspector {
    fn with_caches<R>(&self, generation: u64, f: impl FnOnce(&mut super::Caches) -> R) -> R {
        let mut caches = self.caches.lock().unwrap_or_else(PoisonError::into_inner);
        f(caches.at(generation))
    }

    /// Keeps `f`'s entry unless the stop changed since `generation`.
    fn remember(&self, generation: u64, f: impl FnOnce(&mut super::Caches)) {
        let mut caches = self.caches.lock().unwrap_or_else(PoisonError::into_inner);
        if caches.accepts(generation) {
            f(&mut caches);
        }
    }

    /// `ObjectReference.ReferenceType`: the class of `object`.
    pub(super) async fn class_of(&self, object: u64) -> Result<u64, InspectError> {
        let sizes = self.sizes()?;
        let reply = self.call(9, 1, wire::id_body(object, sizes.object), ReplyIds::None).await?;
        wire::reference_type(&reply, &sizes)
    }

    /// Display name of a class (`int[]`, `com.x.Foo$Bar`).
    pub(super) async fn class_name(&self, class: u64) -> Result<String, InspectError> {
        let generation = self.link.generation();
        if let Some(name) = self.with_caches(generation, |c| c.names.get(&class).cloned()) {
            return Ok(name);
        }
        let sizes = self.sizes()?;
        let reply = self.call(2, 1, wire::id_body(class, sizes.reference_type), ReplyIds::None).await?;
        let signature = wire::string(&reply)?;
        let name = signature_to_name(&signature)
            .ok_or_else(|| InspectError::Failed(format!("malformed class signature {signature:?}")))?;
        self.remember(generation, |c| {
            c.names.insert(class, name.clone());
        });
        Ok(name)
    }

    /// The fields a class declares, statics included.
    pub(super) async fn declared_fields(&self, class: u64) -> Result<Arc<Vec<FieldInfo>>, InspectError> {
        let generation = self.link.generation();
        if let Some(fields) = self.with_caches(generation, |c| c.fields.get(&class).cloned()) {
            return Ok(fields);
        }
        let sizes = self.sizes()?;
        let reply = self.call(2, 4, wire::id_body(class, sizes.reference_type), ReplyIds::None).await?;
        let fields = Arc::new(wire::fields(&reply, &sizes)?);
        self.remember(generation, |c| {
            c.fields.insert(class, fields.clone());
        });
        Ok(fields)
    }

    /// The superclass of a class, 0 for `java.lang.Object`.
    pub(super) async fn superclass_of(&self, class: u64) -> Result<u64, InspectError> {
        let generation = self.link.generation();
        if let Some(superclass) = self.with_caches(generation, |c| c.superclasses.get(&class).copied()) {
            return Ok(superclass);
        }
        let sizes = self.sizes()?;
        let reply = self.call(3, 1, wire::id_body(class, sizes.reference_type), ReplyIds::None).await?;
        let superclass = wire::superclass(&reply, &sizes)?;
        self.remember(generation, |c| {
            c.superclasses.insert(class, superclass);
        });
        Ok(superclass)
    }

    /// `ObjectReference.GetValues`, in the order of `fields`.
    pub(super) async fn read_values(&self, object: u64, fields: &[u64]) -> Result<Vec<Value>, InspectError> {
        let sizes = self.sizes()?;
        let body = wire::get_values_body(object, fields, &sizes);
        let reply = self.call(9, 2, body, ReplyIds::Values).await?;
        let values = wire::values(&reply, &sizes)?;
        if values.len() != fields.len() {
            return Err(InspectError::Failed(format!("{} values for {} fields", values.len(), fields.len())));
        }
        Ok(values)
    }

    pub(super) async fn array_length(&self, array: u64) -> Result<u32, InspectError> {
        let sizes = self.sizes()?;
        wire::length(&self.call(13, 1, wire::id_body(array, sizes.object), ReplyIds::None).await?)
    }

    /// `length` elements from `first`; nothing is sent for an empty range.
    pub(super) async fn array_elements(&self, array: u64, first: u32, length: u32) -> Result<Vec<Value>, InspectError> {
        if length == 0 {
            return Ok(Vec::new());
        }
        let sizes = self.sizes()?;
        let body = wire::id_ints_body(array, sizes.object, &[first, length]);
        let reply = self.call(13, 2, body, ReplyIds::ArrayRegion).await?;
        let elements = wire::array_region(&reply, &sizes)?;
        if elements.len() != length as usize {
            return Err(InspectError::Failed(format!("{} elements for a range of {length}", elements.len())));
        }
        Ok(elements)
    }
}
