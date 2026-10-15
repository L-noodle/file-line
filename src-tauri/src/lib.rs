mod clipboard;
mod filedrop;
mod mousehook;
mod thumbs;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize,
};

/// 卡片大小，与前端 Layout 对应。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SizeKey {
    Small,
    Medium,
    Large,
}

impl SizeKey {
    pub fn from_str(s: &str) -> SizeKey {
        match s {
            "small" => SizeKey::Small,
            "large" => SizeKey::Large,
            _ => SizeKey::Medium,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            SizeKey::Small => "small",
            SizeKey::Medium => "medium",
            SizeKey::Large => "large",
        }
    }
    pub fn scale(&self) -> f64 {
        match self {
            SizeKey::Small => 0.6,
            SizeKey::Medium => 0.8,
            SizeKey::Large => 1.0,
        }
    }
    /// 条带高度：photoMaxHeight(104*scale) + 106，与前端一致。
    pub fn panel_height(&self) -> f64 {
        (104.0 * self.scale()).round() + 106.0
    }
}

pub struct AppState {
    pub size: Mutex<SizeKey>,
}

/// 把主窗口铺满主显示器顶部。
pub fn place_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let size = app.state::<AppState>();
    let h = size.size.lock().unwrap().panel_height();
    if let Ok(Some(mon)) = win.primary_monitor() {
        let PhysicalSize { width, .. } = *mon.size();
        let pos = mon.position();
        let scale = mon.scale_factor();
        // 全屏宽度（物理），高度用逻辑值换算为物理。
        let _ = win.set_size(PhysicalSize::new(width, (h * scale).round() as u32));
        let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
    } else {
        let _ = win.set_size(PhysicalSize::new(1280, h as u32));
    }
}

fn state_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap();
    let _ = fs::create_dir_all(&dir);
    dir.join("state.json")
}

/// 持久化条目：兼容旧的纯路径字符串格式。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum PersistedItem {
    Full {
        path: String,
        #[serde(default)]
        source: String,
    },
    Path(String),
}

impl PersistedItem {
    fn path(&self) -> &str {
        match self {
            PersistedItem::Full { path, .. } => path,
            PersistedItem::Path(p) => p,
        }
    }
    /// drag = 拖拽进入；其余一律视为剪贴板。
    fn source(&self) -> &str {
        match self {
            PersistedItem::Full { source, .. } if source == "drag" => "drag",
            _ => "clip",
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Persisted {
    items: Vec<PersistedItem>,
    size: Option<String>,
}

fn read_state(app: &AppHandle) -> Persisted {
    fs::read_to_string(state_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(app: &AppHandle, p: &Persisted) {
    let _ = fs::write(
        state_path(app),
        serde_json::to_string_pretty(p).unwrap_or_default(),
    );
}

// ---------- 命令 ----------

#[tauri::command]
fn get_state(app: AppHandle) -> serde_json::Value {
    let p = read_state(&app);
    serde_json::json!({
        "items": p.items.iter().map(|i| serde_json::json!({
            "path": i.path(),
            "source": i.source(),
        })).collect::<Vec<_>>(),
        "size": p.size
    })
}

#[tauri::command]
fn save_state(app: AppHandle, items: Vec<PersistedItem>) {
    let size = app.state::<AppState>().size.lock().unwrap().as_str().to_string();
    write_state(&app, &Persisted { items, size: Some(size) });
}

/// 默认程序打开。
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open_with_shell(&path)
}

/// 在资源管理器中定位文件。文件夹则直接打开。
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        return open_with_shell(&path);
    }
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let arg = format!(r#"/select,"{}"\0"#, path);
    let wide: Vec<u16> = "explorer\0".encode_utf16().collect();
    let args: Vec<u16> = arg.encode_utf16().collect();
    unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(wide.as_ptr()),
            PCWSTR(args.as_ptr()),
            None,
            SW_SHOW,
        );
    }
    Ok(())
}

fn open_with_shell(path: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;
    let wide: Vec<u16> = format!("{}\0", path).encode_utf16().collect();
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let r = unsafe {
        ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(wide.as_ptr()), None, None, SW_SHOW)
    };
    if r.0 as usize > 32 {
        Ok(())
    } else {
        Err(format!("无法打开 {}", path))
    }
}

/// 全部另存为：在用户选择的文件夹内新建「晾衣绳 + 年月日时分秒」子文件夹，
/// 把绳子上的全部文件复制进去（重名自动加序号），完成后打开该子文件夹。
#[tauri::command]
fn save_to_folder(paths: Vec<String>, folder: String) -> Result<String, String> {
    let base = PathBuf::from(&folder);
    if !base.is_dir() {
        return Err(format!("目标文件夹不存在：{folder}"));
    }
    // 子文件夹名：晾衣绳 + 年月日时分秒（本地时间）
    let stamp = chrono::Local::now().format("晾衣绳%Y%m%d%H%M%S");
    let dst_dir = base.join(format!("{stamp}"));
    fs::create_dir_all(&dst_dir).map_err(|e| format!("创建文件夹失败：{e}"))?;
    for p in &paths {
        let src = PathBuf::from(p);
        if !src.exists() {
            continue;
        }
        let name = src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let mut dst = dst_dir.join(&name);
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy()));
        let mut i = 2;
        while dst.exists() {
            let nn = match &ext {
                Some(e) => format!("{} ({}){}", stem, i, e),
                None => format!("{} ({})", stem, i),
            };
            dst = dst_dir.join(nn);
            i += 1;
        }
        if src.is_dir() {
            copy_dir_recursive(&src, &dst).map_err(|e| e.to_string())?;
        } else {
            let _ = fs::copy(&src, &dst);
        }
    }
    // 打开新建的子文件夹让用户看到成果
    let dst = dst_dir.to_string_lossy().to_string();
    let _ = open_with_shell(&dst);
    Ok(dst)
}

fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

/// 单击复制：图片写 PNG + DIB + 文件列表；非图片写文件列表。
#[tauri::command]
fn copy_to_clipboard(path: String) -> Result<(), String> {
    clipboard::copy_file_to_clipboard(&path)
}

/// 前端上报卡片命中区域（物理像素，屏幕坐标系），驱动点击穿透。
/// 首次 set_hit_rects 时补注册 OLE 拖放（只跑一次，后续由 show_rope / 预热重装）。
static DROP_INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_hit_rects(
    app: AppHandle,
    rects: Vec<(f64, f64, f64, f64)>,
    panel_h: f64,
    scrollable: bool,
) {
    mousehook::set_regions(&app, rects, panel_h, scrollable);
    // 前端就绪后补注册 OLE 拖放（wry 只注册了初始子窗口，深层子窗口漏注册）。
    // RegisterDragDrop 要求主线程（OLE STA）
    if !DROP_INSTALLED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || filedrop::install(&app2));
    }
}

#[tauri::command]
fn set_capture_override(on: bool) {
    mousehook::set_override(on);
}

/// 显示绳子窗口（截图 / 顶部拖拽触发）。
#[tauri::command]
fn show_rope(app: AppHandle) {
    mousehook::set_revealed(true);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        // 窗口从隐藏恢复显示时 WebView2 会异步销毁/重建深层子窗口（drop 目标所在）。
        // 立即重装太早（子窗口还没建好），延迟 350ms 到主线程幂等重装：
        // REGISTERED 命中的窗口用 OLE 属性验证注册存活，HWND 复用也能正确重注册
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(350));
            let app3 = app2.clone();
            let _ = app2.run_on_main_thread(move || filedrop::install(&app3));
        });
    }
}

/// 隐藏绳子窗口（滑出动画结束后调用）。
#[tauri::command]
fn hide_rope(app: AppHandle) {
    mousehook::set_revealed(false);
    // 重置顶部触发状态：隐藏后鼠标再放顶部/再拖拽都能重新唤出
    mousehook::reset_triggers();
    // 恢复条带窗口尺寸（右键菜单打开时可能临时加高过）
    place_window(&app);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn make_thumb(app: AppHandle, path: String, max_px: u32) -> serde_json::Value {
    match thumbs::make_thumb(&app, &path, max_px) {
        Ok(t) => serde_json::json!({
            "kind": t.kind,
            "w": t.w,
            "h": t.h,
            "b64": t.b64,
            "icon": t.icon_path,
        }),
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[tauri::command]
fn window_resized(app: AppHandle) {
    place_window(&app);
}

// ---------- 运行 ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            size: Mutex::new(SizeKey::Medium),
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_state,
            open_path,
            show_in_folder,
            save_to_folder,
            copy_to_clipboard,
            set_hit_rects,
            set_capture_override,
            make_thumb,
            window_resized,
            show_rope,
            hide_rope
        ])
        .setup(|app| {
            // 恢复卡片大小
            let st = read_state(app.handle());
            if let Some(s) = &st.size {
                *app.state::<AppState>().size.lock().unwrap() = SizeKey::from_str(s);
            }
            place_window(app.handle());
            // 初始完全穿透，等待前端上报命中区
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_ignore_cursor_events(true);
                // 预热：不激活地显示一次（窗口全透明 + 穿透 + 内容移出视口，用户无感），
                // 让 WebView2 完成首次渲染——深层子窗口（拖放目标）此刻才创建。
                // 1.5s 后隐藏；期间若已唤出（REVEALED）则不隐藏。
                // drop target 无需此刻安装：hide 时子窗口销毁注册随之作废，
                // 唤出时 show_rope 会延迟重装（幂等 + 存活性验证）
                if let Ok(h) = win.hwnd() {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
                    unsafe { let _ = ShowWindow(HWND(h.0 as *mut _), SW_SHOWNOACTIVATE); };
                }
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let app3 = app2.clone();
                    let _ = app2.run_on_main_thread(move || {
                        if !mousehook::is_revealed() {
                            if let Some(w) = app3.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    });
                });
            }
            build_tray(app.handle())?;
            clipboard::start_watcher(app.handle().clone());
            mousehook::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let app_state = app.state::<AppState>();
    let cur_size = app_state.size.lock().unwrap();
    let auto_on = app
        .state::<tauri_plugin_autostart::AutoLaunchManager>()
        .is_enabled()
        .unwrap_or(false);

    // --- 菜单项 ---
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机启动", true, auto_on, None::<&str>)?;
    let small = CheckMenuItem::with_id(app, "size-small", "小", true, *cur_size == SizeKey::Small, None::<&str>)?;
    let medium = CheckMenuItem::with_id(app, "size-medium", "中（默认）", true, *cur_size == SizeKey::Medium, None::<&str>)?;
    let large = CheckMenuItem::with_id(app, "size-large", "大", true, *cur_size == SizeKey::Large, None::<&str>)?;
    let help = MenuItem::with_id(app, "help", "使用说明", true, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let size_menu = Submenu::with_items(app, "卡片大小", true, &[&small, &medium, &large])?;
    let menu = Menu::with_items(app, &[&autostart, &sep, &size_menu, &help, &sep, &quit])?;
    drop(cur_size);
    drop(app_state);

    // 单选互斥需要持有各菜单项 handle
    let (small_h, medium_h, large_h) = (small.clone(), medium.clone(), large.clone());
    let autostart_h = autostart.clone();

    // 透明背景专用托盘图标（64px 优化版，嵌入二进制）
    let tray_icon =
        tauri::image::Image::from_bytes(include_bytes!("../icons/tray-64.png")).expect("tray icon");

    let tray = TrayIconBuilder::with_id("main")
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            match id.as_str() {
                "help" => {
                    // 弹出使用说明：由前端渲染与卡片同款的弹窗
                    let _ = app.emit("show-help", ());
                }
                "quit" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.hide();
                    }
                    app.exit(0);
                }
                "autostart" => {
                    let m = app.state::<tauri_plugin_autostart::AutoLaunchManager>();
                    let on = m.is_enabled().unwrap_or(false);
                    let r = if on { m.disable() } else { m.enable() };
                    if let Err(e) = r {
                        eprintln!("autostart: {e}");
                    }
                    let _ = autostart_h.set_checked(!on);
                }
                "size-small" | "size-medium" | "size-large" => {
                    let key = SizeKey::from_str(&id[5..]);
                    *app.state::<AppState>().size.lock().unwrap() = key;
                    place_window(app);
                    // 单选：仅当前项勾选
                    let _ = small_h.set_checked(key == SizeKey::Small);
                    let _ = medium_h.set_checked(key == SizeKey::Medium);
                    let _ = large_h.set_checked(key == SizeKey::Large);
                    let _ = app.emit("size-changed", key.as_str());
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                let _ = tray.app_handle().emit("tray-toggle", ());
            }
        })
        .build(app)?;
    let _ = tray.set_tooltip(Some("晾衣绳：双击显示/收起，右键菜单"));
    Ok(())
}
