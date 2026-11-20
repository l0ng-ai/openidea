//! Windows: OLE `DoDragDrop` of a data object that serves the paths as `CF_HDROP`.

use super::{Outcome, hdrop_file_list};
use raw_window_handle::HasWindowHandle;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, E_NOTIMPL, GlobalFree, HGLOBAL,
    OLE_E_ADVISENOTSUPPORTED, S_OK,
};
use windows::Win32::System::Com::{
    DATADIR_GET, DVASPECT_CONTENT, FORMATETC, IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC,
    IEnumSTATDATA, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::Memory::{GHND, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::{
    CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize,
    OleUninitialize,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Shell::{DROPFILES, SHCreateDataObject, SHCreateStdEnumFmtEtc};
use windows::core::{BOOL, Error, HRESULT, Ref, Result, implement};

/// Drags `paths` (see [`super::local_paths`]) until the button is released, then calls
/// `done` and returns. `DoDragDrop` runs its own message loop, so the window keeps painting.
pub fn start<W: HasWindowHandle>(
    _window: &W,
    paths: Vec<PathBuf>,
    done: impl FnOnce(Outcome) + 'static,
) -> io::Result<()> {
    let files = hdrop_file_list(paths.iter().map(|path| path.as_os_str().encode_wide()));
    // The window's event loop has initialised OLE on this thread already; this takes a
    // reference that `OleUninitialize` gives back.
    unsafe { OleInitialize(None) }.map_err(io::Error::other)?;
    let outcome = drag(files);
    unsafe { OleUninitialize() };
    done(outcome.map_err(io::Error::other)?);
    Ok(())
}

fn drag(files: Vec<u16>) -> Result<Outcome> {
    // Formats other than `CF_HDROP` (the drag image, drop descriptions the shell sets on
    // the source's data object) are kept by a plain shell data object.
    let inner: IDataObject = unsafe { SHCreateDataObject(None, None, None::<&IDataObject>) }?;
    let data: IDataObject = DataObject { files, inner }.into();
    let source: IDropSource = DropSource.into();
    let mut effect = DROPEFFECT_NONE;
    match unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) } {
        DRAGDROP_S_DROP if effect != DROPEFFECT_NONE => Ok(Outcome::Dropped),
        DRAGDROP_S_DROP | DRAGDROP_S_CANCEL => Ok(Outcome::Cancelled),
        error => Err(Error::from_hresult(error)),
    }
}

#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, escape_pressed: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape_pressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if keys & MK_LBUTTON == MODIFIERKEYS_FLAGS(0) {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

#[implement(IDataObject)]
struct DataObject {
    /// The `DROPFILES` file list ([`hdrop_file_list`]).
    files: Vec<u16>,
    inner: IDataObject,
}

const HDROP: FORMATETC = FORMATETC {
    cfFormat: CF_HDROP.0,
    ptd: std::ptr::null_mut(),
    dwAspect: DVASPECT_CONTENT.0,
    lindex: -1,
    tymed: TYMED_HGLOBAL.0 as u32,
};

fn is_hdrop(format: *const FORMATETC) -> bool {
    unsafe { format.as_ref() }.is_some_and(|format| {
        format.cfFormat == HDROP.cfFormat && format.dwAspect == HDROP.dwAspect && format.tymed & HDROP.tymed != 0
    })
}

impl DataObject {
    /// A new `DROPFILES` block; the receiver frees it.
    fn hdrop(&self) -> Result<HGLOBAL> {
        let header = size_of::<DROPFILES>();
        let size = header + std::mem::size_of_val(self.files.as_slice());
        unsafe {
            let handle = GlobalAlloc(GHND, size)?;
            let block = GlobalLock(handle).cast::<u8>();
            if block.is_null() {
                let error = Error::from_thread();
                let _ = GlobalFree(Some(handle));
                return Err(error);
            }
            block.cast::<DROPFILES>().write_unaligned(DROPFILES {
                pFiles: header as u32,
                fWide: true.into(),
                ..Default::default()
            });
            std::ptr::copy_nonoverlapping(self.files.as_ptr().cast::<u8>(), block.add(header), size - header);
            // Fails with no error once the lock count is back to zero, which it is.
            let _ = GlobalUnlock(handle);
            Ok(handle)
        }
    }
}

impl IDataObject_Impl for DataObject_Impl {
    fn GetData(&self, format: *const FORMATETC) -> Result<STGMEDIUM> {
        if !is_hdrop(format) {
            return unsafe { self.inner.GetData(format) };
        }
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: self.hdrop()? },
            pUnkForRelease: std::mem::ManuallyDrop::new(None),
        })
    }

    fn GetDataHere(&self, format: *const FORMATETC, medium: *mut STGMEDIUM) -> Result<()> {
        if is_hdrop(format) {
            return Err(DV_E_FORMATETC.into());
        }
        unsafe { self.inner.GetDataHere(format, medium) }
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        if is_hdrop(format) { S_OK } else { unsafe { self.inner.QueryGetData(format) } }
    }

    fn GetCanonicalFormatEtc(&self, format: *const FORMATETC, canonical: *mut FORMATETC) -> HRESULT {
        unsafe { self.inner.GetCanonicalFormatEtc(format, canonical) }
    }

    fn SetData(&self, format: *const FORMATETC, medium: *const STGMEDIUM, release: BOOL) -> Result<()> {
        unsafe { self.inner.SetData(format, medium, release.as_bool()) }
    }

    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe { SHCreateStdEnumFmtEtc(&[HDROP]) }
    }

    fn DAdvise(&self, _format: *const FORMATETC, _advf: u32, _sink: Ref<IAdviseSink>) -> Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _connection: u32) -> Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}
