//! Where a Snowflake account is reached, and the account name its login and JWT carry.

use crate::source::{DataSource, DbSslMode};
use ide_core::{IdeError, IdeResult};
use reqwest::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Endpoint {
    pub base: Url,
    /// Upper-case account name: the first label of the account identifier.
    pub account: String,
}

/// Reads the data source's host: an account identifier (`myorg-myaccount`,
/// `xy12345.eu-central-1`), a host name (`myorg-myaccount.snowflakecomputing.com`) or the
/// account URL.
pub(crate) fn endpoint(source: &DataSource) -> IdeResult<Endpoint> {
    let raw = source.host.trim();
    let raw = raw.strip_prefix("https://").or_else(|| raw.strip_prefix("http://")).unwrap_or(raw);
    let raw = raw.split(['/', '?', '#']).next().unwrap_or_default().trim_end_matches('.');
    let (host, port) = match raw.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => {
            (host, port.parse::<u16>().ok())
        }
        _ => (raw, None),
    };
    let valid = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    if host.is_empty() || host == "localhost" && source.ssl != DbSslMode::Disable || !host.chars().all(valid) {
        return Err(IdeError::invalid(
            "enter the Snowflake account identifier, for example myorg-myaccount or xy12345.eu-central-1",
        ));
    }
    let account = host.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let literal = host.parse::<std::net::IpAddr>().is_ok() || host == "localhost";
    let full = if literal || host.to_ascii_lowercase().contains(".snowflakecomputing.") {
        host.to_owned()
    } else {
        // Host names cannot hold underscores; Snowflake serves such accounts under the dashed name.
        format!("{}.snowflakecomputing.com", host.replace('_', "-"))
    };
    let scheme = if source.ssl == DbSslMode::Disable { "http" } else { "https" };
    let port = port.or(source.port).filter(|p| *p != 443 || scheme == "http");
    let authority = match port {
        Some(port) => format!("{full}:{port}"),
        None => full,
    };
    let base = Url::parse(&format!("{scheme}://{authority}/"))
        .map_err(|_| IdeError::invalid("invalid Snowflake account identifier"))?;
    Ok(Endpoint { base, account })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::DbDriver;

    fn of(host: &str) -> Endpoint {
        endpoint(&DataSource { driver: DbDriver::Snowflake, host: host.into(), ..Default::default() }).unwrap()
    }

    #[test]
    fn account_identifiers_become_hosts() {
        let e = of("myorg-myaccount");
        assert_eq!(e.base.as_str(), "https://myorg-myaccount.snowflakecomputing.com/");
        assert_eq!(e.account, "MYORG-MYACCOUNT");
        let e = of("xy12345.eu-central-1");
        assert_eq!(e.base.as_str(), "https://xy12345.eu-central-1.snowflakecomputing.com/");
        assert_eq!(e.account, "XY12345");
        let e = of("xy12345.us-east-2.aws");
        assert_eq!(e.base.as_str(), "https://xy12345.us-east-2.aws.snowflakecomputing.com/");
        assert_eq!(e.account, "XY12345");
    }

    #[test]
    fn underscores_stay_in_the_account_name_but_not_in_the_host() {
        let e = of("my_org-my_account");
        assert_eq!(e.base.as_str(), "https://my-org-my-account.snowflakecomputing.com/");
        assert_eq!(e.account, "MY_ORG-MY_ACCOUNT");
    }

    #[test]
    fn hosts_and_urls_are_accepted() {
        for host in [
            "myorg-myaccount.snowflakecomputing.com",
            "https://myorg-myaccount.snowflakecomputing.com",
            "https://myorg-myaccount.snowflakecomputing.com/console/login?x=1",
            "MyOrg-MyAccount.snowflakecomputing.com:443",
        ] {
            let e = of(host);
            assert_eq!(e.base.host_str().unwrap().to_ascii_lowercase(), "myorg-myaccount.snowflakecomputing.com");
            assert_eq!(e.base.port(), None);
            assert_eq!(e.account, "MYORG-MYACCOUNT");
        }
        let e = of("xy12345.eu-west-1.privatelink.snowflakecomputing.com");
        assert_eq!(e.base.as_str(), "https://xy12345.eu-west-1.privatelink.snowflakecomputing.com/");
        assert_eq!(e.account, "XY12345");
        assert_eq!(of("acct.snowflakecomputing.cn").base.as_str(), "https://acct.snowflakecomputing.cn/");
    }

    #[test]
    fn rejects_missing_and_malformed_identifiers() {
        for host in ["", "  ", "localhost", "my account", "user@host", "/path"] {
            let source = DataSource { driver: DbDriver::Snowflake, host: host.into(), ..Default::default() };
            let error = endpoint(&source).unwrap_err();
            assert!(error.message.contains("account identifier"), "{host}: {}", error.message);
        }
    }

    #[test]
    fn plain_http_is_only_for_an_explicit_ssl_off() {
        let source = DataSource {
            driver: DbDriver::Snowflake,
            host: "127.0.0.1".into(),
            port: Some(8080),
            ssl: DbSslMode::Disable,
            ..Default::default()
        };
        let e = endpoint(&source).unwrap();
        assert_eq!(e.base.as_str(), "http://127.0.0.1:8080/");
    }
}
