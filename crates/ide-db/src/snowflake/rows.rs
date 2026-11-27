//! Result decoding: Snowflake's JSON result format sends every cell as text in an internal
//! form (dates as day numbers, timestamps as epoch seconds); these become the grid's text.

use crate::conn::ResultColumn;
use serde::Deserialize;
use serde_json::Value;

/// A column of the result's `rowtype`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RowType {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub precision: Option<i64>,
    pub scale: Option<i64>,
    pub length: Option<i64>,
}

/// `VARCHAR` without a length: Snowflake reports its maximum.
const MAX_TEXT: i64 = 16_777_216;

impl RowType {
    pub(crate) fn column(&self) -> ResultColumn {
        let kind = self.kind.to_ascii_lowercase();
        let scaled = |name: &str| match self.scale {
            Some(scale) => format!("{name}({scale})"),
            None => name.to_owned(),
        };
        let type_name = match kind.as_str() {
            "fixed" => match (self.precision, self.scale) {
                (Some(p), Some(s)) => format!("NUMBER({p},{s})"),
                _ => "NUMBER".into(),
            },
            "real" => "FLOAT".into(),
            "text" => match self.length {
                Some(n) if n > 0 && n < MAX_TEXT => format!("VARCHAR({n})"),
                _ => "VARCHAR".into(),
            },
            "time" => scaled("TIME"),
            "timestamp_ntz" | "timestamp_ltz" | "timestamp_tz" => scaled(&kind.to_ascii_uppercase()),
            other => other.to_ascii_uppercase(),
        };
        ResultColumn { name: self.name.clone(), type_name }
    }
}

/// The grid text of one cell (`None`: SQL NULL).
pub(crate) fn cell(column: &RowType, value: Value) -> Option<String> {
    let text = match value {
        Value::Null => return None,
        Value::String(text) => text,
        other => other.to_string(),
    };
    let scale = column.scale.unwrap_or(0).clamp(0, 9) as usize;
    let shown = match column.kind.to_ascii_lowercase().as_str() {
        "boolean" => Some(if matches!(text.as_str(), "1" | "true" | "TRUE") { "true" } else { "false" }.to_owned()),
        "date" => text.parse::<i64>().ok().map(date),
        "time" => nanos(&text).map(|n| time(n.rem_euclid(DAY), scale)),
        "timestamp_ntz" => nanos(&text).map(|n| timestamp(n, scale)),
        "timestamp_ltz" => nanos(&text).map(|n| format!("{} Z", timestamp(n, scale))),
        "timestamp_tz" => timestamp_tz(&text, scale),
        "binary" => Some(format!("0x{text}")),
        _ => None,
    };
    Some(shown.unwrap_or(text))
}

const SECOND: i128 = 1_000_000_000;
const DAY: i128 = 86_400 * SECOND;

/// `seconds[.fraction]` as nanoseconds.
fn nanos(text: &str) -> Option<i128> {
    let text = text.trim();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut fraction = fraction.to_owned();
    fraction.truncate(9);
    while fraction.len() < 9 {
        fraction.push('0');
    }
    let value = whole.parse::<i128>().ok()? * SECOND + fraction.parse::<i128>().ok()?;
    Some(if negative { -value } else { value })
}

/// Days since 1970-01-01 as `YYYY-MM-DD` (proleptic Gregorian calendar).
fn date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    if year < 0 { format!("-{:04}-{month:02}-{day:02}", -year) } else { format!("{year:04}-{month:02}-{day:02}") }
}

fn time(nanos_of_day: i128, scale: usize) -> String {
    let seconds = nanos_of_day / SECOND;
    let mut text = format!("{:02}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60);
    if scale > 0 {
        let fraction = format!("{:09}", nanos_of_day % SECOND);
        text.push('.');
        text.push_str(&fraction[..scale]);
    }
    text
}

fn timestamp(nanos: i128, scale: usize) -> String {
    format!("{} {}", date(nanos.div_euclid(DAY) as i64), time(nanos.rem_euclid(DAY), scale))
}

/// `seconds[.fraction] offset`, the offset in minutes plus 1440.
fn timestamp_tz(text: &str, scale: usize) -> Option<String> {
    let (instant, offset) = text.trim().split_once(' ')?;
    let offset = offset.trim().parse::<i128>().ok()? - 1440;
    let local = nanos(instant)? + offset * 60 * SECOND;
    let sign = if offset < 0 { '-' } else { '+' };
    Some(format!("{} {sign}{:02}:{:02}", timestamp(local, scale), offset.abs() / 60, offset.abs() % 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(kind: &str, scale: Option<i64>) -> RowType {
        RowType { name: "C".into(), kind: kind.into(), scale, ..Default::default() }
    }

    fn shown(kind: &str, scale: Option<i64>, value: &str) -> String {
        cell(&column(kind, scale), Value::String(value.into())).unwrap()
    }

    #[test]
    fn names_types_the_way_snowflake_spells_them() {
        let named = |kind: &str, precision, scale, length| {
            RowType { name: "C".into(), kind: kind.into(), precision, scale, length }.column().type_name
        };
        assert_eq!(named("fixed", Some(38), Some(0), None), "NUMBER(38,0)");
        assert_eq!(named("fixed", Some(10), Some(2), None), "NUMBER(10,2)");
        assert_eq!(named("real", None, None, None), "FLOAT");
        assert_eq!(named("text", None, None, Some(100)), "VARCHAR(100)");
        assert_eq!(named("text", None, None, Some(16_777_216)), "VARCHAR");
        assert_eq!(named("text", None, None, Some(134_217_728)), "VARCHAR");
        assert_eq!(named("timestamp_ntz", None, Some(9), None), "TIMESTAMP_NTZ(9)");
        assert_eq!(named("timestamp_tz", None, Some(3), None), "TIMESTAMP_TZ(3)");
        assert_eq!(named("time", None, Some(0), None), "TIME(0)");
        for kind in ["boolean", "date", "variant", "object", "array", "binary", "geography", "vector"] {
            assert_eq!(named(kind, None, None, None), kind.to_ascii_uppercase());
        }
    }

    #[test]
    fn null_and_plain_values_pass_through() {
        assert_eq!(cell(&column("fixed", Some(0)), Value::Null), None);
        assert_eq!(shown("fixed", Some(2), "12345678901234567890.12"), "12345678901234567890.12");
        assert_eq!(shown("real", None, "1.5e-7"), "1.5e-7");
        assert_eq!(shown("text", None, "a\nb"), "a\nb");
        assert_eq!(shown("variant", None, "{\n  \"a\": 1\n}"), "{\n  \"a\": 1\n}");
        assert_eq!(cell(&column("fixed", Some(0)), serde_json::json!(7)), Some("7".into()));
    }

    #[test]
    fn booleans_and_binary() {
        assert_eq!(shown("boolean", None, "1"), "true");
        assert_eq!(shown("boolean", None, "true"), "true");
        assert_eq!(shown("boolean", None, "0"), "false");
        assert_eq!(shown("binary", None, "DEADBEEF"), "0xDEADBEEF");
    }

    #[test]
    fn dates_count_days_from_the_epoch() {
        assert_eq!(shown("date", None, "0"), "1970-01-01");
        assert_eq!(shown("date", None, "19675"), "2023-11-14");
        assert_eq!(shown("date", None, "-1"), "1969-12-31");
        assert_eq!(shown("date", None, "11016"), "2000-02-29");
        assert_eq!(shown("date", None, "-719162"), "0001-01-01");
        assert_eq!(shown("date", None, "2932896"), "9999-12-31");
        assert_eq!(shown("date", None, "not a number"), "not a number");
    }

    #[test]
    fn times_and_timestamps_keep_their_scale() {
        assert_eq!(shown("time", Some(0), "3723"), "01:02:03");
        assert_eq!(shown("time", Some(3), "3723.5"), "01:02:03.500");
        assert_eq!(shown("time", Some(9), "86399.999999999"), "23:59:59.999999999");
        assert_eq!(shown("timestamp_ntz", Some(0), "1700000000"), "2023-11-14 22:13:20");
        assert_eq!(shown("timestamp_ntz", Some(3), "1700000000.123000000"), "2023-11-14 22:13:20.123");
        assert_eq!(shown("timestamp_ntz", Some(9), "1700000000.123456789"), "2023-11-14 22:13:20.123456789");
        assert_eq!(shown("timestamp_ntz", Some(3), "-0.500"), "1969-12-31 23:59:59.500");
        assert_eq!(shown("timestamp_ntz", Some(0), "-86401"), "1969-12-30 23:59:59");
        assert_eq!(shown("timestamp_ltz", Some(0), "1700000000"), "2023-11-14 22:13:20 Z");
    }

    #[test]
    fn zoned_timestamps_show_local_time_and_offset() {
        assert_eq!(shown("timestamp_tz", Some(3), "1700000000.123 1440"), "2023-11-14 22:13:20.123 +00:00");
        assert_eq!(shown("timestamp_tz", Some(0), "1700000000 1560"), "2023-11-15 00:13:20 +02:00");
        assert_eq!(shown("timestamp_tz", Some(0), "1700000000 1110"), "2023-11-14 16:43:20 -05:30");
        assert_eq!(shown("timestamp_tz", Some(0), "garbage"), "garbage");
    }
}
