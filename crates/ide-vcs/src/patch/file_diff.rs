use super::{normalized, selected_sections, strip_option, valid_patch_path};
use crate::cli::{run, run_raw_env};
use crate::text_encoding;
use crate::{ChangeKind, PatchDiffContent, PatchFileDiff, Repo, TextEncoding};
use ide_core::{IdeError, IdeResult};
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_PREVIEW_BYTES: u64 = 4 << 20;

pub(crate) fn generate(
    repo: &Repo,
    patch: &str,
    path: &str,
    prefix: &str,
    encoding: &dyn Fn(&Path, &[u8]) -> TextEncoding,
) -> IdeResult<PatchFileDiff> {
    let patch = normalized(patch)?;
    let sections = selected_sections(&patch, Some(&[path.to_owned()]))?;
    let (first_section, first) = &sections[0];
    let before = safe_path(first.old_path.as_deref().unwrap_or(path), prefix)?;
    let after = safe_path(path, prefix)?;
    for (_, file) in &sections {
        if let Some(old) = &file.old_path {
            safe_path(old, prefix)?;
        }
    }
    let before_path = repo.root().join(before);
    let after_path = repo.root().join(after);
    let mut result = PatchFileDiff {
        path: (&after_path).into(),
        old_path: (before != after).then(|| (&before_path).into()),
        content: PatchDiffContent::Binary,
    };
    if sections.iter().any(|(_, file)| file.binary) {
        return Ok(result);
    }
    let Some(local) = read_regular(repo.root(), before)? else { return Ok(result) };
    let view = |bytes: Option<&[u8]>, path: &Path| {
        bytes.map_or(Some(None), |bytes| {
            let charset = encoding(path, bytes);
            (!text_encoding::is_binary(bytes, charset))
                .then(|| Some(text_encoding::decode(bytes, charset).into_owned()))
        })
    };
    let Some(local_text) = view(local.as_deref(), &before_path) else { return Ok(result) };
    let body: String = sections.iter().map(|(section, _)| *section).collect();
    if body.len() as u64 > MAX_PREVIEW_BYTES {
        return Err(too_large());
    }
    let autocrlf = run(repo.root(), &["config", "--get", "core.autocrlf"], None)
        .map(|result| result.stdout_str().trim().to_owned())
        .unwrap_or_else(|_| "false".to_owned());
    let autocrlf = format!("core.autocrlf={autocrlf}");

    let sandbox = tempfile::tempdir()?;
    if let Some(applied) = apply_in_sandbox(sandbox.path(), &body, prefix, before, after, local.as_deref(), &autocrlf)?
    {
        let Some(after_text) = view(applied.as_deref(), &after_path) else { return Ok(result) };
        result.content = if local_text == after_text && before == after {
            PatchDiffContent::Raw { local: local_text, patch: body, applies: true }
        } else {
            PatchDiffContent::Text { before: local_text, after: after_text }
        };
        return Ok(result);
    }

    let base = if first.kind == ChangeKind::Added { Some(None) } else { original_blob(repo, first_section).map(Some) };
    if let Some(base) = base {
        // The first attempt can leave a copied input in place. Use a fresh directory for the base.
        let original = tempfile::tempdir()?;
        if let Some(patched) =
            apply_in_sandbox(original.path(), &body, prefix, before, after, base.as_deref(), &autocrlf)?
        {
            let Some(base) = view(base.as_deref(), &before_path) else { return Ok(result) };
            let Some(patched) = view(patched.as_deref(), &after_path) else { return Ok(result) };
            result.content = PatchDiffContent::Conflict { local: local_text, base, patched };
            return Ok(result);
        }
    }
    result.content = PatchDiffContent::Raw { local: local_text, patch: body, applies: false };
    Ok(result)
}

fn safe_path<'a>(path: &'a str, prefix: &str) -> IdeResult<&'a Path> {
    path.strip_prefix(prefix)
        .map(Path::new)
        .filter(|path| valid_patch_path(path))
        .ok_or_else(|| IdeError::invalid("The patch contains a path outside its repository"))
}

fn too_large() -> IdeError {
    IdeError::invalid("Patch file is too large to preview")
}

// Outer None means non-regular content, inner None means the file is absent.
fn read_regular(root: &Path, rel: &Path) -> IdeResult<Option<Option<Vec<u8>>>> {
    let path = root.join(rel);
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Some(None)),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    let resolved = dunce::canonicalize(&path)?;
    if !resolved.starts_with(dunce::canonicalize(root)?) {
        return Err(IdeError::invalid("The patch contains a path outside its repository"));
    }
    let mut bytes = Vec::new();
    fs::File::open(resolved)?.take(MAX_PREVIEW_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err(too_large());
    }
    Ok(Some(Some(bytes)))
}

fn apply_in_sandbox(
    root: &Path,
    patch: &str,
    prefix: &str,
    before: &Path,
    after: &Path,
    bytes: Option<&[u8]>,
    autocrlf: &str,
) -> IdeResult<Option<Option<Vec<u8>>>> {
    let worktree = root.join("worktree");
    fs::create_dir(&worktree)?;
    if let Some(bytes) = bytes {
        let path = worktree.join(before);
        fs::create_dir_all(path.parent().expect("relative file path"))?;
        fs::write(path, bytes)?;
    }
    let boundary =
        std::env::join_paths([dunce::canonicalize(root)?]).map_err(|error| IdeError::invalid(error.to_string()))?;
    let strip = strip_option(prefix);
    let mut args = vec!["-c", autocrlf, "apply", "--binary"];
    args.extend(strip.as_deref());
    args.push("-");
    let output = run_raw_env(&worktree, &args, Some(patch.as_bytes()), &[("GIT_CEILING_DIRECTORIES", &boundary)])?;
    if output.code != Some(0) {
        return Ok(None);
    }
    read_regular(&worktree, after)
}

fn original_blob(repo: &Repo, section: &str) -> Option<Vec<u8>> {
    let oid = section
        .lines()
        .take_while(|line| !line.starts_with("@@"))
        .find_map(|line| line.strip_prefix("index ")?.split_once("..").map(|(oid, _)| oid));
    let oid = oid.filter(|oid| {
        (4..=64).contains(&oid.len())
            && oid.bytes().all(|byte| byte.is_ascii_hexdigit())
            && oid.bytes().any(|byte| byte != b'0')
    })?;
    let size = run(repo.root(), &["cat-file", "-s", oid], None).ok()?;
    if size.stdout_str().trim().parse::<u64>().map_or(true, |size| size > MAX_PREVIEW_BYTES) {
        return None;
    }
    run(repo.root(), &["cat-file", "blob", oid], None).ok().map(|blob| blob.stdout)
}
