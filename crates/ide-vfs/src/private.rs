//! Owner-only directories for host-managed plugin content.

use ide_core::{IdeError, IdeResult};
use std::fs;
use std::path::Path;

/// Creates one directory with private permissions from the outset. Existing
/// directories must belong to this user and may never be symbolic links.
/// The parent is expected to be an application-owned directory.
pub fn create_private_dir(path: &Path) -> IdeResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let dir: fs::File = rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(std::io::Error::from)?
        .into();
        let meta = dir.metadata()?;
        if !meta.is_dir() || meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(IdeError::invalid("private directory must be owned by the current user and not a symlink"));
        }
        if meta.mode() & 0o7777 != 0o700 {
            dir.set_permissions(fs::Permissions::from_mode(0o700))?;
        }
    }
    #[cfg(windows)]
    windows::create(path)?;
    #[cfg(not(any(unix, windows)))]
    return Err(IdeError::unavailable("private directories are unsupported on this platform"));
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
        SetNamedSecurityInfoW,
    };
    use windows_sys::Win32::Security::{
        ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateDirectoryW, FILE_ATTRIBUTE_REPARSE_POINT};

    struct Descriptor(*mut std::ffi::c_void);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn already_private(path: &[u16], expected: *mut ACL) -> IdeResult<bool> {
        let mut raw = std::ptr::null_mut();
        let mut actual = std::ptr::null_mut();
        let error = unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut actual,
                std::ptr::null_mut(),
                &mut raw,
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).into());
        }
        let descriptor = Descriptor(raw);
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if control & SE_DACL_PROTECTED == 0 || actual.is_null() {
            return Ok(false);
        }
        // Compare only the single ACE, not unused ACL allocation space.
        if unsafe { (*actual).AceCount != 1 || (*expected).AceCount != 1 } {
            return Ok(false);
        }
        let mut actual_ace = std::ptr::null_mut();
        let mut expected_ace = std::ptr::null_mut();
        if unsafe { GetAce(actual, 0, &mut actual_ace) } == 0 || unsafe { GetAce(expected, 0, &mut expected_ace) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let size = unsafe { (*expected_ace.cast::<ACE_HEADER>()).AceSize };
        if unsafe { (*actual_ace.cast::<ACE_HEADER>()).AceSize } != size {
            return Ok(false);
        }
        Ok(unsafe {
            std::slice::from_raw_parts(actual_ace.cast::<u8>(), usize::from(size))
                == std::slice::from_raw_parts(expected_ace.cast::<u8>(), usize::from(size))
        })
    }

    pub(super) fn create(path: &Path) -> IdeResult<()> {
        // Owner rights only, protected against inherited public access;
        // children inherit the same owner-only access from birth.
        let sddl = "D:P(A;OICI;FA;;;OW)\0".encode_utf16().collect::<Vec<_>>();
        let mut raw = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut raw,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let descriptor = Descriptor(raw);
        let attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let wide = path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        if unsafe { CreateDirectoryW(wide.as_ptr(), &attrs) } == 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e.into());
            }
        }
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(IdeError::invalid("private directory must not be a reparse point"));
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = std::ptr::null_mut();
        if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) } == 0
            || present == 0
            || dacl.is_null()
        {
            return Err(std::io::Error::last_os_error().into());
        }
        // Reapplying an inheritable DACL would walk every cached file.
        if already_private(&wide, dacl)? {
            return Ok(());
        }
        let error = unsafe {
            SetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).into());
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn private_creation_and_editor_save_preserve_owner_only_access() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("files");
        create_private_dir(&dir).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let path = dir.join("fake-secret.txt");
        crate::write_atomic_private(&path, b"fake data").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        crate::save_text(&path, "edited fake data", "utf-8", false).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited fake data");
        let link = tmp.path().join("link");
        symlink(&dir, &link).unwrap();
        assert!(create_private_dir(&link).is_err());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

    fn acl(path: &Path) -> String {
        let path = path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        let mut descriptor = std::ptr::null_mut();
        let error = unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(error, 0);
        let mut string = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut string,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        unsafe {
            let mut len = 0;
            while *string.add(len) != 0 {
                len += 1;
            }
            let result = String::from_utf16_lossy(std::slice::from_raw_parts(string, len));
            LocalFree(string.cast());
            LocalFree(descriptor);
            result
        }
    }

    #[test]
    fn directory_and_editor_saved_file_have_only_owner_access() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("files");
        create_private_dir(&dir).unwrap();
        let directory_acl = acl(&dir);
        assert!(directory_acl.starts_with("D:P"), "{directory_acl}");
        assert_eq!(directory_acl.matches("(A;").count(), 1, "{directory_acl}");
        assert!(directory_acl.contains(";;;OW)"), "{directory_acl}");
        let path = dir.join("fake-secret.txt");
        crate::write_atomic_private(&path, b"fake text").unwrap();
        let initial_acl = acl(&path);
        assert_eq!(initial_acl.matches("(A;").count(), 1, "{initial_acl}");
        assert!(initial_acl.contains(";;;OW)"), "{initial_acl}");
        create_private_dir(&dir).unwrap();
        assert_eq!(acl(&dir), directory_acl);
        assert_eq!(acl(&path), initial_acl);
        crate::save_text(&path, "edited fake text", "utf-8", false).unwrap();
        assert_eq!(acl(&path), initial_acl);
    }
}
