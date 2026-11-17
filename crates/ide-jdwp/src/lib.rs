//! JDWP packet codec and the debugger link built on it. Bounds-checked: malformed input is an
//! `Err`, never a panic.

mod codec;
mod ids;
mod inspector;
mod link;

pub use codec::{
    CodecError, FLAG_REPLY, HEADER_LEN, Header, MAX_ADAPTER_PACKET, Reader, Value, Writer, is_object_tag,
    primitive_text,
};
pub use ids::{IdSizes, ReplyIds, Stop, dispose_body, object_ids, stop_of};
pub use inspector::LinkInspector;
pub use link::{JdwpLink, LinkError, LinkOptions, LinkState, OWN_IDS};
