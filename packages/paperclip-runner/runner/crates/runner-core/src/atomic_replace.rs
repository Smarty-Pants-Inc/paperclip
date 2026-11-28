//! Atomic replacement when a restoring filesystem temporarily rejects rename.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};

const EXDEV_RETRY_BUDGET: Duration = Duration::from_secs(60);
const INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_secs(2);

/// Rename an already-written temporary file over its same-directory target.
///
/// On Unix EXDEV only, retain the bytes and permissions, unlink the temporary
/// file, then recreate and fsync it after each wait. Reusing the pathname keeps
/// caller cleanup unchanged; `create_new` ensures a fresh file, not the inode
/// created while the directory was restoring. Publication is always rename,
/// never a copy into the target. Callers still own any parent-directory fsync.
pub fn rename_replace_retrying_exdev(temporary: &Path, target: &Path) -> io::Result<()> {
    let started = Instant::now();
    rename_replace_retrying_exdev_with(
        temporary,
        target,
        |source, destination| fs::rename(source, destination),
        std::thread::sleep,
        || started.elapsed(),
    )
}

fn is_exdev(error: &io::Error) -> bool {
    // Windows error 18 is not EXDEV.
    cfg!(unix) && error.raw_os_error() == Some(18)
}

fn rename_replace_retrying_exdev_with(
    temporary: &Path,
    target: &Path,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
    mut sleep: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
) -> io::Result<()> {
    let original_error = match rename(temporary, target) {
        Err(error) if is_exdev(&error) => error,
        result => return result,
    };
    let saved = (|| -> io::Result<_> {
        Ok((fs::read(temporary)?, fs::metadata(temporary)?.permissions()))
    })();
    fs::remove_file(temporary)?;
    let (bytes, permissions) = saved?;
    let mut backoff = INITIAL_BACKOFF;
    loop {
        let remaining = EXDEV_RETRY_BUDGET.saturating_sub(elapsed());
        if remaining.is_zero() {
            return Err(original_error);
        }
        sleep(backoff.min(remaining));
        backoff = (backoff * 2).min(MAX_BACKOFF);
        if elapsed() >= EXDEV_RETRY_BUDGET {
            return Err(original_error);
        }

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(permissions.mode());
        }
        // Do not clean up a pathname we failed to create (e.g. a collision).
        let mut file = options.open(temporary)?;
        let result = (|| {
            file.set_permissions(permissions.clone())?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            rename(temporary, target)
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                let cleanup = fs::remove_file(temporary);
                if !is_exdev(&error) {
                    return Err(error);
                }
                cleanup?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fixture {
        directory: std::path::PathBuf,
        temporary: std::path::PathBuf,
        target: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "runner-atomic-replace-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&directory).unwrap();
            let temporary = directory.join("state.tmp");
            let target = directory.join("state.json");
            fs::write(&temporary, b"replacement bytes").unwrap();
            fs::write(&target, b"old bytes").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).unwrap();
            }
            Self {
                directory,
                temporary,
                target,
            }
        }

        fn assert_no_temporary(&self) {
            assert!(!self.temporary.exists());
            assert_eq!(fs::read_dir(&self.directory).unwrap().count(), 1);
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    // Injected EXDEV and a fake clock exercise real temporary files and rename
    // without needing a filesystem that is still being restored.
    #[cfg(unix)]
    #[test]
    fn exdev_twice_then_succeeds_with_original_bytes_and_no_temporary() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let elapsed = Cell::new(Duration::ZERO);
        let mut attempts = 0;
        let mut waits = Vec::new();
        rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            |temporary, target| {
                attempts += 1;
                assert_eq!(fs::read(temporary).unwrap(), b"replacement bytes");
                assert_eq!(fs::read(target).unwrap(), b"old bytes");
                assert_eq!(
                    fs::metadata(temporary).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                if attempts <= 2 {
                    Err(io::Error::from_raw_os_error(18))
                } else {
                    fs::rename(temporary, target)
                }
            },
            |wait| {
                assert!(!fixture.temporary.exists());
                waits.push(wait);
                elapsed.set(elapsed.get() + wait);
            },
            || elapsed.get(),
        )
        .unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(
            waits,
            [Duration::from_millis(100), Duration::from_millis(200)]
        );
        assert_eq!(fs::read(&fixture.target).unwrap(), b"replacement bytes");
        fixture.assert_no_temporary();
    }

    #[cfg(unix)]
    #[test]
    fn persistent_exdev_returns_original_error_at_budget_with_no_temporary() {
        let fixture = Fixture::new();
        let elapsed = Cell::new(Duration::ZERO);
        let original = io::Error::from_raw_os_error(18);
        let expected = (
            original.raw_os_error(),
            original.kind(),
            original.to_string(),
        );
        let mut first = Some(original);
        let mut attempts = 0;
        let error = rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            |temporary, _| {
                attempts += 1;
                assert_eq!(fs::read(temporary).unwrap(), b"replacement bytes");
                Err(first
                    .take()
                    .unwrap_or_else(|| io::Error::from_raw_os_error(18)))
            },
            |wait| {
                assert!(!fixture.temporary.exists());
                assert!(wait <= MAX_BACKOFF);
                elapsed.set(elapsed.get() + wait);
            },
            || elapsed.get(),
        )
        .unwrap_err();
        assert_eq!(
            (error.raw_os_error(), error.kind(), error.to_string()),
            expected
        );
        assert_eq!(elapsed.get(), EXDEV_RETRY_BUDGET);
        assert_eq!(attempts, 34);
        assert_eq!(fs::read(&fixture.target).unwrap(), b"old bytes");
        fixture.assert_no_temporary();
    }

    #[test]
    fn non_exdev_is_not_retried_or_changed() {
        let fixture = Fixture::new();
        let error = rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            |_, _| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "original denial",
                ))
            },
            |_| panic!("non-EXDEV must not wait"),
            || panic!("non-EXDEV must not consult the retry clock"),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), "original denial");
        // The fast path preserves the caller's existing cleanup ownership.
        assert_eq!(fs::read(&fixture.temporary).unwrap(), b"replacement bytes");
        assert_eq!(fs::read(&fixture.target).unwrap(), b"old bytes");
    }
}
