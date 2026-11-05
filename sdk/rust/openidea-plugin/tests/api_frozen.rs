//! Released plugin APIs never change (plugins/README.md, "Evolving the plugin API"):
//! wasmtime links a component only if every function type matches exactly, so
//! a field added to a record or a case added to a variant breaks every
//! component built for the release.
//!
//! `tests/api/<version>/` is the WIT of each release, copied when it was
//! frozen. Every interface, type and function in it must still exist in
//! `wit/` with the same definition; additions are fine. When a version is
//! released, copy `wit/` to `tests/api/<that version>/`. Until the first
//! release there is no snapshot and the API may still change freely.

use std::collections::BTreeMap;
use std::path::Path;
use wit_parser::{FunctionKind, Handle, Resolve, Type, TypeDefKind, TypeId, TypeOwner};

/// Everything a release promises, by key (`log/log`, `types/error`), rendered canonically.
fn surface(dir: &Path) -> BTreeMap<String, String> {
    let mut resolve = Resolve::default();
    let (pkg, _) = resolve.push_dir(dir).unwrap_or_else(|e| panic!("{}: {e:?}", dir.display()));
    let mut out = BTreeMap::new();
    for (name, &id) in &resolve.packages[pkg].interfaces {
        let iface = &resolve.interfaces[id];
        for (ty_name, &ty) in &iface.types {
            out.insert(format!("{name}/type {ty_name}"), definition(&resolve, ty));
        }
        for f in iface.functions.values() {
            let params: Vec<String> = f.params.iter().map(|p| format!("{}: {}", p.name, ty(&resolve, &p.ty))).collect();
            let result = f.result.as_ref().map(|r| format!(" -> {}", ty(&resolve, r))).unwrap_or_default();
            let kind = match f.kind {
                FunctionKind::Freestanding => "",
                FunctionKind::AsyncFreestanding => "async ",
                FunctionKind::Method(_) => "method ",
                FunctionKind::Static(_) => "static ",
                FunctionKind::Constructor(_) => "constructor ",
                _ => "other ",
            };
            out.insert(format!("{name}/func {}", f.name), format!("{kind}({}){result}", params.join(", ")));
        }
    }
    for (name, &id) in &resolve.packages[pkg].worlds {
        let world = &resolve.worlds[id];
        let keys = |m: &wit_parser::IndexMap<wit_parser::WorldKey, wit_parser::WorldItem>| {
            m.keys().map(|k| resolve.name_world_key(k)).collect::<Vec<_>>().join(", ")
        };
        out.insert(
            format!("world {name}"),
            format!("imports [{}] exports [{}]", keys(&world.imports), keys(&world.exports)),
        );
    }
    out
}

/// A named type's definition.
fn definition(r: &Resolve, id: TypeId) -> String {
    let def = &r.types[id];
    match &def.kind {
        TypeDefKind::Record(x) => {
            let f: Vec<_> = x.fields.iter().map(|f| format!("{}: {}", f.name, ty(r, &f.ty))).collect();
            format!("record {{ {} }}", f.join(", "))
        }
        TypeDefKind::Variant(x) => {
            let c: Vec<_> = x
                .cases
                .iter()
                .map(|c| c.ty.as_ref().map_or(c.name.clone(), |t| format!("{}({})", c.name, ty(r, t))))
                .collect();
            format!("variant {{ {} }}", c.join(", "))
        }
        TypeDefKind::Enum(x) => {
            format!("enum {{ {} }}", x.cases.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", "))
        }
        TypeDefKind::Flags(x) => {
            format!("flags {{ {} }}", x.flags.iter().map(|f| f.name.as_str()).collect::<Vec<_>>().join(", "))
        }
        TypeDefKind::Resource => "resource".to_owned(),
        // A `use`d type: the same type as the one it names.
        TypeDefKind::Type(t) => format!("= {}", ty(r, t)),
        _ => anonymous(r, id),
    }
}

/// A type in a position (parameter, field…): named types by name, others structurally.
fn ty(r: &Resolve, t: &Type) -> String {
    match t {
        Type::Id(id) => {
            let def = &r.types[*id];
            match (&def.name, def.owner) {
                (Some(name), TypeOwner::Interface(i)) => {
                    format!("{}.{name}", r.interfaces[i].name.as_deref().unwrap_or("?"))
                }
                (Some(name), _) => name.clone(),
                (None, _) => anonymous(r, *id),
            }
        }
        other => format!("{other:?}").to_lowercase(),
    }
}

fn anonymous(r: &Resolve, id: TypeId) -> String {
    let opt = |t: &Option<Type>| t.as_ref().map_or("_".to_owned(), |t| ty(r, t));
    match &r.types[id].kind {
        TypeDefKind::Option(t) => format!("option<{}>", ty(r, t)),
        TypeDefKind::List(t) => format!("list<{}>", ty(r, t)),
        TypeDefKind::Result(x) => format!("result<{}, {}>", opt(&x.ok), opt(&x.err)),
        TypeDefKind::Tuple(x) => format!("tuple<{}>", x.types.iter().map(|t| ty(r, t)).collect::<Vec<_>>().join(", ")),
        TypeDefKind::Handle(Handle::Own(t)) => format!("own<{}>", ty(r, &Type::Id(*t))),
        TypeDefKind::Handle(Handle::Borrow(t)) => format!("borrow<{}>", ty(r, &Type::Id(*t))),
        TypeDefKind::Type(t) => ty(r, t),
        other => format!("{other:?}"),
    }
}

/// The frozen releases (`tests/api/<version>/`), none before the first release.
fn releases(root: &Path) -> Vec<std::path::PathBuf> {
    match std::fs::read_dir(root.join("tests/api")) {
        Ok(dir) => dir.map(|e| e.unwrap().path()).filter(|p| p.is_dir()).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => panic!("tests/api: {e}"),
    }
}

#[test]
fn the_surface_covers_the_whole_api() {
    // Keeps the check below meaningful while there is no release to compare.
    let current = surface(&Path::new(env!("CARGO_MANIFEST_DIR")).join("wit"));
    assert!(current.len() > 50, "only {} items: did wit/ load?", current.len());
    assert!(current.keys().any(|k| k.starts_with("world ")));
    assert!(current.keys().any(|k| k.contains("/func ")));
    assert!(current.keys().any(|k| k.contains("/type ")));
}

#[test]
fn released_apis_are_unchanged() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let current = surface(&root.join("wit"));
    for dir in releases(root) {
        let release = surface(&dir);
        let version = dir.file_name().unwrap().to_string_lossy().into_owned();
        let mut broken = Vec::new();
        for (key, was) in &release {
            match current.get(key) {
                None => broken.push(format!("{key}: removed (was {was})")),
                // A world may gain imports and exports; everything else stays as it was.
                Some(now) if key.starts_with("world ") => {
                    let had = |s: &str, part: &str| -> Vec<String> {
                        let start = s.find(part).unwrap() + part.len();
                        let end = s[start..].find(']').unwrap() + start;
                        s[start..end].split(", ").filter(|x| !x.is_empty()).map(str::to_owned).collect()
                    };
                    for part in ["imports [", "exports ["] {
                        let now = had(now, part);
                        for item in had(was, part) {
                            if !now.contains(&item) {
                                broken.push(format!("{key}: no longer has {item}"));
                            }
                        }
                    }
                }
                Some(now) if now != was => broken.push(format!("{key}:\n      was {was}\n      now {now}")),
                Some(_) => {}
            }
        }
        assert!(broken.is_empty(), "plugin API {version} changed incompatibly:\n  {}", broken.join("\n  "));
        assert!(release.len() > 50, "{version}: only {} items: did the snapshot load?", release.len());
    }
}

#[test]
fn the_current_api_is_a_release_or_newer_than_all() {
    // `wit/` is either a frozen release or the next one; never older.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let src = std::fs::read_to_string(root.join("wit/plugin.wit")).unwrap();
    let current = src.lines().find_map(|l| l.trim().strip_prefix("package openidea:plugin@")).unwrap();
    let current: Vec<u64> = current.trim_end_matches(';').split('.').map(|p| p.parse().unwrap()).collect();
    for dir in releases(root) {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let release: Vec<u64> = name.split('.').map(|p| p.parse().unwrap()).collect();
        assert!(release <= current, "tests/api/{name} is newer than wit/ ({current:?})");
    }
}
