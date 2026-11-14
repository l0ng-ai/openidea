//! Every function the plugin API imports is reachable through the SDK: a new
//! WIT function without a wrapper in `src/` (and so in the mock host, which
//! mirrors the wrappers) fails here instead of going unnoticed by plugin
//! authors. The check is textual: free functions must be called as
//! `wit::<interface>::<function>(`, resource methods as `.<method>(`.

use std::path::Path;
use wit_parser::{FunctionKind, Resolve, WorldItem};

fn sdk_source() -> String {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = String::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "rs") {
            out.push_str(&std::fs::read_to_string(path).unwrap());
        }
    }
    out
}

#[test]
fn every_imported_function_has_an_sdk_wrapper() {
    let mut resolve = Resolve::default();
    let (pkg, _) = resolve.push_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("wit")).unwrap();
    let source = sdk_source();
    let world = resolve.packages[pkg].worlds["plugin"];
    let mut missing = Vec::new();
    let mut checked = 0;
    for item in resolve.worlds[world].imports.values() {
        let WorldItem::Interface { id, .. } = item else { continue };
        let iface = &resolve.interfaces[*id];
        if iface.package != Some(pkg) {
            continue; // WASI
        }
        let module = iface.name.as_deref().unwrap().replace('-', "_");
        for f in iface.functions.values() {
            let name = f.item_name().replace('-', "_");
            let call = match f.kind {
                FunctionKind::Freestanding | FunctionKind::AsyncFreestanding => format!("wit::{module}::{name}("),
                FunctionKind::Constructor(_) => "::new(".to_owned(),
                FunctionKind::Static(_) | FunctionKind::AsyncStatic(_) => format!("::{name}("),
                _ => format!(".{name}("),
            };
            checked += 1;
            if !source.contains(&call) {
                missing.push(format!("{}.{} (expected `{call}`)", iface.name.as_deref().unwrap(), f.name));
            }
        }
    }
    assert!(checked > 30, "only {checked} functions found: is the world still called `plugin`?");
    assert!(missing.is_empty(), "plugin API functions without an SDK wrapper:\n  {}", missing.join("\n  "));
}

#[test]
fn every_optional_export_can_be_registered() {
    let mut resolve = Resolve::default();
    let (pkg, _) = resolve.push_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("wit")).unwrap();
    let source = sdk_source();
    let base = &resolve.worlds[resolve.packages[pkg].worlds["plugin"]];
    let mut missing = Vec::new();
    let mut checked = 0;
    for (name, &id) in &resolve.packages[pkg].worlds {
        if !name.starts_with("plugin-") {
            continue;
        }
        for (key, item) in &resolve.worlds[id].exports {
            let WorldItem::Interface { id, .. } = item else { continue };
            if base.exports.contains_key(key) {
                continue;
            }
            let module = resolve.interfaces[*id].name.as_deref().unwrap().replace('-', "_");
            let guest = format!("exports::openidea::plugin::{module}::Guest for");
            checked += 1;
            if !source.contains(&guest) {
                missing.push(format!("{name}: {module}"));
            }
        }
    }
    assert!(checked >= 5, "only {checked} optional exports found");
    assert!(missing.is_empty(), "optional exports register_plugin! can't export:\n  {}", missing.join("\n  "));
}
