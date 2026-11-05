//! P0 probe guest. Built twice (see `build.sh`): `probe-min` and, with
//! `--features full`, `probe-full` with the optional exports.

#[cfg(feature = "full")]
wit_bindgen::generate!({ world: "probe-full", path: "wit", generate_all });
#[cfg(not(feature = "full"))]
wit_bindgen::generate!({ world: "probe-min", path: "wit", generate_all });

use exports::openidea::probe::base;
use openidea::probe::host_api;
use std::sync::atomic::{AtomicU32, Ordering};

static CALLS: AtomicU32 = AtomicU32::new(0);

struct Probe;

impl base::Guest for Probe {
    fn run(cmd: String, arg: String) -> Result<String, String> {
        let n = CALLS.fetch_add(1, Ordering::Relaxed) + 1;
        match cmd.as_str() {
            "echo" => Ok(arg),
            // Instance state survives between calls (and is lost with the instance).
            "count" => Ok(n.to_string()),
            "spin" => {
                let mut x: u64 = 0;
                loop {
                    x = std::hint::black_box(x.wrapping_add(1));
                }
            }
            "sleep" => {
                host_api::sleep_ms(arg.parse().map_err(|_| "ms")?);
                Ok("slept".into())
            }
            // Streams items pushed by the host until it cancels.
            "task" => {
                let task = host_api::current_task();
                let mut got = Vec::new();
                loop {
                    task.next_ready().block();
                    if task.is_cancelled() {
                        return Ok(format!("cancelled after {}", got.join(",")));
                    }
                    if let Some(item) = task.take() {
                        got.push(item);
                        task.report(got.len() as u32, None);
                    }
                }
            }
            other => Err(format!("unknown: {other}")),
        }
    }
}

#[cfg(feature = "full")]
impl exports::openidea::probe::code_actions::Guest for Probe {
    fn actions(path: String) -> Vec<String> {
        vec![format!("fix:{path}")]
    }
}

#[cfg(feature = "full")]
impl exports::openidea::probe::completion::Guest for Probe {
    fn complete(prefix: String) -> Vec<String> {
        vec![format!("{prefix}1"), format!("{prefix}2")]
    }
}

export!(Probe);
