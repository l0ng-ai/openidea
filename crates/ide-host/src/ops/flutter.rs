//! Flutter's devices. The daemon runs on the project host, where `flutter run` and the debug
//! adapter run too, so a remote project lists the devices of its remote machine.
use crate::Host;
use ide_command::command;
use ide_core::event::FlutterDeviceList;
use ide_core::{IdeError, IdeResult};

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

/// Starts an emulator from [`FlutterDeviceList::emulators`]. Returns once the launch is under way: the device follows as `IdeEvent::FlutterDevices`.
#[command(trust = trusted)]
pub async fn flutter_emulator_launch(host: &Host, window: &str, id: String) -> IdeResult<()> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || project.flutter.launch_emulator(&id))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
        .map_err(IdeError::unavailable)
}

/// The address of the project's DevTools server, started on first use. A server that failed or
/// exited is only started again by the next request.
#[command(trust = trusted)]
pub async fn flutter_devtools_url(host: &Host, window: &str) -> IdeResult<String> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || project.devtools.url(&[]))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
        .map_err(IdeError::unavailable)
}

/// The address of the project's Widget Preview page, its server started on first use with the
/// project's DevTools for its inspector. A server that failed or exited is only started again by
/// the next request.
#[command(trust = trusted)]
pub async fn flutter_widget_preview_url(host: &Host, window: &str) -> IdeResult<String> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        // Without it the tool starts a DevTools of its own.
        let devtools = project.devtools.url(&[]).map(|url| format!("--devtools-server-address={url}"));
        project.widget_preview.url(&Vec::from_iter(devtools.ok()))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
    .map_err(IdeError::unavailable)
}

ide_command::domain!(flutter: flutter_devices, flutter_devices_refresh, flutter_daemon_restart, flutter_emulator_launch,
    flutter_devtools_url, flutter_widget_preview_url);
