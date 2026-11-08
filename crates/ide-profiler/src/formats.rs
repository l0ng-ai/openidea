//! Profile formats: collapsed ("folded") stacks, V8 `.cpuprofile` JSON and
//! `perf script` text.

use crate::ProfileFrameKind;
use crate::tree::{FrameKey, TreeBuilder};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A frame of a collapsed stack: `name (file:line)` (py-spy), otherwise just the name
/// (async-profiler `com/x/Y.m_[j]`, perf / stackcollapse output).
fn folded_frame(raw: &str, base: &Path) -> FrameKey {
    let raw = raw.trim();
    if let Some(open) = raw.rfind(" (")
        && raw.ends_with(')')
    {
        let inner = &raw[open + 2..raw.len() - 1];
        if let Some((file, line)) = inner.rsplit_once(':')
            && let Ok(line) = line.parse::<u32>()
        {
            let p = Path::new(file);
            let file = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
            return FrameKey {
                name: raw[..open].to_owned(),
                file: Some(file),
                line: Some(line.saturating_sub(1)),
                kind: ProfileFrameKind::Code,
            };
        }
    }
    // async-profiler frame type suffixes (`_[j]` JIT, `_[i]` interpreted, `_[k]` kernel…).
    let name = match raw.rfind("_[") {
        Some(i) if raw.ends_with(']') && raw.len() - i <= 5 => &raw[..i],
        _ => raw,
    };
    FrameKey::named(name)
}

/// The allocated type of an async-profiler allocation leaf (`byte[]_[i]`, `java.lang.String_[k]`).
fn allocated_type(raw: &str) -> Option<&str> {
    let raw = raw.trim();
    let name = raw.strip_suffix("_[i]").or_else(|| raw.strip_suffix("_[k]"))?;
    (!name.is_empty()).then_some(name)
}

/// Adds collapsed stacks (`root;caller;callee <count>` per line). With `allocation_leaf`
/// the last frame of a stack is the allocated type.
pub(crate) fn add_folded(b: &mut TreeBuilder, text: &str, base: &Path, allocation_leaf: bool) {
    for line in text.lines() {
        let line = line.trim_end();
        let Some((stack, count)) = line.rsplit_once(' ') else { continue };
        let Ok(count) = count.trim().parse::<f64>() else { continue };
        if stack.is_empty() || count <= 0.0 {
            continue;
        }
        let mut frames: Vec<&str> = stack.split(';').collect();
        let leaf = if allocation_leaf { frames.last().and_then(|f| allocated_type(f)) } else { None };
        if leaf.is_some() {
            frames.pop();
        }
        let stack = frames.into_iter().map(|f| folded_frame(f, base)).chain(leaf.map(FrameKey::allocated));
        b.add_stack(stack, count);
    }
}

fn url_path(url: &str) -> Option<PathBuf> {
    if let Some(rest) = url.strip_prefix("file://") {
        let decoded = percent_decode(rest);
        // `file:///C:/x` on Windows.
        let trimmed = if decoded.len() > 2 && decoded.as_bytes()[2] == b':' { &decoded[1..] } else { &decoded[..] };
        return Some(PathBuf::from(trimmed));
    }
    let p = Path::new(url);
    p.is_absolute().then(|| p.to_path_buf())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether a V8 CPU profile has frames from `root` outside `node_modules`.
pub(crate) fn cpuprofile_runs_code_of(json: &str, root: &Path) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return false };
    // Node reports real paths (`/private/tmp` for `/tmp` on macOS).
    let real = std::fs::canonicalize(root).ok();
    let roots: Vec<&Path> = std::iter::once(root).chain(real.as_deref()).collect();
    v.get("nodes").and_then(Value::as_array).into_iter().flatten().any(|n| {
        let url = n.pointer("/callFrame/url").and_then(Value::as_str).unwrap_or_default();
        url_path(url).is_some_and(|p| {
            roots
                .iter()
                .any(|r| p.strip_prefix(r).is_ok_and(|rel| !rel.components().any(|c| c.as_os_str() == "node_modules")))
        })
    })
}

/// Adds a V8 CPU profile (`node --cpu-prof`), weighted by sampled time in milliseconds.
pub(crate) fn add_cpuprofile(b: &mut TreeBuilder, json: &str) -> Result<(), String> {
    let v: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let nodes = v.get("nodes").and_then(Value::as_array).ok_or("not a CPU profile: no nodes")?;
    let mut by_id: HashMap<i64, &Value> = HashMap::new();
    let mut parent: HashMap<i64, i64> = HashMap::new();
    for n in nodes {
        let Some(id) = n.get("id").and_then(Value::as_i64) else { continue };
        by_id.insert(id, n);
        for c in n.get("children").and_then(Value::as_array).into_iter().flatten() {
            if let Some(c) = c.as_i64() {
                parent.insert(c, id);
            }
        }
    }
    // Self time per node: sample time deltas (µs); fall back to hit counts.
    let mut self_time: HashMap<i64, f64> = HashMap::new();
    let samples = v.get("samples").and_then(Value::as_array);
    let deltas = v.get("timeDeltas").and_then(Value::as_array);
    match (samples, deltas) {
        (Some(s), Some(d)) if s.len() == d.len() && !s.is_empty() => {
            // `timeDeltas[i]` is the time before sample `i`; it belongs to the previous sample.
            for (i, sample) in s.iter().enumerate() {
                let Some(id) = sample.as_i64() else { continue };
                let dt = d.get(i + 1).and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
                *self_time.entry(id).or_default() += dt / 1000.0;
            }
        }
        _ => {
            for (id, n) in &by_id {
                let hits = n.get("hitCount").and_then(Value::as_f64).unwrap_or(0.0);
                if hits > 0.0 {
                    self_time.insert(*id, hits);
                }
            }
        }
    }
    let frame_of = |n: &Value| -> Option<FrameKey> {
        let cf = n.get("callFrame")?;
        let name = cf.get("functionName").and_then(Value::as_str).unwrap_or_default();
        let url = cf.get("url").and_then(Value::as_str).unwrap_or_default();
        if name == "(root)" {
            return None;
        }
        let file = url_path(url);
        let name = if name.is_empty() { "(anonymous)".to_owned() } else { name.to_owned() };
        let line =
            file.as_ref().and(cf.get("lineNumber").and_then(Value::as_i64)).filter(|l| *l >= 0).map(|l| l as u32);
        Some(FrameKey { name, file, line, kind: ProfileFrameKind::Code })
    };
    for (id, weight) in self_time {
        if weight <= 0.0 {
            continue;
        }
        let mut chain = Vec::new();
        let mut cur = Some(id);
        let mut guard = 0;
        while let Some(c) = cur {
            if let Some(f) = by_id.get(&c).and_then(|n| frame_of(n)) {
                chain.push(f);
            }
            cur = parent.get(&c).copied();
            guard += 1;
            if guard > 10_000 {
                break;
            }
        }
        chain.reverse();
        b.add_stack(chain, weight);
    }
    Ok(())
}

/// Adds `perf script` output: one sample per blank-line separated block,
/// a header line followed by leaf-first frames `  addr symbol+0x1f (dso)`.
pub(crate) fn add_perf_script(b: &mut TreeBuilder, text: &str) {
    let mut frames: Vec<FrameKey> = Vec::new();
    let mut in_sample = false;
    let mut flush = |frames: &mut Vec<FrameKey>| {
        if !frames.is_empty() {
            frames.reverse();
            b.add_stack(std::mem::take(frames), 1.0);
        }
    };
    for line in text.lines() {
        if line.trim().is_empty() {
            flush(&mut frames);
            in_sample = false;
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            flush(&mut frames);
            in_sample = true;
            continue;
        }
        if !in_sample {
            continue;
        }
        let mut parts = line.trim().splitn(2, ' ');
        let _addr = parts.next();
        let rest = parts.next().unwrap_or("[unknown]").trim();
        // Drop the `(dso)` and the `+0x…` offset.
        let sym = rest.rfind(" (").map_or(rest, |i| &rest[..i]);
        let sym = sym.rfind("+0x").map_or(sym, |i| &sym[..i]);
        let sym = if sym.is_empty() { "[unknown]" } else { sym };
        frames.push(FrameKey::named(sym));
    }
    flush(&mut frames);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProfileMode;

    #[test]
    fn allocation_leaves_become_types() {
        let mut b = TreeBuilder::new();
        let text = "Alloc.main;Alloc.garbage;byte[]_[i] 541064184\n\
                    Alloc.main;Alloc.strings;java/lang/StringBuilder.toString;java.lang.String_[i] 6815731\n\
                    Alloc.main;Alloc.retained;byte[]_[k] 4112\n\
                    java.lang.String_[i] 524287\n";
        add_folded(&mut b, text, Path::new("/p"), true);
        let p = b.finish("async-profiler", "bytes", ProfileMode::Allocations);
        assert_eq!(p.total, 541064184.0 + 6815731.0 + 4112.0 + 524287.0);
        let kind = |n: &str| p.frames.iter().find(|f| f.name == n).unwrap().kind;
        assert_eq!(kind("byte[]"), ProfileFrameKind::AllocatedType);
        assert_eq!(kind("java.lang.String"), ProfileFrameKind::AllocatedType);
        assert_eq!(kind("Alloc.garbage"), ProfileFrameKind::Code);
        assert_eq!(kind("java/lang/StringBuilder.toString"), ProfileFrameKind::Code);
        assert_eq!(p.frames.iter().filter(|f| f.name == "byte[]").count(), 1, "_[i] and _[k] are one type");
    }

    #[test]
    fn cpu_mode_keeps_kernel_leaf_as_code() {
        let mut b = TreeBuilder::new();
        add_folded(&mut b, "java/lang/Thread.run;__psynch_cvwait_[k] 3\n", Path::new("/p"), false);
        let p = b.finish("async-profiler", "samples", ProfileMode::Cpu);
        assert!(p.frames.iter().all(|f| f.kind == ProfileFrameKind::Code));
        assert!(p.frames.iter().any(|f| f.name == "__psynch_cvwait"));
    }

    #[test]
    fn folded_stacks_with_py_spy_and_async_profiler_frames() {
        let mut b = TreeBuilder::new();
        let text = "<module> (main.py:10);compute (/abs/lib.py:5) 3\n\
                    <module> (main.py:10) 1\n\
                    java/lang/Thread.run_[j];com/x/App.work_[i] 2\n\
                    garbage\n";
        add_folded(&mut b, text, Path::new("/proj"), false);
        let p = b.finish("t", "samples", ProfileMode::Cpu);
        assert_eq!(p.total, 6.0);
        let compute = p.frames.iter().find(|f| f.name == "compute").unwrap();
        assert_eq!(compute.file.as_deref(), Some(Path::new("/abs/lib.py")));
        assert_eq!(compute.line, Some(4));
        let module = p.frames.iter().find(|f| f.name == "<module>").unwrap();
        assert_eq!(module.file.as_deref(), Some(Path::new("/proj/main.py")));
        assert!(p.frames.iter().any(|f| f.name == "com/x/App.work"));
    }

    #[test]
    fn cpuprofile_project_code_detection() {
        let profile = |url: &str| {
            format!(r#"{{"nodes":[{{"id":1,"callFrame":{{"functionName":"f","url":"{url}","lineNumber":0}}}}]}}"#)
        };
        let root = Path::new("/work/app");
        assert!(cpuprofile_runs_code_of(&profile("file:///work/app/src/index.ts"), root));
        assert!(!cpuprofile_runs_code_of(&profile("file:///work/app/node_modules/pnpm/dist/pnpm.cjs"), root));
        assert!(!cpuprofile_runs_code_of(&profile("file:///home/u/.cache/node/corepack/pnpm/lib/main.js"), root));
        assert!(!cpuprofile_runs_code_of(&profile("node:internal/main"), root));
    }

    #[test]
    fn cpuprofile_weights_by_time() {
        let json = r#"{"nodes":[
            {"id":1,"callFrame":{"functionName":"(root)","url":"","lineNumber":-1},"children":[2]},
            {"id":2,"callFrame":{"functionName":"main","url":"file:///app/my%20dir/index.js","lineNumber":3},"children":[3,4]},
            {"id":3,"callFrame":{"functionName":"","url":"file:///app/my%20dir/index.js","lineNumber":7}},
            {"id":4,"callFrame":{"functionName":"(garbage collector)","url":"","lineNumber":-1}}],
            "startTime":0,"endTime":10,"samples":[3,3,2,4],"timeDeltas":[0,1000,2000,500]}"#;
        let mut b = TreeBuilder::new();
        add_cpuprofile(&mut b, json).unwrap();
        let p = b.finish("node", "ms", ProfileMode::Cpu);
        // Sample i gets delta i+1: 3→1ms, 3→2ms, 2→0.5ms, 4→0.
        assert!((p.total - 3.5).abs() < 1e-9);
        let main = p.frames.iter().find(|f| f.name == "main").unwrap();
        assert_eq!(main.file.as_deref(), Some(Path::new("/app/my dir/index.js")));
        assert_eq!(main.line, Some(3));
        assert!(p.frames.iter().any(|f| f.name == "(anonymous)"));
        assert!(add_cpuprofile(&mut TreeBuilder::new(), "{}").is_err());
    }

    #[test]
    fn cpuprofile_without_deltas_uses_hit_counts() {
        let json = r#"{"nodes":[{"id":1,"callFrame":{"functionName":"(root)","url":""},"children":[2]},
            {"id":2,"callFrame":{"functionName":"f","url":"node:internal/x"},"hitCount":4}]}"#;
        let mut b = TreeBuilder::new();
        add_cpuprofile(&mut b, json).unwrap();
        let p = b.finish("node", "samples", ProfileMode::Cpu);
        assert_eq!(p.total, 4.0);
        assert_eq!(p.frames.iter().find(|f| f.name == "f").unwrap().file, None);
    }

    #[test]
    fn perf_script_blocks_become_stacks() {
        let text = "app 123 100.0:     250000 cpu-clock:\n\
                    \t    55d0c1 app::work+0x12 (/bin/app)\n\
                    \t    55d0b0 main+0x20 (/bin/app)\n\
                    \n\
                    app 123 100.1:     250000 cpu-clock:\n\
                    \t    55d0b0 main+0x20 (/bin/app)\n\
                    \t    ffffff [unknown] ([kernel.kallsyms])\n";
        let mut b = TreeBuilder::new();
        add_perf_script(&mut b, text);
        let p = b.finish("perf", "samples", ProfileMode::Cpu);
        assert_eq!(p.total, 2.0);
        let root = &p.nodes[0];
        let names: Vec<&str> =
            root.children.iter().map(|c| p.frames[p.nodes[*c as usize].frame as usize].name.as_str()).collect();
        assert!(names.contains(&"main") && names.contains(&"[unknown]"));
        assert!(p.frames.iter().any(|f| f.name == "app::work"));
    }
}
