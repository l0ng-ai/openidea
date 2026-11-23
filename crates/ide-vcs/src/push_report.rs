use crate::cli;
use ide_core::error::{ErrorData, ErrorKind, PushRefResult, PushRefStatus, PushReport};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::Path;

pub(crate) fn run(
    report: &mut PushReport,
    root: &Path,
    args: &[&str],
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let mut refs = Vec::new();
    let result = cli::run_streaming_stdout(root, args, cancel, on_output, &mut |line| {
        if let Some(result) = parse_ref(line) {
            refs.push(result);
        }
    });
    report.refs.extend(refs.into_iter().map(|(reference, status, summary)| {
        let commits = (status == PushRefStatus::FastForward).then(|| count_commits(root, &summary, cancel)).flatten();
        PushRefResult { reference, status, commits }
    }));
    result.map_err(|error| with_partial_push(error, report))
}

pub(crate) fn with_partial_push(mut error: IdeError, report: &PushReport) -> IdeError {
    if error.kind != ErrorKind::Cancelled && report.refs.iter().any(|update| update.status != PushRefStatus::UpToDate) {
        error.data = Some(ErrorData::PushPartiallyApplied { report: Box::new(report.clone()) });
    }
    error
}

fn parse_ref(line: &str) -> Option<(String, PushRefStatus, String)> {
    let (flag, fields) = line.split_once('\t')?;
    let status = match flag {
        " " => PushRefStatus::FastForward,
        "+" => PushRefStatus::Forced,
        "*" => PushRefStatus::Created,
        "=" => PushRefStatus::UpToDate,
        "-" => PushRefStatus::Deleted,
        _ => return None,
    };
    let (refs, summary) = fields.split_once('\t')?;
    let (_, reference) = refs.split_once(':')?;
    if !reference.starts_with("refs/") || reference.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return None;
    }
    Some((reference.to_owned(), status, summary.trim().to_owned()))
}

fn count_commits(root: &Path, range: &str, cancel: &CancellationToken) -> Option<u32> {
    let (from, to) = range.split_once("..")?;
    let is_hex = |name: &str| (4..=64).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !is_hex(from) || !is_hex(to) {
        return None;
    }
    cli::run_cancellable(root, &["rev-list", "--count", range, "--"], cancel).ok()?.stdout_str().trim().parse().ok()
}
