//! Tectonic builds. One build per source file at a time: starting a new build for the
//! same file kills the previous one (its whole process group).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

#[derive(Default)]
pub struct Builds {
    /// Source path → (generation, child pid).
    running: Mutex<HashMap<String, (u64, u32)>>,
    next_gen: Mutex<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    /// Absolute path of the .tex file.
    file: String,
    /// Extra directories for Tectonic to search (workspace root, class figures folder).
    search_paths: Vec<String>,
    /// Explicit Tectonic binary, if configured.
    tectonic: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    ok: bool,
    cancelled: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    /// The PDF in `.build/`, if the build produced one.
    pdf: Option<String>,
    /// Set when Tectonic couldn't be started at all.
    launch_error: Option<String>,
}

/// Tectonic on PATH, or in the usual install locations (GUI apps on macOS don't get the
/// shell's PATH).
fn find_tectonic(explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join(".cargo/bin"));
    }
    dirs.into_iter().map(|d| d.join("tectonic")).find(|p| p.is_file())
}

fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(pid as i32, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
}

#[tauri::command]
pub async fn compile(state: State<'_, Builds>, req: CompileRequest) -> Result<CompileResult, String> {
    run_build(&state, req).await
}

pub async fn run_build(state: &Builds, req: CompileRequest) -> Result<CompileResult, String> {
    let file = PathBuf::from(&req.file);
    let dir = file.parent().ok_or("file has no parent directory")?.to_path_buf();
    let stem = file.file_stem().ok_or("file has no name")?.to_string_lossy().into_owned();
    let outdir = dir.join(".build");
    std::fs::create_dir_all(&outdir).map_err(|e| format!("{}: {e}", outdir.display()))?;

    let Some(tectonic) = find_tectonic(req.tectonic.as_deref()) else {
        return Ok(CompileResult {
            ok: false, cancelled: false, exit_code: None, stdout: String::new(), stderr: String::new(), duration_ms: 0, pdf: None,
            launch_error: Some("Tectonic isn't installed (or isn't on PATH). Install it with `brew install tectonic`.".into()),
        });
    };

    let mut cmd = Command::new(&tectonic);
    cmd.current_dir(&dir)
        .arg("--outdir").arg(&outdir)
        .args(["--keep-logs", "--keep-intermediates", "--synctex", "--chatter", "minimal"]);
    for p in &req.search_paths {
        cmd.arg("-Z").arg(format!("search-path={p}"));
    }
    // Tectonic doesn't read back the .aux (and .toc, .out…) it keeps in --outdir, so every
    // build would start from nothing and run TeX twice. With the outdir searched, an edit that
    // doesn't change cross-references takes one pass; when they do change, Tectonic still reruns.
    cmd.arg("-Z").arg(format!("search-path={}", outdir.display()));
    cmd.arg(file.file_name().unwrap()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start {}: {e}", tectonic.display()))?;
    let pid = child.id();
    let gen = {
        let mut g = state.next_gen.lock().unwrap();
        *g += 1;
        *g
    };
    if let Some((_, old)) = state.running.lock().unwrap().insert(req.file.clone(), (gen, pid)) {
        kill_group(old);
    }

    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let (status, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let t = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        });
        let mut stdout = String::new();
        let _ = out.read_to_string(&mut stdout);
        let status = child.wait();
        (status, stdout, t.join().unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?;

    // We were superseded if another build for this file registered a newer generation.
    let cancelled = {
        let mut running = state.running.lock().unwrap();
        match running.get(&req.file) {
            Some((g, _)) if *g == gen => {
                running.remove(&req.file);
                false
            }
            _ => true,
        }
    };
    let status = status.map_err(|e| e.to_string())?;
    if !status.success() && !cancelled {
        // A failed run can leave a half-written .aux; don't let the next build read it.
        let _ = std::fs::remove_file(outdir.join(format!("{stem}.aux")));
    }
    let pdf_path = outdir.join(format!("{stem}.pdf"));
    Ok(CompileResult {
        ok: status.success() && !cancelled,
        cancelled,
        exit_code: status.code(),
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis() as u64,
        pdf: (status.success() && pdf_path.is_file()).then(|| pdf_path.to_string_lossy().into_owned()),
        launch_error: None,
    })
}

#[tauri::command]
pub fn cancel_compile(state: State<'_, Builds>, file: String) {
    if let Some((_, pid)) = state.running.lock().unwrap().remove(&file) {
        kill_group(pid);
    }
}

/// SHA-256 of a file as hex, or None if it doesn't exist.
#[tauri::command]
pub fn file_sha256(path: String) -> Result<Option<String>, String> {
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(format!("{:x}", Sha256::digest(&bytes)))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

#[tauri::command]
pub fn copy_file(src: String, dest: String) -> Result<(), String> {
    std::fs::copy(&src, &dest).map(|_| ()).map_err(|e| format!("{src} → {dest}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("texdesk-build-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        d
    }

    fn req(file: &Path, search: &Path) -> CompileRequest {
        CompileRequest { file: file.to_string_lossy().into(), search_paths: vec![search.to_string_lossy().into()], tectonic: None }
    }

    #[test]
    fn builds_with_search_path_and_reports_errors() {
        if find_tectonic(None).is_none() {
            eprintln!("tectonic not installed; skipping");
            return;
        }
        let d = tmpdir("ok");
        std::fs::write(d.join("shared.sty"), "\\ProvidesPackage{shared}\n\\newcommand{\\hi}{Hi}\n").unwrap();
        let ok = d.join("sub/doc.tex");
        std::fs::write(&ok, "\\documentclass{article}\n\\usepackage{shared}\n\\begin{document}\n\\hi\n\\end{document}\n").unwrap();
        let builds = Builds::default();
        let r = tauri::async_runtime::block_on(run_build(&builds, req(&ok, &d))).unwrap();
        assert!(r.ok, "stderr: {}", r.stderr);
        assert!(d.join("sub/.build/doc.pdf").is_file());
        assert!(d.join("sub/.build/doc.synctex.gz").is_file());
        assert!(d.join("sub/.build/doc.log").is_file());
        assert!(!d.join("sub/doc.pdf").exists(), "the build itself must not write next to the source");

        let bad = d.join("sub/bad.tex");
        std::fs::write(&bad, "\\documentclass{article}\n\\begin{document}\n\\nope\n\\end{document}\n").unwrap();
        let r = tauri::async_runtime::block_on(run_build(&builds, req(&bad, &d))).unwrap();
        assert!(!r.ok);
        assert!(r.stderr.contains("bad.tex:3: Undefined control sequence"), "stderr: {}", r.stderr);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn reuses_the_previous_aux_and_still_resolves_references() {
        if find_tectonic(None).is_none() {
            eprintln!("tectonic not installed; skipping");
            return;
        }
        let d = tmpdir("aux");
        let doc = d.join("sub/doc.tex");
        let src = |extra: &str| format!("\\documentclass{{article}}\n\\begin{{document}}\n\\section{{A}}\\label{{a}}\nSee~\\ref{{a}}{extra}.\n\\end{{document}}\n");
        let builds = Builds::default();
        let undefined = || std::fs::read_to_string(d.join("sub/.build/doc.log")).unwrap().contains("undefined references");
        std::fs::write(&doc, src("")).unwrap();
        let r = tauri::async_runtime::block_on(run_build(&builds, req(&doc, &d))).unwrap();
        assert!(r.ok, "stderr: {}", r.stderr);
        assert!(!undefined());
        // An edit with the same labels: one pass, references still resolved from the kept .aux.
        std::fs::write(&doc, src(" more")).unwrap();
        let r = tauri::async_runtime::block_on(run_build(&builds, req(&doc, &d))).unwrap();
        assert!(r.ok, "stderr: {}", r.stderr);
        assert!(!undefined());
        // A failed build drops the .aux so the next one starts clean.
        std::fs::write(&doc, "\\documentclass{article}\n\\begin{document}\n\\nope\n\\end{document}\n").unwrap();
        let r = tauri::async_runtime::block_on(run_build(&builds, req(&doc, &d))).unwrap();
        assert!(!r.ok);
        assert!(!d.join("sub/.build/doc.aux").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_new_build_cancels_the_running_one() {
        if find_tectonic(None).is_none() {
            return;
        }
        let d = tmpdir("cancel");
        let f = d.join("sub/slow.tex");
        // Enough pages to keep the first build busy for a moment.
        std::fs::write(&f, "\\documentclass{article}\n\\begin{document}\n\\count1=0 \\loop \\advance\\count1 by 1 Page \\the\\count1\\newpage \\ifnum\\count1<3000 \\repeat\n\\end{document}\n").unwrap();
        let builds = std::sync::Arc::new(Builds::default());
        let (b1, f1, d1) = (builds.clone(), f.clone(), d.clone());
        let first = std::thread::spawn(move || tauri::async_runtime::block_on(run_build(&b1, req(&f1, &d1))).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(400));
        let second = tauri::async_runtime::block_on(run_build(&builds, req(&f, &d))).unwrap();
        let first = first.join().unwrap();
        assert!(first.cancelled && !first.ok, "first build should have been cancelled");
        assert!(!second.cancelled);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn missing_tectonic_is_a_clear_error() {
        let d = tmpdir("missing");
        let f = d.join("sub/x.tex");
        std::fs::write(&f, "x").unwrap();
        let mut r = req(&f, &d);
        r.tectonic = Some("/nonexistent/tectonic".into());
        let res = tauri::async_runtime::block_on(run_build(&Builds::default(), r)).unwrap();
        assert!(res.launch_error.unwrap().contains("brew install tectonic"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn sha256_and_copy() {
        let d = tmpdir("hash");
        let a = d.join("a.pdf");
        std::fs::write(&a, b"abc").unwrap();
        assert_eq!(
            file_sha256(a.to_string_lossy().into()).unwrap().unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(file_sha256(d.join("none").to_string_lossy().into()).unwrap(), None);
        copy_file(a.to_string_lossy().into(), d.join("b.pdf").to_string_lossy().into()).unwrap();
        assert_eq!(std::fs::read(d.join("b.pdf")).unwrap(), b"abc");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
