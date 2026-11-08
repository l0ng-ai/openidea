//! JDWP packet codec. Bounds-checked: malformed input is an `Err`, never a panic.

mod codec;
mod ids;

pub use codec::{
    CodecError, FLAG_REPLY, HEADER_LEN, Header, MAX_ADAPTER_PACKET, Reader, Value, Writer, is_object_tag,
    primitive_text,
};
pub use ids::{IdSizes, ReplyIds, Stop, dispose_body, object_ids, stop_of};
