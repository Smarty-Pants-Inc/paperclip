//! Test-only paused clock for the connected loop's inbound liveness window.
//!
//! The runner transport is blocking std I/O, so tokio's paused time does not
//! apply. A test installs a `VirtualClock` on the thread that owns the runner
//! transport; a controller thread holding the same `Arc` moves it forward.
//! The clock never advances by itself, so minutes of protocol time take
//! milliseconds of wall time, and threads without a clock keep real time.
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) struct VirtualClock {
    origin: Instant,
    elapsed_ms: AtomicU64,
}

impl VirtualClock {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            origin: Instant::now(),
            elapsed_ms: AtomicU64::new(0),
        })
    }

    pub(crate) fn now(&self) -> Instant {
        self.origin + self.elapsed()
    }

    pub(crate) fn elapsed(&self) -> Duration {
        Duration::from_millis(self.elapsed_ms.load(Ordering::SeqCst))
    }

    /// Move virtual time to `elapsed` since installation. Never moves back.
    pub(crate) fn set(&self, elapsed: Duration) {
        let millis = u64::try_from(elapsed.as_millis()).unwrap();
        self.elapsed_ms.fetch_max(millis, Ordering::SeqCst);
    }

    /// Paused time is installed per thread, so parallel tests never share it.
    pub(crate) fn install(self: &Arc<Self>) {
        INSTALLED.with(|installed| *installed.borrow_mut() = Some(self.clone()));
    }
}

thread_local! {
    static INSTALLED: RefCell<Option<Arc<VirtualClock>>> = const { RefCell::new(None) };
}

/// The liveness clock: virtual on a thread that installed one, else real.
#[allow(dead_code)]
pub(crate) fn now() -> Instant {
    INSTALLED.with(|installed| {
        installed
            .borrow()
            .as_ref()
            .map_or_else(Instant::now, |clock| clock.now())
    })
}
