//! Snowflake error codes as errors the UI can act on: `PermissionDenied` asks for the
//! data source's secret again, everything else shows its message.

use ide_core::{IdeError, error::ErrorKind};

/// The session token expired; the master token renews it.
pub(crate) const SESSION_EXPIRED: &str = "390112";
/// The session is gone (master token expired, session closed by the server): log in again.
pub(crate) const SESSION_GONE: &[&str] = &["390111", "390114", "390104"];
/// The statement still runs; its result is polled.
pub(crate) const IN_PROGRESS: &[&str] = &["333333", "333334"];

const KEY_HINT: &str = "Check that the public key of this private key is assigned to the user \
(ALTER USER … SET RSA_PUBLIC_KEY), and that the account identifier and user name are right.";

/// What to do about a failed login or statement, by Snowflake error code.
fn hint(code: &str, message: &str) -> Option<&'static str> {
    Some(match code {
        "390144" => KEY_HINT,
        "394300" => "Snowflake found no such user: check the user name and the account identifier.",
        "394302" => "The login token arrived too late: check this computer's clock.",
        "394303" => "The login token had expired: check this computer's clock.",
        "394304" => {
            "The public key assigned to the user does not match this private key: compare the fingerprint below \
             with RSA_PUBLIC_KEY_FP of DESC USER."
        }
        "394307" => "The account in the login token does not match: check the account identifier.",
        "390189" => "The role is not granted to this user: change the role of the data source.",
        "390201" => "Check the database, schema and warehouse of the data source, and that the role may use them.",
        "000606" => "Set a warehouse in the data source, or run USE WAREHOUSE <name>.",
        "390422" | "390420" => "A network policy of the account blocks this address.",
        _ if message.contains("is not allowed to access Snowflake") => {
            "A network policy of the account blocks this address."
        }
        _ => return None,
    })
}

/// Whether the login was refused for reasons a different private key or account setting
/// fixes, so the key's fingerprint helps.
pub(crate) fn key_rejected(code: &str) -> bool {
    code == "390144" || code.starts_with("3943")
}

fn kind(code: &str) -> ErrorKind {
    match code {
        // Wrong password or token; expired or revoked tokens.
        "390100" | "390303" | "390318" | "394400" | "394401" | "394402" => ErrorKind::PermissionDenied,
        "000604" | "000605" => ErrorKind::Cancelled,
        "000630" => ErrorKind::TimedOut,
        _ => ErrorKind::InvalidInput,
    }
}

/// The error of a response that reports failure.
pub(crate) fn server(code: Option<&str>, message: Option<&str>) -> IdeError {
    let code = code.unwrap_or_default();
    let message = message.map(str::trim).filter(|m| !m.is_empty()).unwrap_or("the request failed");
    let mut text =
        if code.is_empty() { format!("Snowflake: {message}") } else { format!("Snowflake [{code}]: {message}") };
    if let Some(hint) = hint(code, message) {
        text.push('\n');
        text.push_str(hint);
    }
    IdeError::new(kind(code), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrong_credentials_ask_again_and_other_failures_explain() {
        let e = server(Some("390100"), Some("Incorrect username or password was specified."));
        assert_eq!(e.kind, ErrorKind::PermissionDenied);
        assert_eq!(e.message, "Snowflake [390100]: Incorrect username or password was specified.");
        let e = server(Some("390144"), Some("JWT token is invalid. [abc]"));
        assert_eq!(e.kind, ErrorKind::InvalidInput);
        assert!(e.message.starts_with("Snowflake [390144]: JWT token is invalid. [abc]\nCheck that the public key"));
        assert!(key_rejected("390144") && key_rejected("394304") && !key_rejected("390100"));
        let e = server(Some("000606"), Some("No active warehouse selected in the current session."));
        assert!(e.message.ends_with("run USE WAREHOUSE <name>."), "{}", e.message);
        let e = server(Some("002003"), Some("SQL compilation error:\nObject 'T' does not exist or not authorized."));
        assert_eq!(e.kind, ErrorKind::InvalidInput);
        assert_eq!(
            e.message,
            "Snowflake [002003]: SQL compilation error:\nObject 'T' does not exist or not authorized."
        );
    }

    #[test]
    fn network_policy_and_bare_failures() {
        let e = server(Some("390432"), Some("IP 203.0.113.9 is not allowed to access Snowflake."));
        assert!(e.message.ends_with("A network policy of the account blocks this address."));
        assert_eq!(server(None, None).message, "Snowflake: the request failed");
        assert_eq!(server(Some("000604"), Some("SQL execution canceled")).kind, ErrorKind::Cancelled);
    }
}
