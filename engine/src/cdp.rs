//! One headless Chrome, spoken to over its devtools protocol: on Unix its pipe (`--remote-debugging-pipe`: commands
//! in on its fd 3, answers and events out on its fd 4, each JSON ended by a NUL), so nothing else on the machine can
//! reach it; on Windows a port on 127.0.0.1 it picks (`--remote-debugging-port=0`, read back from its
//! `DevToolsActivePort`). Commands may carry a sessionId (a page attached flat); events go to the channel given.
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
        let mut child = {
            let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
            cmd.arg("--remote-debugging-port=0").arg("--remote-debugging-address=127.0.0.1");
            cmd.spawn()?
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
        #[cfg(windows)]
        {
            let ws = match connect_port(profile, &mut child).await {
                Ok(ws) => ws,
                Err(e) => {
                    let _ = child.kill().await;
                    return Err(e);
                }
            };
            let (sink, stream) = futures_util::StreamExt::split(ws);
            tokio::spawn(write_ws(sink, out_rx));
            tokio::spawn(read_ws(stream, pending.clone(), gone.clone(), events));
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
        buf.extend_from_slice(&chunk[..n]);
        while let Some(i) = buf.iter().position(|&b| b == 0) {
            deliver(&buf[..i], &pending, &events);
            buf.drain(..=i);
        }
    }
    closed(&pending, &gone);
}

#[cfg(windows)]
type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Chrome's port and path from its profile's `DevToolsActivePort` (written once it listens), connected to.
#[cfg(windows)]
async fn connect_port(profile: &Path, child: &mut Child) -> anyhow::Result<Ws> {
    let file = profile.join("DevToolsActivePort");
    for _ in 0..300 {
        if let Ok(Some(_)) = child.try_wait() {
            anyhow::bail!("it exited at start");
        }
        if let Ok(s) = std::fs::read_to_string(&file) {
            let mut lines = s.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}{}", port.trim(), path.trim())).await?;
                return Ok(ws);
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("its devtools port never came")
}

#[cfg(windows)]
async fn write_ws(mut sink: futures_util::stream::SplitSink<Ws, tokio_tungstenite::tungstenite::Message>, mut rx: mpsc::UnboundedReceiver<String>) {
    use futures_util::SinkExt;
    while let Some(m) = rx.recv().await {
        if sink.send(tokio_tungstenite::tungstenite::Message::Text(m.into())).await.is_err() {
            return;
        }
    }
}

#[cfg(windows)]
async fn read_ws(mut stream: futures_util::stream::SplitStream<Ws>, pending: Pending, gone: Arc<AtomicBool>, events: mpsc::UnboundedSender<Value>) {
    use futures_util::StreamExt;
    while let Some(Ok(m)) = stream.next().await {
        if let tokio_tungstenite::tungstenite::Message::Text(t) = m {
            deliver(t.as_bytes(), &pending, &events);
        }
    }
    closed(&pending, &gone);
}

/// The browser's executable in the Chrome unpacked at `top` (deps/README.md).
pub fn executable(top: &Path) -> PathBuf {
    top.join(if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" })
}
