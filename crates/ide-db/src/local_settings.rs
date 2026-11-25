use ide_core::{IdeError, IdeResult};
use std::path::Path;

pub(super) fn persist_local(path: &Path, data: &[u8]) -> IdeResult<()> {
    let dir = path.parent().expect("registry paths have a parent");
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut tmp, data)?;
    tmp.persist(path).map_err(|e| IdeError::from(e.error))?;
    Ok(())
}
