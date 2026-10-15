//! 剪贴板：监听新增图片（自动挂绳）与单击复制时写入文件 / 图片。
//!
//! - Windows：原生 Win32 剪贴板 API（CF_DIB / CF_HDROP / "PNG"）。
//! - macOS：NSPasteboard（图片走 public.png / public.tiff，文件走 NSFilenamesPboardType）。

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tauri::Manager;

/// 自己写入剪贴板后的 sequence/change 计数，监听时跳过，避免回环。
static SELF_SEQ: AtomicU32 = AtomicU32::new(0);

const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif"];
// 仅 Windows 剪贴板位图路径使用（CF_DIB 大小上限）。macOS 路径不读，抑制其 dead_code。
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_BYTES: usize = 64 * 1024 * 1024;

fn is_image_ext(p: &str) -> bool {
    Path::new(p)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 把剪贴板位图保存到应用 inbox 目录，返回绝对路径。
fn save_inbox_png(app: &AppHandle, png: &[u8]) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?.join("inbox");
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M.%S");
    let mut path = dir.join(format!("剪贴板 {}.png", stamp));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("剪贴板 {} ({}).png", stamp, n));
        n += 1;
    }
    std::fs::write(&path, png).ok()?;
    Some(path.to_string_lossy().to_string())
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
        IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    pub fn start_watcher(app: AppHandle) {
        std::thread::spawn(move || {
            let mut last = unsafe { GetClipboardSequenceNumber() };
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let seq = unsafe { GetClipboardSequenceNumber() };
                if seq == 0 || seq == last {
                    continue;
                }
                last = seq;
                if seq == SELF_SEQ.load(Ordering::SeqCst) as u32 {
                    continue;
                }
                match read_clipboard_images(&app) {
                    Ok(paths) if !paths.is_empty() => {
                        let _ = app.emit("clip-new", serde_json::json!({ "paths": paths }));
                    }
                    _ => {}
                }
            }
        });
    }

    fn read_clipboard_images(app: &AppHandle) -> Result<Vec<String>, String> {
        unsafe {
            if OpenClipboard(None).is_err() {
                return Ok(vec![]);
            }
            let result = (|| -> Result<Vec<String>, String> {
                // 密码管理器等标记为隐私的内容：跳过
                if let Ok(fmt) = register_format("ExcludeClipboardContentFromMonitorProcessing") {
                    if fmt != 0 && IsClipboardFormatAvailable(fmt).is_ok() {
                        return Ok(vec![]);
                    }
                }
                // 1) 文件列表里的图片文件
                if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
                    if let Ok(h) = GetClipboardData(CF_HDROP.0 as u32) {
                        let drop = HDROP(h.0 as *mut _);
                        let n = DragQueryFileW(drop, u32::MAX, None);
                        let mut files = Vec::new();
                        for i in 0..n {
                            let len = DragQueryFileW(drop, i, None);
                            if len == 0 {
                                continue;
                            }
                            let mut buf = vec![0u16; len as usize + 1];
                            let copied = DragQueryFileW(drop, i, Some(&mut buf));
                            let s = String::from_utf16_lossy(&buf[..copied as usize]);
                            if is_image_ext(&s) {
                                files.push(s);
                            }
                        }
                        if !files.is_empty() {
                            return Ok(files);
                        }
                    }
                }
                // 2) 位图数据
                for fmt in [CF_DIBV5.0 as u32, CF_DIB.0 as u32] {
                    if !IsClipboardFormatAvailable(fmt).is_ok() {
                        continue;
                    }
                    let Ok(h) = GetClipboardData(fmt) else { continue };
                    let (ptr, len) = match lock_global(HGLOBAL(h.0)) {
                        Some(v) => v,
                        None => continue,
                    };
                    if len == 0 || len > MAX_BYTES {
                        let _ = GlobalUnlock(HGLOBAL(h.0));
                        continue;
                    }
                    let dib = std::slice::from_raw_parts(ptr as *const u8, len);
                    let r = dib_to_png(dib);
                    let _ = GlobalUnlock(HGLOBAL(h.0));
                    if let Some(png) = r {
                        let path = save_inbox_png(app, &png);
                        if let Some(p) = path {
                            return Ok(vec![p]);
                        }
                    }
                }
                Ok(vec![])
            })();
            let _ = CloseClipboard();
            result
        }
    }

    fn lock_global(h: HGLOBAL) -> Option<(*mut std::ffi::c_void, usize)> {
        unsafe {
            let ptr = GlobalLock(h);
            if ptr.is_null() {
                return None;
            }
            use windows::Win32::System::Memory::GlobalSize;
            Some((ptr, GlobalSize(h)))
        }
    }

    fn register_format(name: &str) -> Result<u32, windows::core::Error> {
        use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        Ok(unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) })
    }

    /// 单击复制：图片 → "PNG" 格式 + CF_DIB + CF_HDROP；其他 → 仅 CF_HDROP。
    pub fn copy_file_to_clipboard(path: &str) -> Result<(), String> {
        unsafe {
            if OpenClipboard(None).is_err() {
                return Err("无法打开剪贴板".into());
            }
            let r = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| e.to_string())?;

                let hdrop_bytes = paths_to_hdrop(&[path.to_string()]);
                if let Some(h) = alloc_hglobal(&hdrop_bytes) {
                    let _ = SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(h.0)));
                }

                if is_image_ext(path) {
                    if let Ok(bytes) = std::fs::read(path) {
                        if let Some(fmt) = register_format("PNG").ok().filter(|f| *f != 0) {
                            if let Some(h) = alloc_hglobal(&bytes) {
                                let _ = SetClipboardData(fmt, Some(HANDLE(h.0)));
                            }
                        }
                        if let Ok(img) = image::load_from_memory(&bytes) {
                            let rgba = img.to_rgba8();
                            let dib = rgba_to_dib(&rgba);
                            if let Some(h) = alloc_hglobal(&dib) {
                                let _ = SetClipboardData(CF_DIB.0 as u32, Some(HANDLE(h.0)));
                            }
                        }
                    }
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            r?;
            SELF_SEQ.store(GetClipboardSequenceNumber(), Ordering::SeqCst);
            Ok(())
        }
    }

    fn alloc_hglobal(bytes: &[u8]) -> Option<HGLOBAL> {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).ok()?;
            let ptr = GlobalLock(h);
            if ptr.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            let _ = GlobalUnlock(h);
            Some(h)
        }
    }

    /// CF_DIB / CF_DIBV5 数据 → PNG 字节。支持 24/32bpp BI_RGB 与 32bpp 常规 BI_BITFIELDS。
    pub fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
        if dib.len() < 40 {
            return None;
        }
        let rd_i32 = |o: usize| i32::from_le_bytes(dib[o..o + 4].try_into().unwrap());
        let rd_u16 = |o: usize| u16::from_le_bytes(dib[o..o + 2].try_into().unwrap());
        let rd_u32 = |o: usize| u32::from_le_bytes(dib[o..o + 4].try_into().unwrap());
        let bi_size = rd_u32(0) as usize;
        let w = rd_i32(4);
        let h_raw = rd_i32(8);
        let bpp = rd_u16(14) as u32;
        let compression = rd_u32(16);
        if w <= 0 || h_raw == 0 || bi_size < 40 {
            return None;
        }
        let w = w as u32;
        let top_down = h_raw < 0;
        let h = h_raw.unsigned_abs();

        let (r_shift, r_bits, g_shift, g_bits, b_shift, b_bits, alpha_ok) = if compression == 3 && bpp == 32 {
            let base = 40;
            if dib.len() < base + 12 {
                return None;
            }
            let mask = |o: usize| rd_u32(base + o);
            let rm = mask(0);
            let gm = mask(4);
            let bm = mask(8);
            let am = if bi_size >= 56 { mask(12) } else { 0 };
            let decomp = |m: u32| -> (u32, u32) {
                if m == 0 {
                    return (0, 0);
                }
                let shift = m.trailing_zeros();
                let bits = m.count_ones();
                (shift, bits)
            };
            let (rs, rb) = decomp(rm);
            let (gs, gb) = decomp(gm);
            let (bs, bb) = decomp(bm);
            let a_ok = am != 0 && dib.len() >= base + 16;
            (rs, rb, gs, gb, bs, bb, a_ok)
        } else if compression == 0 && (bpp == 24 || bpp == 32) {
            (16, 8, 8, 8, 0, 8, bpp == 32)
        } else {
            return None;
        };

        let bytes_pp = (bpp / 8) as usize;
        let stride = ((w as usize * bytes_pp) + 3) & !3;
        let pixels_off = bi_size
            + if compression == 3 && bpp == 32 && bi_size == 40 {
                12
            } else {
                0
            };
        if dib.len() < pixels_off + stride * h as usize {
            return None;
        }

        let scale8 = |v: u32, bits: u32| -> u8 {
            if bits == 0 {
                return 0;
            }
            let max = (1u32 << bits) - 1;
            ((v.min(max) * 255) / max) as u8
        };

        let mut img = image::RgbaImage::new(w, h);
        let mut all_zero_alpha = true;
        for y in 0..h {
            let src_row = if top_down { y } else { h - 1 - y };
            let row_off = pixels_off + src_row as usize * stride;
            for x in 0..w {
                let o = row_off + x as usize * bytes_pp;
                let px = if bpp == 32 {
                    let v = u32::from_le_bytes(dib[o..o + 4].try_into().unwrap());
                    (
                        scale8((v >> r_shift) & ((1 << r_bits) - 1), r_bits),
                        scale8((v >> g_shift) & ((1 << g_bits) - 1), g_bits),
                        scale8((v >> b_shift) & ((1 << b_bits) - 1), b_bits),
                        if alpha_ok {
                            ((v >> 24) & 0xFF) as u8
                        } else {
                            255
                        },
                    )
                } else {
                    (dib[o + 2], dib[o + 1], dib[o], 255)
                };
                if px.3 != 0 {
                    all_zero_alpha = false;
                }
                img.put_pixel(x, y, image::Rgba([px.0, px.1, px.2, px.3]));
            }
        }
        if all_zero_alpha {
            for p in img.pixels_mut() {
                p[3] = 255;
            }
        }
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        Some(png)
    }

    /// RGBA → bottom-up 32bpp CF_DIB。
    fn rgba_to_dib(img: &image::RgbaImage) -> Vec<u8> {
        let (w, h) = img.dimensions();
        let mut out = vec![0u8; 40 + (w * h * 4) as usize];
        out[4..8].copy_from_slice(&(w as i32).to_le_bytes());
        out[8..12].copy_from_slice(&(h as i32).to_le_bytes());
        out[12..14].copy_from_slice(&1u16.to_le_bytes());
        out[14..16].copy_from_slice(&32u16.to_le_bytes());
        out[20..24].copy_from_slice(&((w * h * 4) as u32).to_le_bytes());
        let mut idx = 40;
        for row in (0..h).rev() {
            for col in 0..w {
                let p = img.get_pixel(col, row);
                out[idx] = p[2];
                out[idx + 1] = p[1];
                out[idx + 2] = p[0];
                out[idx + 3] = p[3];
                idx += 4;
            }
        }
        out
    }

    /// 路径列表 → CF_HDROP 内存块。
    fn paths_to_hdrop(paths: &[String]) -> Vec<u8> {
        let mut files: Vec<u16> = Vec::new();
        for p in paths {
            files.extend(p.encode_utf16());
            files.push(0);
        }
        files.push(0);
        let mut out = vec![0u8; 20];
        out[0..4].copy_from_slice(&20u32.to_le_bytes());
        out[16..20].copy_from_slice(&1i32.to_le_bytes()); // fWide
        let bytes =
            unsafe { std::slice::from_raw_parts(files.as_ptr().cast::<u8>(), files.len() * 2) };
        out.extend_from_slice(bytes);
        out
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::{CStr, CString};
    use objc::class;
    use objc::msg_send;
    use objc::sel;
    use objc::sel_impl;
    use objc::runtime::Object;

    const FILENAMES_TYPE: &str = "NSFilenamesPboardType";
    const PNG_TYPE: &str = "public.png";
    const TIFF_TYPE: &str = "public.tiff";

    fn ns_string(s: &str) -> *mut Object {
        let c = CString::new(s).unwrap_or_default();
        unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] }
    }

    fn pb() -> *mut Object {
        unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
    }

    fn change_count() -> i64 {
        unsafe { msg_send![pb(), changeCount] }
    }

    fn nsstring_to_string(obj: *mut Object) -> String {
        unsafe {
            let ptr: *const std::os::raw::c_char = msg_send![obj, UTF8String];
            if ptr.is_null() {
                return String::new();
            }
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }

    fn data_for_type(ty: *mut Object) -> Option<Vec<u8>> {
        unsafe {
            let data: *mut Object = msg_send![pb(), dataForType: ty];
            if data.is_null() {
                return None;
            }
            let bytes: *const std::os::raw::c_void = msg_send![data, bytes];
            let len: usize = msg_send![data, length];
            if bytes.is_null() || len == 0 {
                return None;
            }
            Some(std::slice::from_raw_parts(bytes as *const u8, len).to_vec())
        }
    }

    fn filenames_on_pasteboard() -> Vec<String> {
        unsafe {
            let ty = ns_string(FILENAMES_TYPE);
            let plist: *mut Object = msg_send![pb(), propertyListForType: ty];
            if plist.is_null() {
                return Vec::new();
            }
            let n: usize = msg_send![plist, count];
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                let item: *mut Object = msg_send![plist, objectAtIndex: i];
                out.push(nsstring_to_string(item));
            }
            out
        }
    }

    pub fn start_watcher(app: AppHandle) {
        std::thread::spawn(move || {
            let mut last = change_count();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let c = change_count();
                if c == last {
                    continue;
                }
                last = c;
                if c == SELF_SEQ.load(Ordering::SeqCst) as i64 {
                    continue;
                }
                match read_images(&app) {
                    Ok(paths) if !paths.is_empty() => {
                        let _ = app.emit("clip-new", serde_json::json!({ "paths": paths }));
                    }
                    _ => {}
                }
            }
        });
    }

    /// 读取剪贴板：优先文件列表里的图片，其次 PNG/TIFF 位图。
    fn read_images(app: &AppHandle) -> Result<Vec<String>, String> {
        // 1) 文件列表里的图片文件
        let files = filenames_on_pasteboard();
        let img_files: Vec<String> = files.into_iter().filter(|p| is_image_ext(p)).collect();
        if !img_files.is_empty() {
            return Ok(img_files);
        }
        // 2) 位图数据（PNG / TIFF）→ 存盘后返回路径
        if let Some(bytes) = data_for_type(ns_string(PNG_TYPE)) {
            if let Some(p) = save_inbox_png(app, &bytes) {
                return Ok(vec![p]);
            }
        }
        if let Some(bytes) = data_for_type(ns_string(TIFF_TYPE)) {
            if let Ok(img) = image::load_from_memory(&bytes) {
                let mut png = Vec::new();
                if img
                    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                    .is_ok()
                {
                    if let Some(p) = save_inbox_png(app, &png) {
                        return Ok(vec![p]);
                    }
                }
            }
        }
        Ok(vec![])
    }

    /// 单击复制：图片 → public.png + 文件列表；其他 → 仅文件列表。
    pub fn copy_file_to_clipboard(path: &str) -> Result<(), String> {
        unsafe {
            let board = pb();
            let _: isize = msg_send![board, clearContents];

            // 文件列表（Finder 中表现为文件，可拖出）
            let paths_arr: *mut Object = msg_send![class!(NSMutableArray), array];
            let c = CString::new(path).unwrap_or_default();
            let ns: *mut Object =
                msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
            let _: () = msg_send![paths_arr, addObject: ns];
            let ft = ns_string(FILENAMES_TYPE);
            let types_arr: *mut Object = msg_send![class!(NSArray), arrayWithObject: ft];
            let _: isize =
                msg_send![board, declareTypes: types_arr owner: std::ptr::null::<Object>()];
            let _: () = msg_send![board, setPropertyList: paths_arr forType: ft];

            // 图片：额外写入 public.png，便于粘贴进图像类应用
            if is_image_ext(path) {
                if let Ok(bytes) = std::fs::read(path) {
                    let data: *mut Object = msg_send![class!(NSData), dataWithBytes: bytes.as_ptr() length: bytes.len()];
                    let pt = ns_string(PNG_TYPE);
                    let _: () = msg_send![board, setData: data forType: pt];
                }
            }
            SELF_SEQ.store(change_count() as u32, Ordering::SeqCst);
            Ok(())
        }
    }
}

pub use imp::copy_file_to_clipboard;
pub use imp::start_watcher;
