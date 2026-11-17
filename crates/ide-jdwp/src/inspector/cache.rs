use super::wire::FieldInfo;
use std::collections::HashMap;
use std::sync::Arc;

/// What was learnt about classes. Reference types stay valid while their class is loaded, which
/// a stop does not guarantee for the next one, so everything is dropped when the link's stop
/// changes.
#[derive(Default)]
pub(super) struct Caches {
    generation: u64,
    pub(super) names: HashMap<u64, String>,
    pub(super) fields: HashMap<u64, Arc<Vec<FieldInfo>>>,
    pub(super) superclasses: HashMap<u64, u64>,
}

impl Caches {
    /// The caches of `generation`, emptied first if they belong to another stop.
    pub(super) fn at(&mut self, generation: u64) -> &mut Caches {
        if self.generation != generation {
            *self = Caches { generation, ..Caches::default() };
        }
        self
    }

    /// Whether an answer read in `generation` still belongs in the caches.
    pub(super) fn accepts(&self, generation: u64) -> bool {
        self.generation == generation
    }
}
