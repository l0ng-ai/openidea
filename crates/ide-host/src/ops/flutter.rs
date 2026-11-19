//! Flutter's devices. The daemon runs on the project host, where `flutter run` and the debug
//! adapter run too, so a remote project lists the devices of its remote machine.
use crate::Host;
use ide_command::command;
use ide_core::IdeResult;
use ide_core::event::FlutterDeviceList;

/// The project's Flutter devices, starting its `flutter daemon` on first use. Changes arrive as
/// `IdeEvent::FlutterDevices`.
#[command(trust = trusted)]
pub fn flutter_devices(host: &Host, window: &str) -> IdeResult<FlutterDeviceList> {
    Ok(host.project(window)?.flutter.devices())
}

/// Looks at adb again, for Android devices Flutter doesn't report (awaiting authorization, offline).
#[command(trust = trusted)]
pub fn flutter_devices_refresh(host: &Host, window: &str) -> IdeResult<()> {
    host.project(window)?.flutter.refresh();
    Ok(())
}

/// Replaces the project's `flutter daemon`, after a failure or an SDK change.
#[command(trust = trusted)]
pub fn flutter_daemon_restart(host: &Host, window: &str) -> IdeResult<FlutterDeviceList> {
    Ok(host.project(window)?.flutter.restart())
}

ide_command::domain!(flutter: flutter_devices, flutter_devices_refresh, flutter_daemon_restart);
