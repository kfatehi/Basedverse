//! One headless Chrome, spoken to over its devtools protocol on its pipe (`--remote-debugging-pipe`: commands in,
//! answers and events out, each JSON ended by a NUL), so nothing else on the machine can reach it. On Unix the pipe's
//! ends are its fds 3 and 4; on Windows two inherited handles, named to it by `--remote-debugging-io-pipes=<in>,<out>`.
//! Commands may carry a sessionId (a page attached flat); events go to the channel given.
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, BufReader};
#[cfg(unix)]
use tokio::process::{Child, Command};
#[cfg(windows)]
use win::Child;
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
        let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let gone = Arc::new(AtomicBool::new(false));
        let stderr: Arc<Mutex<VecDeque<String>>> = Arc::default();
        #[cfg(unix)]
        let (child, reader, writer) = {
            let mut cmd = Command::new(exe);
            cmd.args(args).envs(env.iter().map(|(k, v)| (k, v))).arg(format!("--user-data-dir={}", profile.display()))
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
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
            let mut child = cmd.spawn()?;
            drop(to_r);
            drop(from_w);
            if let Some(err) = child.stderr.take() {
                let keep = stderr.clone();
                tokio::spawn(async move {
                    let mut lines = BufReader::new(err).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        keep_line(&keep, line);
                    }
                });
            }
            let reader = tokio::net::unix::pipe::Receiver::from_owned_fd(OwnedFd::from(from_r))?;
            let writer = tokio::net::unix::pipe::Sender::from_owned_fd(OwnedFd::from(to_w))?;
            (child, reader, writer)
        };
        // Chrome takes the pipe's ends as two handles it inherits, named by their values (an inherited handle keeps
        // its value) in --remote-debugging-io-pipes; it adopts each only if it is a pipe. It is started by hand
        // (win::spawn) so that it inherits those, its stderr's and NUL, and nothing else this process holds.
        #[cfg(windows)]
        let (child, reader, writer) = {
            anyhow::ensure!(env.is_empty(), "no environment of its own for Chrome on Windows");
            let (to_r, to_w) = std::io::pipe()?;
            let (from_r, from_w) = std::io::pipe()?;
            let (err_r, err_w) = std::io::pipe()?;
            let null = std::fs::OpenOptions::new().read(true).write(true).open("NUL")?;
            let mut argv = args.to_vec();
            argv.push(format!("--user-data-dir={}", profile.display()));
            argv.push("--remote-debugging-pipe".into());
            argv.push(format!("--remote-debugging-io-pipes={},{}", win::value(&to_r)?, win::value(&from_w)?));
            let child = win::spawn(exe, &argv, &null, &err_w, &[&to_r, &from_w])?;
            drop((to_r, from_w, err_w, null));
            let keep = stderr.clone();
            std::thread::Builder::new().name("chrome-stderr".into()).spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(err_r).lines() {
                    let Ok(line) = line else { break };
                    keep_line(&keep, line);
                }
            })?;
            (child, from_r, to_w)
        };
        let pid = child.id().unwrap_or(0);
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

    /// Stops it: asked first (SIGTERM on Unix, Browser.close over its pipe on Windows, which has no SIGTERM), killed
    /// after 5 s.
    pub async fn stop(&self) {
        #[cfg(windows)]
        let _ = self.post("Browser.close", json!({}), None);
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

/// A line Chrome wrote on stderr: logged, and the last 40 kept.
fn keep_line(keep: &Mutex<VecDeque<String>>, line: String) {
    debug!(target: "engine", "chrome: {line}");
    let mut k = keep.lock().unwrap();
    if k.len() == 40 {
        k.pop_front();
    }
    k.push_back(line);
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

/// Chrome started on Windows with CreateProcessW, which std's Command can't do: PROC_THREAD_ATTRIBUTE_HANDLE_LIST, so
/// Chrome inherits the handles listed and nothing else this process holds as inheritable (another spawn's in flight).
/// The listed ones are inheritable from just before the spawn until the caller drops them right after it; a child
/// spawned by another thread in that moment, without a list of its own, could still take them.
#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::path::Path;
    use std::process::ExitStatus;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    /// A handle's value, as Chrome parses it (a u32: Windows handles hold 32 significant bits).
    pub fn value(h: &impl AsRawHandle) -> std::io::Result<u32> {
        u32::try_from(h.as_raw_handle() as usize).map_err(|_| std::io::Error::other("a handle's value over 32 bits"))
    }

    /// The child: what the engine asks of tokio's Child (its pid, whether it ended, waited for, killed), and killed
    /// when dropped, as tokio's with kill_on_drop.
    pub struct Child {
        process: OwnedHandle,
        pid: u32,
    }

    impl Child {
        pub fn id(&self) -> Option<u32> {
            Some(self.pid)
        }

        pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            let h = self.process.as_raw_handle();
            // SAFETY: the process's own handle, open while self is.
            match unsafe { WaitForSingleObject(h, 0) } {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0u32;
                    // SAFETY: as above; code is ours to write.
                    if unsafe { GetExitCodeProcess(h, &mut code) } == 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(Some(ExitStatus::from_raw(code)))
                }
                _ => Err(std::io::Error::last_os_error()),
            }
        }

        pub async fn wait(&mut self) -> std::io::Result<ExitStatus> {
            loop {
                if let Some(status) = self.try_wait()? {
                    return Ok(status);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        pub async fn kill(&mut self) -> std::io::Result<()> {
            self.terminate();
            self.wait().await.map(|_| ())
        }

        fn terminate(&mut self) {
            if let Ok(None) = self.try_wait() {
                // SAFETY: the process's own handle, open while self is.
                unsafe { TerminateProcess(self.process.as_raw_handle(), 1) };
            }
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    /// `"…"` around an argument where Windows' command line needs it (the rules CommandLineToArgvW reads by).
    fn quote(arg: &str, line: &mut String) {
        if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
            line.push_str(arg);
            return;
        }
        line.push('"');
        let mut slashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => slashes += 1,
                // backslashes before a quote are doubled, and one more escapes the quote
                '"' => {
                    line.extend(std::iter::repeat_n('\\', slashes + 1));
                    slashes = 0;
                }
                _ => slashes = 0,
            }
            line.push(c);
        }
        // and before the closing quote, doubled
        line.extend(std::iter::repeat_n('\\', slashes));
        line.push('"');
    }

    /// Starts `exe` with `args`, its stdin and stdout `null`, its stderr `err`, inheriting `inherit` (and those) only.
    pub fn spawn(exe: &Path, args: &[String], null: &impl AsRawHandle, err: &impl AsRawHandle,
                 inherit: &[&dyn AsRawHandle]) -> std::io::Result<Child> {
        let mut line = String::new();
        quote(&exe.to_string_lossy(), &mut line);
        for a in args {
            line.push(' ');
            quote(a, &mut line);
        }
        let mut line: Vec<u16> = line.encode_utf16().chain([0]).collect();
        let exe: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
        let mut handles: Vec<HANDLE> = vec![null.as_raw_handle(), err.as_raw_handle()];
        handles.extend(inherit.iter().map(|h| h.as_raw_handle()));
        for &h in &handles {
            // SAFETY: handles the caller holds open for the call; only their inherit flag changes.
            if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        // The attribute list, sized as Windows asks (a first call that fails by design), then holding the handles.
        let mut size = 0usize;
        // SAFETY: a null list with a size to fill is the documented way to ask the size.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        let mut list = vec![0u64; size.div_ceil(8)];
        let attrs = list.as_mut_ptr().cast();
        // SAFETY: attrs is `size` bytes, 8-aligned; handles outlives the list, deleted below before either goes.
        unsafe {
            if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_ptr().cast(),
                                         std::mem::size_of_val(handles.as_slice()), std::ptr::null_mut(), std::ptr::null()) == 0 {
                let e = std::io::Error::last_os_error();
                DeleteProcThreadAttributeList(attrs);
                return Err(e);
            }
        }
        // SAFETY: plain C structs, zero a valid start for both.
        let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = null.as_raw_handle();
        si.StartupInfo.hStdOutput = null.as_raw_handle();
        si.StartupInfo.hStdError = err.as_raw_handle();
        si.lpAttributeList = attrs;
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: exe and line NUL-ended UTF-16 (line writable, as CreateProcessW wants), si and its list alive for
        // the call; no environment (Chrome gets this process's) and no directory (this process's).
        let ok = unsafe {
            let ok = CreateProcessW(exe.as_ptr(), line.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1,
                                    CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, std::ptr::null(),
                                    std::ptr::null(), &si.StartupInfo, &mut pi);
            DeleteProcThreadAttributeList(attrs);
            ok
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: both handles CreateProcessW just gave this process, each owned once.
        unsafe { CloseHandle(pi.hThread) };
        Ok(Child { process: unsafe { OwnedHandle::from_raw_handle(pi.hProcess) }, pid: pi.dwProcessId })
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn quote_as_windows_reads_it() {
            let q = |a: &str| {
                let mut l = String::new();
                super::quote(a, &mut l);
                l
            };
            assert_eq!(q("--no-sandbox"), "--no-sandbox");
            assert_eq!(q(r"--user-data-dir=C:\a b\profile"), r#""--user-data-dir=C:\a b\profile""#);
            assert_eq!(q(r"C:\a b\"), r#""C:\a b\\""#);
            assert_eq!(q(r#"say "hi""#), r#""say \"hi\"""#);
            assert_eq!(q(r#"a\"b"#), r#""a\\\"b""#);
            assert_eq!(q(""), r#""""#);
        }

        /// What Chrome does with --remote-debugging-io-pipes, done by a PowerShell: write to a pipe handle by its
        /// value. The listed pipe gets its bytes; an inheritable handle not on the list never reaches the child.
        #[test]
        fn a_child_inherits_the_listed_handles_and_no_other() {
            use std::io::Read;
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
            let (mut r, w) = std::io::pipe().unwrap();
            let (mut stray_r, stray_w) = std::io::pipe().unwrap();
            // SAFETY: a handle this test holds; only its inherit flag changes.
            assert_ne!(unsafe { SetHandleInformation(stray_w.as_raw_handle(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }, 0);
            let (_err_r, err_w) = std::io::pipe().unwrap();
            let null = std::fs::OpenOptions::new().read(true).write(true).open("NUL").unwrap();
            let script = format!(
                "$h = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new([IntPtr]::new({}), $false); \
                 $f = [IO.FileStream]::new($h, 'Write'); $f.Write([byte[]](111, 107), 0, 2); $f.Flush(); Start-Sleep 20",
                super::value(&w).unwrap());
            let args = ["-NoProfile", "-NonInteractive", "-Command", &script].map(String::from);
            let child = super::spawn(std::path::Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
                                         &args, &null, &err_w, &[&w]).unwrap();
            drop((w, err_w, null));
            let mut got = [0u8; 2];
            r.read_exact(&mut got).unwrap();
            assert_eq!(&got, b"ok");
            // The stray pipe's only writer is this test's: dropped, its reader ends at once, while the child lives.
            // (A child holding a copy keeps it open until it ends, 20 s on: well past the 10 s allowed.)
            let t = std::time::Instant::now();
            drop(stray_w);
            assert_eq!(stray_r.read(&mut [0u8; 1]).unwrap(), 0);
            assert!(t.elapsed() < std::time::Duration::from_secs(10), "the child held the stray handle");
            drop(child);
        }
    }
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
