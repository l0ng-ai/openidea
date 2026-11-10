use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::time::{Duration, Instant};

pub const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateSource {
    #[default]
    Github,
    Cnb,
}

impl UpdateSource {
    pub fn resolve(preference: &str, locale: &str, system_locale: &str) -> Self {
        match preference {
            "github" => return Self::Github,
            "cnb" => return Self::Cnb,
            _ => {}
        }
        let locale = locale.trim();
        let locale = if matches!(locale, "" | "auto" | "system") { system_locale } else { locale };
        if locale.split(['-', '_']).next().is_some_and(|base| base.eq_ignore_ascii_case("zh")) {
            Self::Cnb
        } else {
            Self::Github
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub enabled: bool,
    pub update: Option<UpdateInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Unix milliseconds of the last successful check in this process.
    pub last_checked: Option<f64>,
    pub checking: bool,
}

/// One schedule and announcement history for the desktop process, independent of its windows.
#[derive(Default)]
pub struct UpdatePolicy {
    attempted: Option<Instant>,
    pub status: UpdateStatus,
    announced: HashSet<String>,
}

impl UpdatePolicy {
    pub fn due_in(&self, now: Instant) -> Duration {
        self.attempted.map_or(Duration::ZERO, |at| CHECK_INTERVAL.saturating_sub(now.saturating_duration_since(at)))
    }

    pub fn begin(&mut self, now: Instant) {
        self.attempted = Some(now);
        self.status.checking = true;
    }

    pub fn finish(&mut self, checked_at: Option<f64>) {
        self.status.checking = false;
        if let Some(at) = checked_at {
            self.status.last_checked = Some(at);
        }
    }

    pub fn announced(&self, version: &str) -> bool {
        self.announced.contains(version)
    }

    /// Manual checks always show their result, but also count as an announcement.
    pub fn announce(&mut self, version: &str) -> bool {
        self.announced.insert(version.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_and_manual_checks_resolve_the_same_preferred_source() {
        for (preference, locale, system, expected) in [
            ("auto", "zh-CN", "en-US", UpdateSource::Cnb),
            ("auto", " ZH_CN ", "en-US", UpdateSource::Cnb),
            ("auto", "system", "zh-CN", UpdateSource::Cnb),
            ("auto", "auto", "zh-TW", UpdateSource::Cnb),
            ("auto", "", "zh", UpdateSource::Cnb),
            ("auto", "en", "zh-CN", UpdateSource::Github),
            ("github", "zh", "zh-CN", UpdateSource::Github),
            ("cnb", "en", "en-US", UpdateSource::Cnb),
        ] {
            assert_eq!(UpdateSource::resolve(preference, locale, system), expected);
        }
    }

    #[test]
    fn checks_at_startup_and_every_four_hours_even_after_failure() {
        let mut policy = UpdatePolicy::default();
        let now = Instant::now();
        assert_eq!(policy.due_in(now), Duration::ZERO);
        policy.begin(now);
        assert!(policy.status.checking);
        policy.finish(None);
        assert_eq!(policy.status.last_checked, None);
        assert_eq!(policy.due_in(now + CHECK_INTERVAL - Duration::from_secs(1)), Duration::from_secs(1));
        assert_eq!(policy.due_in(now + CHECK_INTERVAL), Duration::ZERO);
        policy.begin(now + CHECK_INTERVAL);
        policy.finish(Some(1234.0));
        assert_eq!(policy.status.last_checked, Some(1234.0));
        assert!(!policy.status.checking);
        assert_eq!(policy.due_in(now + CHECK_INTERVAL), CHECK_INTERVAL);
    }

    #[test]
    fn manual_checks_reset_the_schedule_without_losing_last_success_on_failure() {
        let mut policy = UpdatePolicy::default();
        let now = Instant::now();
        policy.begin(now);
        policy.finish(Some(1000.0));
        policy.begin(now + Duration::from_secs(60));
        policy.finish(None);
        assert_eq!(policy.status.last_checked, Some(1000.0));
        assert_eq!(policy.due_in(now + CHECK_INTERVAL), Duration::from_secs(60));
    }

    #[test]
    fn announcements_are_per_version_across_windows_sources_and_manual_checks() {
        let mut policy = UpdatePolicy::default();
        assert!(policy.announce("0.1.40"));
        assert!(!policy.announce("0.1.40"));
        assert!(policy.announce("0.1.41"));
        assert!(!policy.announce("0.1.40"));
        assert!(UpdatePolicy::default().announce("0.1.40"));
    }
}
