mod clipboard;
mod filedrop;
mod mousehook;
mod textdrag;
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
            "medium" => SizeKey::Medium,
            "large" => SizeKey::Large,
            _ => SizeKey::Small,
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
    /// 条带高度：photoMaxHeight(104*scale) + 118，与前端一致。
    /// 118 的余量要容下卡片两行文件名 + Dock 放大 1.2 后的卡片底部，
    /// 否则鼠标移入放大时卡片底部会被窗口裁掉（小档最紧张）。
    pub fn panel_height(&self) -> f64 {
        (104.0 * self.scale()).round() + 118.0
    }
}

pub struct AppState {
    pub size: Mutex<SizeKey>,
    /// 隐藏入口卡片开关（托盘菜单勾选态的内存事实源）。
    /// 不能依赖菜单项 is_checked()：Windows 点击时系统会先自动翻转勾选态，
    /// 读到的已是新值，取反会得到旧值（点了没反应）。这里显式维护并显式 set_checked
    pub hide_entry_cards: Mutex<bool>,
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
/// - 文件 / 文件夹卡片：{ path, source }
/// - 便笺卡片：{ note_id }（正文存在 notes 里，卡片只是挂在绳上的一份视图）
/// - 待办卡片：{ todo_id }（内容存在 todos 里）
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum PersistedItem {
    Full {
        path: String,
        #[serde(default)]
        source: String,
    },
    Note {
        #[serde(alias = "noteId")]
        note_id: String,
    },
    Todo {
        #[serde(alias = "todoId")]
        todo_id: String,
    },
    Countdown {
        #[serde(alias = "countdownId")]
        countdown_id: String,
    },
    Path(String),
}

impl PersistedItem {
    fn path(&self) -> Option<&str> {
        match self {
            PersistedItem::Full { path, .. } => Some(path),
            PersistedItem::Path(p) => Some(p),
            PersistedItem::Note { .. } | PersistedItem::Todo { .. } => None,
            PersistedItem::Countdown { .. } => None,
        }
    }
    fn note_id(&self) -> Option<&str> {
        match self {
            PersistedItem::Note { note_id } => Some(note_id),
            _ => None,
        }
    }
    fn todo_id(&self) -> Option<&str> {
        match self {
            PersistedItem::Todo { todo_id } => Some(todo_id),
            _ => None,
        }
    }
    fn countdown_id(&self) -> Option<&str> {
        match self {
            PersistedItem::Countdown { countdown_id } => Some(countdown_id),
            _ => None,
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

/// 便笺（笔记本数据），与绳子上的卡片独立：卡片取下不影响便笺本体。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct PersistedNote {
    id: String,
    #[serde(default)]
    text: String,
    #[serde(default, alias = "updatedAt")]
    updated_at: i64,
    #[serde(default, alias = "createdAt")]
    created_at: i64,
    /// 置顶：固定到笔记本列表顶部
    #[serde(default)]
    pinned: bool,
}

/// 待办（笔记本数据），与绳子上的卡片独立：卡片取下不影响待办本体。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct PersistedTodo {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default, alias = "startAt")]
    start_at: i64,
    #[serde(default, alias = "endAt")]
    end_at: i64,
    #[serde(default)]
    repeat: bool,
    #[serde(default, alias = "remindStart")]
    remind_start: Option<i64>,
    #[serde(default, alias = "remindEnd")]
    remind_end: Option<i64>,
    #[serde(default)]
    done: bool,
    #[serde(default, alias = "updatedAt")]
    updated_at: i64,
    #[serde(default, alias = "createdAt")]
    created_at: i64,
    #[serde(default)]
    pinned: bool,
}

/// 另存为时落地的便笺 txt（文件名由前端按内容前 10 字 + 序号算出）。
#[derive(serde::Deserialize)]
struct NoteFile {
    name: String,
    text: String,
}

/// 倒计时（笔记本数据），与绳子上的卡片独立：卡片取下不影响倒计时本体。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct PersistedCountdown {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default, alias = "endAt")]
    end_at: i64,
    #[serde(default, alias = "updatedAt")]
    updated_at: i64,
    #[serde(default, alias = "createdAt")]
    created_at: i64,
    #[serde(default)]
    pinned: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Persisted {
    #[serde(default)]
    items: Vec<PersistedItem>,
    size: Option<String>,
    /// 隐藏晾衣绳上的特殊入口卡片（便笺管理入口），托盘菜单勾选
    #[serde(default, alias = "hideEntryCards")]
    hide_entry_cards: bool,
    #[serde(default)]
    notes: Vec<PersistedNote>,
    #[serde(default)]
    todos: Vec<PersistedTodo>,
    #[serde(default)]
    countdowns: Vec<PersistedCountdown>,
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
            "noteId": i.note_id(),
            "todoId": i.todo_id(),
            "countdownId": i.countdown_id(),
        })).collect::<Vec<_>>(),
        "size": p.size,
        "hideEntryCards": p.hide_entry_cards,
        "notes": p.notes.iter().map(|n| serde_json::json!({
            "id": n.id,
            "text": n.text,
            "updatedAt": n.updated_at,
            "createdAt": n.created_at,
            "pinned": n.pinned,
        })).collect::<Vec<_>>(),
        "todos": p.todos.iter().map(|t| serde_json::json!({
            "id": t.id,
            "title": t.title,
            "text": t.text,
            "startAt": t.start_at,
            "endAt": t.end_at,
            "repeat": t.repeat,
            "remindStart": t.remind_start,
            "remindEnd": t.remind_end,
            "done": t.done,
            "updatedAt": t.updated_at,
            "createdAt": t.created_at,
            "pinned": t.pinned,
        })).collect::<Vec<_>>(),
        "countdowns": p.countdowns.iter().map(|c| serde_json::json!({
            "id": c.id,
            "title": c.title,
            "text": c.text,
            "endAt": c.end_at,
            "updatedAt": c.updated_at,
            "createdAt": c.created_at,
            "pinned": c.pinned,
        })).collect::<Vec<_>>(),
    })
}

#[tauri::command]
fn save_state(
    app: AppHandle,
    items: Vec<PersistedItem>,
    notes: Vec<PersistedNote>,
    todos: Vec<PersistedTodo>,
    countdowns: Vec<PersistedCountdown>,
    hide_entry_cards: bool,
) {
    let size = app.state::<AppState>().size.lock().unwrap().as_str().to_string();
    write_state(
        &app,
        &Persisted {
            items,
            size: Some(size),
            hide_entry_cards,
            notes,
            todos,
            countdowns,
        },
    );
}

/// 待办提醒：只把窗口显示出来。前端 React 的 revealed 仍为 false
/// （绳子保持收起，仅展示消息本身），但 Rust 侧必须置 revealed=true——
/// Windows 钩子的命中区捕获受 revealed 门控，否则提醒消息收不到点击。
/// 关闭提醒时前端调 hide_rope 复位。
#[tauri::command]
fn show_reminder_window(app: AppHandle) {
    mousehook::set_revealed(true);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    }
}

/// 默认程序打开。
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open_with_shell(&path)
}

/// 在文件管理器中定位文件。文件夹则直接打开。
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    show_in_folder_impl(&path)
}

#[cfg(windows)]
fn show_in_folder_impl(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if p.is_dir() {
        return open_with_shell(path);
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

#[cfg(target_os = "macos")]
fn show_in_folder_impl(path: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", path])
        .status()
        .map(|_| ())
        .map_err(|e| format!("无法定位 {}: {}", path, e))
}

#[cfg(windows)]
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

#[cfg(target_os = "macos")]
fn open_with_shell(path: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map(|_| ())
        .map_err(|e| format!("无法打开 {}: {}", path, e))
}

/// 全部另存为：在用户选择的文件夹内新建「晾衣绳 + 年月日时分秒」子文件夹，
/// 把绳子上的全部文件复制进去（重名自动加序号），完成后打开该子文件夹。
#[tauri::command]
fn save_to_folder(
    paths: Vec<String>,
    folder: String,
    notes: Vec<NoteFile>,
) -> Result<String, String> {
    let base = PathBuf::from(&folder);
    if !base.is_dir() {
        return Err(format!("目标文件夹不存在：{folder}"));
    }
    // 子文件夹名：晾衣绳 + 年月日时分秒（本地时间）
    let stamp = chrono::Local::now().format("晾衣绳%Y%m%d%H%M%S");
    let dst_dir = base.join(format!("{stamp}"));
    fs::create_dir_all(&dst_dir).map_err(|e| format!("创建文件夹失败：{e}"))?;
    for n in &notes {
        let file = unique_path(&dst_dir, &format!("{}.txt", sanitize_file_name(&n.name)));
        fs::write(&file, n.text.as_bytes()).map_err(|e| format!("写入便笺失败：{e}"))?;
    }
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

/// 去掉文件名里的非法字符（Windows / macOS 通用），空名回退为「便笺」。
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        "便笺".to_string()
    } else {
        cleaned
    }
}

/// 同目录下重名自动加序号（xxx (2).txt）。
fn unique_path(dir: &PathBuf, file_name: &str) -> PathBuf {
    let mut dst = dir.join(file_name);
    if !dst.exists() {
        return dst;
    }
    let stem = PathBuf::from(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = PathBuf::from(file_name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()));
    let mut i = 2;
    while dst.exists() {
        let nn = match &ext {
            Some(e) => format!("{} ({}){}", stem, i, e),
            None => format!("{} ({})", stem, i),
        };
        dst = dir.join(nn);
        i += 1;
    }
    dst
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

/// 便笺单击复制：写入纯文本（拖进输入框即可粘贴）。
#[tauri::command]
fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    clipboard::copy_text_to_clipboard(&text)
}

/// 把便笺正文作为文本拖出（Windows 自己走 OLE；macOS 由前端插件负责）。
#[tauri::command]
fn drag_text(app: AppHandle, text: String) -> Result<(), String> {
    textdrag::start_text_drag(&app, &text)
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

/// 真正把条带窗口从屏幕上撤掉（Windows 兜底）。
///
/// tao 的 `set_visible` 走 `WindowState::apply_diff`：算出的窗口标志与缓存一致时
/// 直接 return（见 tao-0.37 `platform_impl/windows/window_state.rs` 的 `apply_diff`
/// 开头 `if diff.is_empty() { return }`）。而启动预热为了让 WebView2 先渲染一次，
/// 用裸 `ShowWindow(SW_SHOWNOACTIVATE)` 显示了窗口，绕过了 tao 的缓存 ——
/// 缓存里 VISIBLE 仍是 false，于是随后的 `win.hide()` 是**空操作**：
/// 收起后条带窗口（全宽、置顶、~200px 高）一直留在屏幕顶上，只能靠
/// WS_EX_TRANSPARENT 假装不存在。一旦命中区/强制交互状态出现任何残留，
/// 这块"看不见"的条带就会吞掉下方窗口的点击与拖动。
///
/// 这里先调 tao 的 `hide()`（把缓存标志同步成 false），再补一次裸 SW_HIDE，
/// 保证无论缓存状态如何，窗口都真的从屏幕上消失且状态自洽（不会影响下次 show）。
#[cfg(windows)]
fn force_hide(win: &tauri::WebviewWindow) {
    let _ = win.hide();
    if let Ok(h) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
        unsafe {
            let _ = ShowWindow(HWND(h.0 as *mut _), SW_HIDE);
        }
    }
}

#[cfg(not(windows))]
fn force_hide(win: &tauri::WebviewWindow) {
    let _ = win.hide();
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
        force_hide(&win);
    }
}

/// 收起动画开始（不是结束）就立刻转回完全穿透。
///
/// 收起动画有 1.33s，这期间条带窗口仍在屏幕上：若等动画结束才 `hide_rope`，
/// 这段时间内的拖拽（尤其"拖入文件"分支会把整条条带变成可命中）会拦住
/// 下方窗口的点击与拖动。这里提前把 revealed 置 false 并复位触发状态，
/// 让整条条带在整个滑出过程里都是穿透的。
#[tauri::command]
fn collapse_rope(app: AppHandle) {
    let _ = app;
    mousehook::set_revealed(false);
    mousehook::reset_triggers();
}

/// 待办提醒展示期间绳子收起：不隐藏窗口、不缩回条带高度（提醒消息
/// 要继续显示且窗口已临时全屏化），但与 hide_rope 同样复位顶部触发
/// 状态，并保持 revealed=true（Windows 命中区捕获的门控，消息必须可点）。
#[tauri::command]
fn collapse_rope_keep_window(app: AppHandle) {
    let _ = app;
    mousehook::set_revealed(true);
    mousehook::reset_triggers();
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

/// 把应用激活到前台。
/// macOS：crabnebula 的 start_drag 在应用未激活时拉不起原生拖拽会话
/// （首拖/切到别的 App 再拖会失败），这里在拖拽手势开始时主动激活；
/// Windows 用 SetForegroundWindow 置前，其余平台空实现。
#[cfg(target_os = "macos")]
#[tauri::command]
fn activate_app(_app: AppHandle) {
    use objc::class;
    use objc::msg_send;
    use objc::runtime::Object;
    use objc::sel;
    use objc::sel_impl;
    unsafe {
        let app_inst: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app_inst, activateIgnoringOtherApps: objc::runtime::YES];
    }
}

#[cfg(windows)]
#[tauri::command]
fn activate_app(app: AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(h) = win.hwnd() {
            let hwnd = HWND(h.0 as *mut _);
            unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
fn activate_app(_app: AppHandle) {}

/// 请求 macOS「辅助功能 / 输入监控」授权以启用精细点击穿透（未授权时自动回退粗粒度方案）。
#[tauri::command]
fn request_mac_permission(app: AppHandle) -> bool {
    mousehook::mac_request_permission(&app)
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
            size: Mutex::new(SizeKey::Small),
            hide_entry_cards: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_state,
            open_path,
            show_in_folder,
            save_to_folder,
            copy_to_clipboard,
            copy_text_to_clipboard,
            drag_text,
            set_hit_rects,
            set_capture_override,
            make_thumb,
            window_resized,
            show_rope,
            hide_rope,
            collapse_rope,
            collapse_rope_keep_window,
            show_reminder_window,
            activate_app,
            request_mac_permission
        ])
        .setup(|app| {
            // 恢复卡片大小
            let st = read_state(app.handle());
            if let Some(s) = &st.size {
                *app.state::<AppState>().size.lock().unwrap() = SizeKey::from_str(s);
            }
            // 恢复「隐藏入口卡片」开关（托盘菜单勾选态）
            *app.state::<AppState>().hide_entry_cards.lock().unwrap() = st.hide_entry_cards;
            place_window(app.handle());
            // 初始完全穿透，等待前端上报命中区
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_ignore_cursor_events(true);
                // 预热：不激活地显示一次（窗口全透明 + 穿透 + 内容移出视口，用户无感），
                // 让 WebView2 完成首次渲染——深层子窗口（拖放目标）此刻才创建。
                // 1.5s 后隐藏；期间若已唤出（REVEALED）则不隐藏。
                // drop target 无需此刻安装：hide 时子窗口销毁注册随之作废，
                // 唤出时 show_rope 会延迟重装（幂等 + 存活性验证）
                #[cfg(windows)]
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
                                // 预热用的是裸 ShowWindow，tao 缓存的 VISIBLE 仍是 false，
                                // 这里必须走 force_hide 才能真正撤掉窗口（否则它会一直
                                // 置顶留在屏幕顶部那片区域里）
                                force_hide(&w);
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
    let small = CheckMenuItem::with_id(app, "size-small", "小（默认）", true, *cur_size == SizeKey::Small, None::<&str>)?;
    let medium = CheckMenuItem::with_id(app, "size-medium", "中", true, *cur_size == SizeKey::Medium, None::<&str>)?;
    let large = CheckMenuItem::with_id(app, "size-large", "大", true, *cur_size == SizeKey::Large, None::<&str>)?;
    let help = MenuItem::with_id(app, "help", "使用说明", true, None::<&str>)?;
    // 便笺功能入口：置顶（使用说明之上），绳子没唤出时由前端一并唤出
    let note_new = MenuItem::with_id(app, "note-new", "新增便笺", true, None::<&str>)?;
    let note_open = MenuItem::with_id(app, "note-open", "打开笔记本", true, None::<&str>)?;
    // 隐藏入口卡片：勾选后收起晾衣绳上的特殊入口卡片（便笺管理入口）。
    // 勾选态取内存开关（setup 时已从持久化恢复），不读 is_checked()
    let hide_entry = CheckMenuItem::with_id(
        app,
        "hide-entry-cards",
        "隐藏入口卡片",
        true,
        *app_state.hide_entry_cards.lock().unwrap(),
        None::<&str>,
    )?;
    // 待办入口：与便笺同款（新建待办 + 挂卡片 + 编辑窗）
    let todo_new = MenuItem::with_id(app, "todo-new", "新增待办", true, None::<&str>)?;
    // 倒计时入口：与待办同款（新建倒计时 + 挂卡片 + 编辑窗）
    let countdown_new = MenuItem::with_id(app, "countdown-new", "新增倒计时", true, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let size_menu = Submenu::with_items(app, "卡片大小", true, &[&small, &medium, &large])?;
    let menu = Menu::with_items(
        app,
        &[
            &note_new, &todo_new, &countdown_new, &note_open, &hide_entry, &sep, &help, &sep,
            &size_menu, &autostart, &sep, &quit,
        ],
    )?;
    drop(cur_size);
    drop(app_state);

    // 单选互斥需要持有各菜单项 handle
    let (small_h, medium_h, large_h) = (small.clone(), medium.clone(), large.clone());
    let autostart_h = autostart.clone();
    let hide_entry_h = hide_entry.clone();

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
                "note-new" => {
                    // 新增便笺：前端建便笺、挂卡片并弹出编辑窗
                    let _ = app.emit("tray-new-note", ());
                }
                "todo-new" => {
                    // 新增待办：前端建待办、挂卡片并弹出编辑窗
                    let _ = app.emit("tray-new-todo", ());
                }
                "countdown-new" => {
                    // 新增倒计时：前端建倒计时、挂卡片并弹出编辑窗
                    let _ = app.emit("tray-new-countdown", ());
                }
                "note-open" => {
                    // 打开笔记本（便笺管理器）
                    let _ = app.emit("tray-open-notebook", ());
                }
                "hide-entry-cards" => {
                    // 隐藏入口卡片：翻转内存开关，显式落到目标勾选态
                    // （Windows 点击时系统已自动翻转过菜单勾选态，不能读 is_checked 取反），
                    // 再通知前端（前端负责即时收起/恢复入口卡片并持久化）
                    let on = {
                        let st = app.state::<AppState>();
                        let mut cur = st.hide_entry_cards.lock().unwrap();
                        *cur = !*cur;
                        *cur
                    };
                    let _ = hide_entry_h.set_checked(on);
                    let _ = app.emit("hide-entry-cards", on);
                }
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
