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
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;
    use std::ffi::OsStr;
    use std::fs;
    use std::io::{self, Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, BOOL, ERROR_INSUFFICIENT_BUFFER,
        ERROR_PIPE_CONNECTED, ERROR_SUCCESS, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, HANDLE,
        HLOCAL, INVALID_HANDLE_VALUE, TRUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, REVOKE_ACCESS, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        AllocateAndInitializeSid, CopySid, CreateRestrictedToken, CreateWellKnownSid, FreeSid,
        GetLengthSid, GetTokenInformation, InitializeSecurityDescriptor, LogonUserW,
        SetSecurityDescriptorDacl, SetTokenInformation, TokenDefaultDacl, TokenGroups, TokenUser,
        WinWorldSid, ACL, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE,
        LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, NO_INHERITANCE, PSID,
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SID_AND_ATTRIBUTES, SID_IDENTIFIER_AUTHORITY,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_QUERY,
        TOKEN_USER, WRITE_RESTRICTED,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
    };
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessWithLogonW, GetCurrentProcess, GetCurrentProcessId,
        GetExitCodeProcess, OpenProcessToken, ResumeThread, WaitForSingleObject,
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, INFINITE,
        PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

    static ACTIVE_JOB: AtomicIsize = AtomicIsize::new(0);

    unsafe extern "system" fn ctrl_handler(_ctrl_type: u32) -> BOOL {
        let job = ACTIVE_JOB.load(Ordering::SeqCst);
        if job != 0 {
            TerminateJobObject(job as HANDLE, 130);
        }
        TRUE
    }

    #[derive(Debug, Deserialize)]
    struct SandboxUserAccount {
        username: String,
        password: String,
        sid: String,
    }

    #[derive(Debug, Deserialize)]
    struct SandboxUsersFile {
        online: SandboxUserAccount,
        offline: SandboxUserAccount,
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
        credentials_path: String,
        #[serde(default)]
        control_pipe: Option<String>,
        #[serde(default)]
        report_pipe: Option<String>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct InnerConfig {
        command: String,
        args: Vec<String>,
        cwd: String,
        env: BTreeMap<String, String>,
        stdin_pipe: String,
        stdout_pipe: String,
        stderr_pipe: String,
    }

    pub fn run() -> Result<i32, String> {
        let mut args = std::env::args().skip(1);
        let first = args.next().ok_or_else(|| {
            "usage: win-sandbox --probe <creds> | --config <path> [--delete-config] | --inner <path>"
                .to_string()
        })?;

        if first == "--probe" {
            let creds_path = args
                .next()
                .ok_or_else(|| "--probe requires a credentials file path".to_string())?;
            return run_probe(&creds_path);
        }

        if first == "--inner" {
            let inner_path = args
                .next()
                .ok_or_else(|| "--inner requires a config file path".to_string())?;
            let raw = fs::read_to_string(&inner_path)
                .map_err(|e| format!("failed to read inner config {inner_path}: {e}"))?;
            let _ = fs::remove_file(&inner_path);
            let inner: InnerConfig =
                serde_json::from_str(&raw).map_err(|e| format!("invalid inner config: {e}"))?;
            return run_inner(inner);
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
        run_outer(config)
    }

    fn load_credentials(path: &str) -> Result<SandboxUsersFile, String> {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("failed to read sandbox credentials {path}: {e}"))?;
        let trimmed = raw.trim_start_matches('\u{feff}');
        serde_json::from_str(trimmed)
            .map_err(|e| format!("invalid sandbox credentials JSON {path}: {e}"))
    }

    fn run_probe(creds_path: &str) -> Result<i32, String> {
        let creds = load_credentials(creds_path)?;
        for account in [&creds.online, &creds.offline] {
            let user_w = to_wide(&account.username);
            let domain_w = to_wide(".");
            let pass_w = to_wide(&account.password);
            let mut token_raw: HANDLE = null_mut();
            let ok = unsafe {
                LogonUserW(
                    user_w.as_ptr(),
                    domain_w.as_ptr(),
                    pass_w.as_ptr(),
                    LOGON32_LOGON_INTERACTIVE,
                    LOGON32_PROVIDER_DEFAULT,
                    &mut token_raw,
                )
            };
            if ok == 0 {
                return Err(format!(
                    "LogonUserW({}) failed: {}",
                    account.username,
                    last_error()
                ));
            }
            drop(SafeHandle(token_raw));
        }
        let job = JobHandle::create()?;
        drop(job);
        Ok(0)
    }

    fn run_outer(config: SandboxConfig) -> Result<i32, String> {
        let creds = load_credentials(&config.credentials_path)?;
        let account = if config.allow_network {
            &creds.online
        } else {
            &creds.offline
        };

        let sandbox_sid = SidFromString::parse(&account.sid)?;
        let host_user_sid = query_current_user_sid()?;

        // Grant the sandbox user explicit RW/RO NTFS ACEs on declared roots, plus RO on our own
        // executable so CreateProcessWithLogonW can launch the --inner trampoline.
        let mut acl_grants = AclGrantGuard::new(sandbox_sid.sid);
        let rw_mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
        let ro_mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;

        let self_exe = std::env::current_exe()
            .map_err(|e| format!("current_exe failed: {e}"))?
            .to_string_lossy()
            .into_owned();
        acl_grants.grant(&self_exe, ro_mask, false)?;

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

        // Write inner config inside cwd (which is writable by sandbox user, or readable).
        let tag = unique_tag();
        let inner_config_path = Path::new(&config.cwd)
            .join(format!(".win-sandbox-inner-{tag}.json"))
            .to_string_lossy()
            .into_owned();

        let stdin_pipe = format!(r"\\.\pipe\agent-evals-stdin-{tag}");
        let stdout_pipe = format!(r"\\.\pipe\agent-evals-stdout-{tag}");
        let stderr_pipe = format!(r"\\.\pipe\agent-evals-stderr-{tag}");

        // Create 3 named pipe servers with DACL granting both host user and sandbox user access.
        let pipe_dacl = build_two_sid_dacl(host_user_sid.as_ptr() as PSID, sandbox_sid.sid)?;
        let stdin_srv = create_pipe_server(&stdin_pipe, PIPE_ACCESS_OUTBOUND, pipe_dacl.0)?;
        let stdout_srv = create_pipe_server(&stdout_pipe, PIPE_ACCESS_INBOUND, pipe_dacl.0)?;
        let stderr_srv = create_pipe_server(&stderr_pipe, PIPE_ACCESS_INBOUND, pipe_dacl.0)?;

        // Optional report pipe for check-runner: sandbox-accessible pipe bridged to host report_pipe.
        let mut child_env = config.env.clone();
        let mut sandbox_report_pipe: Option<String> = None;
        let mut report_thread: Option<thread::JoinHandle<()>> = None;
        if let Some(host_report_pipe) = config.report_pipe.clone() {
            let sbx_pipe = format!(r"\\.\pipe\agent-evals-report-{tag}");
            let report_srv = create_pipe_server(&sbx_pipe, PIPE_ACCESS_INBOUND, pipe_dacl.0)?;
            let report_raw = report_srv.into_raw() as usize;
            child_env.insert("AGENT_EVALS_REPORT_PIPE".to_string(), sbx_pipe.clone());
            sandbox_report_pipe = Some(sbx_pipe);
            report_thread = Some(thread::spawn(move || {
                let h = report_raw as HANDLE;
                if connect_pipe(h) {
                    let mut src = unsafe { fs::File::from_raw_handle(h as RawHandle) };
                    if let Ok(mut dst) = fs::OpenOptions::new().write(true).open(&host_report_pipe)
                    {
                        let mut buf = [0u8; 4096];
                        while let Ok(n) = src.read(&mut buf) {
                            if n == 0 {
                                break;
                            }
                            if dst.write_all(&buf[..n]).is_err() {
                                break;
                            }
                        }
                        let _ = dst.flush();
                    }
                } else {
                    unsafe { CloseHandle(h) };
                }
            }));
        }

        let inner_cfg = InnerConfig {
            command: config.command.clone(),
            args: config.args.clone(),
            cwd: config.cwd.clone(),
            env: child_env,
            stdin_pipe: stdin_pipe.clone(),
            stdout_pipe: stdout_pipe.clone(),
            stderr_pipe: stderr_pipe.clone(),
        };
        let inner_json = serde_json::to_string(&inner_cfg)
            .map_err(|e| format!("failed to serialize inner config: {e}"))?;
        fs::write(&inner_config_path, inner_json)
            .map_err(|e| format!("failed to write inner config {inner_config_path}: {e}"))?;
        acl_grants.grant(&inner_config_path, rw_mask, false)?;

        // Start stdio pump threads before launching trampoline so ConnectNamedPipe is ready.
        let stdin_raw = stdin_srv.into_raw() as usize;
        let stdout_raw = stdout_srv.into_raw() as usize;
        let stderr_raw = stderr_srv.into_raw() as usize;

        let stdout_thread = thread::spawn(move || {
            let h = stdout_raw as HANDLE;
            if connect_pipe(h) {
                let mut f = unsafe { fs::File::from_raw_handle(h as RawHandle) };
                let mut out = io::stdout().lock();
                let mut buf = [0u8; 8192];
                while let Ok(n) = f.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let _ = out.write_all(&buf[..n]);
                    let _ = out.flush();
                }
            } else {
                unsafe { CloseHandle(h) };
            }
        });

        let stderr_thread = thread::spawn(move || {
            let h = stderr_raw as HANDLE;
            if connect_pipe(h) {
                let mut f = unsafe { fs::File::from_raw_handle(h as RawHandle) };
                let mut err = io::stderr().lock();
                let mut buf = [0u8; 8192];
                while let Ok(n) = f.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let _ = err.write_all(&buf[..n]);
                    let _ = err.flush();
                }
            } else {
                unsafe { CloseHandle(h) };
            }
        });

        let _stdin_thread = thread::spawn(move || {
            let h = stdin_raw as HANDLE;
            if connect_pipe(h) {
                let mut f = unsafe { fs::File::from_raw_handle(h as RawHandle) };
                let mut inp = io::stdin().lock();
                let mut buf = [0u8; 8192];
                while let Ok(n) = inp.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if f.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            } else {
                unsafe { CloseHandle(h) };
            }
        });

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

        // Launch --inner trampoline as the dedicated sandbox user via CreateProcessWithLogonW
        // (works even when the host caller is a standard non-admin user!).
        let user_w = to_wide(&account.username);
        let domain_w = to_wide(".");
        let pass_w = to_wide(&account.password);
        let cmd_line = build_command_line(&self_exe, &["--inner".to_string(), inner_config_path.clone()]);
        let mut cmd_line_w = to_wide(&cmd_line);
        let cwd_w = to_wide(&config.cwd);

        let mut si: STARTUPINFOW = unsafe { zeroed() };
        si.cb = size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };

        let created = unsafe {
            CreateProcessWithLogonW(
                user_w.as_ptr(),
                domain_w.as_ptr(),
                pass_w.as_ptr(),
                0,
                null(),
                cmd_line_w.as_mut_ptr(),
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                null(),
                cwd_w.as_ptr(),
                &si,
                &mut pi,
            )
        };
        if created == 0 {
            let _ = fs::remove_file(&inner_config_path);
            ACTIVE_JOB.store(0, Ordering::SeqCst);
            return Err(format!(
                "CreateProcessWithLogonW(user={}) failed: {}",
                account.username,
                last_error()
            ));
        }

        let process_handle = SafeHandle(pi.hProcess);
        let thread_handle = SafeHandle(pi.hThread);

        let assigned = unsafe { AssignProcessToJobObject(job.0, process_handle.0) };
        if assigned == 0 {
            unsafe { TerminateJobObject(job.0, 1) };
            ACTIVE_JOB.store(0, Ordering::SeqCst);
            return Err(format!("AssignProcessToJobObject failed: {}", last_error()));
        }

        let resumed = unsafe { ResumeThread(thread_handle.0) };
        if resumed == u32::MAX {
            unsafe { TerminateJobObject(job.0, 1) };
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

        ACTIVE_JOB.store(0, Ordering::SeqCst);
        unsafe {
            TerminateJobObject(job.0, exit_code);
        }
        drop(thread_handle);
        drop(process_handle);
        drop(job);

        // Unblock stdout/stderr/report pump threads if the trampoline exited before connecting,
        // then drain all remaining output before exiting.
        let _ = open_pipe_client(&stdout_pipe, GENERIC_WRITE);
        let _ = open_pipe_client(&stderr_pipe, GENERIC_WRITE);
        if let Some(ref sbx_pipe) = sandbox_report_pipe {
            let _ = open_pipe_client(sbx_pipe, GENERIC_WRITE);
        }
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        if let Some(handle) = report_thread {
            let _ = handle.join();
        }
        let _ = fs::remove_file(&inner_config_path);
        drop(acl_grants);

        Ok(exit_code as i32)
    }

    fn run_inner(config: InnerConfig) -> Result<i32, String> {
        let stdin_h = open_pipe_client(&config.stdin_pipe, GENERIC_READ)?;
        let stdout_h = open_pipe_client(&config.stdout_pipe, GENERIC_WRITE)?;
        let stderr_h = open_pipe_client(&config.stderr_pipe, GENERIC_WRITE)?;

        let synth = SyntheticSid::create()?;
        let restricted = build_self_restricted_token(synth.sid)?;

        let cmd_line = build_command_line(&config.command, &config.args);
        let mut cmd_line_w = to_wide(&cmd_line);
        let cwd_w = to_wide(&config.cwd);
        let mut env_block = build_env_block(&config.env);

        let mut si: STARTUPINFOW = unsafe { zeroed() };
        si.cb = size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = stdin_h.0;
        si.hStdOutput = stdout_h.0;
        si.hStdError = stderr_h.0;

        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
        let flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;

        // Launching with a restricted version of our OWN token requires zero special privileges.
        let created = unsafe {
            CreateProcessAsUserW(
                restricted.0,
                null(),
                cmd_line_w.as_mut_ptr(),
                null(),
                null(),
                TRUE,
                flags,
                env_block.as_mut_ptr() as *const _,
                cwd_w.as_ptr(),
                &si,
                &mut pi,
            )
        };
        if created == 0 {
            let err = last_error();
            let msg = format!("win-sandbox inner CreateProcessAsUserW({}) failed: {err}\n", config.command);
            write_handle(stderr_h.0, msg.as_bytes());
            return Ok(125);
        }

        let process_handle = SafeHandle(pi.hProcess);
        let thread_handle = SafeHandle(pi.hThread);
        // Close our copies of the pipe handles so EOF propagates cleanly when the child exits.
        drop(stdin_h);
        drop(stdout_h);
        drop(stderr_h);

        let wait_result = unsafe { WaitForSingleObject(process_handle.0, INFINITE) };
        if wait_result != WAIT_OBJECT_0 {
            return Err(format!("inner WaitForSingleObject failed: {}", last_error()));
        }

        let mut exit_code: u32 = 1;
        unsafe {
            GetExitCodeProcess(process_handle.0, &mut exit_code);
        }
        drop(thread_handle);
        drop(process_handle);
        drop(restricted);
        drop(synth);
        Ok(exit_code as i32)
    }

    fn build_self_restricted_token(synthetic_sid: PSID) -> Result<SafeHandle, String> {
        let mut base_raw: HANDLE = null_mut();
        let desired = TOKEN_DUPLICATE
            | TOKEN_ASSIGN_PRIMARY
            | TOKEN_QUERY
            | TOKEN_ADJUST_DEFAULT
            | TOKEN_ADJUST_SESSIONID;
        let ok = unsafe { OpenProcessToken(GetCurrentProcess(), desired, &mut base_raw) };
        if ok == 0 {
            return Err(format!("OpenProcessToken failed: {}", last_error()));
        }
        let base_token = SafeHandle(base_raw);

        let user_sid_buf = query_user_sid_bytes(base_token.0)?;
        let user_sid = user_sid_buf.as_ptr() as PSID;
        let logon_sid_buf = query_logon_sid_bytes(base_token.0)?;
        let logon_sid = logon_sid_buf.as_ptr() as PSID;
        let world_sid = well_known_sid(WinWorldSid)?;

        let sids_to_restrict = [
            SID_AND_ATTRIBUTES {
                Sid: user_sid,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: synthetic_sid,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: logon_sid,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: world_sid.as_ptr() as PSID,
                Attributes: 0,
            },
        ];

        let mut restricted_raw: HANDLE = null_mut();
        let ok = unsafe {
            CreateRestrictedToken(
                base_token.0,
                DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
                0,
                null(),
                0,
                null(),
                sids_to_restrict.len() as u32,
                sids_to_restrict.as_ptr(),
                &mut restricted_raw,
            )
        };
        if ok == 0 {
            return Err(format!("CreateRestrictedToken failed: {}", last_error()));
        }
        let restricted = SafeHandle(restricted_raw);
        grant_default_dacl_sids(restricted.0, user_sid, logon_sid)?;
        Ok(restricted)
    }

    fn grant_default_dacl_sids(
        token: HANDLE,
        user_sid: PSID,
        logon_sid: PSID,
    ) -> Result<(), String> {
        let make_ea = |sid: PSID| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: SET_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let eas = [make_ea(user_sid), make_ea(logon_sid)];
        let mut new_dacl: *mut ACL = null_mut();
        let status =
            unsafe { SetEntriesInAclW(eas.len() as u32, eas.as_ptr(), null_mut(), &mut new_dacl) };
        if status != ERROR_SUCCESS {
            return Err(format!("SetEntriesInAclW(TokenDefaultDacl) error {status}"));
        }
        let _dacl_guard = LocalFreeGuard(new_dacl as HLOCAL);
        let td = TOKEN_DEFAULT_DACL {
            DefaultDacl: new_dacl,
        };
        let ok = unsafe {
            SetTokenInformation(
                token,
                TokenDefaultDacl,
                &td as *const _ as *const _,
                size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        };
        if ok == 0 {
            return Err(format!(
                "SetTokenInformation(TokenDefaultDacl) failed: {}",
                last_error()
            ));
        }
        Ok(())
    }

    struct OwnedDacl(*mut ACL);
    impl Drop for OwnedDacl {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0 as HLOCAL) };
            }
        }
    }

    fn build_two_sid_dacl(sid_a: PSID, sid_b: PSID) -> Result<OwnedDacl, String> {
        let make_ea = |sid: PSID| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: SET_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let eas = [make_ea(sid_a), make_ea(sid_b)];
        let mut dacl: *mut ACL = null_mut();
        let status =
            unsafe { SetEntriesInAclW(eas.len() as u32, eas.as_ptr(), null_mut(), &mut dacl) };
        if status != ERROR_SUCCESS {
            return Err(format!("SetEntriesInAclW(pipe) error {status}"));
        }
        Ok(OwnedDacl(dacl))
    }

    fn create_pipe_server(name: &str, open_mode: u32, dacl: *mut ACL) -> Result<SafeHandle, String> {
        let name_w = to_wide(name);
        let mut sd: SECURITY_DESCRIPTOR = unsafe { zeroed() };
        if unsafe { InitializeSecurityDescriptor(&mut sd as *mut _ as *mut _, SECURITY_DESCRIPTOR_REVISION) } == 0 {
            return Err(format!("InitializeSecurityDescriptor failed: {}", last_error()));
        }
        if unsafe { SetSecurityDescriptorDacl(&mut sd as *mut _ as *mut _, TRUE, dacl, 0) } == 0 {
            return Err(format!("SetSecurityDescriptorDacl failed: {}", last_error()));
        }
        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: &mut sd as *mut _ as *mut _,
            bInheritHandle: 0,
        };
        let h = unsafe {
            CreateNamedPipeW(
                name_w.as_ptr(),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                65536,
                65536,
                0,
                &sa,
            )
        };
        if h == INVALID_HANDLE_VALUE || h.is_null() {
            return Err(format!("CreateNamedPipeW({name}) failed: {}", last_error()));
        }
        Ok(SafeHandle(h))
    }

    fn connect_pipe(h: HANDLE) -> bool {
        let ok = unsafe { ConnectNamedPipe(h, null_mut()) };
        ok != 0 || last_error() == ERROR_PIPE_CONNECTED
    }

    fn open_pipe_client(name: &str, desired_access: u32) -> Result<SafeHandle, String> {
        let name_w = to_wide(name);
        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: TRUE,
        };
        let h = unsafe {
            CreateFileW(
                name_w.as_ptr(),
                desired_access,
                0,
                &sa,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE || h.is_null() {
            return Err(format!("CreateFileW({name}) failed: {}", last_error()));
        }
        Ok(SafeHandle(h))
    }

    fn write_handle(h: HANDLE, bytes: &[u8]) {
        use windows_sys::Win32::Storage::FileSystem::WriteFile;
        let mut written: u32 = 0;
        unsafe {
            WriteFile(h, bytes.as_ptr(), bytes.len() as u32, &mut written, null_mut());
        }
    }

    struct SidFromString {
        sid: PSID,
    }
    impl SidFromString {
        fn parse(s: &str) -> Result<Self, String> {
            let w = to_wide(s);
            let mut sid: PSID = null_mut();
            let ok = unsafe { ConvertStringSidToSidW(w.as_ptr(), &mut sid) };
            if ok == 0 {
                return Err(format!("ConvertStringSidToSidW({s}) failed: {}", last_error()));
            }
            Ok(Self { sid })
        }
    }
    impl Drop for SidFromString {
        fn drop(&mut self) {
            if !self.sid.is_null() {
                unsafe { LocalFree(self.sid as HLOCAL) };
            }
        }
    }

    fn query_current_user_sid() -> Result<Vec<u8>, String> {
        let mut token_raw: HANDLE = null_mut();
        let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_raw) };
        if ok == 0 {
            return Err(format!("OpenProcessToken(self) failed: {}", last_error()));
        }
        let token = SafeHandle(token_raw);
        query_user_sid_bytes(token.0)
    }

    fn query_user_sid_bytes(token: HANDLE) -> Result<Vec<u8>, String> {
        let mut len: u32 = 0;
        let ok = unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len) };
        if ok == 0 && last_error() != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "GetTokenInformation(TokenUser) sizing failed: {}",
                last_error()
            ));
        }
        let mut buf = vec![0u8; len as usize];
        let ok = unsafe {
            GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut _, len, &mut len)
        };
        if ok == 0 {
            return Err(format!(
                "GetTokenInformation(TokenUser) failed: {}",
                last_error()
            ));
        }
        let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
        let sid_len = unsafe { GetLengthSid(user.User.Sid) } as usize;
        let mut out = vec![0u8; sid_len];
        let copied = unsafe { CopySid(sid_len as u32, out.as_mut_ptr() as PSID, user.User.Sid) };
        if copied == 0 {
            return Err(format!("CopySid(TokenUser) failed: {}", last_error()));
        }
        Ok(out)
    }

    fn query_logon_sid_bytes(token: HANDLE) -> Result<Vec<u8>, String> {
        let mut len: u32 = 0;
        let ok = unsafe { GetTokenInformation(token, TokenGroups, null_mut(), 0, &mut len) };
        if ok == 0 && last_error() != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "GetTokenInformation(TokenGroups) sizing failed: {}",
                last_error()
            ));
        }
        let mut buf = vec![0u8; len as usize];
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenGroups,
                buf.as_mut_ptr() as *mut _,
                len,
                &mut len,
            )
        };
        if ok == 0 {
            return Err(format!(
                "GetTokenInformation(TokenGroups) failed: {}",
                last_error()
            ));
        }
        let groups = unsafe { &*(buf.as_ptr() as *const TOKEN_GROUPS) };
        let slice = unsafe {
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
        };
        for g in slice {
            if (g.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID {
                let sid_len = unsafe { GetLengthSid(g.Sid) } as usize;
                let mut out = vec![0u8; sid_len];
                let copied = unsafe { CopySid(sid_len as u32, out.as_mut_ptr() as PSID, g.Sid) };
                if copied != 0 {
                    return Ok(out);
                }
            }
        }
        Err("could not locate SE_GROUP_LOGON_ID in sandbox user token".to_string())
    }

    fn well_known_sid(sid_type: i32) -> Result<Vec<u8>, String> {
        let mut size: u32 = 68;
        let mut buf = vec![0u8; size as usize];
        let ok = unsafe {
            CreateWellKnownSid(sid_type, null_mut(), buf.as_mut_ptr() as PSID, &mut size)
        };
        if ok == 0 {
            return Err(format!(
                "CreateWellKnownSid({sid_type}) failed: {}",
                last_error()
            ));
        }
        buf.truncate(size as usize);
        Ok(buf)
    }

    fn unique_tag() -> String {
        let pid = unsafe { GetCurrentProcessId() };
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{pid}-{nanos}")
    }

    struct SyntheticSid {
        sid: PSID,
    }

    impl SyntheticSid {
        fn create() -> Result<Self, String> {
            let auth = SID_IDENTIFIER_AUTHORITY {
                Value: [0, 0, 0, 0, 0, 9],
            };
            let pid = unsafe { GetCurrentProcessId() };
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let hi = ((nanos >> 32) & 0xFFFF_FFFF) as u32;
            let lo = (nanos & 0xFFFF_FFFF) as u32;
            let mut sid: PSID = null_mut();
            let ok = unsafe {
                AllocateAndInitializeSid(&auth, 4, 1, pid, hi, lo, 0, 0, 0, 0, &mut sid)
            };
            if ok == 0 {
                return Err(format!("AllocateAndInitializeSid failed: {}", last_error()));
            }
            Ok(Self { sid })
        }
    }

    impl Drop for SyntheticSid {
        fn drop(&mut self) {
            if !self.sid.is_null() {
                unsafe { FreeSid(self.sid) };
            }
        }
    }

    struct SafeHandle(HANDLE);
    impl SafeHandle {
        fn into_raw(mut self) -> HANDLE {
            let h = self.0;
            self.0 = null_mut();
            h
        }
    }
    impl Drop for SafeHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
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
                unsafe { CloseHandle(h) };
                return Err(format!("SetInformationJobObject failed: {}", last_error()));
            }
            Ok(Self(h))
        }
    }
    impl Drop for JobHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
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
                unsafe { LocalFree(self.0) };
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
