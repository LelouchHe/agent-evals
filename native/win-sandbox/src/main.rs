#[cfg(not(windows))]
fn main() {
    eprintln!("win-sandbox is only supported on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    match windows_impl::run() {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("win-sandbox: {err}");
            std::process::exit(125);
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use serde::Deserialize;
    use std::collections::BTreeMap;
    use std::ffi::OsStr;
    use std::fs;
    use std::io::Read;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, BOOL, ERROR_SUCCESS, HANDLE, HLOCAL,
        INVALID_HANDLE_VALUE, S_OK, TRUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        REVOKE_ACCESS, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, FreeSid, WinCapabilityInternetClientSid, ACL,
        DACL_SECURITY_INFORMATION, NO_INHERITANCE, PSID, SECURITY_CAPABILITIES,
        SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, SetConsoleCtrlHandler, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcessId, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
        WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES,
        STARTUPINFOEXW,
    };

    const HRESULT_ALREADY_EXISTS: i32 = 0x8007_00B7u32 as i32;
    const SE_GROUP_ENABLED: u32 = 0x0000_0004;

    static ACTIVE_JOB: AtomicIsize = AtomicIsize::new(0);

    unsafe extern "system" fn ctrl_handler(_ctrl_type: u32) -> BOOL {
        let job = ACTIVE_JOB.load(Ordering::SeqCst);
        if job != 0 {
            TerminateJobObject(job as HANDLE, 130);
        }
        TRUE
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SandboxConfig {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        writable_roots: Vec<String>,
        #[serde(default)]
        readable_roots: Vec<String>,
        #[serde(default)]
        writable_files: Vec<String>,
        #[serde(default)]
        readable_files: Vec<String>,
        #[serde(default)]
        allow_network: bool,
        #[serde(default)]
        control_pipe: Option<String>,
    }

    pub fn run() -> Result<i32, String> {
        let mut args = std::env::args().skip(1);
        let first = args
            .next()
            .ok_or_else(|| "usage: win-sandbox --probe | --config <path> [--delete-config]".to_string())?;

        if first == "--probe" {
            return run_probe();
        }

        if first != "--config" {
            return Err(format!("unknown argument: {first}"));
        }

        let config_path = args
            .next()
            .ok_or_else(|| "--config requires a file path".to_string())?;
        let mut delete_config = false;
        for extra in args {
            if extra == "--delete-config" {
                delete_config = true;
            } else {
                return Err(format!("unknown argument: {extra}"));
            }
        }

        let raw = fs::read_to_string(&config_path)
            .map_err(|e| format!("failed to read config {config_path}: {e}"))?;
        if delete_config {
            let _ = fs::remove_file(&config_path);
        }

        let config: SandboxConfig =
            serde_json::from_str(&raw).map_err(|e| format!("invalid config JSON: {e}"))?;
        run_sandboxed(config)
    }

    fn run_probe() -> Result<i32, String> {
        let profile = AppContainerProfile::create("probe")?;
        let job = JobHandle::create()?;
        drop(job);
        drop(profile);
        Ok(0)
    }

    fn run_sandboxed(config: SandboxConfig) -> Result<i32, String> {
        let profile = AppContainerProfile::create("run")?;
        let mut acl_grants = AclGrantGuard::new(profile.sid);

        let rw_mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
        let ro_mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;

        for dir in &config.readable_roots {
            if Path::new(dir).exists() {
                acl_grants.grant(dir, ro_mask, true)?;
            }
        }
        for file in &config.readable_files {
            if Path::new(file).exists() {
                acl_grants.grant(file, ro_mask, false)?;
            }
        }
        for dir in &config.writable_roots {
            if Path::new(dir).exists() {
                acl_grants.grant(dir, rw_mask, true)?;
            }
        }
        for file in &config.writable_files {
            if Path::new(file).exists() {
                acl_grants.grant(file, rw_mask, false)?;
            }
        }

        // Prepare capabilities
        let mut cap_sid_buf: Vec<u8> = Vec::new();
        let mut cap_attrs: Vec<SID_AND_ATTRIBUTES> = Vec::new();
        if config.allow_network {
            let mut sid_size: u32 = 68;
            cap_sid_buf.resize(sid_size as usize, 0);
            let ok = unsafe {
                CreateWellKnownSid(
                    WinCapabilityInternetClientSid,
                    null_mut(),
                    cap_sid_buf.as_mut_ptr() as PSID,
                    &mut sid_size,
                )
            };
            if ok == 0 {
                return Err(format!(
                    "CreateWellKnownSid(InternetClient) failed: {}",
                    last_error()
                ));
            }
            cap_attrs.push(SID_AND_ATTRIBUTES {
                Sid: cap_sid_buf.as_mut_ptr() as PSID,
                Attributes: SE_GROUP_ENABLED,
            });
        }

        let mut sec_caps = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            Capabilities: if cap_attrs.is_empty() {
                null_mut()
            } else {
                cap_attrs.as_mut_ptr()
            },
            CapabilityCount: cap_attrs.len() as u32,
            Reserved: 0,
        };

        // Initialize proc thread attribute list
        let mut attr_size: usize = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_size);
        }
        if attr_size == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList sizing failed: {}",
                last_error()
            ));
        }
        let mut attr_buf = vec![0usize; (attr_size + size_of::<usize>() - 1) / size_of::<usize>()];
        let attr_list = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        let ok = unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) };
        if ok == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList failed: {}",
                last_error()
            ));
        }
        let _attr_guard = AttrListGuard(attr_list);

        let ok = unsafe {
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &mut sec_caps as *mut SECURITY_CAPABILITIES as *const _,
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!("UpdateProcThreadAttribute failed: {}", last_error()));
        }

        let job = JobHandle::create()?;
        ACTIVE_JOB.store(job.0 as isize, Ordering::SeqCst);
        unsafe {
            SetConsoleCtrlHandler(Some(ctrl_handler), TRUE);
        }

        if let Some(pipe_path) = config.control_pipe.clone() {
            thread::spawn(move || {
                if let Ok(mut file) = fs::File::open(&pipe_path) {
                    let mut buf = [0u8; 16];
                    let _ = file.read(&mut buf);
                    let active = ACTIVE_JOB.load(Ordering::SeqCst);
                    if active != 0 {
                        unsafe {
                            TerminateJobObject(active as HANDLE, 130);
                        }
                    }
                }
            });
        }

        // Build command line, cwd, and environment
        let cmd_line = build_command_line(&config.command, &config.args);
        let mut cmd_line_w = to_wide(&cmd_line);
        let cwd_w = to_wide(&config.cwd);
        let mut env_block = build_env_block(&config.env);

        let mut si: STARTUPINFOEXW = unsafe { zeroed() };
        si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        si.StartupInfo.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        si.StartupInfo.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        si.lpAttributeList = attr_list;

        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
        let flags = CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;

        let created = unsafe {
            CreateProcessW(
                null(),
                cmd_line_w.as_mut_ptr(),
                null(),
                null(),
                TRUE,
                flags,
                env_block.as_mut_ptr() as *const _,
                cwd_w.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            )
        };
        if created == 0 {
            ACTIVE_JOB.store(0, Ordering::SeqCst);
            return Err(format!(
                "CreateProcessW({}) failed: {}",
                config.command,
                last_error()
            ));
        }

        let process_handle = SafeHandle(pi.hProcess);
        let thread_handle = SafeHandle(pi.hThread);

        let assigned = unsafe { AssignProcessToJobObject(job.0, process_handle.0) };
        if assigned == 0 {
            unsafe {
                TerminateJobObject(job.0, 1);
            }
            ACTIVE_JOB.store(0, Ordering::SeqCst);
            return Err(format!("AssignProcessToJobObject failed: {}", last_error()));
        }

        let resumed = unsafe { ResumeThread(thread_handle.0) };
        if resumed == u32::MAX {
            unsafe {
                TerminateJobObject(job.0, 1);
            }
            ACTIVE_JOB.store(0, Ordering::SeqCst);
            return Err(format!("ResumeThread failed: {}", last_error()));
        }

        let wait_result = unsafe { WaitForSingleObject(process_handle.0, INFINITE) };
        if wait_result != WAIT_OBJECT_0 {
            return Err(format!("WaitForSingleObject failed: {}", last_error()));
        }

        let mut exit_code: u32 = 1;
        unsafe {
            GetExitCodeProcess(process_handle.0, &mut exit_code);
        }

        // Terminate any remaining descendants in the job object before cleaning up ACLs
        ACTIVE_JOB.store(0, Ordering::SeqCst);
        unsafe {
            TerminateJobObject(job.0, exit_code);
        }
        drop(thread_handle);
        drop(process_handle);
        drop(job);
        drop(acl_grants);
        drop(profile);

        Ok(exit_code as i32)
    }

    struct SafeHandle(HANDLE);
    impl Drop for SafeHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct AttrListGuard(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for AttrListGuard {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0);
            }
        }
    }

    struct JobHandle(HANDLE);
    impl JobHandle {
        fn create() -> Result<Self, String> {
            let h = unsafe { CreateJobObjectW(null(), null()) };
            if h.is_null() {
                return Err(format!("CreateJobObjectW failed: {}", last_error()));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                unsafe {
                    CloseHandle(h);
                }
                return Err(format!("SetInformationJobObject failed: {}", last_error()));
            }
            Ok(Self(h))
        }
    }
    impl Drop for JobHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct AppContainerProfile {
        name_w: Vec<u16>,
        sid: PSID,
    }

    impl AppContainerProfile {
        fn create(tag: &str) -> Result<Self, String> {
            let pid = unsafe { GetCurrentProcessId() };
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let name = format!("agent-evals.{tag}.{pid}.{nanos}");
            let name_w = to_wide(&name);
            let display_w = to_wide("Agent Evals Sandbox");
            let desc_w = to_wide("Ephemeral sandbox profile for @lelouchhe/agent-evals");

            let mut sid: PSID = null_mut();
            let hr = unsafe {
                CreateAppContainerProfile(
                    name_w.as_ptr(),
                    display_w.as_ptr(),
                    desc_w.as_ptr(),
                    null(),
                    0,
                    &mut sid,
                )
            };
            if hr == HRESULT_ALREADY_EXISTS {
                let hr2 = unsafe {
                    DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid)
                };
                if hr2 != S_OK {
                    return Err(format!(
                        "DeriveAppContainerSidFromAppContainerName failed: 0x{:08x}",
                        hr2 as u32
                    ));
                }
            } else if hr != S_OK {
                return Err(format!(
                    "CreateAppContainerProfile failed: 0x{:08x}",
                    hr as u32
                ));
            }
            Ok(Self { name_w, sid })
        }
    }

    impl Drop for AppContainerProfile {
        fn drop(&mut self) {
            unsafe {
                if !self.sid.is_null() {
                    FreeSid(self.sid);
                }
                DeleteAppContainerProfile(self.name_w.as_ptr());
            }
        }
    }

    struct AclGrantGuard {
        sid: PSID,
        granted: Vec<Vec<u16>>,
    }

    impl AclGrantGuard {
        fn new(sid: PSID) -> Self {
            Self {
                sid,
                granted: Vec::new(),
            }
        }

        fn grant(&mut self, path: &str, access_mask: u32, inherit: bool) -> Result<(), String> {
            let path_w = to_wide(path);
            let inheritance = if inherit {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            };
            apply_ace(&path_w, self.sid, access_mask, SET_ACCESS, inheritance)
                .map_err(|e| format!("failed to grant ACL on {path}: {e}"))?;
            self.granted.push(path_w);
            Ok(())
        }
    }

    impl Drop for AclGrantGuard {
        fn drop(&mut self) {
            for path_w in self.granted.iter().rev() {
                let _ = apply_ace(path_w, self.sid, 0, REVOKE_ACCESS, NO_INHERITANCE);
            }
        }
    }

    fn apply_ace(
        path_w: &[u16],
        sid: PSID,
        access_mask: u32,
        access_mode: i32,
        inheritance: u32,
    ) -> Result<(), String> {
        let mut old_dacl: *mut ACL = null_mut();
        let mut sd: *mut core::ffi::c_void = null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                path_w.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut sd,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("GetNamedSecurityInfoW error {status}"));
        }
        let _sd_guard = LocalFreeGuard(sd as HLOCAL);

        let ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access_mask,
            grfAccessMode: access_mode,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };

        let mut new_dacl: *mut ACL = null_mut();
        let status = unsafe { SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl) };
        if status != ERROR_SUCCESS {
            return Err(format!("SetEntriesInAclW error {status}"));
        }
        let _dacl_guard = LocalFreeGuard(new_dacl as HLOCAL);

        let status = unsafe {
            SetNamedSecurityInfoW(
                path_w.as_ptr() as *mut u16,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("SetNamedSecurityInfoW error {status}"));
        }
        Ok(())
    }

    struct LocalFreeGuard(HLOCAL);
    impl Drop for LocalFreeGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn last_error() -> u32 {
        unsafe { GetLastError() }
    }

    fn build_env_block(env: &BTreeMap<String, String>) -> Vec<u16> {
        let mut entries: Vec<(&String, &String)> = env
            .iter()
            .filter(|(k, v)| !k.contains('\0') && !k.contains('=') && !v.contains('\0'))
            .collect();
        // Win32 CreateProcessW requires environment blocks to be sorted case-insensitively.
        entries.sort_by(|(a, _), (b, _)| a.to_uppercase().cmp(&b.to_uppercase()));
        let mut block = Vec::new();
        for (k, v) in entries {
            let entry = format!("{k}={v}");
            block.extend(OsStr::new(&entry).encode_wide());
            block.push(0);
        }
        if block.is_empty() {
            block.push(0);
        }
        block.push(0);
        block
    }

    fn build_command_line(command: &str, args: &[String]) -> String {
        let mut parts = Vec::with_capacity(1 + args.len());
        parts.push(quote_win_arg(command));
        for arg in args {
            parts.push(quote_win_arg(arg));
        }
        parts.join(" ")
    }

    fn quote_win_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
            return arg.to_string();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0usize;
        for ch in arg.chars() {
            if ch == '\\' {
                backslashes += 1;
            } else if ch == '"' {
                for _ in 0..(backslashes * 2 + 1) {
                    out.push('\\');
                }
                out.push('"');
                backslashes = 0;
            } else {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(ch);
            }
        }
        for _ in 0..(backslashes * 2) {
            out.push('\\');
        }
        out.push('"');
        out
    }
}
