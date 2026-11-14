//! Always-on ingress admission. TCP accept sleeps in the kernel when idle;
//! only pending upgrades retry nonblocking I/O, for at most two seconds.
use super::DurableRunnerError;
use std::io::{self, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::ErrorResponse;
use tungstenite::handshake::HandshakeError;
use tungstenite::{accept_hdr_with_config, WebSocket};

/// Independent of the controller's connect/auth budget. Silent and partial
/// requests occupy one of at most 16 upgrade workers for no more than 2s.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PENDING_HANDSHAKES: usize = 16;
/// A completed upgrade may precede the next connect tick. Keep only the first
/// for 2s, then drop it; no idle socket can become an unbounded FIFO backlog.
const READY_GRACE: Duration = Duration::from_secs(2);

struct ReadySocket {
    socket: WebSocket<TcpStream>,
    expires: Instant,
}

struct Admission {
    path: String,
    generation: u64,
    ready: Option<ReadySocket>,
    active: bool,
    accept_error: Option<String>,
}

impl Admission {
    fn expire_ready(&mut self) {
        if self
            .ready
            .as_ref()
            .is_some_and(|ready| Instant::now() >= ready.expires)
        {
            self.ready = None;
        }
    }
}

pub(crate) struct ListenerIngress {
    address: SocketAddr,
    admission: Arc<Mutex<Admission>>,
    stopping: Arc<AtomicBool>,
    changed: Arc<Condvar>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ListenerIngress {
    pub(super) fn new(listener: TcpListener, path: String) -> io::Result<Self> {
        listener.set_nonblocking(false)?;
        let address = listener.local_addr()?;
        let admission = Arc::new(Mutex::new(Admission {
            path,
            generation: 0,
            ready: None,
            active: false,
            accept_error: None,
        }));
        let stopping = Arc::new(AtomicBool::new(false));
        let shared = admission.clone();
        let stop = stopping.clone();
        let changed = Arc::new(Condvar::new());
        let wake = changed.clone();
        let worker = thread::Builder::new()
            .name("runner-ingress".into())
            .spawn(move || {
                let mut pending: Vec<thread::JoinHandle<()>> = Vec::new();
                loop {
                    let connection = listener.accept();
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let (mut stream, _) = match connection {
                        Ok(connection) => connection,
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::Interrupted
                                    | io::ErrorKind::ConnectionAborted
                                    | io::ErrorKind::ConnectionReset
                            ) =>
                        {
                            continue
                        }
                        Err(error) => {
                            shared.lock().unwrap().accept_error = Some(error.to_string());
                            break;
                        }
                    };
                    // The deadline starts at accept, not when a worker is scheduled.
                    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    pending.retain_mut(|worker| !worker.is_finished());
                    let (path, generation, occupied) = {
                        let mut state = shared.lock().unwrap();
                        state.expire_ready();
                        (
                            state.path.clone(),
                            state.generation,
                            state.active || state.ready.is_some(),
                        )
                    };
                    if occupied || pending.len() >= MAX_PENDING_HANDSHAKES {
                        reject_busy(&mut stream);
                        continue;
                    }
                    let state = shared.clone();
                    let stop = stop.clone();
                    let wake = wake.clone();
                    if let Ok(worker) = thread::Builder::new()
                        .name("runner-ingress-upgrade".into())
                        .spawn(move || {
                            upgrade(stream, path, generation, deadline, &state, &stop, &wake)
                        })
                    {
                        pending.push(worker);
                    }
                }
                // No detached upgrade workers survive endpoint shutdown.
                for worker in pending {
                    let _ = worker.join();
                }
            })?;
        Ok(Self {
            address,
            admission,
            stopping,
            changed,
            worker: Some(worker),
        })
    }

    pub(crate) fn local_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.address)
    }

    pub(super) fn rotate(&self, path: String) {
        let mut state = self.admission.lock().unwrap();
        state.path = path;
        state.generation = state.generation.wrapping_add(1);
        state.ready = None;
        self.changed.notify_all();
    }

    pub(super) fn take(&self) -> Result<Option<ListenerSocket>, DurableRunnerError> {
        let mut state = self.admission.lock().unwrap();
        if let Some(error) = &state.accept_error {
            return Err(DurableRunnerError::invalid(format!(
                "runner ingress listener accept failed: {error}"
            )));
        }
        state.expire_ready();
        let Some(ready) = state.ready.take() else {
            return Ok(None);
        };
        state.active = true;
        self.changed.notify_all();
        Ok(Some(ListenerSocket {
            socket: ready.socket,
            admission: self.admission.clone(),
        }))
    }
}

impl Drop for ListenerIngress {
    fn drop(&mut self) {
        {
            let mut state = self.admission.lock().unwrap();
            self.stopping.store(true, Ordering::Release);
            state.ready = None;
            self.changed.notify_all();
        }
        // Wake the blocking accept without an idle polling timer. Listener mode
        // binds IPv4 wildcard; tests may bind loopback directly.
        let address = SocketAddr::from(([127, 0, 0, 1], self.address.port()));
        let _ = TcpStream::connect_timeout(&address, Duration::from_millis(100));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn reject_busy(stream: &mut TcpStream) {
    // Best effort on a fresh nonblocking stream: never wait on an extra peer.
    let _ = stream.write_all(
        b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
}

fn upgrade(
    stream: TcpStream,
    path: String,
    generation: u64,
    deadline: Instant,
    admission: &Arc<Mutex<Admission>>,
    stopping: &AtomicBool,
    changed: &Condvar,
) {
    let expired = || stopping.load(Ordering::Acquire) || Instant::now() >= deadline;
    if expired() || stream.set_nonblocking(true).is_err() {
        return;
    }
    let mut handshake = accept_hdr_with_config(
        stream,
        |request: &tungstenite::handshake::server::Request, response| {
            if request.uri().path() != path
                || request.uri().query().is_some()
                || request.headers().contains_key("sec-websocket-extensions")
            {
                let mut rejection = ErrorResponse::new(Some(
                    "runner listener requires the configured path without extensions".to_owned(),
                ));
                *rejection.status_mut() = tungstenite::http::StatusCode::BAD_REQUEST;
                return Err(rejection);
            }
            let state = admission.lock().unwrap();
            if state.active || state.ready.is_some() || state.generation != generation {
                let mut rejection = ErrorResponse::new(None);
                *rejection.status_mut() = tungstenite::http::StatusCode::SERVICE_UNAVAILABLE;
                return Err(rejection);
            }
            Ok(response)
        },
        None,
    );
    loop {
        if expired() {
            return;
        }
        match handshake {
            Ok(mut socket) => {
                if socket.get_mut().set_nonblocking(false).is_err() {
                    return;
                }
                let mut state = admission.lock().unwrap();
                state.expire_ready();
                if !state.active && state.ready.is_none() && state.generation == generation {
                    let expires = Instant::now() + READY_GRACE;
                    state.ready = Some(ReadySocket { socket, expires });
                    // The ready socket really closes at grace expiry even if
                    // runnerd remains idle and no further TCP peer arrives.
                    while !stopping.load(Ordering::Acquire)
                        && state
                            .ready
                            .as_ref()
                            .is_some_and(|ready| ready.expires == expires)
                    {
                        let remaining = expires.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            state.expire_ready();
                            break;
                        }
                        state = changed.wait_timeout(state, remaining).unwrap().0;
                    }
                }
                return;
            }
            Err(HandshakeError::Interrupted(mid_handshake)) => {
                if admission.lock().unwrap().generation != generation {
                    return;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(Duration::from_millis(5).min(remaining));
                if expired() {
                    return;
                }
                handshake = mid_handshake.handshake();
            }
            Err(_) => return, // Bad peers are not controller connection failures.
        }
    }
}

pub(super) struct ListenerSocket {
    socket: WebSocket<TcpStream>,
    admission: Arc<Mutex<Admission>>,
}
impl Deref for ListenerSocket {
    type Target = WebSocket<TcpStream>;
    fn deref(&self) -> &Self::Target {
        &self.socket
    }
}
impl DerefMut for ListenerSocket {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.socket
    }
}
impl Drop for ListenerSocket {
    fn drop(&mut self) {
        let _ = self.socket.get_ref().shutdown(std::net::Shutdown::Both);
        self.admission.lock().unwrap().active = false;
    }
}
