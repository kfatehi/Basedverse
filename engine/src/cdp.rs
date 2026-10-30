//! One headless Chrome, spoken to over its devtools protocol on its pipe (`--remote-debugging-pipe`: commands in,
//! answers and events out, each JSON ended by a NUL), so nothing else on the machine can reach it. On Unix the pipe's
//! ends are its fds 3 and 4; on Windows two inherited handles, named to it by `--remote-debugging-io-pipes=<in>,<out>`.
//! Commands may carry a sessionId (a page attached flat); events go to the channel given.
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tracing::debug;

#[derive(Debug)]
pub enum CdpError {
    /// The browser's connection is closed: it exited, or is being stopped.
    Gone,
    /// A command went unanswered: the page's main thread is busy, or stuck.
    Timeout(String),
    /// The browser answered a command with an error.
    Failed(String),
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CdpError::Gone => write!(f, "the browser is gone"),
            CdpError::Timeout(m) => write!(f, "{m}: no answer"),
            CdpError::Failed(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for CdpError {}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

pub struct Browser {
    child: Mutex<Option<Child>>,
    pub pid: u32,
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    gone: Arc<AtomicBool>,
    /// Its last lines on stderr, for when it dies.
    pub stderr: Arc<Mutex<VecDeque<String>>>,
}

impl Browser {
    /// Starts `exe` with `args` (and `env` for its process alone) and its devtools connection; events to `events`.
    pub async fn start(exe: &Path, args: &[String], env: &[(String, String)], profile: &Path,
                       events: mpsc::UnboundedSender<Value>) -> anyhow::Result<Browser> {
        let mut cmd = Command::new(exe);
        cmd.args(args).envs(env.iter().map(|(k, v)| (k, v))).arg(format!("--user-data-dir={}", profile.display()))
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let gone = Arc::new(AtomicBool::new(false));
        #[cfg(unix)]
        let (mut child, reader, writer) = {
            let (to_r, to_w) = std::io::pipe()?;
            let (from_r, from_w) = std::io::pipe()?;
            use std::os::fd::{AsRawFd, OwnedFd};
            let (r, w) = (to_r.as_raw_fd(), from_w.as_raw_fd());
            cmd.arg("--remote-debugging-pipe");
            // SAFETY: only async-signal-safe calls between fork and exec: the pipes' ends onto 3 and 4 (through
            // copies above 9 first, whatever 3 and 4 hold), and on Linux, the browser killed if visit dies.
            unsafe {
                cmd.pre_exec(move || {
                    let (r2, w2) = (libc::fcntl(r, libc::F_DUPFD, 10), libc::fcntl(w, libc::F_DUPFD, 10));
                    if r2 < 0 || w2 < 0 || libc::dup2(r2, 3) < 0 || libc::dup2(w2, 4) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    #[cfg(target_os = "linux")]
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    Ok(())
                });
            }
            let child = cmd.spawn()?;
            drop(to_r);
            drop(from_w);
            let reader = tokio::net::unix::pipe::Receiver::from_owned_fd(OwnedFd::from(from_r))?;
            let writer = tokio::net::unix::pipe::Sender::from_owned_fd(OwnedFd::from(to_w))?;
            (child, reader, writer)
        };
        #[cfg(windows)]
        let (mut child, reader, writer) = {
            // Chrome takes the pipe's ends as handles it inherits, named by their values (inherited handles keep them),
            // and adopts each only if it is a pipe. Inheritable only for this spawn: dropped as soon as it is made.
            let (to_r, to_w) = std::io::pipe()?;
            let (from_r, from_w) = std::io::pipe()?;
            let (r, w) = (inheritable(&to_r)?, inheritable(&from_w)?);
            cmd.arg("--remote-debugging-pipe").arg(format!("--remote-debugging-io-pipes={r},{w}"));
            let child = cmd.spawn();
            drop(to_r);
            drop(from_w);
            (child?, from_r, to_w)
        };
        let pid = child.id().unwrap_or(0);
        let stderr: Arc<Mutex<VecDeque<String>>> = Arc::default();
        if let Some(err) = child.stderr.take() {
            let keep = stderr.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    debug!(target: "engine", "chrome: {line}");
                    let mut k = keep.lock().unwrap();
                    if k.len() == 40 {
                        k.pop_front();
                    }
                    k.push_back(line);
                }
            });
        }
        #[cfg(unix)]
        {
            tokio::spawn(write_pipe(writer, out_rx));
            tokio::spawn(read_pipe(reader, pending.clone(), gone.clone(), events));
        }
        // An anonymous pipe on Windows has no overlapped I/O for tokio to wait on: a thread each way, blocking.
        #[cfg(windows)]
        {
            let (p, g) = (pending.clone(), gone.clone());
            std::thread::Builder::new().name("cdp-write".into()).spawn(move || write_blocking(writer, out_rx))?;
            std::thread::Builder::new().name("cdp-read".into()).spawn(move || read_blocking(reader, p, g, events))?;
        }
        Ok(Browser { child: Mutex::new(Some(child)), pid, out: out_tx, pending, next: AtomicU64::new(0), gone, stderr })
    }

    /// Sends a command and returns at once; the receiver has its answer when it comes.
    pub fn post(&self, method: &str, params: Value, session: Option<&str>) -> Result<oneshot::Receiver<Value>, CdpError> {
        if self.gone.load(Ordering::Relaxed) {
            return Err(CdpError::Gone);
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        if self.out.send(msg.to_string()).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(CdpError::Gone);
        }
        Ok(rx)
    }

    /// A command's result, within `timeout`.
    pub async fn call(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Result<Value, CdpError> {
        let rx = self.post(method, params, session)?;
        let m = match tokio::time::timeout(timeout, rx).await {
            Err(_) => return Err(CdpError::Timeout(method.to_string())),
            Ok(Err(_)) => return Err(CdpError::Gone),
            Ok(Ok(m)) => m,
        };
        if let Some(e) = m.get("error") {
            if self.gone.load(Ordering::Relaxed) {
                return Err(CdpError::Gone);
            }
            return Err(CdpError::Failed(format!("{method}: {}", e.get("message").and_then(Value::as_str).unwrap_or("?"))));
        }
        Ok(m.get("result").cloned().unwrap_or(json!({})))
    }

    /// Whether it still runs, with its connection open; its exit code if not (when there is one).
    pub fn alive(&self) -> Result<(), Option<i32>> {
        let mut child = self.child.lock().unwrap();
        let Some(c) = child.as_mut() else { return Err(None) };
        match c.try_wait() {
            Ok(Some(status)) => Err(status.code()),
            _ if self.gone.load(Ordering::Relaxed) => Err(None),
            _ => Ok(()),
        }
    }

    /// Stops it: asked first (SIGTERM on Unix), killed after 5 s.
    pub async fn stop(&self) {
        self.gone.store(true, Ordering::Relaxed);
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // SAFETY: a signal to the browser's own process, which this process started and has not reaped.
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
        if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
}

/// A message from the browser: an answer to its command, or an event.
fn deliver(raw: &[u8], pending: &Pending, events: &mpsc::UnboundedSender<Value>) {
    let Ok(m) = serde_json::from_slice::<Value>(raw) else { return };
    match m.get("id").and_then(Value::as_u64) {
        Some(id) => {
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(m);
            }
        }
        None => {
            let _ = events.send(m);
        }
    }
}

/// The connection closed: every command still waiting is answered that the browser is gone.
fn closed(pending: &Pending, gone: &AtomicBool) {
    gone.store(true, Ordering::Relaxed);
    for (_, tx) in pending.lock().unwrap().drain() {
        let _ = tx.send(json!({ "error": { "message": "the browser is gone" } }));
    }
}

#[cfg(unix)]
async fn write_pipe(mut w: tokio::net::unix::pipe::Sender, mut rx: mpsc::UnboundedReceiver<String>) {
    use tokio::io::AsyncWriteExt;
    while let Some(m) = rx.recv().await {
        if w.write_all(m.as_bytes()).await.is_err() || w.write_all(b"\0").await.is_err() {
            return;
        }
    }
}

#[cfg(unix)]
async fn read_pipe(mut r: tokio::net::unix::pipe::Receiver, pending: Pending, gone: Arc<AtomicBool>, events: mpsc::UnboundedSender<Value>) {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 1 << 16];
    loop {
        let n = match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        frames(&mut buf, &chunk[..n], &pending, &events);
    }
    closed(&pending, &gone);
}

/// Bytes read from the pipe: each whole message (up to its NUL) delivered, the rest kept for the next read.
fn frames(buf: &mut Vec<u8>, read: &[u8], pending: &Pending, events: &mpsc::UnboundedSender<Value>) {
    buf.extend_from_slice(read);
    while let Some(i) = buf.iter().position(|&b| b == 0) {
        deliver(&buf[..i], pending, events);
        buf.drain(..=i);
    }
}

/// A pipe's end made inheritable, as the number Chrome reads from `--remote-debugging-io-pipes` (an inherited handle
/// keeps its value in the child). The caller drops it right after the spawn, so another child started in that moment
/// is the only other one that could inherit it. Windows handles hold 32 significant bits: the value fits Chrome's u32.
#[cfg(windows)]
fn inheritable(end: &impl std::os::windows::io::AsRawHandle) -> std::io::Result<u32> {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    let h = end.as_raw_handle();
    // SAFETY: a handle this process owns, open for the call (the borrow), its inherit flag alone changed.
    if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    u32::try_from(h as usize).map_err(|_| std::io::Error::other("a handle's value over 32 bits"))
}

#[cfg(windows)]
fn write_blocking(mut w: std::io::PipeWriter, mut rx: mpsc::UnboundedReceiver<String>) {
    use std::io::Write;
    while let Some(m) = rx.blocking_recv() {
        if w.write_all(m.as_bytes()).is_err() || w.write_all(b"\0").is_err() {
            return;
        }
    }
}

#[cfg(windows)]
fn read_blocking(mut r: std::io::PipeReader, pending: Pending, gone: Arc<AtomicBool>, events: mpsc::UnboundedSender<Value>) {
    use std::io::Read;
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 1 << 16];
    loop {
        let n = match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        frames(&mut buf, &chunk[..n], &pending, &events);
    }
    closed(&pending, &gone);
}

/// The browser's executable in the Chrome unpacked at `top` (deps/README.md).
pub fn executable(top: &Path) -> PathBuf {
    top.join(if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_deliver_whole_messages_across_reads() {
        let pending: Pending = Arc::default();
        let (tx, mut rx) = oneshot::channel();
        pending.lock().unwrap().insert(1, tx);
        let (events, mut got) = mpsc::unbounded_channel();
        let mut buf = Vec::new();
        frames(&mut buf, br#"{"method":"A"}"#, &pending, &events);
        assert!(got.try_recv().is_err(), "no NUL yet: nothing delivered");
        frames(&mut buf, b"\0{\"id\":1,\"result\":{}}\0{\"meth", &pending, &events);
        assert_eq!(got.try_recv().unwrap()["method"], "A");
        assert_eq!(rx.try_recv().unwrap()["id"], 1);
        assert_eq!(buf, br#"{"meth"#);
    }
}
