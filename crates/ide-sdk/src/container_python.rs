//! A Docker or Compose run target's Python as the project interpreter
//! (`languages.python.interpreter = "target:<id>"`, PyCharm's Docker / Docker Compose
//! interpreter).
//!
//! basedpyright / pyright run on this machine, so the library folders of the
//! container's `sys.path` are copied here once per image (a snapshot) and given to
//! the server as `extraPaths`. Its interpreter is a neutral one: an empty virtualenv
//! the IDE creates, so no local site-packages mix in. Without any local Python the
//! server gets `extraPaths` alone and its bundled typeshed standard library.
//!
//! The snapshot is read-only: packages change in the image (requirements, Dockerfile)
//! and a rebuilt image gets a new snapshot. Taking one runs the docker CLI (`ide-host`).

use crate::apply::merge_init_options;
use crate::exec::{query_in, which};
use crate::libraries::{LibraryGroup, LibraryRoot};
use crate::python::PythonPackage;
use ide_core::{IdeError, IdeResult};
use ide_language::LanguageServerConfig;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Run in the container with `python -c`: prints [`PROBE_MARKER`] and a JSON
/// [`Probe`] (an entrypoint may print more around it).
pub const PROBE: &str = "import json,os,sys,sysconfig\n\
p=sysconfig.get_paths()\n\
print('OPENIDEA-PYTHON '+json.dumps({'version':'%d.%d.%d'%sys.version_info[:3],\
'executable':sys.executable,'stdlib':[p.get('stdlib'),p.get('platstdlib')],\
'path':[x for x in sys.path if x and os.path.isdir(x)]}))";
const PROBE_MARKER: &str = "OPENIDEA-PYTHON ";

/// What [`PROBE`] prints about the container's interpreter.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Probe {
    /// `3.12.7`.
    pub version: String,
    pub executable: String,
    /// `stdlib` and `platstdlib` of `sysconfig`.
    pub stdlib: Vec<Option<String>>,
    /// The folders of `sys.path`, in order.
    pub path: Vec<String>,
}

pub fn parse_probe(out: &str) -> IdeResult<Probe> {
    let json = out
        .lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix(PROBE_MARKER))
        .ok_or_else(|| IdeError::internal(format!("the container's Python printed no paths: {}", out.trim())))?;
    serde_json::from_str(json).map_err(|e| IdeError::internal(format!("cannot read the container's Python paths: {e}")))
}

/// The container folders a snapshot copies: the `sys.path` folders outside the standard
/// library (its stubs come with the server) and outside the project, which is here already.
/// A folder inside another one of the list is copied with it.
pub fn folders_to_copy(probe: &Probe, container_root: &str) -> Vec<String> {
    let under = |path: &str, dir: &str| {
        let dir = dir.trim_end_matches('/');
        path == dir || path.starts_with(&format!("{dir}/")) || dir.is_empty()
    };
    let stdlib: Vec<&str> = probe.stdlib.iter().flatten().map(String::as_str).collect();
    // `site-packages` lives inside the standard library's folder.
    let packages = |path: &str| path.split('/').any(|c| c == "site-packages" || c == "dist-packages");
    let mut out: Vec<String> = Vec::new();
    for path in &probe.path {
        let path = path.trim_end_matches('/');
        if !path.starts_with('/')
            || (stdlib.iter().any(|s| under(path, s)) && !packages(path))
            || (!container_root.trim().is_empty() && under(path, container_root))
            || out.iter().any(|o| under(path, o))
        {
            continue;
        }
        out.retain(|o| !under(o, path));
        out.push(path.to_owned());
    }
    out
}

/// Where a snapshot in `dir` keeps its copy of the container folder `container`.
pub fn local_folder(dir: &Path, container: &str) -> PathBuf {
    container.split('/').filter(|c| !c.is_empty() && *c != "." && *c != "..").fold(dir.join("fs"), |p, c| p.join(c))
}

/// `snapshot.json` of a snapshot folder.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Snapshot {
    /// `sha256:…` of the image the folders were copied from.
    pub image: String,
    pub probe: Probe,
    /// The copied container folders ([`local_folder`] has them here).
    pub folders: Vec<String>,
    /// The neutral interpreter given to the language server; `None` without a local Python.
    pub neutral_python: Option<PathBuf>,
}

const SNAPSHOT_FILE: &str = "snapshot.json";
/// Names the snapshot folder in use, in the target's folder.
const CURRENT_FILE: &str = "current";

/// A target's snapshots: `<cache>/<target>/<image>/`.
pub fn target_dir(cache: &Path, target_id: &str) -> PathBuf {
    cache.join(dir_name(target_id))
}

/// The folder name of an image id or target id.
pub fn dir_name(id: &str) -> String {
    let id = id.strip_prefix("sha256:").map(|hex| &hex[..hex.len().min(16)]).unwrap_or(id);
    let name: String =
        id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if name.is_empty() { "_".into() } else { name }
}

/// The snapshot in use for the target whose folder is `target_dir`, with its folder.
pub fn current(target_dir: &Path) -> Option<(PathBuf, Snapshot)> {
    let name = std::fs::read_to_string(target_dir.join(CURRENT_FILE)).ok()?;
    let dir = target_dir.join(dir_name(name.trim()));
    read(&dir).map(|s| (dir, s))
}

/// The complete snapshot in `dir`, if there is one.
pub fn read(dir: &Path) -> Option<Snapshot> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(SNAPSHOT_FILE)).ok()?).ok()
}

/// Writes `snapshot.json` (last: a folder without it is incomplete).
pub fn write(dir: &Path, snapshot: &Snapshot) -> IdeResult<()> {
    let json = serde_json::to_string_pretty(snapshot).map_err(|e| IdeError::internal(e.to_string()))?;
    std::fs::write(dir.join(SNAPSHOT_FILE), json)?;
    Ok(())
}

/// Makes the snapshot of `image` the one in use and removes the target's other snapshots.
pub fn make_current(target_dir: &Path, image: &str) -> IdeResult<()> {
    let keep = dir_name(image);
    std::fs::write(target_dir.join(CURRENT_FILE), &keep)?;
    for entry in std::fs::read_dir(target_dir)?.flatten() {
        let path = entry.path();
        if path.is_dir()
            && entry.file_name().to_string_lossy() != keep.as_str()
            && let Err(e) = std::fs::remove_dir_all(&path)
        {
            tracing::warn!("cannot remove the old Python snapshot {}: {e}", path.display());
        }
    }
    Ok(())
}

/// The local folders of a snapshot that exist.
pub fn local_folders(dir: &Path, snapshot: &Snapshot) -> Vec<PathBuf> {
    snapshot.folders.iter().map(|f| local_folder(dir, f)).filter(|p| p.is_dir()).collect()
}

/// basedpyright / pyright: the neutral interpreter and the snapshot's folders as
/// `extraPaths`. Without a snapshot yet the server only loses the local interpreter.
pub fn configure_server(cfg: &mut LanguageServerConfig, snapshot: Option<(&Path, &Snapshot)>) {
    let section = match cfg.name.as_str() {
        "basedpyright" => "basedpyright",
        "pyright" => "python",
        _ => return,
    };
    let Some((dir, snapshot)) = snapshot else { return };
    if let Some(python) = snapshot.neutral_python.as_deref().filter(|p| p.is_file()) {
        merge_init_options(cfg, json!({ "python": { "pythonPath": python.to_string_lossy() } }));
        if let Some(venv) = crate::venv_of(python) {
            cfg.env.insert("VIRTUAL_ENV".into(), venv.to_string_lossy().into_owned());
        }
    }
    let paths: Vec<String> = local_folders(dir, snapshot).iter().map(|p| p.to_string_lossy().into_owned()).collect();
    merge_init_options(cfg, json!({ "settings": { section: { "analysis": { "extraPaths": paths } } } }));
}

/// External Libraries: the snapshot's folders, named after the target.
pub fn library_group(target_name: &str, dir: &Path, snapshot: &Snapshot) -> Option<LibraryGroup> {
    let short = snapshot.probe.version.split('.').take(2).collect::<Vec<_>>().join(".");
    let roots: Vec<LibraryRoot> = snapshot
        .folders
        .iter()
        .map(|f| (f, local_folder(dir, f)))
        .filter(|(_, p)| p.is_dir())
        .map(|(f, p)| LibraryRoot { name: f.rsplit('/').next().unwrap_or(f).to_owned(), path: p.into() })
        .collect();
    (!roots.is_empty()).then(|| LibraryGroup {
        name: format!("Python {short} ({target_name})"),
        kind: "python".into(),
        roots,
    })
}

/// The packages of a snapshot, from the `*.dist-info` / `*.egg-info` metadata it copied.
pub fn packages(dir: &Path, snapshot: &Snapshot) -> Vec<PythonPackage> {
    let mut out: Vec<PythonPackage> = Vec::new();
    for folder in local_folders(dir, snapshot) {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let metadata = if name.ends_with(".dist-info") {
                path.join("METADATA")
            } else if name.ends_with(".egg-info") {
                if path.is_dir() { path.join("PKG-INFO") } else { path }
            } else {
                continue;
            };
            let Some(package) = std::fs::read_to_string(&metadata).ok().and_then(|m| package_of(&m)) else {
                continue;
            };
            if !out.iter().any(|p| p.name.eq_ignore_ascii_case(&package.name)) {
                out.push(package);
            }
        }
    }
    out.sort_by_key(|p| p.name.to_lowercase());
    out
}

fn package_of(metadata: &str) -> Option<PythonPackage> {
    let header = |key: &str| {
        metadata
            .lines()
            .take_while(|l| !l.is_empty())
            .find_map(|l| l.strip_prefix(key).and_then(|v| v.strip_prefix(':')))
            .map(|v| v.trim().to_owned())
    };
    Some(PythonPackage { name: header("Name")?, version: header("Version").unwrap_or_default() })
}

/// The neutral interpreter for a container Python of `version`: an empty virtualenv in
/// `cache`, made from a local Python of the same minor version when there is one. `None`
/// when this machine has no Python at all.
pub fn neutral_python(cache: &Path, version: &str) -> Option<PathBuf> {
    neutral_python_with(cache, version, which)
}

pub(crate) fn neutral_python_with(
    cache: &Path,
    version: &str,
    which: impl Fn(&str) -> Option<PathBuf>,
) -> Option<PathBuf> {
    let short = version.split('.').take(2).collect::<Vec<_>>().join(".");
    let named = (!short.is_empty()).then(|| format!("python{short}"));
    let (base, label) = match named.as_deref().and_then(|n| which(n).map(|p| (p, short.clone()))) {
        Some(found) => found,
        None => (which("python3").or_else(|| which("python"))?, "default".to_owned()),
    };
    let venv = cache.join("neutral").join(label);
    let python = venv.join(crate::bin_dir()).join(crate::exe("python"));
    if python.is_file() && venv.join("pyvenv.cfg").is_file() {
        return Some(python);
    }
    std::fs::create_dir_all(&venv).ok()?;
    let location = venv.to_string_lossy().into_owned();
    query_in(&base, &["-m", "venv", "--without-pip", &location], None, &[], Duration::from_secs(60));
    python.is_file().then_some(python)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::server;

    fn probe() -> Probe {
        Probe {
            version: "3.12.7".into(),
            executable: "/usr/local/bin/python3".into(),
            stdlib: vec![Some("/usr/local/lib/python3.12".into()), Some("/usr/local/lib/python3.12".into())],
            path: [
                "/workspaces/app",
                "/workspaces/app/src",
                "/usr/local/lib/python3.12",
                "/usr/local/lib/python3.12/lib-dynload",
                "/opt/lib/extra",
                "/usr/local/lib/python3.12/site-packages",
                "/usr/local/lib/python3.12/site-packages/setuptools/_vendor",
                "relative",
            ]
            .map(String::from)
            .to_vec(),
        }
    }

    #[test]
    fn copies_library_folders_outside_the_stdlib_and_the_project() {
        assert_eq!(
            folders_to_copy(&probe(), "/workspaces/app"),
            ["/opt/lib/extra", "/usr/local/lib/python3.12/site-packages"]
        );
        let mut p = probe();
        p.path.insert(0, "/opt/lib/extra/inner".into());
        assert_eq!(folders_to_copy(&p, "/workspaces/app")[0], "/opt/lib/extra", "the outer folder replaces the inner");
    }

    #[test]
    fn reads_the_probe_after_other_output() {
        let line = format!("{PROBE_MARKER}{}", serde_json::to_string(&probe()).unwrap());
        let out = format!("waiting for the entrypoint\n{line}\nbye\n");
        assert_eq!(parse_probe(&out).unwrap(), probe());
        assert!(parse_probe("python3: not found").unwrap_err().message.contains("not found"));
    }

    #[test]
    fn mirrors_container_paths_and_names_folders() {
        let dir = Path::new("snap");
        assert_eq!(
            local_folder(dir, "/usr/local/lib/../site-packages"),
            Path::new("snap").join("fs").join("usr").join("local").join("lib").join("site-packages")
        );
        assert_eq!(dir_name("sha256:0123456789abcdef0123"), "0123456789abcdef");
        assert_eq!(dir_name("target/../x y"), "target____x_y");
    }

    fn snapshot_in(dir: &Path, neutral: Option<PathBuf>) -> Snapshot {
        let snapshot = Snapshot {
            image: "sha256:abc".into(),
            probe: probe(),
            folders: vec!["/usr/local/lib/python3.12/site-packages".into(), "/gone".into()],
            neutral_python: neutral,
        };
        let site = local_folder(dir, &snapshot.folders[0]);
        std::fs::create_dir_all(site.join("Django-5.1.3.dist-info")).unwrap();
        std::fs::write(
            site.join("Django-5.1.3.dist-info/METADATA"),
            "Metadata-Version: 2.1\nName: Django\nVersion: 5.1.3\n\nName: not a header\n",
        )
        .unwrap();
        std::fs::create_dir_all(site.join("asgiref-3.8.1.dist-info")).unwrap();
        std::fs::write(site.join("asgiref-3.8.1.dist-info/METADATA"), "Name: asgiref\nVersion: 3.8.1\n").unwrap();
        std::fs::write(site.join("legacy.egg-info"), "Name: legacy\nVersion: 0.1\n").unwrap();
        snapshot
    }

    #[test]
    fn lists_packages_and_library_roots_of_a_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let snapshot = snapshot_in(tmp.path(), None);
        let names: Vec<String> =
            packages(tmp.path(), &snapshot).into_iter().map(|p| format!("{} {}", p.name, p.version)).collect();
        assert_eq!(names, ["asgiref 3.8.1", "Django 5.1.3", "legacy 0.1"]);
        let group = library_group("web", tmp.path(), &snapshot).unwrap();
        assert_eq!(group.name, "Python 3.12 (web)");
        assert_eq!(group.roots.len(), 1, "a folder that was not copied is left out");
        assert_eq!(group.roots[0].name, "site-packages");
    }

    #[test]
    fn current_snapshot_switches_and_drops_old_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let target = target_dir(tmp.path(), "web");
        for image in ["sha256:old", "sha256:new"] {
            let dir = target.join(dir_name(image));
            std::fs::create_dir_all(&dir).unwrap();
            write(&dir, &Snapshot { image: image.into(), ..Default::default() }).unwrap();
        }
        std::fs::create_dir_all(target.join("new.partial")).unwrap();
        assert!(current(&target).is_none());
        make_current(&target, "sha256:new").unwrap();
        let (dir, snapshot) = current(&target).unwrap();
        assert_eq!((dir, snapshot.image.as_str()), (target.join("new"), "sha256:new"));
        assert!(!target.join("old").exists() && !target.join("new.partial").exists());
    }

    #[test]
    fn basedpyright_gets_the_neutral_interpreter_and_extra_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let venv = tmp.path().join("neutral");
        let python = venv.join(crate::bin_dir()).join(crate::exe("python"));
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "include-system-site-packages = false\n").unwrap();
        let snapshot = snapshot_in(tmp.path(), Some(python.clone()));
        let site = local_folder(tmp.path(), &snapshot.folders[0]).to_string_lossy().into_owned();

        let mut cfg = server("basedpyright");
        configure_server(&mut cfg, Some((tmp.path(), &snapshot)));
        let opts = serde_json::to_value(cfg.initialization_options.as_ref().unwrap()).unwrap();
        assert_eq!(opts["python"]["pythonPath"], python.to_string_lossy().as_ref());
        assert_eq!(opts["settings"]["basedpyright"]["analysis"]["extraPaths"], json!([site]));
        assert_eq!(cfg.env["VIRTUAL_ENV"], venv.to_string_lossy().as_ref());

        let mut cfg = server("pyright");
        configure_server(&mut cfg, Some((tmp.path(), &snapshot)));
        let opts = serde_json::to_value(cfg.initialization_options.as_ref().unwrap()).unwrap();
        assert_eq!(opts["settings"]["python"]["analysis"]["extraPaths"], json!([site]));

        let mut cfg = server("ruff");
        configure_server(&mut cfg, Some((tmp.path(), &snapshot)));
        assert!(cfg.initialization_options.is_none());
    }

    #[test]
    fn without_a_local_python_only_extra_paths_reach_the_server() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(neutral_python_with(tmp.path(), "3.12.7", |_| None), None);
        let snapshot = snapshot_in(tmp.path(), None);
        let mut cfg = server("basedpyright");
        configure_server(&mut cfg, Some((tmp.path(), &snapshot)));
        let opts = serde_json::to_value(cfg.initialization_options.as_ref().unwrap()).unwrap();
        assert!(opts.get("python").is_none(), "no pythonPath: the server falls back to its bundled typeshed");
        assert_eq!(opts["settings"]["basedpyright"]["analysis"]["extraPaths"].as_array().unwrap().len(), 1);
        assert!(!cfg.env.contains_key("VIRTUAL_ENV"));
    }

    // A real `python3 -m venv`: runs where a Python is installed (the dev container, CI).
    #[test]
    fn neutral_python_is_an_empty_virtualenv() {
        let Some(base) = which("python3") else { return };
        let tmp = tempfile::tempdir().unwrap();
        let which = |name: &str| (name == "python3").then(|| base.clone());
        let python = neutral_python_with(tmp.path(), "0.0.1", which).unwrap();
        assert!(python.starts_with(tmp.path().join("neutral").join("default")));
        let cfg = std::fs::read_to_string(crate::venv_of(&python).unwrap().join("pyvenv.cfg")).unwrap();
        assert!(cfg.contains("include-system-site-packages = false"));
        assert_eq!(neutral_python_with(tmp.path(), "0.0.1", which), Some(python), "reused");
    }
}
