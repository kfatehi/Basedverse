//! Framing on the wire (../SPEC.md sections 5.4, 7.2 and 7.4): length-prefixed JSON on a link's control
//! stream, and video frames on a link's streams and on the page connection.
use anyhow::{bail, Result};
use bytes::{BufMut, Bytes, BytesMut};
use iroh::endpoint::{ReadExactError, RecvStream, SendStream};
use serde_json::Value;

/// The largest encoded frame carried; bigger ones are dropped.
pub const MAX_FRAME: usize = 1 << 20;
/// The largest control message.
const MAX_MSG: usize = 64 * 1024;

/// One encoded video frame.
#[derive(Clone, Debug)]
pub struct Frame {
    pub key: bool,
    /// The `VideoFrame` timestamp, in microseconds.
    pub ts: u64,
    pub data: Bytes,
}

impl Frame {
    /// From a page's binary message: channel (u16), flags (u8, bit 0 keyframe), timestamp (u64), chunk.
    pub fn from_page(b: &[u8]) -> Option<(u16, Frame)> {
        if b.len() < 11 || b.len() - 11 > MAX_FRAME {
            return None;
        }
        let channel = u16::from_be_bytes([b[0], b[1]]);
        let ts = u64::from_be_bytes(b[3..11].try_into().ok()?);
        Some((channel, Frame { key: b[2] & 1 == 1, ts, data: Bytes::copy_from_slice(&b[11..]) }))
    }

    /// As a page binary message, labelled with this visit-client's channel for it.
    pub fn to_page(&self, channel: u16) -> Bytes {
        let mut out = BytesMut::with_capacity(11 + self.data.len());
        out.put_u16(channel);
        out.put_u8(self.key as u8);
        out.put_u64(self.ts);
        out.extend_from_slice(&self.data);
        out.freeze()
    }

    /// On a link's video stream: length (u32, of what follows), flags (u8), timestamp (u64), chunk.
    pub fn to_link(&self) -> Bytes {
        let mut out = BytesMut::with_capacity(4 + 9 + self.data.len());
        out.put_u32((9 + self.data.len()) as u32);
        out.put_u8(self.key as u8);
        out.put_u64(self.ts);
        out.extend_from_slice(&self.data);
        out.freeze()
    }
}

/// The next frame on a link's video stream; None when the stream ends.
pub async fn read_link_frame(r: &mut RecvStream) -> Result<Option<Frame>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(()) => {}
        Err(ReadExactError::FinishedEarly(0)) => return Ok(None),
        Err(e) => bail!("reading a frame: {e}"),
    }
    let len = u32::from_be_bytes(len) as usize;
    if !(9..=9 + MAX_FRAME).contains(&len) {
        bail!("a frame of {len} bytes");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await.map_err(|e| anyhow::anyhow!("reading a frame: {e}"))?;
    Ok(Some(Frame { key: buf[0] & 1 == 1, ts: u64::from_be_bytes(buf[1..9].try_into()?), data: Bytes::from(buf).slice(9..) }))
}

/// A control message: its length (u32), then the JSON.
pub async fn write_msg(w: &mut SendStream, v: &Value) -> Result<()> {
    let body = serde_json::to_vec(v)?;
    let mut out = BytesMut::with_capacity(4 + body.len());
    out.put_u32(body.len() as u32);
    out.extend_from_slice(&body);
    w.write_all(&out).await?;
    Ok(())
}

/// The next control message; None when the stream ends.
pub async fn read_msg(r: &mut RecvStream) -> Result<Option<Value>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(()) => {}
        Err(ReadExactError::FinishedEarly(0)) => return Ok(None),
        Err(e) => bail!("reading a message: {e}"),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_MSG {
        bail!("a message of {len} bytes");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await.map_err(|e| anyhow::anyhow!("reading a message: {e}"))?;
    Ok(Some(serde_json::from_slice(&buf)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_frames_round_trip() {
        let f = Frame { key: true, ts: 1_234_567, data: Bytes::from_static(b"chunk") };
        let (ch, back) = Frame::from_page(&f.to_page(7)).unwrap();
        assert_eq!((ch, back.key, back.ts, &back.data[..]), (7, true, 1_234_567, &b"chunk"[..]));
        assert!(Frame::from_page(&[0u8; 10]).is_none(), "shorter than a header");
    }

    #[test]
    fn link_frames_count_what_follows() {
        let f = Frame { key: false, ts: 9, data: Bytes::from_static(b"abc") };
        let b = f.to_link();
        assert_eq!(u32::from_be_bytes(b[0..4].try_into().unwrap()) as usize, b.len() - 4);
        assert_eq!(b[4], 0);
    }
}
