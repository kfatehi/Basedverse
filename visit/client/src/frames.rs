//! Framing on the wire (../SPEC.md sections 5.4, 7.2, 7.4 and 8): length-prefixed JSON on a link's control
//! stream, a scene's deltas on a link's streams and on the page connection, and its edits (gzipped JSON) on a
//! link's scene stream.
use std::io::Read;

use anyhow::{anyhow, bail, Result};
use bytes::{BufMut, Bytes, BytesMut};
use iroh::endpoint::{ReadExactError, RecvStream, SendStream};
use serde_json::Value;

/// The largest delta carried; bigger ones are dropped.
pub const MAX_FRAME: usize = 1 << 20;
/// The largest control message.
const MAX_MSG: usize = 64 * 1024;
/// The largest scene edit, gzipped, and what it may unpack to: a room's whole scene is the biggest (a busy
/// three.js room's is some 0.5 MB of JSON, 0.2 MB gzipped).
pub const MAX_SCENE: usize = 16 << 20;
pub const MAX_SCENE_JSON: usize = 64 << 20;
/// Flags: bit 0 a key delta (everything that has moved, not only since the last); bit 1 (from a page only) a
/// scene edit, not a delta (../SPEC.md section 5.4).
const KEY: u8 = 1;
const EDIT: u8 = 2;
/// A page's own avatar (8.6): gzipped JSON, kept by its visit-client for the hosts that ask.
const AVATAR: u8 = 4;
/// A moment of the page's own user's voice (8.7: its channel says where it may go, VOICE_ROOM, VOICE_CALLS and
/// VOICE_CHANNEL; its visit-client decides who hears it), or to the page, another office's: one Opus packet. To the
/// page, the first byte of the timestamp's place says how it came (ROUTE_NEAR, ROUTE_CALL, ROUTE_VOICE).
const AUDIO: u8 = 8;
/// To the page, a moment of someone else's voice an office passed on (8.7, 8.8): a visitor's, from the room to
/// another visitor near them; a call's, from a phone on speaker to those near it, and theirs to the call. Who spoke
/// (an id, then a name, each a length byte and UTF-8), then the Opus packet.
const RELAY: u8 = 16;
/// A landscape (8.10), from the page: its own, gzipped JSON (its channel is ignored). Another office's goes to the
/// page as text (`landscape`), never dropped as a frame may be.
const LAND: u8 = 32;
/// One of a page's own possessions (8.11): its model, gzipped JSON, its slot in the list the page gave (the frame's
/// channel). Kept by its visit-client for the hosts that ask.
const POSSESSION: u8 = 64;
/// A picture shared in chat (8.12): from the page, one to keep (its channel a slot the page names, answered with
/// `media_ready`); to the page, one it asked for (who it is, its type, then its bytes; never dropped).
const MEDIA: u8 = 128;
/// The most one packet of voice takes (20 ms of Opus is some tens of bytes).
pub const MAX_AUDIO: usize = 1000;
/// The most an avatar takes gzipped, and unpacked.
pub const MAX_AVATAR: usize = 4 << 20;
pub const MAX_AVATAR_JSON: usize = 16 << 20;

/// One delta of a host's scene (../SPEC.md section 8.3): newest wins, as a group of pictures would.
#[derive(Clone, Debug)]
pub struct Frame {
    pub key: bool,
    /// When the host took it, by its page's clock, in microseconds.
    pub ts: u64,
    pub data: Bytes,
}

impl Frame {
    /// From a page's binary message: channel (u16), flags (u8), timestamp (u64), the delta. None for a
    /// malformed one, and for a scene edit (`scene_from_page`).
    pub fn from_page(b: &[u8]) -> Option<(u16, Frame)> {
        if b.len() < 11 || b[2] & EDIT != 0 || b.len() - 11 > MAX_FRAME {
            return None;
        }
        let channel = u16::from_be_bytes([b[0], b[1]]);
        let ts = u64::from_be_bytes(b[3..11].try_into().ok()?);
        Some((channel, Frame { key: b[2] & KEY != 0, ts, data: Bytes::copy_from_slice(&b[11..]) }))
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

    /// On a link's delta stream: length (u32, of what follows), flags (u8), timestamp (u64), the delta.
    pub fn to_link(&self) -> Bytes {
        let mut out = BytesMut::with_capacity(13 + self.data.len());
        out.put_u32(9 + self.data.len() as u32);
        out.put_u8(self.key as u8);
        out.put_u64(self.ts);
        out.extend_from_slice(&self.data);
        out.freeze()
    }
}

/// The next delta on a link's delta stream; None when the stream ends.
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
    let (key, ts) = (buf[0] & KEY != 0, u64::from_be_bytes(buf[1..9].try_into()?));
    Ok(Some(Frame { key, ts, data: Bytes::from(buf).slice(9..) }))
}

/// A scene edit from a page's binary message: channel (u16), flags (only the edit bit), timestamp (u64,
/// unused), then the edit, gzipped JSON. None if malformed or too big.
pub fn scene_from_page(b: &[u8]) -> Option<(u16, Bytes)> {
    if b.len() < 11 || b[2] != EDIT || b.len() - 11 > MAX_SCENE {
        return None;
    }
    Some((u16::from_be_bytes([b[0], b[1]]), Bytes::copy_from_slice(&b[11..])))
}

/// The page's own avatar, gzipped (its channel is ignored), if the frame is one and not too big.
pub fn avatar_from_page(b: &[u8]) -> Option<Bytes> {
    if b.len() < 11 || b[2] != AVATAR || b.len() - 11 > MAX_AVATAR {
        return None;
    }
    Some(Bytes::copy_from_slice(&b[11..]))
}

/// One of the page's own possessions' models, gzipped, and its slot, if the frame is one and not too big (as an
/// avatar may be).
pub fn possession_from_page(b: &[u8]) -> Option<(u16, Bytes)> {
    if b.len() < 12 || b[2] != POSSESSION || b.len() - 11 > MAX_AVATAR {
        return None;
    }
    Some((u16::from_be_bytes([b[0], b[1]]), Bytes::copy_from_slice(&b[11..])))
}

/// The page's own landscape, gzipped, if the frame is one and not too big.
pub fn land_from_page(b: &[u8]) -> Option<Bytes> {
    if b.len() < 12 || b[2] != LAND || b.len() - 11 > MAX_SCENE {
        return None;
    }
    Some(Bytes::copy_from_slice(&b[11..]))
}

/// A picture from the page to keep (its slot, and its bytes), if the frame is one and not too big.
pub fn media_from_page(b: &[u8]) -> Option<(u16, Bytes)> {
    if b.len() < 12 || b[2] != MEDIA || b.len() - 11 > crate::media::MAX_MEDIA {
        return None;
    }
    Some((u16::from_be_bytes([b[0], b[1]]), Bytes::copy_from_slice(&b[11..])))
}

/// A picture for the page: who it is (its id), its type, then its bytes.
pub fn media_to_page(id: &str, mime: &str, bytes: &[u8]) -> Bytes {
    let head = relay_head(id, mime, bytes);
    let mut out = BytesMut::with_capacity(11 + head.len());
    out.put_u16(0);
    out.put_u8(MEDIA);
    out.put_u64(0);
    out.extend_from_slice(&head);
    out.freeze()
}

/// Where a page's own user's voice may go: the room they are in (and across a plot's side), their calls, the room
/// voice they are in.
pub const VOICE_ROOM: u16 = 1;
pub const VOICE_CALLS: u16 = 2;
pub const VOICE_CHANNEL: u16 = 4;
/// How a voice came to the page (8.7): in person (in a room, or across a plot's side), on a call, in a room voice.
pub const ROUTE_NEAR: u8 = 0;
pub const ROUTE_CALL: u8 = 1;
pub const ROUTE_VOICE: u8 = 2;

/// A packet of the page's own user's voice and where it may go, if the frame is one and not too big.
pub fn audio_from_page(b: &[u8]) -> Option<(u16, Bytes)> {
    if b.len() < 12 || b[2] != AUDIO || b.len() - 11 > MAX_AUDIO {
        return None;
    }
    Some((u16::from_be_bytes([b[0], b[1]]), Bytes::copy_from_slice(&b[11..])))
}

/// Someone's voice passed on (RELAY, and a room voice's): who spoke (an id of at most 100 bytes: a visit's id, or an
/// office's key; a name of at most 24 characters), then the voice.
pub fn relay_head(id: &str, name: &str, voice: &[u8]) -> Bytes {
    let cut = |s: &str, n: usize| -> String { s.chars().scan(0, |len, c| { *len += c.len_utf8(); (*len <= n).then_some(c) }).collect() };
    let (id, name) = (cut(id, 100), cut(&name.chars().take(24).collect::<String>(), 96));
    let mut out = BytesMut::with_capacity(2 + id.len() + name.len() + voice.len());
    out.put_u8(id.len() as u8);
    out.extend_from_slice(id.as_bytes());
    out.put_u8(name.len() as u8);
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(voice);
    out.freeze()
}

/// Who spoke and the voice, from someone's voice passed on, if it is one.
pub fn relay_parts(b: &[u8]) -> Option<(String, String, &[u8])> {
    let n = *b.first()? as usize;
    let id = std::str::from_utf8(b.get(1..1 + n)?).ok()?;
    let m = *b.get(1 + n)? as usize;
    let name = std::str::from_utf8(b.get(2 + n..2 + n + m)?).ok()?;
    Some((id.to_string(), name.to_string(), &b[2 + n + m..]))
}

/// Someone's voice the other side passed on, for the page, on the channel of the visit it came by, and how.
pub fn relay_to_page(channel: u16, route: u8, data: &[u8]) -> Bytes {
    voice_to_page(channel, RELAY, route, data)
}

/// The other office's packet of voice for the page, on the channel of the visit it came by, and how.
pub fn audio_to_page(channel: u16, route: u8, data: &[u8]) -> Bytes {
    voice_to_page(channel, AUDIO, route, data)
}

fn voice_to_page(channel: u16, flag: u8, route: u8, data: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(11 + data.len());
    out.put_u16(channel);
    out.put_u8(flag);
    out.put_u8(route);
    out.put_bytes(0, 7);
    out.extend_from_slice(data);
    out.freeze()
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
    read_blob(r, MAX_SCENE).await
}

/// The next length-prefixed blob (as a scene edit is), at most `max` bytes; None when the stream ends.
pub async fn read_blob(r: &mut RecvStream, max: usize) -> Result<Option<Bytes>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(()) => {}
        Err(ReadExactError::FinishedEarly(0)) => return Ok(None),
        Err(e) => bail!("reading a scene edit: {e}"),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > max {
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
    unpack_json(gz, MAX_SCENE_JSON)
}

/// As unpack_scene, unpacking to at most `max` bytes.
pub fn unpack_json(gz: &[u8], max: usize) -> Result<Vec<u8>> {
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(gz).take(max as u64 + 1).read_to_end(&mut json).map_err(|e| anyhow!("not gzip: {e}"))?;
    if json.len() > max {
        bail!("unpacks to more than {max} bytes");
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
    fn who_spoke_goes_with_the_voice() {
        let head = relay_head("phone:v1a2b3c4d5e6f", "Ada Ünder", b"opus");
        assert_eq!(relay_parts(&head), Some(("phone:v1a2b3c4d5e6f".to_string(), "Ada Ünder".to_string(), &b"opus"[..])));
        let long = relay_head(&"x".repeat(120), &"é".repeat(40), b"");
        let (id, name, voice) = relay_parts(&long).unwrap();
        assert_eq!((id.len(), name.chars().count(), voice.len()), (100, 24, 0));   // an office's key fits (a room voice's)
        let page = audio_to_page(7, ROUTE_CALL, b"opus");
        assert_eq!((&page[..4], &page[11..]), (&[0, 7, AUDIO, ROUTE_CALL][..], &b"opus"[..]));   // how it came, first in the timestamp's place
        assert!(relay_parts(&[5, b'a']).is_none() && relay_parts(&[]).is_none());
        assert!(audio_from_page(&[0, 3, AUDIO, 0, 0, 0, 0, 0, 0, 0, 0, 0xFC]).is_some() && audio_from_page(&[0, 3, RELAY, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]).is_none());
    }

    #[test]
    fn page_frames_round_trip() {
        let f = Frame { key: true, ts: 1_234_567, data: Bytes::from_static(b"delta") };
        let (ch, back) = Frame::from_page(&f.to_page(7)).unwrap();
        assert_eq!((ch, back.key, back.ts, &back.data[..]), (7, true, 1_234_567, &b"delta"[..]));
        assert!(Frame::from_page(&[0u8; 10]).is_none(), "shorter than a header");
        assert!(Frame::from_page(&[0, 1, EDIT, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]).is_none(), "a scene edit is not a delta");
    }

    #[test]
    fn link_frames_count_what_follows() {
        let b = Frame { key: false, ts: 9, data: Bytes::from_static(b"abc") }.to_link();
        assert_eq!(u32::from_be_bytes(b[0..4].try_into().unwrap()) as usize, b.len() - 4);
        assert_eq!((b[4], &b[13..]), (0, &b"abc"[..]));
    }

    #[test]
    fn scene_edits_from_the_page_and_unpacked() {
        let gz = |b: &[u8]| {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            std::io::Write::write_all(&mut e, b).unwrap();
            e.finish().unwrap()
        };
        let mut msg = vec![0, 3, EDIT, 0, 0, 0, 0, 0, 0, 0, 0];
        msg.extend_from_slice(&gz(br#" {"type":"scene","json":{}}"#));
        let (ch, body) = scene_from_page(&msg).unwrap();
        assert_eq!(ch, 3);
        assert_eq!(unpack_scene(&body).unwrap(), br#" {"type":"scene","json":{}}"#);
        assert!(scene_from_page(&[0, 3, EDIT | KEY, 0, 0, 0, 0, 0, 0, 0, 0, 1]).is_none(), "only the edit bit");
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
}
