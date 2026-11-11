use crate::error::HeapError;

/// Big-endian cursor over a dump. Every read is bounds-checked; running off `buf` yields
/// `Truncated` at `buf.len()`, so callers bound a record by slicing `buf` to its end.
pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    id_size: u8,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8], pos: usize, id_size: u8) -> Self {
        Self { buf, pos, id_size }
    }

    pub(crate) fn pos(&self) -> usize {
        self.pos
    }

    pub(crate) fn id_size(&self) -> u8 {
        self.id_size
    }

    pub(crate) fn buf(&self) -> &'a [u8] {
        self.buf
    }

    pub(crate) fn bytes(&mut self, n: usize) -> Result<&'a [u8], HeapError> {
        let end = self.pos.checked_add(n).filter(|&end| end <= self.buf.len());
        let Some(end) = end else {
            return Err(HeapError::Truncated { at: self.buf.len() as u64 });
        };
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    pub(crate) fn skip(&mut self, n: usize) -> Result<(), HeapError> {
        self.bytes(n).map(|_| ())
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], HeapError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.bytes(N)?);
        Ok(out)
    }

    pub(crate) fn u1(&mut self) -> Result<u8, HeapError> {
        Ok(self.array::<1>()?[0])
    }

    pub(crate) fn u2(&mut self) -> Result<u16, HeapError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    pub(crate) fn u4(&mut self) -> Result<u32, HeapError> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    pub(crate) fn u8(&mut self) -> Result<u64, HeapError> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    /// `id_size` is 4 or 8; the public entry points reject anything else before building a reader.
    pub(crate) fn id(&mut self) -> Result<u64, HeapError> {
        if self.id_size == 4 { self.u4().map(u64::from) } else { self.u8() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_big_endian_and_ids_of_both_sizes() {
        let buf = [1, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 5];
        let mut r = Reader::new(&buf, 0, 8);
        assert_eq!((r.u1().unwrap(), r.u2().unwrap(), r.u4().unwrap(), r.u8().unwrap()), (1, 2, 3, 4));
        assert_eq!(r.pos(), 15);
        assert_eq!(Reader::new(&buf[15..], 0, 4).id().unwrap(), 5);
    }

    #[test]
    fn running_off_the_end_reports_the_buffer_end() {
        let buf = [0u8; 6];
        let mut r = Reader::new(&buf, 4, 8);
        assert!(matches!(r.u4(), Err(HeapError::Truncated { at: 6 })));
        assert_eq!(r.pos(), 4, "a failed read does not advance");
        assert!(matches!(r.skip(usize::MAX), Err(HeapError::Truncated { at: 6 })));
        assert!(matches!(Reader::new(&buf, 99, 8).u1(), Err(HeapError::Truncated { at: 6 })));
    }
}
