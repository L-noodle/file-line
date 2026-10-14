//! 剪贴板：轮询监听新增图片；单击复制时写入原图。
//! Windows 原生 API：CF_DIB / CF_DIBV5 / CF_HDROP / "PNG" 注册格式。

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

/// 自己写入剪贴板后的 sequence number，监听时跳过，避免回环。
static SELF_SEQ: AtomicU32 = AtomicU32::new(0);

const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif"];
const MAX_BYTES: usize = 64 * 1024 * 1024;

fn is_image_ext(p: &str) -> bool {
    Path::new(p)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 启动监听线程：0.5s 轮询 sequence number，变化时读取图片。
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
            if seq == SELF_SEQ.load(Ordering::SeqCst) {
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

/// 读取剪贴板：优先文件列表里的图片，其次位图数据（存入 inbox 后返回路径）。
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

// ---------- DIB 解码 ----------

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
        // BI_BITFIELDS：掩码紧跟头部
        let base = if bi_size == 40 { 12 } else { 40 };
        if dib.len() < base + 12 {
            return None;
        }
        let mask = |o: usize| rd_u32(base + o);
        let rm = mask(0);
        let gm = mask(4);
        let bm = mask(8);
        let am = if bi_size >= 52 { mask(12) } else { 0 };
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
        // BI_RGB：32bpp 为 BGRA
        (0, 8, 8, 8, 16, 8, bpp == 32)
    } else {
        return None; // 8bpp 调色板等不常见格式
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
    // 一些老截图工具写入的 32bpp DIB alpha 全为 0：视为不透明
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

// ---------- 写入（复制原图） ----------

/// 单击复制：图片 → "PNG" 格式 + CF_DIB + CF_HDROP；其他 → 仅 CF_HDROP。
pub fn copy_file_to_clipboard(path: &str) -> Result<(), String> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return Err("无法打开剪贴板".into());
        }
        let r = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;

            // 文件列表
            let hdrop_bytes = paths_to_hdrop(&[path.to_string()]);
            if let Some(h) = alloc_hglobal(&hdrop_bytes) {
                let _ = SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(h.0)));
            }

            // 图片：PNG 原始格式 + DIB
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
