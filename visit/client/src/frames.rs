//! Framing on the wire (../SPEC.md sections 5.4, 7.2, 7.4 and 8.3): length-prefixed JSON on a link's control
//! stream, video frames and scene deltas on a link's streams and on the page connection, and scene edits
//! (gzipped JSON) on a link's scene stream.
use std::io::Read;

use anyhow::{anyhow, bail, Result};
use bytes::{BufMut, Bytes, BytesMut};
use iroh::endpoint::{ReadExactError, RecvStream, SendStream};
use serde_json::Value;

/// The largest encoded frame carried; bigger ones are dropped.
pub const MAX_FRAME: usize = 1 << 20;
/// The largest control message.
const MAX_MSG: usize = 64 * 1024;
/// The largest scene edit, gzipped, and what it may unpack to: a room's whole scene is the biggest (a busy
/// three.js room's is some 0.5 MB of JSON, 0.2 MB gzipped).
pub const MAX_SCENE: usize = 16 << 20;
pub const MAX_SCENE_JSON: usize = 64 << 20;
/// Flags: bit 0 a keyframe; bit 1 the frame carries its meta (META bytes, after the timestamp); bit 2 (from a
/// page only) a scene edit, not a frame; bit 3 a scene delta, not video (../SPEC.md section 8.3).
const KEY: u8 = 1;
const HAS_META: u8 = 2;
const SCENE: u8 = 4;
const DELTA: u8 = 8;
/// What a frame was rendered from (../SPEC.md section 5.4): the time of the visitor's input it reflects
/// (f64, the visitor page's clock, ms) and the look it was drawn at (yaw, pitch: f32 each). Carried as is.
pub const META: usize = 16;

/// One encoded video frame, or one scene delta (they travel alike: newest wins).
#[derive(Clone, Debug)]
pub struct Frame {
    pub key: bool,
    pub delta: bool,
    /// The `VideoFrame` timestamp (a delta's: when the host took it), in microseconds.
    pub ts: u64,
    pub meta: Option<[u8; META]>,
    pub data: Bytes,
}

impl Frame {
    /// From a page's binary message: channel (u16), flags (u8), timestamp (u64), meta (if flagged), chunk.
    /// None for a malformed one, and for a scene edit (`scene_from_page`).
    pub fn from_page(b: &[u8]) -> Option<(u16, Frame)> {
        if b.len() < 11 || b[2] & SCENE != 0 {
            return None;
        }
        let channel = u16::from_be_bytes([b[0], b[1]]);
        let (meta, at) = if b[2] & HAS_META != 0 { (Some(b.get(11..11 + META)?.try_into().ok()?), 11 + META) } else { (None, 11) };
        if b.len() - at > MAX_FRAME {
            return None;
        }
        let ts = u64::from_be_bytes(b[3..11].try_into().ok()?);
        Some((channel, Frame { key: b[2] & KEY != 0, delta: b[2] & DELTA != 0, ts, meta, data: Bytes::copy_from_slice(&b[at..]) }))
    }

    fn flags(&self, meta: bool) -> u8 {
        (self.key as u8) | if self.delta { DELTA } else { 0 } | if meta && self.meta.is_some() { HAS_META } else { 0 }
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
    let (key, delta, ts) = (buf[0] & KEY != 0, buf[0] & DELTA != 0, u64::from_be_bytes(buf[1..9].try_into()?));
    let (meta, at) = if buf[0] & HAS_META != 0 {
        (Some(buf.get(9..9 + META).ok_or_else(|| anyhow::anyhow!("a frame too short for its meta"))?.try_into()?), 9 + META)
    } else {
        (None, 9)
    };
    Ok(Some(Frame { key, delta, ts, meta, data: Bytes::from(buf).slice(at..) }))
}

/// A scene edit from a page's binary message: channel (u16), flags (only the scene bit), timestamp (u64,
/// unused), then the edit, gzipped JSON. None if malformed or too big.
pub fn scene_from_page(b: &[u8]) -> Option<(u16, Bytes)> {
    if b.len() < 11 || b[2] != SCENE || b.len() - 11 > MAX_SCENE {
        return None;
    }
    Some((u16::from_be_bytes([b[0], b[1]]), Bytes::copy_from_slice(&b[11..])))
}

/// A scene edit on a link's scene stream: its length (u32), then the gzipped JSON.
pub async fn write_scene_msg(w: &mut SendStream, gz: &[u8]) -> Result<()> {
    let mut out = BytesMut::with_capacity(4 + gz.len());
    out.put_u32(gz.len() as u32);
    out.extend_from_slice(gz);
    w.write_all(&out).await?;
    Ok(())
}

/// The next scene edit (still gzipped); None when the stream ends. One longer than MAX_SCENE is an error:
/// the stream cannot be read past it.
pub async fn read_scene_msg(r: &mut RecvStream) -> Result<Option<Bytes>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(()) => {}
        Err(ReadExactError::FinishedEarly(0)) => return Ok(None),
        Err(e) => bail!("reading a scene edit: {e}"),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_SCENE {
        bail!("a scene edit of {len} bytes");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await.map_err(|e| anyhow!("reading a scene edit: {e}"))?;
    Ok(Some(Bytes::from(buf)))
}

/// How deep a scene edit's JSON may nest (a room's scene graph nests a few levels per object).
const MAX_DEPTH: usize = 256;

/// A scene edit unpacked and checked: gzip that unpacks to at most MAX_SCENE_JSON bytes (a "zip bomb" stops
/// there), of one well-formed JSON object nested at most MAX_DEPTH deep. What the page then reads, it reads as
/// data (../SPEC.md section 8.3).
pub fn unpack_scene(gz: &[u8]) -> Result<Vec<u8>> {
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(gz).take(MAX_SCENE_JSON as u64 + 1).read_to_end(&mut json).map_err(|e| anyhow!("not gzip: {e}"))?;
    if json.len() > MAX_SCENE_JSON {
        bail!("unpacks to more than {MAX_SCENE_JSON} bytes");
    }
    if json.iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'{') {
        bail!("not a JSON object");
    }
    if depth(&json) > MAX_DEPTH {
        bail!("nested more than {MAX_DEPTH} deep");
    }
    serde_json::from_slice::<serde::de::IgnoredAny>(&json).map_err(|e| anyhow!("not JSON: {e}"))?;
    Ok(json)
}

/// The deepest JSON nesting in `json` (outside strings), in one pass.
fn depth(json: &[u8]) -> usize {
    let (mut d, mut most, mut string, mut escaped) = (0usize, 0usize, false, false);
    for &b in json {
        if string {
            (string, escaped) = (escaped || b != b'"', !escaped && b == b'\\');
        } else {
            match b {
                b'"' => string = true,
                b'{' | b'[' => { d += 1; most = most.max(d); }
                b'}' | b']' => d = d.saturating_sub(1),
                _ => {}
            }
        }
    }
    most
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
        let f = Frame { key: true, delta: false, ts: 1_234_567, meta: None, data: Bytes::from_static(b"chunk") };
        let (ch, back) = Frame::from_page(&f.to_page(7)).unwrap();
        assert_eq!((ch, back.key, back.delta, back.ts, back.meta, &back.data[..]), (7, true, false, 1_234_567, None, &b"chunk"[..]));
        let g = Frame { meta: Some([5; META]), delta: true, ..f };
        let (_, back) = Frame::from_page(&g.to_page(7)).unwrap();
        assert_eq!((back.meta, back.delta, &back.data[..]), (Some([5; META]), true, &b"chunk"[..]));
        assert!(Frame::from_page(&[0u8; 10]).is_none(), "shorter than a header");
        assert!(Frame::from_page(&[0, 1, HAS_META, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]).is_none(), "flagged meta, but too short for it");
        assert!(Frame::from_page(&[0, 1, SCENE, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]).is_none(), "a scene edit is not a frame");
    }

    #[test]
    fn scene_edits_from_the_page_and_unpacked() {
        let gz = |b: &[u8]| {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            std::io::Write::write_all(&mut e, b).unwrap();
            e.finish().unwrap()
        };
        let mut msg = vec![0, 3, SCENE, 0, 0, 0, 0, 0, 0, 0, 0];
        msg.extend_from_slice(&gz(br#" {"type":"scene","json":{}}"#));
        let (ch, body) = scene_from_page(&msg).unwrap();
        assert_eq!(ch, 3);
        assert_eq!(unpack_scene(&body).unwrap(), br#" {"type":"scene","json":{}}"#);
        assert!(scene_from_page(&[0, 3, SCENE | KEY, 0, 0, 0, 0, 0, 0, 0, 0, 1]).is_none(), "only the scene bit");
        assert!(unpack_scene(b"not gzip").is_err());
        assert!(unpack_scene(&gz(b"[1, 2]")).is_err(), "an object, not an array");
        assert!(unpack_scene(&gz(br#"{"type": "scene", "#)).is_err(), "cut short");
        let deep = |n: usize| format!("{{\"a\":{}1{}}}", "[".repeat(n), "]".repeat(n));
        assert!(unpack_scene(&gz(deep(300).as_bytes())).unwrap_err().to_string().contains("deep"));
        assert!(unpack_scene(&gz(deep(200).as_bytes())).is_ok());
        assert_eq!(depth(br#"{"a": "[[[{", "b": ["\"", "\\", {"c": []}]}"#), 4, "brackets in strings and escapes do not count");
        // A zip bomb: a few KB that would unpack to more than the limit stops at the limit.
        let bomb = gz(&vec![b' '; MAX_SCENE_JSON + 10]);
        assert!(bomb.len() < 1 << 20);
        assert!(unpack_scene(&bomb).unwrap_err().to_string().contains("more than"));
    }

    #[test]
    fn link_frames_count_what_follows_and_carry_meta_only_when_understood() {
        let f = Frame { key: false, delta: false, ts: 9, meta: Some([7; META]), data: Bytes::from_static(b"abc") };
        let (with, without) = (f.to_link(true), f.to_link(false));
        for b in [&with, &without] {
            assert_eq!(u32::from_be_bytes(b[0..4].try_into().unwrap()) as usize, b.len() - 4);
        }
        assert_eq!((with[4], without[4]), (HAS_META, 0));
        assert_eq!(with.len() - without.len(), META);
    }
}
