use crate::{Repo, cli, execution_allowed};
use gix::lock::{self, acquire::Fail};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitSigningConfig {
    pub format: String,
    pub enabled: bool,
    pub key: Option<String>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GpgSigningKey {
    pub fingerprint: String,
    pub user_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitSigningEdit {
    pub enabled: Option<bool>,
    pub key: Option<String>,
}

impl Repo {
    pub fn signing_config(&self) -> IdeResult<GitSigningConfig> {
        Ok(GitSigningConfig {
            format: self.config_get("gpg.format")?.unwrap_or_else(|| "openpgp".into()),
            enabled: self.config_get_bool("commit.gpgsign")?.unwrap_or_default(),
            key: self.config_get("user.signingkey")?.filter(|key| !key.is_empty()),
        })
    }

    pub fn gpg_signing_keys(&self, cancel: &CancellationToken) -> IdeResult<Vec<GpgSigningKey>> {
        let _scope = self.execution_scope();
        self.require_openpgp()?;
        let program = gpg_program(self.root(), cancel)?;
        let mut cmd = Command::new(&program);
        cmd.current_dir(self.root()).args(["--batch", "--no-tty", "--with-colons", "--list-secret-keys"]);
        ide_core::process::prepare(&mut cmd);
        let out = cli::capture_command(cmd, None, cancel, 4 << 20, "GnuPG")?;
        if out.code != Some(0) {
            return Err(IdeError::unavailable(format!(
                "Could not list OpenPGP signing keys ({}): {}",
                program.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(parse_keys(&out.stdout_str()))
    }

    pub fn edit_signing(&self, edit: GitSigningEdit) -> IdeResult<()> {
        let _scope = self.execution_scope();
        self.require_openpgp()?;
        if edit.enabled.is_none() && edit.key.is_none() {
            return Ok(());
        }
        if edit.key.as_deref().is_some_and(|key| !valid_fingerprint(key)) {
            return Err(IdeError::invalid("invalid OpenPGP fingerprint"));
        }
        let config = self.metadata_dirs()?[1].join("config");
        let mut lock = lock::File::acquire(&config, Fail::Immediately, None, 0, Some(&lock::acquire::resolve_symlink))
            .map_err(|error| IdeError::new(ErrorKind::Io, error.to_string()))?;

        // Let Git rewrite both values, holding its normal config lock until both edits succeed.
        let mut original = std::fs::File::open(&config)?;
        let mut staged = tempfile::NamedTempFile::new_in(config.parent().expect("repository config directory"))?;
        io::copy(&mut original, &mut staged)?;
        let enabled = edit.enabled.map(|enabled| if enabled { "true" } else { "false" });
        for (name, value) in [("commit.gpgsign", enabled), ("user.signingkey", edit.key.as_deref())] {
            if let Some(value) = value {
                cli::run(
                    self.root(),
                    &[
                        "config",
                        "--file",
                        staged.path().to_str().ok_or_else(|| IdeError::invalid("non-UTF-8 Git config path"))?,
                        "--replace-all",
                        "--",
                        name,
                        value,
                    ],
                    None,
                )?;
            }
        }
        // Git's config writer replaces the staging file, so reopen its final path.
        let mut updated = std::fs::File::open(staged.path())?;
        lock.with_mut(|file| {
            io::copy(&mut updated, file)?;
            file.set_permissions(original.metadata()?.permissions())
        })?;
        drop(original);
        lock.commit().map_err(|error| IdeError::new(ErrorKind::Io, error.to_string()))?;
        Ok(())
    }

    fn require_openpgp(&self) -> IdeResult<()> {
        if !execution_allowed() {
            return Err(IdeError::unavailable("Git signing configuration requires a trusted project"));
        }
        if self.config_get("gpg.format")?.is_some_and(|format| format != "openpgp") {
            return Err(IdeError::invalid("the repository uses a signing format other than OpenPGP"));
        }
        Ok(())
    }
}

fn gpg_program(root: &Path, cancel: &CancellationToken) -> IdeResult<PathBuf> {
    let args = ["config", "--null", "--get-regexp", r"^gpg\.(openpgp\.)?program$"];
    let out = cli::run_cancellable_raw(root, &args, cancel)?;
    let program = match out.code {
        Some(0) => {
            let config = out.stdout_str();
            let (_, program) = config
                .split_terminator('\0')
                .next_back()
                .and_then(|entry| entry.split_once('\n'))
                .filter(|(_, program)| !program.is_empty())
                .ok_or_else(|| IdeError::invalid("invalid OpenPGP signing program"))?;
            PathBuf::from(program)
        }
        Some(1) if out.stderr.is_empty() => PathBuf::from("gpg"),
        _ => return Err(cli::failure(&args, &out.stderr, &out.stdout, out.code)),
    };
    if cfg!(windows)
        && (program.as_os_str().eq_ignore_ascii_case("gpg") || program.as_os_str().eq_ignore_ascii_case("gpg.exe"))
    {
        let exec_path = cli::run_cancellable(root, &["--exec-path"], cancel)?.stdout_str();
        let bundled = Path::new(exec_path.trim()).join("../../../usr/bin/gpg.exe");
        if let Ok(path) = dunce::canonicalize(bundled) {
            return Ok(path);
        }
    }
    Ok(if program.is_relative() && program.components().count() > 1 { root.join(program) } else { program })
}

fn valid_fingerprint(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_keys(output: &str) -> Vec<GpgSigningKey> {
    let mut keys = Vec::new();
    let mut pending = None;
    let mut follows_primary = false;
    for record in output.lines() {
        let fields: Vec<_> = record.split(':').collect();
        match fields.first().copied() {
            Some("sec") => {
                if let Some(key) = pending.take() {
                    keys.push(key);
                }
                follows_primary = !matches!(fields.get(1), Some(&("r" | "e" | "i" | "d")))
                    && fields.get(11).is_some_and(|caps| caps.contains('S') && !caps.contains('D'));
            }
            Some("fpr") if follows_primary => {
                follows_primary = false;
                if let Some(fingerprint) = fields.get(9).filter(|value| valid_fingerprint(value)) {
                    pending = Some(GpgSigningKey { fingerprint: fingerprint.to_string(), user_id: None });
                }
            }
            Some("uid") => {
                if let Some(key) = pending.as_mut().filter(|key| key.user_id.is_none()) {
                    key.user_id = fields.get(9).map(|value| decode_user_id(value));
                }
            }
            _ => {}
        }
    }
    keys.extend(pending);
    keys
}

fn decode_user_id(value: &str) -> String {
    let mut bytes = Vec::new();
    let mut rest = value.as_bytes();
    while let Some((&byte, tail)) = rest.split_first() {
        if let [b'\\', b'x', high, low, remaining @ ..] = rest
            && let (Some(high), Some(low)) = (char::from(*high).to_digit(16), char::from(*low).to_digit(16))
        {
            bytes.push((high * 16 + low) as u8);
            rest = remaining;
        } else {
            bytes.push(byte);
            rest = tail;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ExecutionScope;

    const FINGERPRINT: &str = "1234567890123456789012345678901234567890";
    const SUBKEY: &str = "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";

    #[test]
    fn lists_signing_primary_fingerprints_and_decodes_user_ids() {
        let records = format!(
            "sec:u:255:22:67890:1:::u:::cSC:::+::ed25519:::0:\n\
             fpr:::::::::{FINGERPRINT}:\n\
             uid:u::::1::AA::Signing\\x3a Test <test@example.com>::::::::::0:\n\
             ssb:u:255:22:FFFF:1::::::s:::+::ed25519::\n\
             fpr:::::::::{SUBKEY}:\n\
             sec:e:255:22:1111:1:::u:::sS:::+::ed25519:::0:\n\
             fpr:::::::::{SUBKEY}:\n\
             sec:u:255:22:2222:1:::u:::eE:::+::ed25519:::0:\n\
             fpr:::::::::{SUBKEY}:\n"
        );
        assert_eq!(
            parse_keys(&records),
            vec![GpgSigningKey {
                fingerprint: FINGERPRINT.into(),
                user_id: Some("Signing: Test <test@example.com>".into()),
            }]
        );
    }

    #[test]
    fn edits_local_signing_config_with_git_lock_and_preserves_other_settings() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let _scope = ExecutionScope::enter(true);
            cli::run(dir.path(), args, None).unwrap().stdout_str()
        };
        git(&["init"]);
        git(&["config", "--local", "gpg.format", "openpgp"]);
        git(&["config", "--local", "commit.gpgsign", "false"]);
        git(&["config", "--local", "user.signingkey", "old-key"]);
        git(&["config", "--local", "user.email", "test@example.com"]);
        let repo = Repo::discover(dir.path()).unwrap().unwrap();

        let enable = || GitSigningEdit { enabled: Some(true), key: Some(FINGERPRINT.into()) };
        assert!(repo.edit_signing(enable()).is_err());
        assert!(repo.gpg_signing_keys(&CancellationToken::default()).is_err());
        repo.set_execution_allowed(true);
        let lock = dir.path().join(".git/config.lock");
        std::fs::write(&lock, b"another process owns this lock").unwrap();
        assert!(repo.edit_signing(enable()).is_err());
        assert_eq!(git(&["config", "--local", "--get", "user.signingkey"]).trim(), "old-key");
        std::fs::remove_file(lock).unwrap();

        repo.edit_signing(enable()).unwrap();
        assert_eq!(git(&["config", "--local", "--get", "user.signingkey"]).trim(), FINGERPRINT);
        assert_eq!(git(&["config", "--local", "--get", "user.email"]).trim(), "test@example.com");
        assert!(repo.signing_config().unwrap().enabled);

        repo.edit_signing(GitSigningEdit { enabled: Some(false), key: None }).unwrap();
        assert!(!repo.signing_config().unwrap().enabled);
        assert_eq!(git(&["config", "--local", "--get", "user.signingkey"]).trim(), FINGERPRINT);

        git(&["config", "--local", "gpg.format", "ssh"]);
        assert!(repo.edit_signing(enable()).is_err());
        assert_eq!(repo.signing_config().unwrap().format, "ssh");
        assert!(!repo.signing_config().unwrap().enabled);
    }
}
