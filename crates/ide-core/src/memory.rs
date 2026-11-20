//! Returning freed heap pages to the OS.

/// Hands pages the allocator has freed but kept back to the OS. Call after a burst of
/// short-lived allocations (a full index scan); until then they still count towards the
/// process's memory footprint.
pub fn release_free_pages() {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: a null zone covers every zone; a zero goal releases as much as possible.
        unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) };
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only returns free memory to the OS.
    unsafe {
        libc::malloc_trim(0);
    }
}
