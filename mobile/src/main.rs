// Desktop builds of the phone app, for trying it without a simulator.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    openidea_mobile_lib::run()
}
