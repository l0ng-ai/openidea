//! Saved git HTTPS credentials, in the app's own secret store (next to the SSH
//! passwords), never in git's global configuration. Answers to askpass prompts
//! are remembered only after the git command that used them succeeded, and a
//! stored credential that fails authentication is forgotten so the next command
//! asks again.

use crate::secrets::SecretFile;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// A stored credential: `user` answered `Username for …`, `secret` the password.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitCredential {
    pub user: String,
    pub secret: String,
}

/// What [`GitCredentials::lookup`] decided for a prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GitAnswer {
    /// Answer the prompt with this text without asking the user.
    Auto(String),
    /// Nothing stored; the dialog may offer to remember a new credential.
    PromptNew,
}

/// Shared store: a [`SecretFile`] of `scheme://host[:port]` → `user\nsecret`, plus the
/// state of each git command currently running (credentials it consumed and
/// answers to save when it succeeds).
#[derive(Clone)]
pub struct GitCredentials {
    saved: Arc<SecretFile>,
    sessions: Arc<Mutex<HashMap<u64, Session>>>,
}

#[derive(Default)]
struct Session {
    /// Stored credentials this command used (possibly wrong): forgotten if the
    /// command fails with an authentication error.
    used: HashMap<String, GitCredential>,
    /// `scheme://host[:port]` → credential the user asked to remember: written when the
    /// command succeeds.
    pending: HashMap<String, GitCredential>,
}

/// Global instance: the askpass server and every `git` child process agree on it.
static INSTANCE: Mutex<Option<GitCredentials>> = Mutex::new(None);

/// Installs the store of `path` (the app's data directory). Called once at
/// start-up; git prompts before that are simply not remembered.
pub fn init(path: PathBuf) {
    *INSTANCE.lock() = Some(GitCredentials { saved: Arc::new(SecretFile::new(path)), sessions: Arc::default() });
}

/// The installed store, if start-up got that far.
pub fn get() -> Option<GitCredentials> {
    INSTANCE.lock().clone()
}

/// `scheme://host[:port]` of an HTTPS prompt (`Username for 'https://host'` /
/// `Password for 'https://user@host'`); `None` for anything else (SSH prompts,
/// passphrases, host-key questions — none of git's business here).
pub fn prompt_key(prompt: &str) -> Option<String> {
    let quoted = prompt.split('\'').nth(1)?;
    let (scheme, rest) = quoted.split_once("://")?;
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let authority = rest.split('/').next()?;
    // `user@host` (possibly with a password): keep the host part only.
    let host = authority.rsplit('@').next()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// The user name embedded in a password prompt (`https://user@host`), if any.
/// Git URL-encodes it (`%40` for `@`), which a lookup must match.
fn prompt_user(prompt: &str) -> Option<String> {
    let quoted = prompt.split('\'').nth(1)?;
    let authority = quoted.split_once("://")?.1.split('/').next()?;
    let (user, _) = authority.rsplit_once('@')?;
    let user = user.split(':').next()?;
    (!user.is_empty()).then(|| user.to_owned())
}

/// `stderr` of a failed git command says the stored credential was rejected.
fn is_auth_failure(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("authentication failed")
        || s.contains("authentication unsuccessful")
        || s.contains("invalid username or password")
        || s.contains("access denied")
        || s.contains("authorization failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("the requested url returned error: 403")
        || s.contains("the requested url returned error: 401")
}

impl GitCredentials {
    /// The stored credential for `key` (`scheme://host[:port]`).
    pub fn credential(&self, key: &str) -> Option<GitCredential> {
        let raw = self.saved.get(key)?;
        let (user, secret) = raw.split_once('\n')?;
        Some(GitCredential { user: user.to_owned(), secret: secret.to_owned() })
    }

    /// What to do with a git HTTPS `prompt`: answer it from the store or show
    /// the dialog.
    /// `None`: not a git HTTPS credential prompt.
    pub fn lookup(&self, prompt: &str) -> Option<GitAnswer> {
        let key = prompt_key(prompt)?;
        let wants_user = prompt.to_ascii_lowercase().starts_with("username");
        match self.credential(&key) {
            Some(c) => {
                // The password prompt carries the user name git will send: a
                // mismatch means the stored entry belongs to another account.
                let answer = if wants_user {
                    Some(c.user)
                } else {
                    prompt_user(prompt).is_none_or(|u| u == c.user).then_some(c.secret)
                };
                Some(answer.map_or(GitAnswer::PromptNew, GitAnswer::Auto))
            }
            None => Some(GitAnswer::PromptNew),
        }
    }

    /// The stored answer to `prompt`; `None` falls through to the UI prompt.
    /// Only a consumed *password* marks `key` as used — a stored user name
    /// alone proves nothing about the credential's validity.
    pub fn answer_saved(&self, command_id: u64, prompt: &str) -> Option<String> {
        let key = prompt_key(prompt)?;
        let mut sessions = self.sessions.lock();
        let credential = self.credential(&key)?;
        if prompt.to_ascii_lowercase().starts_with("username") {
            return Some(credential.user);
        }
        if prompt_user(prompt).is_some_and(|user| user != credential.user) {
            return None;
        }
        let answer = credential.secret.clone();
        sessions.entry(command_id).or_default().used.insert(key, credential);
        Some(answer)
    }

    /// The user's `answer` to `prompt`, remembered when the current git command
    /// succeeds (`remember` = the dialog's "Remember" checkbox). Records the
    /// key only for pending saves: a re-typed answer does not consume the
    /// stored credential, so an auth failure must not delete it.
    pub fn answered(&self, command_id: u64, prompt: &str, answer: &str, remember: bool) {
        if !remember {
            return;
        }
        let Some(key) = prompt_key(prompt) else { return };
        let mut sessions = self.sessions.lock();
        let s = sessions.entry(command_id).or_default();
        let wants_user = prompt.to_ascii_lowercase().starts_with("username");
        let entry = s.pending.entry(key).or_insert(GitCredential { user: String::new(), secret: String::new() });
        if wants_user {
            entry.user = answer.to_owned();
        } else {
            entry.secret = answer.to_owned();
            // The password prompt carries the user name git will send.
            if entry.user.is_empty()
                && let Some(u) = prompt_user(prompt)
            {
                entry.user = u;
            }
        }
    }

    /// Called when a git child process exits: on success, writes the remembered
    /// credentials and marks used ones as verified; on an authentication
    /// failure, forgets every credential the command consumed so the next run
    /// asks again instead of looping on a wrong password.
    pub fn command_finished(&self, command_id: u64, success: bool, stderr: &str) {
        let mut sessions = self.sessions.lock();
        let Some(session) = sessions.remove(&command_id) else { return };
        if success {
            for (key, c) in session.pending {
                if c.secret.is_empty() {
                    continue; // a lone user name is not a credential
                }
                if let Err(e) = self.saved.set(&key, &format!("{}\n{}", c.user, c.secret)) {
                    tracing::warn!("git credentials: {}", e.message);
                }
            }
        } else if is_auth_failure(stderr) {
            // `used` holds exactly the keys whose stored password was sent.
            for (key, used) in session.used {
                if self.credential(&key).as_ref() == Some(&used) {
                    self.saved.delete(&key);
                }
            }
        }
    }

    /// Settings › Git: `scheme://host[:port]` entries with a saved credential.
    pub fn list(&self) -> Vec<String> {
        self.saved.keys()
    }

    /// Forgets the credential of `key` (Settings › Git › Clear, or a remote edit).
    pub fn forget(&self, key: &str) {
        self.saved.delete(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, GitCredentials) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("git-credentials.json");
        (tmp, GitCredentials { saved: Arc::new(SecretFile::new(path)), sessions: Arc::default() })
    }

    #[test]
    fn parses_https_prompts() {
        assert_eq!(prompt_key("Username for 'https://github.com': ").as_deref(), Some("https://github.com"));
        assert_eq!(prompt_key("Password for 'https://user@github.com': ").as_deref(), Some("https://github.com"));
        assert_eq!(
            prompt_key("Password for 'https://user%40mail.com@example.com:8443/x': ").as_deref(),
            Some("https://example.com:8443")
        );
        assert_eq!(prompt_key("git@github.com's password: "), None);
        assert_eq!(prompt_key("Enter passphrase for key '/u/.ssh/id_ed25519': "), None);
    }

    #[test]
    fn saves_only_after_success_and_answers_silently() {
        let (_t, c) = store();
        // First run: prompts the user, who checks "remember".
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::PromptNew));
        c.answered(1, "Username for 'https://github.com': ", "me", true);
        c.answered(1, "Password for 'https://me@github.com': ", "secret", true);
        // A failure before the password is verified saves nothing.
        c.command_finished(1, false, "fatal: some other error");
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::PromptNew));

        c.answered(1, "Username for 'https://github.com': ", "me", true);
        c.answered(1, "Password for 'https://me@github.com': ", "secret", true);
        c.command_finished(1, true, "");
        // Second run: no prompts at all.
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::Auto("me".into())));
        assert_eq!(c.lookup("Password for 'https://me@github.com': "), Some(GitAnswer::Auto("secret".into())));
    }

    #[test]
    fn forgets_a_rejected_credential() {
        let (_t, c) = store();
        c.answered(1, "Username for 'https://github.com': ", "me", true);
        c.answered(1, "Password for 'https://me@github.com': ", "wrong", true);
        c.command_finished(1, true, "");
        // The next command consumes the stored credential silently.
        assert_eq!(c.answer_saved(1, "Username for 'https://github.com': ").as_deref(), Some("me"));
        assert_eq!(c.answer_saved(1, "Password for 'https://me@github.com': ").as_deref(), Some("wrong"));
        c.command_finished(
            1,
            false,
            "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x.git/'",
        );
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::PromptNew));
    }

    #[test]
    fn lists_and_forgets() {
        let (_t, c) = store();
        c.answered(1, "Username for 'https://a.example.com': ", "u", true);
        c.answered(1, "Password for 'https://u@a.example.com': ", "p", true);
        c.answered(1, "Username for 'https://b.example.com': ", "u", true);
        c.answered(1, "Password for 'https://u@b.example.com': ", "p", true);
        c.command_finished(1, true, "");
        assert_eq!(c.list(), vec!["https://a.example.com", "https://b.example.com"]);
        c.forget("https://a.example.com");
        assert_eq!(c.list(), vec!["https://b.example.com"]);
    }
    #[test]
    fn interleaved_commands_do_not_share_pending_or_used_credentials() {
        for failure_first in [false, true] {
            let (_t, c) = store();
            let old = "Password for 'https://me@old.example:8443': ";
            let new = "Password for 'https://me@new.example:8443': ";
            c.answered(1, old, "rejected", true);
            c.command_finished(1, true, "");

            assert_eq!(c.answer_saved(2, old).as_deref(), Some("rejected"));
            c.answered(3, new, "verified", true);
            c.command_finished(4, true, "");
            assert!(c.credential("https://new.example:8443").is_none());
            assert!(c.credential("https://old.example:8443").is_some());
            if failure_first {
                c.command_finished(2, false, "fatal: Authentication failed");
                assert!(c.credential("https://new.example:8443").is_none());
                c.command_finished(3, true, "");
            } else {
                c.command_finished(3, true, "");
                assert!(c.credential("https://old.example:8443").is_some());
                c.command_finished(2, false, "fatal: Authentication failed");
            }
            assert!(c.credential("https://old.example:8443").is_none());
            assert_eq!(c.credential("https://new.example:8443").unwrap().secret, "verified");
            assert!(c.sessions.lock().is_empty());
        }
    }

    #[test]
    fn unrelated_success_does_not_save_an_unverified_password() {
        let (_t, c) = store();
        c.answered(1, "Password for 'https://me@example.com': ", "wrong", true);
        c.command_finished(2, true, "");
        assert!(c.list().is_empty());
        c.command_finished(1, false, "HTTP Basic: Access denied");
        assert!(c.list().is_empty());
        assert!(c.sessions.lock().is_empty());
    }

    #[test]
    fn stale_failure_does_not_delete_a_newly_verified_password() {
        let (_t, c) = store();
        let prompt = "Password for 'https://me@example.com': ";
        c.answered(1, prompt, "old", true);
        c.command_finished(1, true, "");
        c.answer_saved(2, prompt).unwrap();
        c.answered(3, prompt, "new", true);
        c.command_finished(3, true, "");
        c.command_finished(2, false, "Authentication failed");
        assert_eq!(c.answer_saved(4, prompt).as_deref(), Some("new"));
    }

    #[test]
    fn ports_and_ipv6_are_distinct_credential_keys() {
        for (url, key) in [
            ("http://me@example.com:8080/repo", "http://example.com:8080"),
            ("https://me@example.com:8443/repo", "https://example.com:8443"),
            ("https://me@[::1]:8443/repo", "https://[::1]:8443"),
            ("https://[::1]/repo", "https://[::1]"),
        ] {
            assert_eq!(prompt_key(&format!("Password for '{url}': ")).as_deref(), Some(key));
        }
        let (_t, c) = store();
        c.answered(1, "Password for 'https://me@example.com:8443': ", "secret", true);
        c.command_finished(1, true, "");
        assert!(c.answer_saved(2, "Password for 'https://me@example.com:9443': ").is_none());
        assert!(c.answer_saved(2, "Password for 'https://me@example.com': ").is_none());
    }

    #[test]
    fn recognizes_auth_errors_without_matching_arbitrary_numbers() {
        for message in [
            "fatal: Authentication failed",
            "Authentication unsuccessful",
            "Invalid username or password",
            "HTTP Basic: Access denied",
            "Authorization failed",
            "fatal: could not read Username for 'https://example.com'",
            "fatal: could not read Password for 'https://example.com'",
            "fatal: unable to access: The requested URL returned error: 401",
            "fatal: unable to access: The requested URL returned error: 403",
        ] {
            assert!(is_auth_failure(message), "{message}");
        }
        for message in [
            "Failed to connect to example.com port 4010",
            "Could not resolve host: server403.example",
            "fatal: repository '/repo/401' does not exist",
            "remote: error in commit abc403def",
            "The requested URL returned error: 500",
        ] {
            assert!(!is_auth_failure(message), "{message}");
        }
    }
}
