//! Released plugin APIs never change (plugins/README.md, "Evolving the plugin API"):
//! wasmtime links a component only if every function type matches exactly, so
//! a field added to a record or a case added to a variant breaks every
//! component built for the release.
//!
//! `tests/api/released/` is the WIT of the latest released version. Every
//! interface, type and function in it must still exist in `wit/` with the same
//! definition. Additions need a newer version than the snapshot's: under the
//! released version `wit/` must match it exactly. When a version ships, copy
//! `wit/` over the snapshot (the release workflow refuses a tag whose `wit/`
//! version differs from it). Each snapshot passed this check against the one
//! before, so the latest one covers every earlier release.

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

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// The latest released version's WIT.
fn released() -> std::path::PathBuf {
    root().join("tests/api/released")
}

/// The `package openidea:plugin@x.y.z` version of a WIT directory.
fn version(dir: &Path) -> Vec<u64> {
    let src = std::fs::read_to_string(dir.join("plugin.wit")).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    let v = src.lines().find_map(|l| l.trim().strip_prefix("package openidea:plugin@")).unwrap();
    v.trim_end_matches(';').split('.').map(|p| p.parse().unwrap()).collect()
}

#[test]
fn the_surface_covers_the_whole_api() {
    for dir in [root().join("wit"), released()] {
        let items = surface(&dir);
        assert!(items.len() > 50, "{}: only {} items: did it load?", dir.display(), items.len());
        assert!(items.keys().any(|k| k.starts_with("world ")));
        assert!(items.keys().any(|k| k.contains("/func ")));
        assert!(items.keys().any(|k| k.contains("/type ")));
    }
}

#[test]
fn the_released_api_is_unchanged() {
    let current = surface(&root().join("wit"));
    let release = surface(&released());
    let mut broken = Vec::new();
    for (key, was) in &release {
        match current.get(key) {
            None => broken.push(format!("{key}: removed (was {was})")),
            // A world may gain imports and exports; everything else stays as it was. Items are
            // compared without their `@version`: a later minor names them `@1.2.0`, and wasmtime
            // resolves the release's `@1.1.0` to it.
            Some(now) if key.starts_with("world ") => {
                let had = |s: &str, part: &str| -> Vec<String> {
                    let start = s.find(part).unwrap() + part.len();
                    let end = s[start..].find(']').unwrap() + start;
                    s[start..end]
                        .split(", ")
                        .filter(|x| !x.is_empty())
                        .map(|x| x.split('@').next().unwrap_or(x).to_owned())
                        .collect()
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
    assert!(broken.is_empty(), "the released plugin API changed incompatibly:\n  {}", broken.join("\n  "));
}

#[test]
fn additions_need_a_newer_version() {
    // A component built from `wit/` imports what `wit/` declares; under a released version an
    // IDE of that release would lack the additions and refuse it.
    let (current, release) = (version(&root().join("wit")), version(&released()));
    assert!(current >= release, "wit/ ({current:?}) is older than the released API ({release:?})");
    if current == release {
        let (now, was) = (surface(&root().join("wit")), surface(&released()));
        let added: Vec<_> = now.keys().filter(|k| now.get(*k) != was.get(*k)).collect();
        assert!(
            added.is_empty(),
            "wit/ adds to the released version {release:?}; bump the package version in wit/ \
             (and the SDK's copy, ENGINE_VERSION, API_VERSION) first:\n  {added:?}"
        );
    }
}
