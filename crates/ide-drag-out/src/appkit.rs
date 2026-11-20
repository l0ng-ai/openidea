//! macOS: an AppKit dragging session with one pasteboard item per path, each a file URL.

use super::Outcome;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
    NSEventModifierFlags, NSEventType, NSPasteboardItem, NSPasteboardTypeFileURL, NSView, NSWorkspace,
};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::cell::Cell;
use std::io;
use std::path::PathBuf;

/// The size of each file's icon under the pointer, in points.
const ICON_SIZE: f64 = 32.0;

/// Starts dragging `paths` (see [`super::local_paths`]) from `window`, each shown with its
/// Finder icon; `done` runs on the main thread when the drag ends.
pub fn start<W: HasWindowHandle>(
    window: &W,
    paths: Vec<PathBuf>,
    done: impl FnOnce(Outcome) + 'static,
) -> io::Result<()> {
    let mtm = MainThreadMarker::new().ok_or_else(|| io::Error::other("a drag starts on the main thread"))?;
    let RawWindowHandle::AppKit(handle) =
        window.window_handle().map_err(|error| io::Error::other(error.to_string()))?.as_raw()
    else {
        return Err(io::Error::other("not an AppKit window"));
    };
    // SAFETY: the handle names this window's view, alive while `window` is borrowed.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    let window = view.window().ok_or_else(|| io::Error::other("the view has no window"))?;
    let content = window.contentView().ok_or_else(|| io::Error::other("the window has no content view"))?;
    // In window coordinates, which are the content view's.
    let pointer = window.mouseLocationOutsideOfEventStream();
    let frame = NSRect::new(
        NSPoint::new(pointer.x - ICON_SIZE / 2.0, pointer.y - ICON_SIZE / 2.0),
        NSSize::new(ICON_SIZE, ICON_SIZE),
    );

    let workspace = NSWorkspace::sharedWorkspace();
    let mut items = Vec::with_capacity(paths.len());
    for path in &paths {
        let path = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path)
            .absoluteString()
            .ok_or_else(|| io::Error::other(format!("not a file URL: {path}")))?;
        let item = NSPasteboardItem::new();
        if !item.setString_forType(&url, unsafe { NSPasteboardTypeFileURL }) {
            return Err(io::Error::other(format!("cannot put {path} on the pasteboard")));
        }
        let drag_item =
            NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), ProtocolObject::from_ref(&*item));
        let icon = workspace.iconForFile(&path);
        unsafe { drag_item.setDraggingFrame_contents(frame, Some(&icon)) };
        items.push(drag_item);
    }

    // The session starts from a drag event at the pointer: the web view's own mouse events
    // went to WebKit, and the current event may be a later one.
    let timestamp = NSApplication::sharedApplication(mtm).currentEvent().map_or(0.0, |event| event.timestamp());
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDragged,
        pointer,
        NSEventModifierFlags::empty(),
        timestamp,
        window.windowNumber(),
        None,
        0,
        1,
        1.0,
    )
    .ok_or_else(|| io::Error::other("cannot make the drag event"))?;
    let source = DragSource::new(Box::new(done), mtm);
    content.beginDraggingSessionWithItems_event_source(
        &NSArray::from_retained_slice(&items),
        &event,
        ProtocolObject::from_ref(&*source),
    );
    Ok(())
}

type Done = Box<dyn FnOnce(Outcome)>;

struct Ivars {
    done: Cell<Option<Done>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "OpenIdeaDragOutSource"]
    #[ivars = Ivars]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operation_mask(&self, session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
            session.setAnimatesToStartingPositionsOnCancelOrFail(true);
            NSDragOperation::Copy
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, operation: NSDragOperation) {
            if let Some(done) = self.ivars().done.take() {
                done(if operation == NSDragOperation::None { Outcome::Cancelled } else { Outcome::Dropped });
            }
        }
    }
);

impl DragSource {
    fn new(done: Done, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { done: Cell::new(Some(done)) });
        unsafe { msg_send![super(this), init] }
    }
}
