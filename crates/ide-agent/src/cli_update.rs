//! Checks and updates only the global npm installation selected by the agent launcher.
use crate::{AgentManager, AgentSource, provider};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AgentCliOffer {
    pub current: String,
    pub latest: String,
    pub prefix: PathBuf,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AgentCliUpdateResult {
    Available(AgentCliOffer),
    Permission(AgentCliOffer),
    Current { current: String },
    Channel { current: String },
    Updated { current: String },
    Unmanaged,
    Error { code: String },
}

pub(crate) fn package(id: &str) -> Option<&'static str> {
    Some(match id {
        "claude" => "@anthropic-ai/claude-code",
        "codex" => "@openai/codex",
        "gemini" => "@google/gemini-cli",
        "opencode" => "opencode-ai",
        "copilot" => "@github/copilot",
        "qwen" => "@qwen-code/qwen-code",
        "auggie" => "@augmentcode/auggie",
        "qoder" => "@qoder-ai/qodercli",
        "omp" => "@oh-my-pi/pi-coding-agent",
        _ => return None,
    })
}

impl AgentManager {
    pub fn cli_update(
        &self,
        id: &str,
        offer: Option<&AgentCliOffer>,
        cancel: &CancellationToken,
    ) -> IdeResult<AgentCliUpdateResult> {
        let spec = self.shared.spec(id).ok_or_else(|| IdeError::invalid(format!("unknown agent {id}")))?;
        let (Some(pkg), Some(builtin)) = (package(id), provider::builtin_spec(id)) else {
            return Ok(AgentCliUpdateResult::Unmanaged);
        };
        if spec.source != AgentSource::Builtin {
            return Ok(AgentCliUpdateResult::Unmanaged);
        }
        let Ok(npm) = which::which("npm") else { return Ok(AgentCliUpdateResult::Unmanaged) };
        let program = spec.resolve_for_launch(&self.shared.paths.project_root).command;
        match maintain(&npm, Path::new(&program), &builtin.command, pkg, offer, cancel) {
            Err(e) if e.kind == ErrorKind::Unavailable => Ok(AgentCliUpdateResult::Error { code: e.message }),
            result => result,
        }
    }
}

struct Installation {
    modules: PathBuf,
    folder: PathBuf,
    link: PathBuf,
}

impl Installation {
    fn at(prefix: &Path, pkg: &str, bin: &str) -> Self {
        let modules = prefix.join(if cfg!(windows) { "node_modules" } else { "lib/node_modules" });
        let link = if cfg!(windows) { prefix.join(format!("{bin}.cmd")) } else { prefix.join("bin").join(bin) };
        Self { folder: modules.join(pkg), modules, link }
    }

    fn version(&self, program: &Path, pkg: &str, bin: &str) -> IdeResult<Option<String>> {
        if !program.is_absolute() || !self.folder.try_exists()? || !self.link.try_exists()? || !program.try_exists()? {
            return Ok(None);
        }
        let folder = dunce::canonicalize(&self.folder)?;
        if fs::symlink_metadata(&self.folder)?.is_symlink()
            || dunce::canonicalize(program)? != dunce::canonicalize(&self.link)?
        {
            return Ok(None);
        }
        let manifest = self.folder.join("package.json");
        if !manifest.try_exists()? {
            return Ok(None);
        }
        let manifest: Value = serde_json::from_slice(&fs::read(manifest)?)
            .map_err(|_| IdeError::invalid("Invalid npm package manifest"))?;
        let entry = manifest["bin"].as_str().or_else(|| manifest["bin"][bin].as_str());
        let Some(entry) = entry.filter(|_| manifest["name"] == pkg) else { return Ok(None) };
        let Some(version) = manifest["version"].as_str() else {
            return Err(IdeError::invalid("Missing npm package version"));
        };
        let entry = folder.join(entry);
        if !entry.try_exists()? {
            return Ok(None);
        }
        let entry = dunce::canonicalize(entry)?;
        if !entry.starts_with(&folder) {
            return Ok(None);
        }
        #[cfg(unix)]
        let owns = fs::symlink_metadata(&self.link)?.is_symlink() && dunce::canonicalize(&self.link)? == entry;
        #[cfg(windows)]
        let owns = {
            let prefix = dunce::canonicalize(self.link.parent().unwrap())?;
            let Ok(target) = entry.strip_prefix(prefix) else { return Ok(None) };
            let needle = format!("%dp0%\\{}\"", target.display()).to_lowercase();
            fs::read_to_string(&self.link)?.replace('/', "\\").to_lowercase().contains(&needle)
        };
        Ok(owns.then(|| version.to_owned()))
    }

    fn writable(&self) -> io::Result<bool> {
        for dir in [&*self.folder, self.folder.parent().unwrap(), &self.modules, self.link.parent().unwrap()] {
            #[cfg(unix)]
            let access: io::Result<()> =
                rustix::fs::accessat(rustix::fs::CWD, dir, rustix::fs::Access::WRITE_OK, rustix::fs::AtFlags::empty())
                    .map_err(Into::into);
            #[cfg(windows)]
            let access = tempfile::tempfile_in(dir).map(drop);
            match access {
                Err(e) if matches!(e.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem) => {
                    return Ok(false);
                }
                other => other?,
            }
        }
        Ok(true)
    }
}

fn stable(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version).ok().filter(|v| v.pre.is_empty() && v.build.is_empty())
}

fn maintain(
    npm: &Path,
    program: &Path,
    bin: &str,
    pkg: &str,
    approved: Option<&AgentCliOffer>,
    cancel: &CancellationToken,
) -> IdeResult<AgentCliUpdateResult> {
    use AgentCliUpdateResult::*;
    let run = |args: &[&str]| {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let mut cmd = Command::new(npm);
        cmd.args(args)
            .current_dir(npm.parent().unwrap())
            .env("NPM_CONFIG_UPDATE_NOTIFIER", "false")
            .env("NPM_CONFIG_LOGLEVEL", "error");
        ide_tools::run_streamed(cmd, cancel, &|_| {}).map_err(|e| {
            if e.kind == ErrorKind::Cancelled {
                return e;
            }
            // npm diagnostics can contain private registry URLs; expose only known codes.
            let code = e
                .message
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .find(|w| {
                    matches!(
                        *w,
                        "EACCES"
                            | "EPERM"
                            | "EROFS"
                            | "ENOTFOUND"
                            | "EAI_AGAIN"
                            | "ETIMEDOUT"
                            | "E404"
                            | "E401"
                            | "E403"
                    )
                })
                .unwrap_or("npm");
            IdeError::unavailable(code)
        })
    };
    let output = run(&["prefix", "-g"])?;
    let prefix = Path::new(output.trim_end());
    if !prefix.is_absolute() {
        return Err(IdeError::invalid("Invalid npm global prefix"));
    }
    let installation = Installation::at(prefix, pkg, bin);
    let Some(current) = installation.version(program, pkg, bin)? else { return Ok(Unmanaged) };
    let latest: String = serde_json::from_str(&run(&["view", &format!("{pkg}@latest"), "version", "--json"])?)
        .map_err(|_| IdeError::invalid("Invalid npm version response"))?;
    let (Some(before), Some(after)) = (stable(&current), stable(&latest)) else {
        return Ok(Channel { current });
    };
    if before >= after {
        return Ok(Current { current });
    }
    let offer = AgentCliOffer { current, latest, prefix: prefix.to_owned() };
    if !installation.writable()? {
        return Ok(Permission(offer));
    }
    if approved != Some(&offer) {
        return Ok(Available(offer));
    }
    run(&[
        "install",
        "-g",
        "--prefix",
        prefix.to_str().unwrap(),
        "--no-audit",
        "--no-fund",
        &format!("{pkg}@{}", offer.latest),
    ])?;
    if installation.version(program, pkg, bin)?.as_ref() != Some(&offer.latest) {
        return Err(IdeError::invalid("npm installation verification failed"));
    }
    Ok(Updated { current: offer.latest })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    const PKG: &str = "@anthropic-ai/claude-code";

    struct Fixture {
        root: TempDir,
        install: Installation,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::Builder::new().prefix("全局 prefix ").tempdir().unwrap();
            let install = Installation::at(root.path(), PKG, "claude");
            fs::create_dir_all(&install.folder).unwrap();
            fs::create_dir_all(install.link.parent().unwrap()).unwrap();
            fs::write(install.folder.join("entry.js"), "").unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(install.folder.join("entry.js"), &install.link).unwrap();
            #[cfg(windows)]
            fs::write(&install.link, r#"@"%dp0%\node_modules\@anthropic-ai\claude-code\entry.js""#).unwrap();
            let fixture = Self { root, install };
            fixture.manifest(PKG, "2.1.9");
            fixture
        }

        fn manifest(&self, name: &str, version: &str) {
            fs::write(
                self.install.folder.join("package.json"),
                json!({"name":name,"version":version,"bin":{"claude":"entry.js"}}).to_string(),
            )
            .unwrap();
        }
        fn version(&self) -> Option<String> {
            self.install.version(&self.install.link, PKG, "claude").unwrap()
        }

        #[cfg(unix)]
        fn npm(&self, script: &str) -> PathBuf {
            use std::os::unix::fs::PermissionsExt;
            let path = self.root.path().join("npm");
            fs::write(&path, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    #[test]
    fn requires_the_selected_install_and_its_exact_package_entry() {
        let f = Fixture::new();
        assert_eq!(f.version().as_deref(), Some("2.1.9"));
        let other = f.root.path().join("other");
        fs::write(&other, "").unwrap();
        assert_eq!(f.install.version(&other, PKG, "claude").unwrap(), None);
        f.manifest("other-package", "2.1.9");
        assert_eq!(f.version(), None);
        f.manifest(PKG, "2.1.9");
        fs::remove_file(&f.install.link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&other, &f.install.link).unwrap();
        #[cfg(windows)]
        fs::write(&f.install.link, r#"@"%dp0%\other""#).unwrap();
        assert_eq!(f.version(), None);
    }

    #[cfg(unix)]
    const NPM: &str = r#"case "$1" in
prefix) pwd -P ;;
view) cat latest ;;
install)
    test "$2" = "-g" && test "$3" = "--prefix" && test "$4" = "$(pwd -P)"
    test "$7" = "@anthropic-ai/claude-code@2.1.12"
    cp updated.json "$4/lib/node_modules/@anthropic-ai/claude-code/package.json"
    touch installed ;;
*) exit 2 ;;
esac"#;

    #[cfg(unix)]
    #[test]
    fn installs_only_the_confirmed_offer_and_rechecks_ownership() {
        use AgentCliUpdateResult::*;
        let f = Fixture::new();
        let npm = f.npm(NPM);
        let cancel = CancellationToken::new();
        let run =
            |offer: Option<&AgentCliOffer>| maintain(&npm, &f.install.link, "claude", PKG, offer, &cancel).unwrap();
        let latest = f.root.path().join("latest");
        fs::write(&latest, r#""2.1.12""#).unwrap();
        let Available(offer) = run(None) else { panic!("expected an offer") };
        for different in [
            AgentCliOffer { prefix: PathBuf::from("/other"), ..offer.clone() },
            AgentCliOffer { current: "2.0.0".into(), ..offer.clone() },
        ] {
            assert_eq!(run(Some(&different)), Available(offer.clone()));
        }
        fs::write(&latest, r#""2.2.0""#).unwrap();
        assert!(matches!(run(Some(&offer)), Available(new) if new.latest == "2.2.0"));
        fs::write(&latest, r#""2.0.0""#).unwrap();
        assert!(matches!(run(Some(&offer)), Current { .. }));
        fs::write(&latest, r#""2.2.0-beta.1""#).unwrap();
        assert!(matches!(run(Some(&offer)), Channel { .. }));
        fs::write(&latest, r#""2.1.12""#).unwrap();
        f.manifest("other-package", "2.1.9");
        assert_eq!(run(Some(&offer)), Unmanaged);
        assert!(!f.root.path().join("installed").exists());
        f.manifest(PKG, "2.1.12");
        fs::copy(f.install.folder.join("package.json"), f.root.path().join("updated.json")).unwrap();
        f.manifest(PKG, "2.1.9");
        assert_eq!(run(Some(&offer)), Updated { current: "2.1.12".into() });
        assert!(f.root.path().join("installed").exists());
        assert_eq!(run(None), Current { current: "2.1.12".into() });
    }

    #[cfg(unix)]
    #[test]
    fn permission_failure_never_starts_an_install() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let npm = f.npm(NPM);
        fs::write(f.root.path().join("latest"), r#""2.1.12""#).unwrap();
        let run = |offer: Option<&AgentCliOffer>| {
            maintain(&npm, &f.install.link, "claude", PKG, offer, &CancellationToken::new()).unwrap()
        };
        let AgentCliUpdateResult::Available(offer) = run(None) else { panic!("expected an offer") };
        fs::set_permissions(&f.install.folder, fs::Permissions::from_mode(0o555)).unwrap();
        // root can write even when no mode bit grants write permission.
        if tempfile::tempfile_in(&f.install.folder).is_err() {
            assert_eq!(run(Some(&offer)), AgentCliUpdateResult::Permission(offer));
        }
        fs::set_permissions(&f.install.folder, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!f.root.path().join("installed").exists());
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_stops_a_running_npm_process() {
        use std::time::{Duration, Instant};
        let f = Fixture::new();
        let npm = f.npm(
            r#"case "$1" in
prefix) pwd -P ;;
view) echo '"2.1.12"' ;;
install) touch started; exec sleep 30 ;;
esac"#,
        );
        let cancel = CancellationToken::new();
        let AgentCliUpdateResult::Available(offer) =
            maintain(&npm, &f.install.link, "claude", PKG, None, &cancel).unwrap()
        else {
            panic!("expected an offer")
        };
        let started = f.root.path().join("started");
        std::thread::scope(|s| {
            let op = s.spawn(|| maintain(&npm, &f.install.link, "claude", PKG, Some(&offer), &cancel));
            let deadline = Instant::now() + Duration::from_secs(5);
            while !started.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            cancel.cancel();
            assert!(started.exists());
            assert_eq!(op.join().unwrap().unwrap_err().kind, ErrorKind::Cancelled);
        });
        assert_eq!(f.version().as_deref(), Some("2.1.9"));
    }
}
