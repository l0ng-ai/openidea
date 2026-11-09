/// The Windows OS build used by ConPTY; unavailable on other platforms or on query failure.
#[cfg(windows)]
pub fn windows_build_number() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info =
        OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    // SAFETY: `info` is initialized and declares the size of the writable structure.
    let status = unsafe { RtlGetVersion(&mut info) };
    (status >= 0 && info.dwBuildNumber > 0).then_some(info.dwBuildNumber)
}

#[cfg(not(windows))]
pub fn windows_build_number() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_build_is_platform_specific() {
        let build = super::windows_build_number();
        #[cfg(windows)]
        assert!(build.is_some_and(|build| build > 0));
        #[cfg(not(windows))]
        assert_eq!(build, None);
    }
}
