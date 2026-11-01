use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Size(pub(super) u32, pub(super) u32);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Mode {
    pub(super) maximized: bool,
    pub(super) fullscreen: bool,
    pub(super) minimized: bool,
}

impl Mode {
    pub(super) fn normal(self) -> bool {
        !self.maximized && !self.fullscreen && !self.minimized
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct ModeHistory(pub(super) Mode);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NormalTransition {
    Stable,
    WaitForResize,
    Restore,
}

impl ModeHistory {
    pub(super) fn observe(&mut self, current: Mode, can_restore: bool) -> NormalTransition {
        let returned = !self.0.normal() && current.normal();
        if returned && !can_restore {
            return NormalTransition::WaitForResize;
        }
        self.0 = current;
        if returned { NormalTransition::Restore } else { NormalTransition::Stable }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Limits {
    pub(super) min: (f64, f64),
    pub(super) max: (Option<f64>, Option<f64>),
}

impl Limits {
    pub(super) fn in_work_area(self, area: Option<Size>, scale: f64) -> Self {
        let Some(Size(width, height)) = area.filter(|s| s.0 > 0 && s.1 > 0) else { return self };
        Self {
            max: (
                Some(self.max.0.unwrap_or(f64::INFINITY).min((f64::from(width) / scale).floor())),
                Some(self.max.1.unwrap_or(f64::INFINITY).min((f64::from(height) / scale).floor())),
            ),
            ..self
        }
    }
}

pub(super) fn restore_size(saved: Size, scale: f64, limits: Limits) -> Size {
    let dimension = |pixels: u32, min: f64, max: Option<f64>| {
        let logical = (f64::from(pixels) / scale).max(min).max(1.0);
        // gtk_window_resize takes integer logical dimensions.
        (logical.min(max.unwrap_or(f64::INFINITY).max(min)).round() * scale).round() as u32
    };
    Size(dimension(saved.0, limits.min.0, limits.max.0), dimension(saved.1, limits.min.1, limits.max.1))
}

pub(super) fn remember_size(previous: Size, current: Size, restoring: bool, mode: Mode) -> Size {
    if restoring || !mode.normal() || current.0 == 0 || current.1 == 0 { previous } else { current }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ModeAction {
    Request,
    Wait,
    Track,
}

pub(super) fn mode_action(reached: bool, requested: bool, timed_out: bool) -> ModeAction {
    if reached {
        ModeAction::Track
    } else if !requested {
        ModeAction::Request
    } else if timed_out {
        ModeAction::Track
    } else {
        ModeAction::Wait
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub(super) struct Geometry {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) prev_x: i32,
    pub(super) prev_y: i32,
    pub(super) maximized: bool,
    pub(super) fullscreen: bool,
    pub(super) visible: bool,
    pub(super) decorated: bool,
}

impl Geometry {
    pub(super) fn set_normal_size(&mut self, size: Size) {
        (self.width, self.height) = (size.0, size.1);
        self.maximized = false;
        self.fullscreen = false;
    }
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            prev_x: 0,
            prev_y: 0,
            maximized: false,
            fullscreen: false,
            visible: true,
            decorated: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constrained_size_does_not_skip_the_first_mode_request() {
        assert_eq!(mode_action(false, false, true), ModeAction::Request);
        assert_eq!(mode_action(false, false, false), ModeAction::Request);
        assert_eq!(mode_action(false, true, false), ModeAction::Wait);
        assert_eq!(mode_action(false, true, true), ModeAction::Track);
        assert_eq!(mode_action(true, false, false), ModeAction::Track);
    }

    #[test]
    fn physical_sizes_use_the_actual_output_scale() {
        for scale in [1.0, 2.0] {
            assert_eq!(restore_size(Size(2468, 1356), scale, Limits::default()), Size(2468, 1356));
        }
        // Saved at scale 1, mapped on scale 2: keep physical pixels, not twice that size.
        assert_eq!(restore_size(Size(1234, 678), 2.0, Limits::default()), Size(1234, 678));
    }

    #[test]
    fn gtk_limits_and_integer_logical_dimensions_are_applied_once() {
        let limits = Limits { min: (800.0, 500.0), max: (Some(1600.0), Some(1000.0)) };
        assert_eq!(restore_size(Size(1201, 801), 1.0, limits), Size(1201, 801));
        assert_eq!(restore_size(Size(1201, 801), 2.0, limits), Size(1600, 1000));
        assert_eq!(restore_size(Size(2001, 1401), 2.0, limits), Size(2002, 1402));
        assert_eq!(restore_size(Size(9000, 6000), 2.0, limits), Size(3200, 2000));
    }

    #[test]
    fn damaged_sizes_are_bounded_in_the_actual_outputs_units() {
        let limits = Limits { min: (800.0, 500.0), ..Default::default() };
        for scale in [1.0, 2.0] {
            let bounded = limits.in_work_area(Some(Size(3840, 2160)), scale);
            assert_eq!(restore_size(Size(45068, 30000), scale, bounded), Size(3840, 2160));
            assert_eq!(restore_size(Size(2468, 1356), scale, bounded), Size(2468, 1356));
        }
    }

    #[test]
    fn restoration_and_non_normal_events_preserve_the_normal_size() {
        let normal = Size(1234, 678);
        for current in [Size(2468, 1356), Size(2648, 1602), Size(5476, 3204)] {
            assert_eq!(remember_size(normal, current, true, Mode::default()), normal);
            for mode in [
                Mode { maximized: true, ..Default::default() },
                Mode { fullscreen: true, ..Default::default() },
                Mode { minimized: true, ..Default::default() },
            ] {
                assert_eq!(remember_size(normal, current, false, mode), normal);
            }
        }
        assert_eq!(remember_size(normal, Size(1201, 801), false, Mode::default()), Size(1201, 801));
        assert_eq!(remember_size(normal, Size(0, 678), false, Mode::default()), normal);
    }

    #[test]
    fn a_mixed_dpi_maximized_launch_does_not_compound() {
        let mut saved = Size(2468, 1356);
        for _ in 0..3 {
            saved = remember_size(saved, Size(saved.0 * 2, saved.1 * 2), true, Mode::default());
            let restored = restore_size(saved, 2.0, Limits::default());
            saved = remember_size(saved, restored, false, Mode::default());
            saved = remember_size(saved, Size(3840, 2160), false, Mode { maximized: true, ..Default::default() });
            assert_eq!(saved, Size(2468, 1356));
        }
    }

    #[test]
    fn moved_does_not_consume_the_unmaximize_resize() {
        for mode in [
            Mode { maximized: true, ..Default::default() },
            Mode { fullscreen: true, ..Default::default() },
            Mode { minimized: true, ..Default::default() },
        ] {
            let mut history = ModeHistory(mode);
            assert_eq!(history.observe(Mode::default(), false), NormalTransition::WaitForResize);
            assert_eq!(history.0, mode);
            assert_eq!(history.observe(Mode::default(), true), NormalTransition::Restore);
            assert_eq!(history.observe(Mode::default(), true), NormalTransition::Stable);
        }
    }

    #[test]
    fn an_explicit_normal_frame_overrides_old_window_modes() {
        let mut saved = Geometry { maximized: true, fullscreen: true, x: 123, y: 456, ..Default::default() };
        saved.set_normal_size(Size(1100, 700));
        assert_eq!((saved.width, saved.height), (1100, 700));
        assert!(!saved.maximized && !saved.fullscreen);
        assert_eq!((saved.x, saved.y), (123, 456));
    }

    #[test]
    fn state_files_remain_compatible_and_keep_closed_windows() {
        let saved: std::collections::HashMap<String, Geometry> = serde_json::from_str(
            r#"{"main":{"width":1234,"height":678,"maximized":true},"settings":{"width":1001,"height":701}}"#,
        )
        .unwrap();
        let copy: std::collections::HashMap<String, Geometry> =
            serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap();
        assert_eq!(copy["settings"].height, 701);
        assert!(copy["main"].maximized);
        assert_eq!(copy["main"].width, 1234);
    }
}
