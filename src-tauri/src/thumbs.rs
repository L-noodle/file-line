//! 缩略图：图片生成 base64（前端展示）与 PNG 文件（拖出时的预览图标）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

#[derive(Clone)]
pub struct Thumb {
    pub kind: &'static str, // "image" | "folder" | "file"
    pub w: u32,
    pub h: u32,
    pub b64: String,
    pub icon_path: String,
}

static CACHE: Mutex<Option<HashMap<String, Thumb>>> = Mutex::new(None);

// 用户提供的高清文件夹图标，编译期嵌入
const FOLDER_PNG: &[u8] = include_bytes!("../icons/folder.png");
static FOLDER_THUMB: Mutex<Option<Thumb>> = Mutex::new(None);

/// 文件夹缩略图：解码嵌入的 folder.png，缩放后写盘（拖出预览）+ b64（卡片显示）。
fn folder_thumb(app: &AppHandle) -> Option<Thumb> {
    if let Some(t) = FOLDER_THUMB.lock().unwrap().as_ref() {
        return Some(t.clone());
    }
    let img = image::load_from_memory(FOLDER_PNG).ok()?;
    let rgba = img.to_rgba8();
    let (w0, h0) = rgba.dimensions();
    let max_px = 192u32;
    let scale = (max_px as f64 / w0.max(1) as f64)
        .min(max_px as f64 / h0.max(1) as f64)
        .min(1.0);
    let (w, h) = (
        ((w0 as f64 * scale).round() as u32).max(1),
        ((h0 as f64 * scale).round() as u32).max(1),
    );
    let scaled = if scale < 1.0 {
        image::imageops::resize(&rgba, w, h, image::imageops::FilterType::Triangle)
    } else {
        rgba
    };
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(scaled)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    let b64 = b64_encode(&png);
    let dir = app.path().app_data_dir().ok()?.join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    let p = dir.join("generic-folder.png");
    std::fs::write(&p, &png).ok()?;
    let t = Thumb {
        kind: "folder",
        w,
        h,
        b64,
        icon_path: p.to_string_lossy().to_string(),
    };
    *FOLDER_THUMB.lock().unwrap() = Some(t.clone());
    Some(t)
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn is_image(p: &str) -> bool {
    Path::new(p)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico"]
                .contains(&e.to_ascii_lowercase().as_str())
        })
        .unwrap_or(false)
}

/// 嵌入的文件类型图标（48x48，按图标名取用）。
fn icon_bytes(name: &str) -> Option<&'static [u8]> {
    Some(match name {
        "3d" => include_bytes!("../icons/file-icons/3d.png"),
        "code" => include_bytes!("../icons/file-icons/code.png"),
        "config" => include_bytes!("../icons/file-icons/config.png"),
        "database" => include_bytes!("../icons/file-icons/database.png"),
        "else" => include_bytes!("../icons/file-icons/else.png"),
        "email" => include_bytes!("../icons/file-icons/email.png"),
        "excel" => include_bytes!("../icons/file-icons/excel.png"),
        "exe" => include_bytes!("../icons/file-icons/exe.png"),
        "image" => include_bytes!("../icons/file-icons/image.png"),
        "image-gif" => include_bytes!("../icons/file-icons/image-gif.png"),
        "link" => include_bytes!("../icons/file-icons/link.png"),
        "music" => include_bytes!("../icons/file-icons/music.png"),
        "pdf" => include_bytes!("../icons/file-icons/pdf.png"),
        "ppt" => include_bytes!("../icons/file-icons/ppt.png"),
        "txt" => include_bytes!("../icons/file-icons/txt.png"),
        "video" => include_bytes!("../icons/file-icons/video.png"),
        "word" => include_bytes!("../icons/file-icons/word.png"),
        "wps" => include_bytes!("../icons/file-icons/wps.png"),
        "zip" => include_bytes!("../icons/file-icons/zip.png"),
        _ => return None,
    })
}

/// 文件扩展名 → 图标名。
fn file_icon_name(ext: &str) -> &'static str {
    match ext {
        // Office / 文档
        "doc" | "docx" | "rtf" | "odt" => "word",
        "xls" | "xlsx" | "xlsm" | "csv" | "ods" => "excel",
        "ppt" | "pptx" | "odp" => "ppt",
        "wps" | "et" | "dps" => "wps",
        "pdf" => "pdf",
        "txt" | "md" | "log" | "rtfd" => "txt",
        // 压缩包
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "cab" | "iso" => "zip",
        // 音频
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "ape" | "opus" | "mid" => "music",
        // 视频（.ts 归入代码类：TypeScript 更常见）
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg"
        | "mpeg" | "rmvb" | "3gp" => "video",
        // 无法生成缩略图的图片格式（svg/psd 等解码失败后落到这里）
        "svg" | "psd" | "ai" | "eps" | "heic" | "heif" | "raw" | "cr2" | "nef" | "arw" | "dng" => {
            "image"
        }
        // 可执行 / 安装包
        "exe" | "msi" | "bat" | "cmd" | "com" | "apk" | "appx" => "exe",
        // 代码
        "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs" | "py" | "rs" | "go" | "java" | "kt"
        | "c" | "h" | "cpp" | "hpp" | "cc" | "cs" | "php" | "rb" | "swift" | "lua" | "sh"
        | "ps1" | "html" | "htm" | "css" | "scss" | "less" | "vue" | "dart" | "scala" | "asm" => "code",
        // 配置
        "json" | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "env"
        | "properties" | "reg" | "plist" | "editorconfig" => "config",
        // 数据库
        "db" | "sqlite" | "sqlite3" | "db3" | "sql" | "mdb" | "accdb" | "dbf" => "database",
        // 邮件
        "eml" | "msg" => "email",
        // 快捷方式
        "lnk" | "url" => "link",
        // 3D 模型
        "obj" | "stl" | "fbx" | "gltf" | "glb" | "3mf" | "dae" | "ply" | "blend" | "max" => "3d",
        _ => "else",
    }
}

static FILE_THUMBS: Mutex<Option<HashMap<String, Thumb>>> = Mutex::new(None);

/// 类型图标缩略图：原图写盘（拖出预览）+ b64（卡片显示），按图标名缓存。
fn file_icon_thumb(app: &AppHandle, name: &str) -> Option<Thumb> {
    {
        let cache = FILE_THUMBS.lock().unwrap();
        if let Some(t) = cache.as_ref().and_then(|m| m.get(name)) {
            return Some(t.clone());
        }
    }
    let data = icon_bytes(name)?;
    let dir = app.path().app_data_dir().ok()?.join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    let p = dir.join(format!("file-{name}.png"));
    std::fs::write(&p, data).ok()?;
    let t = Thumb {
        kind: "file",
        w: 0,
        h: 0,
        b64: b64_encode(data),
        icon_path: p.to_string_lossy().to_string(),
    };
    FILE_THUMBS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(name.to_string(), t.clone());
    Some(t)
}

/// 提取 exe 内嵌图标（32px 大图标），失败返回 None（回退 exe.png）。
fn exe_icon_thumb(app: &AppHandle, path: &str) -> Option<Thumb> {
    let png = unsafe { exe_icon_png(path) }?;
    let (w, h) = image::load_from_memory(&png)
        .ok()?
        .to_rgba8()
        .dimensions();
    let dir = app.path().app_data_dir().ok()?.join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    let p = dir.join(format!("file-exe-{:x}.png", fnv1a(path)));
    std::fs::write(&p, &png).ok()?;
    Some(Thumb {
        kind: "file",
        w,
        h,
        b64: b64_encode(&png),
        icon_path: p.to_string_lossy().to_string(),
    })
}

unsafe fn exe_icon_png(path: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut fi = SHFILEINFOW::default();
    let res = SHGetFileInfoW(
        PCWSTR(wide.as_ptr()),
        FILE_FLAGS_AND_ATTRIBUTES(0),
        Some(&mut fi),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON,
    );
    if res == 0 || fi.hIcon.is_invalid() {
        return None;
    }
    let png = hicon_to_png(fi.hIcon);
    let _ = DestroyIcon(fi.hIcon);
    png
}

/// HICON → PNG 字节（32bpp BGRA top-down 取回后转 RGBA）。
unsafe fn hicon_to_png(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, ReleaseDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut info = ICONINFO::default();
    if GetIconInfo(hicon, &mut info).is_err() || info.hbmColor.is_invalid() {
        return None;
    }
    let result = (|| {
        let mut bmp = BITMAP::default();
        if GetObjectW(
            info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut core::ffi::c_void),
        ) == 0
        {
            return None;
        }
        let (w, h) = (bmp.bmWidth.max(1) as u32, bmp.bmHeight.max(1) as u32);
        if w > 256 || h > 256 {
            return None; // 异常位图
        }
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let hdc = GetDC(None);
        let ok = GetDIBits(
            hdc,
            info.hbmColor,
            0,
            h,
            Some(buf.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        ) == h as i32;
        let _ = ReleaseDC(None, hdc);
        if !ok {
            return None;
        }
        // BGRA → RGBA；旧图标 alpha 可能全 0（用掩码渲染），此时设为不透明
        let mut has_alpha = false;
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            if px[3] != 0 {
                has_alpha = true;
            }
        }
        if !has_alpha {
            for px in buf.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }
        let img = image::RgbaImage::from_raw(w, h, buf)?;
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        Some(png)
    })();
    let _ = DeleteObject(info.hbmColor.into());
    let _ = DeleteObject(info.hbmMask.into());
    result
}

pub fn make_thumb(app: &AppHandle, path: &str, max_px: u32) -> Result<Thumb, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{}|{}|{}", path, max_px, mtime);

    if let Some(cache) = CACHE.lock().unwrap().as_ref() {
        if let Some(t) = cache.get(&key) {
            return Ok(t.clone());
        }
    }

    let thumb = build_thumb(app, path, max_px, meta.is_dir())?;
    CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(key, thumb.clone());
    Ok(thumb)
}

fn build_thumb(app: &AppHandle, path: &str, max_px: u32, is_dir: bool) -> Result<Thumb, String> {
    if is_dir {
        if let Some(t) = folder_thumb(app) {
            return Ok(t);
        }
        return Ok(Thumb {
            kind: "folder",
            w: 0,
            h: 0,
            b64: String::new(),
            icon_path: String::new(),
        });
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    // GIF 显示专属图标（动图不取静态帧）
    if ext == "gif" {
        if let Some(t) = file_icon_thumb(app, "image-gif") {
            return Ok(t);
        }
    }
    // exe 优先显示程序内嵌图标，提取失败回退类型图标
    if ext == "exe" {
        if let Some(t) = exe_icon_thumb(app, path) {
            return Ok(t);
        }
    }
    if is_image(path) {
        if let Ok(img) = image::ImageReader::open(path)
            .map_err(|e| e.to_string())
            .and_then(|r| r.decode().map_err(|e| e.to_string()))
        {
            let rgba = img.to_rgba8();
            let (w0, h0) = rgba.dimensions();
            let scale = (max_px as f64 / w0.max(1) as f64)
                .min(max_px as f64 / h0.max(1) as f64)
                .min(1.0);
            let (w, h) = (
                ((w0 as f64 * scale).round() as u32).max(1),
                ((h0 as f64 * scale).round() as u32).max(1),
            );
            let scaled = if scale < 1.0 {
                image::imageops::resize(&rgba, w, h, image::imageops::FilterType::Triangle)
            } else {
                rgba
            };
            let mut png = Vec::new();
            image::DynamicImage::ImageRgba8(scaled.clone())
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            let b64 = b64_encode(&png);
            // 拖出预览图存盘
            let icon_path = {
                let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("thumbs");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let p = dir.join(format!("{}.png", fnv1a(path)));
                std::fs::write(&p, &png).map_err(|e| e.to_string())?;
                p.to_string_lossy().to_string()
            };
            return Ok(Thumb {
                kind: "image",
                w,
                h,
                b64,
                icon_path,
            });
        }
    }
    let name = file_icon_name(&ext);
    if let Some(t) = file_icon_thumb(app, name) {
        return Ok(t);
    }
    Ok(Thumb {
        kind: "file",
        w: 0,
        h: 0,
        b64: String::new(),
        icon_path: String::new(),
    })
}
