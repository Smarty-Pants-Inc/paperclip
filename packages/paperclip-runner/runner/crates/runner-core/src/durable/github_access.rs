//! Run-local HTTP facade for GitHub access over the authenticated runner PRP ingress.
//!
//! The box-side launcher connects through a per-runner Unix socket in a private
//! directory. Request and reply bodies are bounded to the callback bridge's
//! existing 10 MiB + 64 KiB limit. This module never logs request data.

#[cfg(not(unix))]
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

pub const MAX_GITHUB_ACCESS_BODY_BYTES: usize = 10 * 1024 * 1024 + 64 * 1024;
#[cfg(unix)]
pub(crate) const GITHUB_ACCESS_RESPONSE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30);
#[cfg(unix)]
const REQUEST_QUEUE_CAPACITY: usize = 64;

#[cfg(unix)]
mod unix_socket {
    use std::collections::BTreeMap;
    use std::fs;
    use std::io::{self, Read, Write};
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::{
        self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError,
    };
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use serde_json::{json, Value};

    use super::{
        GitHubAccessRequest, GITHUB_ACCESS_RESPONSE_TIMEOUT, MAX_GITHUB_ACCESS_BODY_BYTES,
        REQUEST_QUEUE_CAPACITY,
    };

    const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
    const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(1);
    const HTTP_RESPONSE_TIMEOUT_SLICE: Duration = Duration::from_millis(100);
    const CONNECTION_QUEUE_CAPACITY: usize = 32;
    const HTTP_WORKER_COUNT: usize = 4;
    const ERROR_BODY_UNAVAILABLE: &[u8] = br#"{"error":"runner ingress unavailable"}"#;
    const ERROR_BODY_METHOD_NOT_ALLOWED: &[u8] = br#"{"error":"Method not allowed"}"#;
    const GITHUB_CREDENTIALS_PATH: &str = "/runtime-tools/github/credentials";

    pub struct GitHubAccessIngress {
        socket_path: PathBuf,
        private_directory: PathBuf,
        requests: Receiver<GitHubAccessRequest>,
        connection_sender: Option<SyncSender<UnixStream>>,
        shutdown: Arc<AtomicBool>,
        accept_thread: Option<JoinHandle<()>>,
        worker_threads: Vec<JoinHandle<()>>,
        available: Arc<AtomicBool>,
    }

    impl GitHubAccessIngress {
        /// Bind one private socket below a fresh 0700 directory and restrict the
        /// socket itself to 0600 before exposing its path to the provider.
        pub fn start() -> io::Result<Self> {
            let mut secret = [0_u8; 16];
            getrandom::fill(&mut secret)
                .map_err(|error| io::Error::other(format!("secure randomness failed: {error}")))?;
            let random_hex = secret
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let directory_name = format!("paperclip-git-{random_hex}");
            let request_id_prefix = format!("github-access-{random_hex}");
            secret.fill(0);
            let private_directory = std::env::temp_dir().join(directory_name);
            let mut directory_builder = fs::DirBuilder::new();
            directory_builder.recursive(false).mode(0o700);
            directory_builder.create(&private_directory)?;
            if let Err(error) =
                fs::set_permissions(&private_directory, fs::Permissions::from_mode(0o700))
            {
                let _ = fs::remove_dir_all(&private_directory);
                return Err(error);
            }
            let socket_path = private_directory.join("broker.sock");

            let listener = match UnixListener::bind(&socket_path) {
                Ok(listener) => listener,
                Err(error) => {
                    let _ = fs::remove_dir_all(&private_directory);
                    return Err(error);
                }
            };
            if let Err(error) = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
                .and_then(|()| listener.set_nonblocking(true))
            {
                drop(listener);
                let _ = fs::remove_file(&socket_path);
                let _ = fs::remove_dir_all(&private_directory);
                return Err(error);
            }

            let (request_sender, requests) = mpsc::sync_channel(REQUEST_QUEUE_CAPACITY);
            let (connection_sender, connection_receiver) =
                mpsc::sync_channel(CONNECTION_QUEUE_CAPACITY);
            let connection_receiver = Arc::new(Mutex::new(connection_receiver));
            let shutdown = Arc::new(AtomicBool::new(false));
            let available = Arc::new(AtomicBool::new(true));
            let next_request_id = Arc::new(AtomicU64::new(0));
            let mut worker_threads: Vec<JoinHandle<()>> = Vec::with_capacity(HTTP_WORKER_COUNT);

            for index in 0..HTTP_WORKER_COUNT {
                let receiver = Arc::clone(&connection_receiver);
                let requests = request_sender.clone();
                let shutdown = Arc::clone(&shutdown);
                let available = Arc::clone(&available);
                let request_id_prefix = request_id_prefix.clone();
                let next_request_id = Arc::clone(&next_request_id);
                let worker = match thread::Builder::new()
                    .name(format!("github-access-http-{index}"))
                    .spawn(move || loop {
                        if shutdown.load(Ordering::Acquire) {
                            break;
                        }
                        let connection = match receiver.lock() {
                            Ok(receiver) => receiver.recv_timeout(Duration::from_millis(100)),
                            Err(_) => break,
                        };
                        match connection {
                            Ok(mut stream) => handle_connection(
                                &mut stream,
                                &requests,
                                &shutdown,
                                &available,
                                &request_id_prefix,
                                &next_request_id,
                            ),
                            Err(RecvTimeoutError::Timeout) => continue,
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }) {
                    Ok(worker) => worker,
                    Err(error) => {
                        drop(connection_sender);
                        for worker in worker_threads.drain(..) {
                            let _ = worker.join();
                        }
                        drop(listener);
                        let _ = fs::remove_file(&socket_path);
                        let _ = fs::remove_dir_all(&private_directory);
                        return Err(error);
                    }
                };
                worker_threads.push(worker);
            }

            let accept_shutdown = Arc::clone(&shutdown);
            let accept_connections = connection_sender.clone();
            let accept_thread = match thread::Builder::new()
                .name("github-access-accept".to_owned())
                .spawn(move || {
                    while !accept_shutdown.load(Ordering::Acquire) {
                        match listener.accept() {
                            Ok((stream, _)) => match accept_connections.try_send(stream) {
                                Ok(()) => {}
                                Err(TrySendError::Full(mut stream)) => {
                                    let _ = stream.set_write_timeout(Some(HTTP_READ_TIMEOUT));
                                    write_http_error(&mut stream, 503);
                                }
                                Err(TrySendError::Disconnected(mut stream)) => {
                                    let _ = stream.set_write_timeout(Some(HTTP_READ_TIMEOUT));
                                    write_http_error(&mut stream, 503);
                                    break;
                                }
                            },
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(20));
                            }
                            Err(_) => {
                                if !accept_shutdown.load(Ordering::Acquire) {
                                    thread::sleep(Duration::from_millis(20));
                                }
                            }
                        }
                    }
                }) {
                Ok(thread) => thread,
                Err(error) => {
                    shutdown.store(true, Ordering::Release);
                    drop(connection_sender);
                    for worker in worker_threads.drain(..) {
                        let _ = worker.join();
                    }
                    let _ = fs::remove_file(&socket_path);
                    let _ = fs::remove_dir_all(&private_directory);
                    return Err(error);
                }
            };

            Ok(Self {
                socket_path,
                private_directory,
                requests,
                connection_sender: Some(connection_sender),
                shutdown,
                accept_thread: Some(accept_thread),
                worker_threads,
                available,
            })
        }

        pub fn socket_path(&self) -> &std::path::Path {
            &self.socket_path
        }

        pub fn set_available(&self, available: bool) {
            self.available.store(available, Ordering::Release);
        }

        pub fn try_next_request(&mut self) -> Option<GitHubAccessRequest> {
            match self.requests.try_recv() {
                Ok(request) => Some(request),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
            }
        }

        pub(crate) fn reject_queued(&mut self, status: u16) {
            while let Some(request) = self.try_next_request() {
                let request_id = request.request_id().to_owned();
                let _ = request.respond(super::error_reply(&request_id, status));
            }
        }
    }

    impl Drop for GitHubAccessIngress {
        fn drop(&mut self) {
            self.available.store(false, Ordering::Release);
            self.shutdown.store(true, Ordering::Release);
            super::clear_provider_environment(&self.socket_path);
            self.connection_sender.take();
            if let Some(thread) = self.accept_thread.take() {
                let _ = thread.join();
            }
            for thread in self.worker_threads.drain(..) {
                let _ = thread.join();
            }
            let _ = fs::remove_file(&self.socket_path);
            let _ = fs::remove_dir_all(&self.private_directory);
        }
    }

    fn handle_connection(
        stream: &mut UnixStream,
        requests: &SyncSender<GitHubAccessRequest>,
        shutdown: &AtomicBool,
        available: &AtomicBool,
        request_id_prefix: &str,
        next_request_id: &AtomicU64,
    ) {
        let _ = stream.set_read_timeout(Some(HTTP_READ_TIMEOUT));
        let _ = stream.set_write_timeout(Some(HTTP_READ_TIMEOUT));
        let parsed = match read_http_request(stream) {
            Ok(request) => request,
            Err(HttpReadError::TooLarge) => {
                write_http_error(stream, 413);
                return;
            }
            Err(HttpReadError::BadRequest) => {
                write_http_error(stream, 400);
                return;
            }
            Err(HttpReadError::Io) => {
                write_http_error(stream, 503);
                return;
            }
        };
        if parsed.target != GITHUB_CREDENTIALS_PATH {
            write_http_error(stream, 404);
            return;
        }
        if parsed.method != "POST" {
            write_http_error(stream, 405);
            return;
        }
        if ["origin", "cookie", "sec-fetch-site"]
            .iter()
            .any(|header| parsed.headers.contains_key(*header))
        {
            write_http_error(stream, 403);
            return;
        }
        if !available.load(Ordering::Acquire) || shutdown.load(Ordering::Acquire) {
            write_http_error(stream, 503);
            return;
        }

        let Ok(sequence) =
            next_request_id.fetch_update(Ordering::AcqRel, Ordering::Acquire, |sequence| {
                sequence.checked_add(1)
            })
        else {
            write_http_error(stream, 503);
            return;
        };
        let request_id = format!("{request_id_prefix}-{sequence:016x}");
        let frame = json!({
            "kind": "github_access.http",
            "requestId": request_id,
            "method": parsed.method,
            "path": parsed.target,
            "headers": safe_request_headers(&parsed.headers),
            "bodyBase64": BASE64.encode(&parsed.body),
        });
        let deadline = Instant::now() + GITHUB_ACCESS_RESPONSE_TIMEOUT;
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        let request = GitHubAccessRequest {
            request_id: request_id.clone(),
            frame,
            response: response_sender,
            deadline,
        };
        match requests.try_send(request) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(request))
            | Err(mpsc::TrySendError::Disconnected(request)) => {
                let _ = request.respond(super::error_reply(&request_id, 503));
                write_http_error(stream, 503);
                return;
            }
        }

        loop {
            if shutdown.load(Ordering::Acquire) || !available.load(Ordering::Acquire) {
                write_http_error(stream, 503);
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                write_http_error(stream, 503);
                return;
            }
            match response_receiver.recv_timeout(remaining.min(HTTP_RESPONSE_TIMEOUT_SLICE)) {
                Ok(response) => {
                    let _ = write_reply(stream, &request_id, &response);
                    return;
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    write_http_error(stream, 503);
                    return;
                }
            }
        }
    }

    struct ParsedHttpRequest {
        method: String,
        target: String,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    }

    enum HttpReadError {
        TooLarge,
        BadRequest,
        Io,
    }

    fn read_http_request(stream: &mut UnixStream) -> Result<ParsedHttpRequest, HttpReadError> {
        let mut header = Vec::with_capacity(1024);
        let mut byte = [0_u8; 1];
        loop {
            if header.len() >= MAX_HTTP_HEADER_BYTES {
                return Err(HttpReadError::TooLarge);
            }
            match stream.read_exact(&mut byte) {
                Ok(()) => header.push(byte[0]),
                Err(_) => return Err(HttpReadError::Io),
            }
            if header.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let header_text = std::str::from_utf8(&header).map_err(|_| HttpReadError::BadRequest)?;
        let mut lines = header_text[..header_text.len() - 4].split("\r\n");
        let request_line = lines.next().ok_or(HttpReadError::BadRequest)?;
        let mut parts = request_line.split_ascii_whitespace();
        let method = parts.next().ok_or(HttpReadError::BadRequest)?;
        let target = parts.next().ok_or(HttpReadError::BadRequest)?;
        let version = parts.next().ok_or(HttpReadError::BadRequest)?;
        if parts.next().is_some()
            || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
            || !is_http_token(method)
            || !target.starts_with('/')
            || target
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte == b' ')
        {
            return Err(HttpReadError::BadRequest);
        }
        let mut headers = BTreeMap::new();
        let mut content_length = None;
        let mut transfer_encoding = false;
        for line in lines {
            let (name, value) = line.split_once(':').ok_or(HttpReadError::BadRequest)?;
            if !is_http_token(name)
                || value
                    .bytes()
                    .any(|byte| (byte.is_ascii_control() && byte != b'\t') || byte == 0x7f)
            {
                return Err(HttpReadError::BadRequest);
            }
            let name = name.to_ascii_lowercase();
            let value = value
                .trim_matches(|byte| byte == ' ' || byte == '\t')
                .to_owned();
            match name.as_str() {
                "content-length" => {
                    if content_length.is_some() {
                        return Err(HttpReadError::BadRequest);
                    }
                    content_length = Some(
                        value
                            .parse::<usize>()
                            .map_err(|_| HttpReadError::BadRequest)?,
                    );
                }
                "transfer-encoding" => transfer_encoding = true,
                _ => {
                    headers
                        .entry(name)
                        .and_modify(|existing: &mut String| {
                            existing.push_str(", ");
                            existing.push_str(&value);
                        })
                        .or_insert(value);
                }
            }
        }
        if transfer_encoding {
            return Err(HttpReadError::BadRequest);
        }
        let body_length = content_length.unwrap_or(0);
        if body_length > MAX_GITHUB_ACCESS_BODY_BYTES {
            return Err(HttpReadError::TooLarge);
        }
        let mut body = vec![0_u8; body_length];
        stream
            .read_exact(&mut body)
            .map_err(|_| HttpReadError::Io)?;
        Ok(ParsedHttpRequest {
            method: method.to_owned(),
            target: target.to_owned(),
            headers,
            body,
        })
    }

    fn safe_request_headers(headers: &BTreeMap<String, String>) -> serde_json::Map<String, Value> {
        let mut output = serde_json::Map::new();
        for (name, value) in headers {
            if matches!(name.as_str(), "content-type" | "accept")
                || matches!(
                    name.as_str(),
                    "x-paperclip-bridge-generation"
                        | "x-paperclip-bridge-transport"
                        | "x-paperclip-run-id"
                )
                || (name == "x-paperclip-github-capability"
                    && value.len() <= 4_096
                    && !value.contains(','))
            {
                output.insert(name.clone(), Value::String(value.clone()));
            }
        }
        output
    }

    fn is_http_token(value: &str) -> bool {
        !value.is_empty()
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#'
                            | b'$'
                            | b'%'
                            | b'&'
                            | b'\''
                            | b'*'
                            | b'+'
                            | b'-'
                            | b'.'
                            | b'^'
                            | b'_'
                            | b'`'
                            | b'|'
                            | b'~'
                    )
            })
    }

    fn write_reply(stream: &mut UnixStream, request_id: &str, response: &Value) -> io::Result<()> {
        let Some(object) = response.as_object() else {
            write_http_error(stream, 502);
            return Ok(());
        };
        if !super::is_reply_frame(response)
            || object.get("requestId").and_then(Value::as_str) != Some(request_id)
        {
            write_http_error(stream, 502);
            return Ok(());
        }
        let Some(status) = object
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .filter(|status| (100..=599).contains(status))
        else {
            write_http_error(stream, 502);
            return Ok(());
        };
        let Some(headers) = object.get("headers").and_then(Value::as_object) else {
            write_http_error(stream, 502);
            return Ok(());
        };
        let Some(body) = object.get("bodyBase64").and_then(Value::as_str) else {
            write_http_error(stream, 502);
            return Ok(());
        };
        let body = match BASE64.decode(body) {
            Ok(body) if body.len() <= MAX_GITHUB_ACCESS_BODY_BYTES => body,
            _ => {
                write_http_error(stream, 502);
                return Ok(());
            }
        };
        let mut output = format!("HTTP/1.1 {status} {}\r\n", reason_phrase(status));
        for (name, value) in headers {
            let Some(value) = value.as_str() else {
                write_http_error(stream, 502);
                return Ok(());
            };
            if !is_http_token(name)
                || value
                    .bytes()
                    .any(|byte| byte.is_ascii_control() && byte != b'\t')
                || matches!(
                    name.to_ascii_lowercase().as_str(),
                    "content-length" | "transfer-encoding" | "connection" | "keep-alive"
                )
            {
                continue;
            }
            output.push_str(name);
            output.push_str(": ");
            output.push_str(value);
            output.push_str("\r\n");
        }
        output.push_str(&format!(
            "content-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        ));
        stream.write_all(output.as_bytes())?;
        stream.write_all(&body)?;
        stream.flush()
    }

    fn write_http_error(stream: &mut UnixStream, status: u16) {
        let body = if status == 404 {
            br#"{"error":"Not found"}"#.as_slice()
        } else if status == 405 {
            ERROR_BODY_METHOD_NOT_ALLOWED
        } else if status == 413 {
            br#"{"error":"Request body too large"}"#.as_slice()
        } else if status == 400 {
            br#"{"error":"Invalid request"}"#.as_slice()
        } else if status == 403 {
            br#"{"error":"GitHub session authentication required"}"#.as_slice()
        } else if status == 503 {
            ERROR_BODY_UNAVAILABLE
        } else if status == 504 {
            br#"{"error":"runner ingress response timed out"}"#.as_slice()
        } else {
            br#"{"error":"Invalid runner ingress response"}"#.as_slice()
        };
        let response = format!(
            "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            reason_phrase(status),
            body.len()
        );
        if stream.write_all(response.as_bytes()).is_ok() && stream.write_all(body).is_ok() {
            let _ = stream.flush();
        }
    }

    fn reason_phrase(status: u16) -> &'static str {
        match status {
            200 => "OK",
            201 => "Created",
            202 => "Accepted",
            204 => "No Content",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            409 => "Conflict",
            413 => "Payload Too Large",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            502 => "Bad Gateway",
            503 => "Service Unavailable",
            504 => "Gateway Timeout",
            _ => "Response",
        }
    }
}

#[cfg(unix)]
pub use unix_socket::GitHubAccessIngress;

#[cfg(not(unix))]
pub struct GitHubAccessIngress;

#[cfg(not(unix))]
impl GitHubAccessIngress {
    pub fn start() -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "runner GitHub ingress requires a private Unix socket",
        ))
    }

    pub fn socket_path(&self) -> &Path {
        Path::new("")
    }

    pub fn set_available(&self, _available: bool) {}

    pub fn try_next_request(&mut self) -> Option<GitHubAccessRequest> {
        None
    }

    pub(crate) fn reject_queued(&mut self, _status: u16) {}
}

#[derive(Clone)]
struct ProviderEnvironment {
    socket_path: PathBuf,
}

static PROVIDER_ENVIRONMENT: OnceLock<Mutex<Option<ProviderEnvironment>>> = OnceLock::new();

fn provider_environment_slot() -> &'static Mutex<Option<ProviderEnvironment>> {
    PROVIDER_ENVIRONMENT.get_or_init(|| Mutex::new(None))
}

pub(crate) fn install_provider_environment(socket_path: &Path) -> Result<(), ()> {
    let mut value = provider_environment_slot().lock().map_err(|_| ())?;
    *value = Some(ProviderEnvironment {
        socket_path: socket_path.to_owned(),
    });
    Ok(())
}

pub(crate) fn clear_provider_environment(socket_path: &Path) {
    if let Ok(mut value) = provider_environment_slot().lock() {
        if value
            .as_ref()
            .is_some_and(|environment| environment.socket_path == socket_path)
        {
            *value = None;
        }
    }
}

pub(crate) fn apply_provider_environment(command: &mut std::process::Command) {
    let Ok(value) = provider_environment_slot().lock() else {
        command
            .env_remove("PAPERCLIP_GITHUB_RUNNER_SOCKET")
            .env_remove("PAPERCLIP_GITHUB_ACCESS_TRANSPORT")
            .env("PAPERCLIP_GITHUB_BROKER_URL", "")
            .env("PAPERCLIP_GITHUB_BROKER_TOKEN", "")
            .env("PAPERCLIP_GITHUB_BRIDGE_TOKEN", "");
        return;
    };
    let Some(environment) = value.as_ref() else {
        // In callback-bridge mode the server-provided environment is already
        // complete. Do not rewrite it when no runner ingress is installed.
        return;
    };
    // The session capability arrives in runnerd's existing launch environment.
    // Keep its value only on provider children, where the GitHub launcher needs
    // it to authenticate the local socket request; never use the bridge URL.
    let session_capability = std::env::var_os("PAPERCLIP_GITHUB_BROKER_TOKEN").unwrap_or_default();
    command
        .env("PAPERCLIP_GITHUB_RUNNER_SOCKET", &environment.socket_path)
        .env("PAPERCLIP_GITHUB_ACCESS_TRANSPORT", "runner_ingress")
        .env("PAPERCLIP_GITHUB_BROKER_URL", "")
        .env("PAPERCLIP_GITHUB_BROKER_TOKEN", session_capability)
        .env("PAPERCLIP_GITHUB_BRIDGE_TOKEN", "");
}

/// One local HTTP request waiting for a matching authenticated PRP reply.
pub struct GitHubAccessRequest {
    request_id: String,
    frame: Value,
    response: SyncSender<Value>,
    deadline: std::time::Instant,
}

impl GitHubAccessRequest {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn frame(&self) -> &Value {
        &self.frame
    }

    pub(crate) fn deadline(&self) -> std::time::Instant {
        self.deadline
    }

    /// Complete the local HTTP request with the contract's bare reply frame.
    pub fn respond(self, response: Value) -> Result<(), ()> {
        self.response.send(response).map_err(|_| ())
    }
}

pub(crate) fn is_reply_frame(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == 4
        && object.contains_key("requestId")
        && object.contains_key("status")
        && object.contains_key("headers")
        && object.contains_key("bodyBase64")
}

pub(crate) fn error_reply(request_id: &str, status: u16) -> Value {
    let body: &[u8] = if status == 503 {
        br#"{"error":"runner ingress unavailable"}"#
    } else if status == 504 {
        br#"{"error":"runner ingress response timed out"}"#
    } else if status == 413 {
        br#"{"error":"Request body too large"}"#
    } else if status == 403 {
        br#"{"error":"No active GitHub run"}"#
    } else {
        br#"{"error":"GitHub credentials unavailable"}"#
    };
    json!({
        "requestId": request_id,
        "status": status,
        "headers": { "content-type": "application/json", "cache-control": "no-store" },
        "bodyBase64": BASE64.encode(body),
    })
}
