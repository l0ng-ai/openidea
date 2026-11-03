use super::*;
use std::io::Read;

const TEXT_LIMIT: u64 = 32 * 1024 * 1024;

pub(super) fn copy_tree(from: &Path, to: &Path) -> IdeResult<()> {
    no_links(from)?;
    let metadata = fs::symlink_metadata(from)?;
    if metadata.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        fs::copy(from, to)?;
    } else {
        return Err(IdeError::invalid(format!("Not a regular Unity asset: {}", from.display())));
    }
    Ok(())
}

fn files(dir: &Path, out: &mut Vec<PathBuf>) -> IdeResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            files(&entry.path(), out)?;
        } else {
            out.push(entry.path());
        }
    }
    Ok(())
}

fn read_text(path: &Path) -> IdeResult<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(TEXT_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > TEXT_LIMIT {
        return Err(IdeError::invalid(format!(
            "Unity serialized asset exceeds the 32 MiB copy limit: {}",
            path.display()
        )));
    }
    String::from_utf8(bytes)
        .map_err(|_| IdeError::invalid(format!("Cannot rewrite binary Unity metadata: {}", path.display())))
}

fn guid(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()) && value.bytes().any(|b| b != b'0')
}

pub(super) fn regenerate(stage: &Path) -> IdeResult<()> {
    let mut paths = Vec::new();
    files(stage, &mut paths)?;
    let mut ids = HashMap::new();
    for path in paths.iter().filter(|p| is_meta(p)) {
        let text = read_text(path)?;
        let values: Vec<_> = text
            .trim_start_matches('\u{feff}')
            .lines()
            .filter_map(|l| l.strip_prefix("guid:").map(str::trim))
            .collect();
        if values.len() != 1 || !guid(values[0]) {
            return Err(IdeError::invalid(format!("Missing or invalid GUID in {}", path.display())));
        }
        if ids.insert(values[0].to_ascii_lowercase(), uuid::Uuid::new_v4().simple().to_string()).is_some() {
            return Err(IdeError::invalid("Duplicate source GUIDs; resolve them in Unity before copying"));
        }
    }
    for path in paths {
        let ext = path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
        if ext == "asmdef" || ext == "asmref" {
            let text = read_text(&path)?;
            let mut json: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| IdeError::invalid(e.to_string()))?;
            if rewrite_json(&mut json, &ids) {
                fs::write(&path, serde_json::to_string_pretty(&json).map_err(|e| IdeError::internal(e.to_string()))?)?;
            }
            continue;
        }
        let mut header = [0; 32];
        let n = fs::File::open(&path)?.read(&mut header)?;
        let header = String::from_utf8_lossy(&header[..n]);
        let header = header.trim_start_matches('\u{feff}');
        let yaml = header.starts_with("%YAML") || header.starts_with("--- !u!");
        if !yaml && !is_meta(&path) {
            // These formats may be binary under Mixed/Force Binary. We cannot
            // safely preserve internal references without Unity deserialization.
            if matches!(
                ext.as_str(),
                "asset"
                    | "prefab"
                    | "unity"
                    | "mat"
                    | "anim"
                    | "controller"
                    | "overridecontroller"
                    | "playable"
                    | "mask"
                    | "rendertexture"
                    | "physicmaterial"
                    | "physicsmaterial2d"
                    | "lighting"
                    | "terrainlayer"
                    | "guiskin"
                    | "flare"
                    | "cubemap"
                    | "spriteatlas"
                    | "spriteatlasv2"
                    | "preset"
                    | "shadervariants"
                    | "giparams"
                    | "lightingdata"
                    | "fontsettings"
                    | "texture2d"
                    | "mesh"
            ) {
                return Err(IdeError::invalid(format!(
                    "Cannot copy binary Unity serialized asset {}; use Force Text serialization in Unity",
                    path.display()
                )));
            }
            continue;
        }
        let before = read_text(&path)?;
        let after = rewrite_yaml(&before, &ids);
        if before != after {
            fs::write(&path, after)?;
        }
    }
    Ok(())
}

fn rewrite_json(value: &mut serde_json::Value, ids: &HashMap<String, String>) -> bool {
    match value {
        serde_json::Value::String(s) => {
            if let Some(id) = s.strip_prefix("GUID:").and_then(|id| ids.get(&id.to_ascii_lowercase())) {
                *s = format!("GUID:{id}");
                true
            } else {
                false
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().fold(false, |changed, v| rewrite_json(v, ids) || changed),
        serde_json::Value::Object(o) => o.values_mut().fold(false, |changed, v| rewrite_json(v, ids) || changed),
        _ => false,
    }
}

/// Patch GUID scalar tokens without reserializing Unity's YAML dialect. Quoted
/// strings, comments and indented block scalars are not asset references.
fn rewrite_yaml(text: &str, ids: &HashMap<String, String>) -> String {
    let mut bytes = text.as_bytes().to_vec();
    let mut offset = 0;
    let mut block_indent = None;
    let mut quote = None;
    for line in text.split_inclusive('\n') {
        let raw = line.as_bytes();
        let indent = raw.iter().take_while(|b| **b == b' ').count();
        if block_indent.is_some_and(|n| indent > n || line.trim().is_empty()) {
            offset += raw.len();
            continue;
        }
        block_indent = None;
        let mut i = 0;
        while i < raw.len() {
            let b = raw[i];
            if let Some(q) = quote {
                if q == b'"' && b == b'\\' {
                    i += 2;
                    continue;
                }
                if b == q {
                    if q == b'\'' && raw.get(i + 1) == Some(&q) {
                        i += 2;
                        continue;
                    }
                    quote = None;
                }
                i += 1;
                continue;
            }
            if b == b'#' && (i == 0 || raw[i - 1].is_ascii_whitespace()) {
                break;
            }
            if b == b'"' || b == b'\'' {
                let prefix = line[..i].trim();
                // Apostrophes inside plain scalars (e.g. Hero's Sword) do not
                // open a quoted scalar or suppress references on later lines.
                if prefix.is_empty() || prefix.ends_with([':', '-', '[', '{', ',']) {
                    quote = Some(b);
                    i += 1;
                    continue;
                }
            }
            if (b == b'|' || b == b'>') && line[..i].trim_end().ends_with([':', '-']) {
                block_indent = Some(indent);
                break;
            }
            if raw[i..].starts_with(b"guid:") {
                let prefix = line[..i].trim_start_matches('\u{feff}').trim_end();
                if prefix.is_empty() || prefix.ends_with(['{', ',']) {
                    let start = i + 5 + raw[i + 5..].iter().take_while(|b| **b == b' ' || **b == b'\t').count();
                    let end = start + 32;
                    if end <= raw.len()
                        && raw[start..end].iter().all(u8::is_ascii_hexdigit)
                        && (end == raw.len()
                            || raw[end].is_ascii_whitespace()
                            || matches!(raw[end], b',' | b'}' | b'#'))
                        && let Some(new) = ids.get(&line[start..end].to_ascii_lowercase())
                    {
                        bytes[offset + start..offset + end].copy_from_slice(new.as_bytes());
                        i = end;
                        continue;
                    }
                }
            }
            // Non-ASCII bytes cannot begin any token handled above.
            i += 1;
        }
        offset += raw.len();
    }
    String::from_utf8(bytes).expect("GUID substitutions preserve UTF-8")
}
