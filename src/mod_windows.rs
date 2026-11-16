//! Reusable native windows hosting one isolated mod copy and an optional browser surface.
use std::{cell::RefCell, collections::HashMap, path::{Path, PathBuf}, rc::Rc, time::{Duration, Instant}};
use gpui::{prelude::*, *};
use gpui_shell::{ShellRoot, ShellRuntime};
use serde_json::{Value, json};
use crate::mods::{self, Instance};

thread_local! {
    static WINDOWS: RefCell<HashMap<String, WindowHandle<ModWindow>>> = RefCell::new(HashMap::new());
}

#[cfg(not(target_os = "linux"))]
type NativeWebView = wry::WebView;
#[cfg(target_os = "linux")]
struct NativeWebView;

struct ModWindow {
    copy: u64,
    runtime: Option<Rc<ShellRuntime>>,
    root: Option<Entity<ShellRoot>>,
    error: Option<String>,
    webview: Option<NativeWebView>,
    _bounds: Subscription,
}

impl ModWindow {
    fn cleanup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.webview.take();
        if let (Some(runtime), Some(root)) = (&self.runtime, self.root.take()) {
            runtime.close_now(&root, Instant::now() + Duration::from_millis(250), window, cx);
        }
    }

    fn load(&mut self, spec: &Value, window: &mut Window, cx: &mut Context<Self>) {
        self.cleanup(window, cx);
        let inst = Instance { name: spec["mod"].as_str().unwrap_or_default().into(), props: spec.get("props").cloned().unwrap_or(Value::Null) };
        let Some(runtime) = &self.runtime else { return; };
        self.copy = mods::prepare_load(&inst);
        let loaded = mods::scan().into_iter().find(|f| f.id == inst.name)
            .ok_or_else(|| anyhow::anyhow!("mod not found: {}", inst.name))
            .and_then(|f| runtime.try_load(&f.dir, window, cx));
        match loaded { Ok(root) => { self.root = Some(root); self.error = None; }, Err(e) => { tracing::warn!("cannot load native mod: {e:#}"); self.error = Some(format!("{e:#}")); } }
        window.set_window_title(spec.get("title").and_then(Value::as_str).unwrap_or(&inst.name));
        cx.notify();
    }
}

impl Render for ModWindow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().children(self.root.clone()).children(self.error.clone())
    }
}

pub fn open(key: String, spec: Value, cx: &mut App) {
    let existing = WINDOWS.with_borrow(|w| w.get(&key).copied());
    if let Some(handle) = existing {
        if handle.update(cx, |view, window, cx| { view.load(&spec, window, cx); window.activate_window(); }).is_ok() { return; }
    }
    let dim = |name, fallback| spec.get(name).and_then(Value::as_f64).filter(|v| v.is_finite() && *v >= 100.0 && *v <= 10000.0).unwrap_or(fallback) as f32;
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(dim("width", 1000.0)), px(dim("height", 740.0))), cx))),
        titlebar: Some(TitlebarOptions::default()),
        window_decorations: Some(WindowDecorations::Server),
        ..Default::default()
    };
    let result = cx.open_window(options, |window, cx| cx.new(|cx| {
        let runtime = ShellRuntime::new_isolated();
        if let Err(e) = &runtime { tracing::warn!("cannot create native mod runtime: {e:#}"); }
        let error = runtime.as_ref().err().map(|e| format!("{e:#}"));
        let runtime = runtime.ok();
        let bounds = cx.observe_window_bounds(window, |this: &mut ModWindow, window, _| {
            #[cfg(not(target_os = "linux"))]
            if let Some(webview) = &this.webview { let _ = webview.set_bounds(web_bounds(window)); }
        });
        let weak = cx.weak_entity();
        let close_key = key.clone();
        window.on_window_should_close(cx, move |window, cx| {
            let _ = weak.update(cx, |this, cx| this.cleanup(window, cx));
            WINDOWS.with_borrow_mut(|w| { w.remove(&close_key); });
            true
        });
        let mut view = ModWindow { copy: 0, runtime, root: None, error, webview: None, _bounds: bounds };
        view.load(&spec, window, cx);
        view
    }));
    match result {
        Ok(handle) => { WINDOWS.with_borrow_mut(|w| { w.insert(key, handle); }); }
        Err(e) => tracing::warn!("cannot open mod window: {e:#}"),
    }
}

pub fn close_all(cx: &mut App) {
    let handles: Vec<_> = WINDOWS.with_borrow_mut(|w| w.drain().map(|(_, handle)| handle).collect());
    for handle in handles {
        let _ = handle.update(cx, |view, window, cx| {
            if let (Some(runtime), Some(root)) = (&view.runtime, view.root.take()) {
                runtime.close_now(&root, Instant::now() + Duration::from_millis(250), window, cx);
            }
            view.webview.take();
            window.remove_window();
        });
    }
}

pub fn close_all_now(deadline: Instant, cx: &mut App) {
    let handles: Vec<_> = WINDOWS.with_borrow_mut(|w| w.drain().map(|(_, handle)| handle).collect());
    for handle in handles {
        let _ = handle.update(cx, |view, window, cx| {
            view.webview.take();
            if let (Some(runtime), Some(root)) = (&view.runtime, view.root.take()) {
                runtime.close_now(&root, deadline, window, cx);
            }
        });
    }
}

pub fn close(key: &str, cx: &mut App) {
    if let Some(handle) = WINDOWS.with_borrow_mut(|w| w.remove(key)) {
        let _ = handle.update(cx, |view, window, cx| { view.cleanup(window, cx); window.remove_window(); });
    }
}

pub fn document(copy: u64, path: &str, cx: &mut App) {
    let handles: Vec<_> = WINDOWS.with_borrow(|w| w.values().copied().collect());
    for handle in handles {
        let _ = handle.update(cx, |view, window, cx| {
            if view.copy != copy { return; }
            view.webview.take();
            match staged_document(&mods::app_dir().join("data/files"), Path::new(path)).and_then(|path| build_webview(window, copy, path)) {
                Ok(webview) => view.webview = Some(webview),
                Err(e) => {
                    let message = format!("{e:#}");
                    tracing::warn!("cannot display native mod document: {message}");
                    mods::deliver_command(copy, &format!("webview:{}", json!({"type":"error", "message": message})));
                    view.error = Some(message);
                    cx.notify();
                }
            }
        });
    }
}

fn staged_document(staging: &Path, path: &Path) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(path.is_absolute(), "document path must be absolute");
    let staging = staging.canonicalize()?;
    let canonical = path.canonicalize()?;
    anyhow::ensure!(canonical.starts_with(&staging) && canonical.is_file(), "document must be staged under data/files");
    anyhow::ensure!(!path.components().any(|c| matches!(c, std::path::Component::ParentDir)), "document path must not contain traversal");
    for ancestor in path.ancestors().take_while(|p| !p.as_os_str().is_empty()) {
        anyhow::ensure!(!ancestor.symlink_metadata()?.file_type().is_symlink(), "document path must not contain symlinks");
    }
    anyhow::ensure!(canonical.metadata()?.len() <= 16 * 1024 * 1024, "preview document exceeds 16 MiB");
    Ok(canonical)
}

fn asset(root: &Path, encoded: &str) -> anyhow::Result<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(encoded).decode_utf8()?;
    let relative = Path::new(decoded.trim_start_matches('/'));
    anyhow::ensure!(relative.components().all(|c| matches!(c, std::path::Component::Normal(_))), "invalid asset path");
    let path = root.join(relative);
    let canonical = path.canonicalize()?;
    anyhow::ensure!(canonical.starts_with(root) && canonical == path && canonical.is_file(), "asset outside document directory");
    Ok(canonical)
}

#[cfg(not(target_os = "linux"))]
fn web_bounds(window: &Window) -> wry::Rect {
    let s = window.viewport_size();
    wry::Rect { position: wry::dpi::LogicalPosition::new(0, 0).into(), size: wry::dpi::LogicalSize::new(f64::from(s.width), f64::from(s.height)).into() }
}

#[cfg(not(target_os = "linux"))]
fn build_webview(window: &Window, copy: u64, path: PathBuf) -> anyhow::Result<NativeWebView> {
    let root = path.parent().unwrap().to_owned();
    let filename = path.file_name().unwrap().to_string_lossy();
    let url = format!("herdr-preview://localhost/{}", percent_encoding::utf8_percent_encode(&filename, percent_encoding::NON_ALPHANUMERIC));
    let navigation_url = url.clone();
    let ipc_url = url.clone();
    Ok(wry::WebViewBuilder::new()
        .with_incognito(true)
        .with_bounds(web_bounds(window))
        .with_custom_protocol("herdr-preview".into(), move |_, request| {
            let response = asset(&root, request.uri().path()).and_then(|path| {
                use std::io::Read;
                let mut bytes = Vec::new();
                std::fs::File::open(&path)?.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
                anyhow::ensure!(bytes.len() <= 64 * 1024 * 1024, "preview asset exceeds 64 MiB");
                Ok((bytes, mime_guess::from_path(&path).first_or_octet_stream().to_string()))
            });
            let (status, bytes, mime) = match response { Ok((bytes, mime)) => (200, bytes, mime), Err(_) => (403, b"Forbidden".to_vec(), "text/plain".into()) };
            wry::http::Response::builder().status(status).header("Content-Type", mime)
                .header("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'")
                .body(bytes.into()).unwrap()
        })
        .with_ipc_handler(move |request| {
            let origin = request.uri().to_string();
            let origin = origin.split('#').next().unwrap_or_default();
            let owned = origin == ipc_url || origin == ipc_url.replace("herdr-preview://localhost/", "http://herdr-preview.localhost/") || origin == ipc_url.replace("herdr-preview://localhost/", "https://herdr-preview.localhost/");
            if owned && request.body().len() <= 65536 && serde_json::from_str::<Value>(request.body()).is_ok() { mods::deliver_command(copy, &format!("webview:{}", request.body())); }
        })
        .with_navigation_handler(move |url| {
            let url = url.split('#').next().unwrap_or_default();
            url == navigation_url || url == navigation_url.replace("herdr-preview://localhost/", "http://herdr-preview.localhost/") || url == navigation_url.replace("herdr-preview://localhost/", "https://herdr-preview.localhost/")
        })
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_url(url)
        .build_as_child(window)?)
}

#[cfg(target_os = "linux")]
fn build_webview(_: &Window, _: u64, _: PathBuf) -> anyhow::Result<NativeWebView> {
    anyhow::bail!("native browser previews are not yet supported on Linux")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::core::prelude::v1::test;
    #[test]
    fn native_window_lifecycle_isolated() {
        let home = std::env::temp_dir().join(format!("herdr-native-window-test-{}", std::process::id()));
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "mod_windows::tests::native_window_lifecycle", "--nocapture", "--test-threads=1"])
            .env("HERDR_APP_HOME", &home).env("HERDR_TEST_NATIVE_WINDOW", "1").output().unwrap();
        let _ = std::fs::remove_dir_all(home);
        let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(out.status.success() && log.contains("1 passed"), "{log}");
    }

    #[gpui::test]
    fn native_window_lifecycle(cx: &mut gpui::TestAppContext) {
        if std::env::var("HERDR_TEST_NATIVE_WINDOW").as_deref() != Ok("1") { return; }
        mods::write_workspace().unwrap();
        let folder = mods::app_dir().join("mods/native-probe");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("mod.json"), r#"{"place":"none"}"#).unwrap();
        std::fs::write(folder.join("main.js"), r#"
            import { View, div } from "gpui-kit";
            import { props, setShared } from "herdr";
            export default class Probe extends View {
                close() { setShared("native.closed", props().version); }
                render() { return div(); }
            }
        "#).unwrap();
        cx.update(mods::init);
        let _requests = mods::install_policy();
        let _main_runtime = cx.update(ShellRuntime::new).unwrap();
        cx.update(|cx| open("probe".into(), json!({"mod":"native-probe","props":{"version":1}}), cx));
        let first = WINDOWS.with_borrow(|w| w["probe"]);
        let (old_copy, bounds) = cx.update(|cx| first.update(cx, |view, window, _| {
            assert!(view.error.is_none(), "{:?}", view.error);
            assert!(view.root.is_some());
            (view.copy, window.bounds())
        }).unwrap());
        cx.update(|cx| open("probe".into(), json!({"mod":"native-probe","props":{"version":2},"width":400,"height":300}), cx));
        assert_eq!(first, WINDOWS.with_borrow(|w| w["probe"]));
        assert_eq!(mods::shared("native.closed"), Some(json!(1)));
        let new_copy = cx.update(|cx| first.update(cx, |view, window, _| {
            assert_ne!(view.copy, old_copy);
            assert_eq!(window.bounds(), bounds);
            view.copy
        }).unwrap());
        cx.update(|cx| document(old_copy, "/missing-document.html", cx));
        cx.update(|cx| first.update(cx, |view, _, _| assert!(view.error.is_none())).unwrap());
        cx.update(|cx| document(new_copy, "/missing-document.html", cx));
        cx.update(|cx| first.update(cx, |view, _, _| assert!(view.error.is_some())).unwrap());
        cx.update(|cx| close("probe", cx));
        assert_eq!(mods::shared("native.closed"), Some(json!(2)));
        assert!(WINDOWS.with_borrow(|w| w.is_empty()));
        assert!(cx.update(|cx| first.update(cx, |_, _, _| ())).is_err());
    }

    #[test]
    fn document_and_assets_cannot_escape_staging() {
        let root = std::env::temp_dir().join(format!("herdr-preview-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join("index.html"), "test").unwrap();
        assert!(staged_document(&root, &root.join("index.html")).is_ok());
        assert!(staged_document(&root, Path::new("index.html")).is_err());
        assert!(asset(&root, "/index.html").is_ok());
        assert!(asset(&root, "/%2e%2e/secret").is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(root.join("index.html"), root.join("link.html")).unwrap();
            assert!(asset(&root, "/link.html").is_err());
            assert!(staged_document(&root, &root.join("link.html")).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
