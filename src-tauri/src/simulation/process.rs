use super::error::SimulationError;
use std::{
    path::Path,
    process::{Child, Command, Stdio},
};

#[cfg(target_os = "linux")]
use std::{
    io,
    os::unix::process::CommandExt,
    sync::{
        atomic::{AtomicI32, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
};

#[cfg(windows)]
use std::{
    mem::{size_of, zeroed},
    os::windows::{io::AsRawHandle, process::CommandExt},
    ptr::null_mut,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::CREATE_NO_WINDOW,
    },
};

#[cfg(windows)]
#[derive(Debug)]
pub struct ProcessGuard(HANDLE);

#[cfg(windows)]
unsafe impl Send for ProcessGuard {}
#[cfg(windows)]
unsafe impl Sync for ProcessGuard {}

#[cfg(windows)]
impl ProcessGuard {
    pub fn create() -> Result<Self, SimulationError> {
        // SAFETY: A null name creates an unnamed job, and every returned handle is checked.
        let handle = unsafe { CreateJobObjectW(null_mut(), null_mut()) };
        if handle.is_null() {
            return Err(SimulationError::new(
                "JOB_CREATE_FAILED",
                "The protected simulation process could not be created.",
            ));
        }
        // SAFETY: The structure is plain Win32 data and is initialized before the API call.
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: handle is valid, and the pointer and size describe information for this call.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const information).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            // SAFETY: handle was successfully created and has not been closed.
            unsafe { CloseHandle(handle) };
            return Err(SimulationError::new(
                "JOB_CONFIGURE_FAILED",
                "The protected simulation process could not be configured.",
            ));
        }
        Ok(Self(handle))
    }

    pub fn assign(&self, child: &Child) -> Result<(), SimulationError> {
        let process_handle = child.as_raw_handle() as HANDLE;
        // SAFETY: Both handles are live for the duration of this call.
        if unsafe { AssignProcessToJobObject(self.0, process_handle) } == 0 {
            return Err(SimulationError::new(
                "JOB_ASSIGN_FAILED",
                "The simulation process could not be placed in its protection boundary.",
            ));
        }
        Ok(())
    }

    pub fn terminate(&self) -> Result<(), SimulationError> {
        // SAFETY: self owns a live job handle.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(SimulationError::new(
                "JOB_TERMINATE_FAILED",
                "The simulation process could not be terminated.",
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        // SAFETY: The wrapper uniquely owns the handle and closes it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct ProcessGuard(AtomicI32);

#[cfg(target_os = "linux")]
impl ProcessGuard {
    pub fn create() -> Result<Self, SimulationError> {
        Ok(Self(AtomicI32::new(0)))
    }
    pub fn assign(&self, child: &Child) -> Result<(), SimulationError> {
        self.0.store(child.id() as i32, Ordering::Release);
        Ok(())
    }
    pub fn terminate(&self) -> Result<(), SimulationError> {
        let pid = self.0.load(Ordering::Acquire);
        if pid <= 0 {
            return Ok(());
        }
        // SAFETY: pid is the exact child identifier returned by std::process::Child.
        if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(SimulationError::new(
                "PROCESS_TERMINATE_FAILED",
                "The simulation process could not be terminated.",
            ))
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("The desktop simulation sidecar supports Windows and Linux only");

pub struct SpawnedSidecar {
    pub child: Child,
    pub guard: ProcessGuard,
    #[cfg(target_os = "linux")]
    pub parent_keeper: ParentKeeper,
}

struct SpawnedProcess {
    child: Child,
    guard: ProcessGuard,
}

#[cfg(target_os = "linux")]
pub struct ParentKeeper {
    release: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(target_os = "linux")]
impl Drop for ParentKeeper {
    fn drop(&mut self) {
        self.release.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(target_os = "linux")]
fn configure_parent_death_signal(command: &mut Command) {
    let expected_parent = std::process::id() as libc::pid_t;
    // SAFETY: pre_exec performs only async-signal-safe libc calls before exec.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != expected_parent {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "desktop parent exited before sidecar exec",
                ));
            }
            Ok(())
        });
    }
}

pub fn spawn(path: &Path, resource_root: &Path) -> Result<SpawnedSidecar, SimulationError> {
    let mut command = Command::new(path);
    command
        .arg("--resource-root")
        .arg(resource_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(not(all(target_os = "linux", debug_assertions)))]
    command
        .env_remove("D6_NATIVE_MUJOCO_VIEWER_POC")
        .env_remove("D6_NATIVE_MUJOCO_VIEWER_FPS");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(target_os = "linux")]
    return spawn_with_parent_keeper(command);
    #[cfg(windows)]
    spawn_direct(command).map(|spawned| SpawnedSidecar {
        child: spawned.child,
        guard: spawned.guard,
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn spawn_guarded(command: Command) -> Result<SpawnedSidecar, SimulationError> {
    spawn_with_parent_keeper(command)
}

fn spawn_direct(mut command: Command) -> Result<SpawnedProcess, SimulationError> {
    let guard = ProcessGuard::create()?;
    let mut child = command.spawn().map_err(|_| {
        SimulationError::new(
            "SIDECAR_SPAWN_FAILED",
            "The simulation sidecar could not be started.",
        )
    })?;
    if let Err(error) = guard.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(SpawnedProcess { child, guard })
}

#[cfg(target_os = "linux")]
fn spawn_with_parent_keeper(command: Command) -> Result<SpawnedSidecar, SimulationError> {
    let (spawned_tx, spawned_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::channel();
    let keeper_thread = thread::Builder::new()
        .name("sidecar-parent-keeper".into())
        .spawn(move || {
            let mut command = command;
            configure_parent_death_signal(&mut command);
            let result = spawn_direct(command);
            let _ = spawned_tx.send(result);
            let _ = release_rx.recv();
        })
        .map_err(|_| SimulationError::internal())?;
    match spawned_rx.recv() {
        Ok(Ok(spawned)) => Ok(SpawnedSidecar {
            child: spawned.child,
            guard: spawned.guard,
            parent_keeper: ParentKeeper {
                release: Some(release_tx),
                thread: Some(keeper_thread),
            },
        }),
        Ok(Err(error)) => {
            drop(release_tx);
            let _ = keeper_thread.join();
            Err(error)
        }
        Err(_) => {
            drop(release_tx);
            let _ = keeper_thread.join();
            Err(SimulationError::internal())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::os::unix::process::ExitStatusExt as _;

    #[test]
    fn native_viewer_poc_is_compile_time_limited_to_linux_debug() {
        assert_eq!(
            cfg!(all(target_os = "linux", debug_assertions)),
            cfg!(target_os = "linux") && cfg!(debug_assertions)
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn parent_death_helper() {
        if std::env::var_os("SIDECAR_PDEATHSIG_HELPER").is_none() {
            return;
        }
        use std::io::Write as _;
        let mut command = Command::new("sleep");
        command.arg("30").stdin(Stdio::null()).stderr(Stdio::null());
        configure_parent_death_signal(&mut command);
        let child = command.spawn().expect("spawn protected child");
        println!("PDEATHSIG_PID={}", child.id());
        std::io::stdout().flush().expect("flush child pid");
        drop(child);
        // SAFETY: This dedicated helper intentionally simulates an abrupt desktop exit.
        unsafe { libc::_exit(0) }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn parent_death_signal_prevents_permanent_orphan() {
        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "simulation::process::tests::parent_death_helper",
                "--nocapture",
            ])
            .env("SIDECAR_PDEATHSIG_HELPER", "1")
            .output()
            .expect("run abrupt parent helper");
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).expect("utf8 helper output");
        let pid = stdout
            .lines()
            .find_map(|line| line.strip_prefix("PDEATHSIG_PID="))
            .expect("protected child pid")
            .parse::<libc::pid_t>()
            .expect("numeric child pid");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            // SAFETY: signal 0 only checks whether the reported process still exists.
            if unsafe { libc::kill(pid, 0) } != 0
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("protected child remained after its parent exited");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn dedicated_parent_keeper_survives_transient_calling_thread() {
        let calling_thread = std::thread::spawn(|| {
            let mut command = Command::new("sleep");
            command
                .arg("30")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            spawn_with_parent_keeper(command).expect("spawn protected child")
        });
        let mut spawned = calling_thread.join().expect("transient calling thread");
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            spawned
                .child
                .try_wait()
                .expect("query protected child")
                .is_none(),
            "the child must outlive the transient thread that requested the spawn"
        );
        spawned.guard.terminate().expect("terminate test child");
        let status = spawned.child.wait().expect("reap test child");
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    #[test]
    #[cfg(windows)]
    fn job_handle_has_raii_lifetime() {
        let guard = ProcessGuard::create().expect("job object");
        drop(guard);
    }
}
