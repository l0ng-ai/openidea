//! Drives a real device through `adb`, checking what the Logcat tool window does:
//! that the device list parses, that the stream delivers batches, and that
//! cancelling stops both the stream and its `adb` process.
//!
//! Ignored by default (needs a connected device). Run with
//! `OPENIDEA_ADB_DEVICE=<serial> cargo test -p ide-android --test device -- --ignored --nocapture`
//! — without the variable, the connected device is used when there is exactly one.

use ide_android::*;
use ide_core::CancellationToken;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn serial() -> Option<String> {
    if let Ok(serial) = std::env::var("OPENIDEA_ADB_DEVICE") {
        return Some(serial);
    }
    let online = devices().ok()?.into_iter().filter(AndroidDevice::is_online).collect::<Vec<_>>();
    (online.len() == 1).then(|| online[0].serial.clone())
}

#[test]
#[ignore]
fn finds_the_adb_executable() {
    let adb = adb_executable().expect("adb (set ANDROID_HOME or OPENIDEA_ADB)");
    println!("adb: {}", adb.display());
    assert!(adb.is_file());
}

#[test]
#[ignore]
fn lists_connected_devices() {
    let devices = devices().expect("adb devices");
    for device in &devices {
        println!("{:<16} {:<14} {} ({:?})", device.serial, device.state, device.label(), device.transport_id);
    }
    assert!(!devices.is_empty(), "no devices connected");
}

#[test]
#[ignore]
fn streams_batches_and_stops_on_cancel() {
    let serial = serial().expect("a single connected device, or OPENIDEA_ADB_DEVICE");
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let received = Arc::new(Mutex::new(Vec::<LogcatLine>::new()));
    let sink = received.clone();
    let started = Instant::now();
    let stream = std::thread::spawn(move || {
        ide_android::logcat(&serial, false, &stop, &mut |batch| {
            sink.lock().unwrap().extend(batch);
        })
    });
    // Enough to see the tail seed and a few live lines from a device that idles.
    std::thread::sleep(Duration::from_secs(4));
    cancel.cancel();
    stream.join().unwrap().expect("logcat stops cleanly when cancelled");
    let lines = received.lock().unwrap();
    println!("{} lines in {:?}", lines.len(), started.elapsed());
    for line in lines.iter().rev().take(5) {
        println!("{:<14} {:>6} {}", line.tag, line.pid, line.message);
    }
    assert!(!lines.is_empty(), "no lines within 4s");
    assert!(lines.iter().any(|l| l.level != LogcatLevel::Unknown), "every line failed to parse");
}
