//! Pictures and links shared in chat (../SPEC.md 8.12): what a picture may be, and a link's preview, made by its
//! sender's visit-client, as messaging apps do (those who get it never contact the site).
use std::{io::Read, time::Duration};

use bytes::Bytes;
use serde_json::{json, Value};

use crate::VERSION;

/// The largest picture shared (a screenshot fits); and a link preview's picture, and the most of its page read.
pub const MAX_MEDIA: usize = 8 << 20;
const MAX_PREVIEW_IMAGE: usize = 2 << 20;
const MAX_PAGE: u64 = 512 << 10;
/// At most this many pictures, and links, in a line.
pub const MEDIA_PER_LINE: usize = 4;
pub const LINKS_PER_LINE: usize = 2;

/// A picture's type, by what its bytes start with (whatever it was said to be): PNG, JPEG, WebP or GIF; else none.
pub fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A picture, checked: one of the four kinds, by its bytes, at most `max`; its id (the blake3 hash of it, hex) and
/// type.
pub fn picture(b: &[u8], max: usize) -> Option<(String, &'static str)> {
    if b.is_empty() || b.len() > max {
        return None;
    }
    Some((blake3::hash(b).to_hex().to_string(), sniff(b)?))
}

/// A picture's id: 64 lowercase hex characters.
pub fn id_ok(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The pictures and links a line carries, as a page or a link gives them, checked (at most MEDIA_PER_LINE and
/// LINKS_PER_LINE): each picture { id, mime, size }; each link { url (http or https), title, description, site,
/// image (a picture) }.
pub fn attachments(m: &Value) -> (Vec<Value>, Vec<Value>) {
    let pic = |p: &Value| -> Option<Value> {
        let id = p.get("id").and_then(Value::as_str).filter(|id| id_ok(id))?;
        let mime = p.get("mime").and_then(Value::as_str).filter(|m| ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(m))?;
        let size = p.get("size").and_then(Value::as_u64).filter(|s| *s > 0 && *s as usize <= MAX_MEDIA)?;
        Some(json!({ "id": id, "mime": mime, "size": size }))
    };
    let media = m.get("media").and_then(Value::as_array).into_iter().flatten().take(MEDIA_PER_LINE).filter_map(pic).collect();
    let links = m.get("links").and_then(Value::as_array).into_iter().flatten().take(LINKS_PER_LINE).filter_map(|l| {
        let url = l.get("url").and_then(Value::as_str).filter(|u| url_ok(u))?;
        let s = |k: &str, n: usize| clip(l.get(k).and_then(Value::as_str).unwrap_or(""), n);
        Some(json!({ "url": url, "title": s("title", 200), "description": s("description", 500), "site": s("site", 100),
                     "image": l.get("image").and_then(pic).unwrap_or(Value::Null) }))
    }).collect();
    (media, links)
}

/// A link that may be shared: http or https, at most 2 000 characters, no spaces or control characters.
pub fn url_ok(u: &str) -> bool {
    (u.starts_with("http://") || u.starts_with("https://")) && u.len() <= 2000 && u.len() > 8 && !u.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// At most `n` characters, without control characters, trimmed.
pub fn clip(s: &str, n: usize) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(n).collect()
}

/// A link's preview: where it led (after redirects), the page's title, description and site, and its picture.
#[derive(Debug, Default, PartialEq)]
pub struct Preview {
    pub url: String,
    pub title: String,
    pub description: String,
    pub site: String,
    pub image: Option<Bytes>,
}

/// A link's preview, fetched (http or https only; 6 s at most, 4 redirects, the first 512 KB of the page): its Open
/// Graph title, description, site and picture (at most 2 MB), else its <title> and description; a link that is a
/// picture, that picture. None: nothing to show. Blocking: run apart from the async threads.
pub fn preview(url: &str) -> Option<Preview> {
    if !url_ok(url) {
        return None;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(6)))
        .max_redirects(4)
        .user_agent(format!("visit-client/{VERSION} (link preview)"))
        .build()
        .into();
    let mut res = agent.get(url).call().ok()?;
    let at = ureq::ResponseExt::get_uri(&res).to_string();
    let kind = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if kind.starts_with("image/") {
        let mut b = Vec::new();
        res.body_mut().as_reader().take(MAX_PREVIEW_IMAGE as u64 + 1).read_to_end(&mut b).ok()?;
        let image = picture(&b, MAX_PREVIEW_IMAGE).map(|_| Bytes::from(b));
        let name = at.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("").to_string();
        return image.map(|i| Preview { title: clip(&name, 200), site: host(&at), url: at.clone(), description: String::new(), image: Some(i) });
    }
    if !(kind.is_empty() || kind.contains("html")) {
        return None;
    }
    let mut page = Vec::new();
    res.body_mut().as_reader().take(MAX_PAGE).read_to_end(&mut page).ok()?;
    let (mut p, src) = read_page(&String::from_utf8_lossy(&page), &at);
    p.image = src.and_then(|src| fetch_picture(&agent, &src));
    (!p.title.is_empty() || !p.description.is_empty() || p.image.is_some()).then_some(p)
}

fn fetch_picture(agent: &ureq::Agent, url: &str) -> Option<Bytes> {
    if !url_ok(url) {
        return None;
    }
    let mut res = agent.get(url).call().ok()?;
    let mut b = Vec::new();
    res.body_mut().as_reader().take(MAX_PREVIEW_IMAGE as u64 + 1).read_to_end(&mut b).ok()?;
    picture(&b, MAX_PREVIEW_IMAGE).map(|_| Bytes::from(b))
}

/// What a page says of itself, for a preview: its title, description and site; and where its picture is, made
/// absolute against `at`.
pub fn read_page(html: &str, at: &str) -> (Preview, Option<String>) {
    let mut meta: Vec<(String, String)> = Vec::new();
    let low = html.to_ascii_lowercase();
    let mut i = 0;
    while let Some(start) = low[i..].find("<meta").map(|s| s + i) {
        let end = low[start..].find('>').map_or(low.len(), |e| e + start);
        let a = attrs(&html[start + 5..end]);
        let get = |k: &str| a.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        if let (Some(name), Some(content)) = (get("property").or_else(|| get("name")), get("content")) {
            meta.push((name.to_ascii_lowercase(), entities(&content)));
        }
        i = end;
    }
    let first = |keys: &[&str]| keys.iter().find_map(|k| meta.iter().find(|(n, v)| n == k && !v.trim().is_empty()).map(|(_, v)| v.clone()));
    let title = first(&["og:title", "twitter:title"]).or_else(|| {
        let s = low.find("<title")?;
        let open = low[s..].find('>')? + s + 1;
        let close = low[open..].find("</title")? + open;
        Some(entities(&html[open..close]))
    }).unwrap_or_default();
    let image = first(&["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]).and_then(|src| resolve(at, &src));
    let p = Preview {
        url: at.to_string(),
        title: clip(&title, 200),
        description: clip(&first(&["og:description", "twitter:description", "description"]).unwrap_or_default(), 500),
        site: clip(&first(&["og:site_name"]).unwrap_or_else(|| host(at)), 100),
        image: None,
    };
    (p, image)
}

/// A tag's attributes (its text after the tag's name): name (lowercase) and value, quoted or not.
fn attrs(s: &str) -> Vec<(String, String)> {
    let (b, mut out, mut i) = (s.as_bytes(), Vec::new(), 0);
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let n0 = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'>' {
            i += 1;
        }
        let name = s[n0..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] != b'=' {
            if !name.is_empty() {
                out.push((name, String::new()));
            }
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let value = if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
            let q = b[i];
            let v0 = i + 1;
            i = v0;
            while i < b.len() && b[i] != q {
                i += 1;
            }
            let v = &s[v0..i.min(b.len())];
            i += 1;
            v
        } else {
            let v0 = i;
            while i < b.len() && !b[i].is_ascii_whitespace() {
                i += 1;
            }
            &s[v0..i]
        };
        if !name.is_empty() {
            out.push((name, value.to_string()));
        }
    }
    out
}

/// HTML's character references, the common ones: &amp; &lt; &gt; &quot; &#39; &apos; &nbsp; and numeric.
fn entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|e| *e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let c = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match c {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A link's address made absolute against the page it is on (none: not http or https).
pub fn resolve(base: &str, href: &str) -> Option<String> {
    let href = entities(href.trim());
    let (scheme, rest) = base.split_once("://")?;
    let origin = format!("{scheme}://{}", rest.split(['/', '?', '#']).next().unwrap_or(""));
    let out = if href.starts_with("http://") || href.starts_with("https://") {
        href
    } else if let Some(h) = href.strip_prefix("//") {
        format!("{scheme}://{h}")
    } else if href.starts_with('/') {
        format!("{origin}{href}")
    } else if href.contains(':') {
        return None;   // data:, javascript: and the like
    } else {
        let path = base.split(['?', '#']).next().unwrap_or(base);
        let dir = if path.len() > origin.len() { &path[..path.rfind('/').unwrap_or(path.len()) + 1] } else { "" };
        if dir.is_empty() { format!("{origin}/{href}") } else { format!("{dir}{href}") }
    };
    url_ok(&out).then_some(out)
}

/// The host a link goes to, without "www.".
pub fn host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let h = rest.split(['/', '?', '#']).next().unwrap_or("");
    let h = h.rsplit('@').next().unwrap_or(h);
    h.strip_prefix("www.").unwrap_or(h).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pictures_by_their_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff(b"<svg xmlns"), None);
        let (id, mime) = picture(b"GIF89a..", MAX_MEDIA).unwrap();
        assert!(id_ok(&id) && mime == "image/gif");
        assert!(picture(b"GIF89a..", 4).is_none() && picture(b"", MAX_MEDIA).is_none());
        assert!(!id_ok(&id.to_uppercase()) && !id_ok("abc"));
    }

    #[test]
    fn a_line_s_pictures_and_links_are_checked() {
        let id = "a".repeat(64);
        let (media, links) = attachments(&json!({
            "media": [{ "id": id, "mime": "image/png", "size": 10 }, { "id": "nope", "mime": "image/png", "size": 1 }, { "id": id, "mime": "text/html", "size": 1 }],
            "links": [{ "url": "https://example.com/a", "title": "A\u{7}  title", "image": { "id": id, "mime": "image/jpeg", "size": 3 } }, { "url": "javascript:alert(1)" }],
        }));
        assert_eq!(media, vec![json!({ "id": id, "mime": "image/png", "size": 10 })]);
        assert_eq!(links, vec![json!({ "url": "https://example.com/a", "title": "A title", "description": "", "site": "", "image": { "id": id, "mime": "image/jpeg", "size": 3 } })]);
    }

    #[test]
    fn a_page_says_what_it_is() {
        let html = r#"<html><head><title>Plain &amp; simple</title>
            <meta property="og:title" content="The &quot;real&quot; title">
            <META name=description content='About it &#8212; all'>
            <meta property="og:image" content="/img/a.png?x=1&amp;y=2"></head></html>"#;
        let (p, image) = read_page(html, "https://www.example.com/blog/post?id=3");
        assert_eq!((p.title.as_str(), p.description.as_str(), p.site.as_str()), ("The \"real\" title", "About it — all", "example.com"));
        assert_eq!(image.as_deref(), Some("https://www.example.com/img/a.png?x=1&y=2"));
        let (p, image) = read_page("<title>Only a title</title>", "http://h.test/");
        assert_eq!((p.title.as_str(), image), ("Only a title", None));
    }

    #[test]
    fn addresses_made_absolute() {
        let base = "https://a.test/x/y.html?q";
        assert_eq!(resolve(base, "z.png").as_deref(), Some("https://a.test/x/z.png"));
        assert_eq!(resolve(base, "/z.png").as_deref(), Some("https://a.test/z.png"));
        assert_eq!(resolve(base, "//cdn.test/z.png").as_deref(), Some("https://cdn.test/z.png"));
        assert_eq!(resolve("https://a.test", "z.png").as_deref(), Some("https://a.test/z.png"));
        assert_eq!(resolve(base, "data:image/png;base64,AA"), None);
        assert_eq!(host("https://user@www.a.test:8443/p"), "a.test:8443");
    }
}
