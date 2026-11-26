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
        CloseHandle, GetLastError, LocalFree, BOOL, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS,
        GENERIC_ALL, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, TRUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        REVOKE_ACCESS, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        AllocateAndInitializeSid, CopySid, CreateRestrictedToken, CreateWellKnownSid, FreeSid,
        GetLengthSid, GetTokenInformation, LogonUserW, SetTokenInformation, TokenDefaultDacl,
        TokenGroups, TokenUser, WinWorldSid, ACL, DACL_SECURITY_INFORMATION,
        DISABLE_MAX_PRIVILEGE, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, NO_INHERITANCE,
        PSID, SID_AND_ATTRIBUTES, SID_IDENTIFIER_AUTHORITY, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        TOKEN_DEFAULT_DACL, TOKEN_GROUPS, TOKEN_USER, WRITE_RESTRICTED,
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
        CreateProcessWithTokenW, GetCurrentProcessId, GetExitCodeProcess, ResumeThread,
        WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, INFINITE,
        PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

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
    }

    pub fn run() -> Result<i32, String> {
        let mut args = std::env::args().skip(1);
        let first = args.next().ok_or_else(|| {
            "usage: win-sandbox --probe <credentials-path> | --config <path> [--delete-config]"
                .to_string()
        })?;

        if first == "--probe" {
            let creds_path = args
                .next()
                .ok_or_else(|| "--probe requires a credentials file path".to_string())?;
            return run_probe(&creds_path);
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

    fn load_credentials(path: &str) -> Result<SandboxUsersFile, String> {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("failed to read sandbox credentials {path}: {e}"))?;
        let trimmed = raw.trim_start_matches('\u{feff}');
        serde_json::from_str(trimmed)
            .map_err(|e| format!("invalid sandbox credentials JSON {path}: {e}"))
    }

    fn run_probe(creds_path: &str) -> Result<i32, String> {
        let creds = load_credentials(creds_path)?;
        let synth = SyntheticSid::create()?;
        for account in [&creds.online, &creds.offline] {
            let (token, _user_sid) = build_sandbox_user_token(account, synth.sid)?;
            drop(token);
        }
        let job = JobHandle::create()?;
        drop(job);
        drop(synth);
        Ok(0)
    }

    fn run_sandboxed(config: SandboxConfig) -> Result<i32, String> {
        let creds = load_credentials(&config.credentials_path)?;
        let account = if config.allow_network {
            &creds.online
        } else {
            &creds.offline
        };

        let synth = SyntheticSid::create()?;
        let (restricted_token, user_sid_buf) = build_sandbox_user_token(account, synth.sid)?;
        let user_sid = user_sid_buf.as_ptr() as PSID;

        // Grant the dedicated sandbox user SID (which is present in both TokenUser and
        // SidsToRestrict) explicit RW/RO NTFS ACEs on declared roots, and revoke on exit.
        let mut acl_grants = AclGrantGuard::new(user_sid);

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

        let cmd_line = build_command_line(&config.command, &config.args);
        let mut cmd_line_w = to_wide(&cmd_line);
        let cwd_w = to_wide(&config.cwd);
        let mut env_block = build_env_block(&config.env);

        let mut si: STARTUPINFOW = unsafe { zeroed() };
        si.cb = size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        si.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        si.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };

        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
        let flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;

        let created = unsafe {
            CreateProcessWithTokenW(
                restricted_token.0,
                0,
                null(),
                cmd_line_w.as_mut_ptr(),
                flags,
                env_block.as_mut_ptr() as *const _,
                cwd_w.as_ptr(),
                &si,
                &mut pi,
            )
        };
        if created == 0 {
            ACTIVE_JOB.store(0, Ordering::SeqCst);
            return Err(format!(
                "CreateProcessWithTokenW({}, user={}) failed: {}",
                config.command,
                account.username,
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

        ACTIVE_JOB.store(0, Ordering::SeqCst);
        unsafe {
            TerminateJobObject(job.0, exit_code);
        }
        drop(thread_handle);
        drop(process_handle);
        drop(job);
        drop(acl_grants);
        drop(restricted_token);
        drop(synth);

        Ok(exit_code as i32)
    }

    fn build_sandbox_user_token(
        account: &SandboxUserAccount,
        synthetic_sid: PSID,
    ) -> Result<(SafeHandle, Vec<u8>), String> {
        let user_w = to_wide(&account.username);
        let domain_w = to_wide(".");
        let pass_w = to_wide(&account.password);

        let mut logon_raw: HANDLE = null_mut();
        let ok = unsafe {
            LogonUserW(
                user_w.as_ptr(),
                domain_w.as_ptr(),
                pass_w.as_ptr(),
                LOGON32_LOGON_INTERACTIVE,
                LOGON32_PROVIDER_DEFAULT,
                &mut logon_raw,
            )
        };
        if ok == 0 {
            return Err(format!(
                "LogonUserW({}) failed: {}",
                account.username,
                last_error()
            ));
        }
        let logon_token = SafeHandle(logon_raw);

        let user_sid_buf = query_user_sid_bytes(logon_token.0)?;
        let user_sid = user_sid_buf.as_ptr() as PSID;
        let logon_sid_buf = query_logon_sid_bytes(logon_token.0)?;
        let logon_sid = logon_sid_buf.as_ptr() as PSID;
        let world_sid = well_known_sid(WinWorldSid)?;

        // Dedicated sandbox user SID is included in SidsToRestrict:
        // - Matches CREATOR OWNER on libuv's CreateNamedPipeA -> stdio: "pipe" works natively!
        // - Real user's %USERPROFILE% has no ACE for the sandbox user -> read & write blocked!
        // - WRITE_RESTRICTED blocks writes anywhere not granted to sandbox user / synthetic SID!
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
                logon_token.0,
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
        Ok((restricted, user_sid_buf))
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
                unsafe {
                    FreeSid(self.sid);
                }
            }
        }
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
