//! How often the terminal and Run console pumps hand output to the UI, from
//! Settings › Tools › Terminal › Max FPS (#5897). The frontend paints at most that
//! often anyway; batching at half its frame interval keeps a fresh batch ready for
//! every frame while cutting the IPC events (and their handling on the UI thread)
//! that would only be buffered there.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

/// Frames per second; 0 is Unlimited.
static MAX_FPS: AtomicU32 = AtomicU32::new(0);

/// Applies the `terminal.maxFps` setting: `"unlimited"` or a number of frames per second.
/// Running sessions pick it up at their next batch.
pub fn set_max_fps(setting: &str) {
    MAX_FPS.store(setting.trim().parse::<u32>().unwrap_or(0), Ordering::Relaxed);
}

/// The batch interval for a pump whose Unlimited interval is `unlimited`.
pub fn batch_interval(unlimited: Duration) -> Duration {
    interval_for(MAX_FPS.load(Ordering::Relaxed), unlimited)
}

/// Half the paint interval, within 4–200 ms, and never faster than the Unlimited rate.
fn interval_for(fps: u32, unlimited: Duration) -> Duration {
    if fps == 0 {
        return unlimited;
    }
    Duration::from_millis((500 / u64::from(fps)).clamp(4, 200)).max(unlimited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_is_half_the_frame_and_clamped() {
        let terminal = Duration::from_millis(4);
        let run = Duration::from_millis(8);
        let ms = |fps, unlimited| interval_for(fps, unlimited).as_millis();
        assert_eq!(ms(0, terminal), 4, "Unlimited keeps the pump's own rate");
        assert_eq!(ms(0, run), 8);
        assert_eq!([60, 30, 15, 10, 5].map(|fps| ms(fps, terminal)), [8, 16, 33, 50, 100]);
        assert_eq!(ms(1, terminal), 200, "upper bound");
        assert_eq!(ms(1000, terminal), 4, "lower bound");
        assert_eq!(ms(1000, run), 8, "never faster than Unlimited");
    }

    #[test]
    fn setting_values_parse_and_unknown_means_unlimited() {
        set_max_fps("30");
        assert_eq!(batch_interval(Duration::from_millis(4)).as_millis(), 16);
        set_max_fps("unlimited");
        assert_eq!(batch_interval(Duration::from_millis(4)).as_millis(), 4);
        set_max_fps("fast");
        assert_eq!(batch_interval(Duration::from_millis(8)).as_millis(), 8);
    }
}
