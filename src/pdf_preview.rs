//! Bounded PDF page rasterization for the Files mod.
use gpui_shell::{HostError, HostValue};
use hayro::{PixmapSettings, RenderCache, RenderSettings};
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::Pixmap;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};

const INPUT_LIMIT: u64 = 4 * 1024 * 1024;
const MAX_SIDE: u32 = 4096;
const MAX_PIXELS: f32 = 4_000_000.0;
static RENDER: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);

pub fn options(value: Value) -> Result<(usize, u32), HostError> {
    if !value.is_null() && !value.is_object() { return Err(HostError::new("renderPdf options must be an object")); }
    let integer = |key, default, max| match value.get(key) {
        None => Ok(default),
        Some(v) => v.as_u64().filter(|v| *v > 0 && *v <= max)
            .ok_or_else(|| HostError::new(format!("renderPdf: invalid {key}"))),
    };
    Ok((integer("page", 1, u32::MAX as u64)? as usize, integer("width", 1600, MAX_SIDE as u64)? as u32))
}

fn rasterize(bytes: Vec<u8>, page: usize, width: u32) -> Result<(usize, Pixmap), String> {
    if bytes.len() as u64 > INPUT_LIMIT { return Err("PDF preview limit: 4 MiB".into()); }
    if width == 0 || width > MAX_SIDE { return Err("PDF width must be between 1 and 4096".into()); }
    let pdf = Pdf::new(bytes).map_err(|e| format!("Cannot read PDF (invalid or password protected): {e:?}"))?;
    let pages = pdf.pages().len();
    let page = page.checked_sub(1).and_then(|index| pdf.pages().get(index)).ok_or("PDF page is out of range")?;
    let (w, h) = page.render_dimensions();
    if !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 { return Err("Invalid PDF page dimensions".into()); }
    let scale = (width as f32 / w).min(MAX_SIDE as f32 / h).min((MAX_PIXELS / (w * h)).sqrt());
    if !scale.is_finite() || scale <= 0.0 || w * scale < 1.0 || h * scale < 1.0 { return Err("PDF page dimensions are too extreme".into()); }
    let pixmap = hayro::render(page, &RenderCache::new(), &InterpreterSettings::default(), &RenderSettings::default(),
        &PixmapSettings { x_scale: scale, y_scale: scale, bg_color: hayro::vello_cpu::color::palette::css::WHITE });
    Ok((pages, pixmap))
}

struct Output {
    input: PathBuf,
    path: PathBuf,
    relative: String,
    file: std::fs::File,
    keep: bool,
}

impl Drop for Output {
    fn drop(&mut self) {
        if !self.keep { let _ = std::fs::remove_file(&self.path); }
    }
}

fn prepare(root: &Path, path: &Path) -> Result<Output, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let staged = root.join("data/files").canonicalize().map_err(|e| e.to_string())?;
    let input = path.canonicalize().map_err(|e| e.to_string())?;
    if !staged.starts_with(&root) || !input.starts_with(&staged) { return Err("renderPdf only reads staged files under appHome()/data/files".into()); }
    if !std::fs::metadata(&input).map_err(|e| e.to_string())?.is_file() { return Err("PDF must be a regular file".into()); }
    let path = input.with_file_name(format!("page-{}-{}.png", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let relative = path.strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
    // Reserve before spawning: closing the mod sees this file in its cleanup
    // snapshot. The worker only writes this handle, never recreates a pathname.
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
    Ok(Output { input, path, relative, file, keep: false })
}

fn finish(mut output: Output, page: usize, width: u32) -> Result<Value, String> {
    let file = std::fs::File::open(&output.input).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("PDF must be a regular file".into()); }
    let mut bytes = Vec::new();
    file.take(INPUT_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let (pages, pixmap) = rasterize(bytes, page, width)?;
    let (width, height) = (pixmap.width(), pixmap.height());
    let png = pixmap.into_png().map_err(|e| e.to_string())?;
    // AssetSource refuses files over 16 MiB.
    if png.len() > 16 * 1024 * 1024 { return Err("Rendered PDF page is too large".into()); }
    output.file.write_all(&png).map_err(|e| e.to_string())?;
    output.keep = true;
    Ok(json!({"path": output.relative, "width": width, "height": height, "pages": pages}))
}

#[cfg(test)]
fn render_in(root: &Path, path: &Path, page: usize, width: u32) -> Result<Value, String> {
    finish(prepare(root, path)?, page, width)
}

pub fn render(path: PathBuf, page: usize, width: u32) -> Result<impl std::future::Future<Output = Result<HostValue, HostError>> + Send, HostError> {
    let output = prepare(&crate::mods::app_dir(), &path).map_err(HostError::new)?;
    let (tx, rx) = async_channel::bounded(1);
    let run = move || {
        let result = std::panic::catch_unwind(|| {
            let _guard = RENDER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            finish(output, page, width)
        }).unwrap_or_else(|_| Err("Cannot render this PDF".into()));
        if let Err(error) = tx.send_blocking(result) {
            if let Ok(value) = error.0 {
                if let Some(path) = value["path"].as_str() { let _ = std::fs::remove_file(crate::mods::app_dir().join(path)); }
            }
        }
    };
    #[cfg(not(test))]
    std::thread::spawn(run);
    #[cfg(test)]
    run();
    Ok(async move {
        let value = rx.recv().await.map_err(|e| HostError::new(e.to_string()))?.map_err(HostError::new)?;
        Ok(crate::mods::to_host(&value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> Vec<u8> {
        // Two colored pages, so page selection and rendered pixels are observable.
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Contents 4 0 R >>",
            "<< /Length 26 >>\nstream\n1 0 0 rg 0 0 100 200 re f\nendstream",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R >>",
            "<< /Length 26 >>\nstream\n0 0 1 rg 0 0 200 100 re f\nendstream",
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0];
        for (i, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", i + 1).bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).bytes());
        for offset in &offsets[1..] { pdf.extend(format!("{offset:010} 00000 n \n").bytes()); }
        pdf.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF", offsets.len()).bytes());
        pdf
    }

    #[test]
    fn renders_requested_page_with_bounded_dimensions() {
        let (pages, first) = rasterize(document(), 1, 200).unwrap();
        assert_eq!(pages, 2);
        assert_eq!((first.width(), first.height()), (200, 400));
        let first = image::load_from_memory(&first.into_png().unwrap()).unwrap().to_rgba8();
        assert!(first.get_pixel(100, 200)[0] > 240);
        assert!(first.get_pixel(100, 200)[2] < 10);
        let (_, second) = rasterize(document(), 2, 200).unwrap();
        assert_eq!((second.width(), second.height()), (200, 100));
        let second = image::load_from_memory(&second.into_png().unwrap()).unwrap().to_rgba8();
        assert!(second.get_pixel(100, 50)[2] > 240);
        assert!(second.get_pixel(100, 50)[0] < 10);
    }

    #[test]
    fn rejects_invalid_files_pages_and_render_sizes() {
        assert!(rasterize(b"not a PDF".to_vec(), 1, 200).is_err());
        for page in [0, 3, usize::MAX] { assert!(rasterize(document(), page, 200).is_err()); }
        for width in [0, 4097, u32::MAX] { assert!(rasterize(document(), 1, width).is_err()); }
    }
    #[test]
    fn unpainted_pdf_page_has_an_opaque_white_background() {
        let data = String::from_utf8(document()).unwrap().replace("100 200 re", "050 200 re").into_bytes();
        let (_, page) = rasterize(data, 1, 200).unwrap();
        let image = image::load_from_memory(&page.into_png().unwrap()).unwrap().to_rgba8();
        assert_eq!(image.get_pixel(150, 200).0, [255, 255, 255, 255]);
    }

    #[test]
    fn output_stays_in_staging_and_source_is_preserved() {
        let root = std::env::temp_dir().join(format!("herdr-pdf-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let dir = root.join("data/files/preview");
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.pdf");
        std::fs::write(&input, document()).unwrap();
        let result = render_in(&root, &input, 2, 200).unwrap();
        assert_eq!(result["pages"], 2);
        let output = root.join(result["path"].as_str().unwrap());
        assert!(output.starts_with(&dir));
        assert_eq!(image::open(output).unwrap().width(), 200);
        assert_eq!(std::fs::read(&input).unwrap(), document());
        let outside = root.join("outside.pdf");
        std::fs::write(&outside, document()).unwrap();
        assert!(render_in(&root, &outside, 1, 200).unwrap_err().contains("staged"));
        #[cfg(unix)]
        {
            let link = dir.join("link.pdf");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(render_in(&root, &link, 1, 200).unwrap_err().contains("staged"));
        }
        let reserved = prepare(&root, &input).unwrap();
        assert!(reserved.path.exists());
        std::fs::remove_file(&reserved.path).unwrap();
        std::fs::remove_file(&input).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(dir.join("link.pdf")).unwrap();
        // The in-flight worker fails or writes its unlinked handle, never recreates the directory.
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(finish(reserved, 1, 200).is_err());
        assert!(!dir.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn options_reject_non_integer_out_of_bounds_and_wrong_types() {
        assert_eq!(options(Value::Null).unwrap(), (1, 1600));
        assert_eq!(options(json!({"page": 2, "width": 200})).unwrap(), (2, 200));
        for value in [json!(false), json!([]), json!({"page": 0}), json!({"page": -1}), json!({"page": 1.5}), json!({"width": "200"}), json!({"width": 4097})] {
            assert!(options(value).is_err());
        }
        assert!(rasterize(vec![0; INPUT_LIMIT as usize + 1], 1, 200).is_err());
    }

}
