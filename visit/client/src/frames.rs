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
/// Flags: bit 0 a keyframe; bit 1 the frame carries its meta (META bytes, after the timestamp).
const KEY: u8 = 1;
const HAS_META: u8 = 2;
/// What a frame was rendered from (../SPEC.md section 5.4): the time of the visitor's input it reflects
/// (f64, the visitor page's clock, ms) and the look it was drawn at (yaw, pitch: f32 each). Carried as is.
pub const META: usize = 16;

/// One encoded video frame.
#[derive(Clone, Debug)]
pub struct Frame {
    pub key: bool,
    /// The `VideoFrame` timestamp, in microseconds.
    pub ts: u64,
    pub meta: Option<[u8; META]>,
    pub data: Bytes,
}

impl Frame {
    /// From a page's binary message: channel (u16), flags (u8), timestamp (u64), meta (if flagged), chunk.
    pub fn from_page(b: &[u8]) -> Option<(u16, Frame)> {
        if b.len() < 11 {
            return None;
        }
        let channel = u16::from_be_bytes([b[0], b[1]]);
        let (meta, at) = if b[2] & HAS_META != 0 { (Some(b.get(11..11 + META)?.try_into().ok()?), 11 + META) } else { (None, 11) };
        if b.len() - at > MAX_FRAME {
            return None;
        }
        let ts = u64::from_be_bytes(b[3..11].try_into().ok()?);
        Some((channel, Frame { key: b[2] & KEY != 0, ts, meta, data: Bytes::copy_from_slice(&b[at..]) }))
    }

    fn flags(&self, meta: bool) -> u8 {
        (self.key as u8) | if meta && self.meta.is_some() { HAS_META } else { 0 }
    }

    /// As a page binary message, labelled with this visit-client's channel for it.
    pub fn to_page(&self, channel: u16) -> Bytes {
        let mut out = BytesMut::with_capacity(11 + META + self.data.len());
        out.put_u16(channel);
        out.put_u8(self.flags(true));
        out.put_u64(self.ts);
        if let Some(m) = &self.meta {
            out.extend_from_slice(m);
        }
        out.extend_from_slice(&self.data);
        out.freeze()
    }

    /// On a link's video stream: length (u32, of what follows), flags (u8), timestamp (u64), meta, chunk.
    /// `meta`: the other side understands it (it said so in its handshake); else it is left out.
    pub fn to_link(&self, meta: bool) -> Bytes {
        let m = if meta { self.meta.as_ref() } else { None };
        let len = 9 + m.map_or(0, |_| META) + self.data.len();
        let mut out = BytesMut::with_capacity(4 + len);
        out.put_u32(len as u32);
        out.put_u8(self.flags(meta));
        out.put_u64(self.ts);
        if let Some(m) = m {
            out.extend_from_slice(m);
        }
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
    if !(9..=9 + META + MAX_FRAME).contains(&len) {
        bail!("a frame of {len} bytes");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await.map_err(|e| anyhow::anyhow!("reading a frame: {e}"))?;
    let (key, ts) = (buf[0] & KEY != 0, u64::from_be_bytes(buf[1..9].try_into()?));
    let (meta, at) = if buf[0] & HAS_META != 0 {
        (Some(buf.get(9..9 + META).ok_or_else(|| anyhow::anyhow!("a frame too short for its meta"))?.try_into()?), 9 + META)
    } else {
        (None, 9)
    };
    Ok(Some(Frame { key, ts, meta, data: Bytes::from(buf).slice(at..) }))
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
        let f = Frame { key: true, ts: 1_234_567, meta: None, data: Bytes::from_static(b"chunk") };
        let (ch, back) = Frame::from_page(&f.to_page(7)).unwrap();
        assert_eq!((ch, back.key, back.ts, back.meta, &back.data[..]), (7, true, 1_234_567, None, &b"chunk"[..]));
        let g = Frame { meta: Some([5; META]), ..f };
        let (_, back) = Frame::from_page(&g.to_page(7)).unwrap();
        assert_eq!((back.meta, &back.data[..]), (Some([5; META]), &b"chunk"[..]));
        assert!(Frame::from_page(&[0u8; 10]).is_none(), "shorter than a header");
        assert!(Frame::from_page(&[0, 1, HAS_META, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]).is_none(), "flagged meta, but too short for it");
    }

    #[test]
    fn link_frames_count_what_follows_and_carry_meta_only_when_understood() {
        let f = Frame { key: false, ts: 9, meta: Some([7; META]), data: Bytes::from_static(b"abc") };
        let (with, without) = (f.to_link(true), f.to_link(false));
        for b in [&with, &without] {
            assert_eq!(u32::from_be_bytes(b[0..4].try_into().unwrap()) as usize, b.len() - 4);
        }
        assert_eq!((with[4], without[4]), (HAS_META, 0));
        assert_eq!(with.len() - without.len(), META);
    }
}
