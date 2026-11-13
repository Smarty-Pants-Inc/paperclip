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

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PENDING_HANDSHAKES: usize = 16;
/// One accept-to-authentication budget: HTTP upgrade, ready wait, and mutual
/// authentication share this deadline. Authenticated welcome keeps its own budget.
const UNAUTHENTICATED_TIMEOUT: Duration = Duration::from_millis(2500);

struct ReadySocket {
    socket: WebSocket<TcpStream>,
    expires: Instant,
}

struct Admission {
    path: String,
    generation: u64,
    ready: Option<ReadySocket>,
    active: Option<Instant>,
    active_deadline: Option<Instant>,
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

struct UpgradeControl {
    stream: Mutex<Option<TcpStream>>,
    cancelled: AtomicBool,
    upgrading: AtomicBool,
}

impl UpgradeControl {
    fn shutdown(&self) {
        if let Some(stream) = self.stream.lock().unwrap().as_ref() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

struct PendingUpgrade {
    control: Arc<UpgradeControl>,
    worker: thread::JoinHandle<()>,
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
            active: None,
            active_deadline: None,
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
                // Acceptance order is also eviction order. Completed upgrades
                // are protected under the same mutex that publishes ready/active.
                let mut pending: Vec<PendingUpgrade> = Vec::new();
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
                    // Both deadlines start at accept, not worker scheduling.
                    let accepted = Instant::now();
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    let mut index = 0;
                    while index < pending.len() {
                        if pending[index].worker.is_finished() {
                            let _ = pending.remove(index).worker.join();
                        } else {
                            index += 1;
                        }
                    }
                    let (path, generation, evicted) = {
                        let mut state = shared.lock().unwrap();
                        state.expire_ready();
                        if state.active.is_some() || state.ready.is_some() {
                            reject_busy(&mut stream);
                            continue;
                        }
                        let evicted = if pending.len() >= MAX_PENDING_HANDSHAKES {
                            let Some(oldest) = pending.iter().position(|pending| {
                                pending.control.upgrading.load(Ordering::Acquire)
                            }) else {
                                reject_busy(&mut stream);
                                continue;
                            };
                            let pending = pending.remove(oldest);
                            pending.control.cancelled.store(true, Ordering::Release);
                            pending.control.shutdown();
                            Some(pending)
                        } else {
                            None
                        };
                        (state.path.clone(), state.generation, evicted)
                    };
                    // Join before replacing: not even a flood can grow the
                    // worker count beyond 16. Cancellation interrupts I/O and
                    // the retry loop observes it within its existing 5ms step.
                    if let Some(evicted) = evicted {
                        let _ = evicted.worker.join();
                    }
                    let Ok(shutdown_stream) = stream.try_clone() else {
                        continue;
                    };
                    let control = Arc::new(UpgradeControl {
                        stream: Mutex::new(Some(shutdown_stream)),
                        cancelled: AtomicBool::new(false),
                        upgrading: AtomicBool::new(true),
                    });
                    let worker_control = control.clone();
                    let state = shared.clone();
                    let stop = stop.clone();
                    let wake = wake.clone();
                    if let Ok(worker) = thread::Builder::new()
                        .name("runner-ingress-upgrade".into())
                        .spawn(move || {
                            upgrade(
                                stream,
                                path,
                                generation,
                                accepted,
                                &worker_control,
                                &state,
                                &stop,
                                &wake,
                            );
                            // Do not retain an extra TCP handle in the pending
                            // list after the worker finishes (including errors).
                            worker_control.stream.lock().unwrap().take();
                        })
                    {
                        pending.push(PendingUpgrade { control, worker });
                    }
                }
                // No detached upgrade workers survive endpoint shutdown.
                for pending in pending {
                    let _ = pending.worker.join();
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
        state.active = Some(ready.expires);
        state.active_deadline = Some(ready.expires);
        self.changed.notify_all();
        Ok(Some(ListenerSocket {
            socket: ready.socket,
            id: ready.expires,
            deadline: Some(ready.expires),
            admission: self.admission.clone(),
            changed: self.changed.clone(),
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
    accepted: Instant,
    control: &UpgradeControl,
    admission: &Arc<Mutex<Admission>>,
    stopping: &AtomicBool,
    changed: &Condvar,
) {
    let upgrade_deadline = accepted + HANDSHAKE_TIMEOUT;
    let deadline = accepted + UNAUTHENTICATED_TIMEOUT;
    let expired = || {
        stopping.load(Ordering::Acquire)
            || control.cancelled.load(Ordering::Acquire)
            || Instant::now() >= upgrade_deadline
    };
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
            if state.active.is_some() || state.ready.is_some() || state.generation != generation {
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
                if control.cancelled.load(Ordering::Acquire) {
                    return;
                }
                control.upgrading.store(false, Ordering::Release);
                if state.active.is_none() && state.ready.is_none() && state.generation == generation
                {
                    state.ready = Some(ReadySocket {
                        socket,
                        expires: deadline,
                    });
                    // One deadline survives ready -> active handover. The
                    // worker also shuts down stalled authentication I/O (even
                    // fragmented traffic), without a new timer/thread/poller.
                    loop {
                        let owns_ready = state
                            .ready
                            .as_ref()
                            .is_some_and(|ready| ready.expires == deadline);
                        let owns_active = state.active_deadline == Some(deadline);
                        if stopping.load(Ordering::Acquire) || (!owns_ready && !owns_active) {
                            if owns_active {
                                control.shutdown();
                                state.active = None;
                                state.active_deadline = None;
                            }
                            break;
                        }
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            if owns_ready {
                                state.ready = None;
                            }
                            if owns_active {
                                control.shutdown();
                                state.active = None;
                                state.active_deadline = None;
                            }
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
                let remaining = upgrade_deadline.saturating_duration_since(Instant::now());
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
    id: Instant,
    deadline: Option<Instant>,
    admission: Arc<Mutex<Admission>>,
    changed: Arc<Condvar>,
}
impl ListenerSocket {
    pub(super) fn authentication_deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// Only called after validating the controller's proof and sending ours.
    pub(super) fn authenticated(&mut self) -> Result<(), DurableRunnerError> {
        let mut state = self.admission.lock().unwrap();
        if state.active != Some(self.id)
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(DurableRunnerError::invalid(
                "listener authentication deadline elapsed",
            ));
        }
        self.deadline = None;
        state.active_deadline = None;
        self.changed.notify_all();
        Ok(())
    }
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
        let mut state = self.admission.lock().unwrap();
        // Expiry may already have closed this unauthenticated socket and
        // admitted another. A stale handle must not release its successor.
        if state.active == Some(self.id) {
            state.active = None;
            state.active_deadline = None;
        }
        self.changed.notify_all();
    }
}
