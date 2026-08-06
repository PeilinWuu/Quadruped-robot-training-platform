use super::error::SimulationError;
use std::{
    path::Path,
    process::{Child, Command, Stdio},
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
pub struct JobObject(HANDLE);

#[cfg(windows)]
unsafe impl Send for JobObject {}
#[cfg(windows)]
unsafe impl Sync for JobObject {}

#[cfg(windows)]
impl JobObject {
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
impl Drop for JobObject {
    fn drop(&mut self) {
        // SAFETY: The wrapper uniquely owns the handle and closes it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(not(windows))]
#[derive(Debug)]
pub struct JobObject;

#[cfg(not(windows))]
impl JobObject {
    pub fn create() -> Result<Self, SimulationError> {
        Err(SimulationError::new(
            "UNSUPPORTED_PLATFORM",
            "The simulation sidecar currently requires Windows.",
        ))
    }
    pub fn assign(&self, _child: &Child) -> Result<(), SimulationError> {
        Err(SimulationError::internal())
    }
    pub fn terminate(&self) -> Result<(), SimulationError> {
        Err(SimulationError::internal())
    }
}

pub struct SpawnedSidecar {
    pub child: Child,
    pub job: JobObject,
}

pub fn spawn(path: &Path, resource_root: &Path) -> Result<SpawnedSidecar, SimulationError> {
    let job = JobObject::create()?;
    let mut command = Command::new(path);
    command
        .arg("--resource-root")
        .arg(resource_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|_| {
        SimulationError::new(
            "SIDECAR_SPAWN_FAILED",
            "The simulation sidecar could not be started.",
        )
    })?;
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(SpawnedSidecar { child, job })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn job_handle_has_raii_lifetime() {
        let job = JobObject::create().expect("job object");
        drop(job);
    }
}
