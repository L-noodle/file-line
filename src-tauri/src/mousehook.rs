//! 低级鼠标钩子：动态切换窗口点击穿透 + 悬停事件 + 顶部拖拽检测。
//! 卡片命中区内可交互；其余全穿透（条带空白不吞鼠标，桌面内容正常 hover）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

struct Regions {
    rects: Vec<Rect>,
    panel_h: f64,
    win_w: f64,
    scale: f64,
}

static REGIONS: Mutex<Option<Regions>> = Mutex::new(None);
static CAPTURING: AtomicBool = AtomicBool::new(false);
static OVERRIDE: AtomicBool = AtomicBool::new(false);
static PANEL_HOVER: AtomicBool = AtomicBool::new(false);

/// 顶部拖拽检测：光标在主屏顶部且左键按住
static TOP_ACTIVE: AtomicBool = AtomicBool::new(false);
static TOP_SINCE: AtomicU64 = AtomicU64::new(0); // 0 = 未开始，否则为起始毫秒时间戳
static TOP_SHOWN: AtomicBool = AtomicBool::new(false);

/// 顶部悬停检测：光标（无需按键）停留在主屏顶部 20px 内
static HOVER_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOVER_SINCE: AtomicU64 = AtomicU64::new(0);
static HOVER_SHOWN: AtomicBool = AtomicBool::new(false);

enum Msg {
    Capture(bool),
    Hover(bool),
}
static TX: OnceLock<Sender<Msg>> = OnceLock::new();

/// 绳子隐藏时重置全部顶部触发状态，保证下次悬停/拖拽能重新触发。
pub fn reset_triggers() {
    TOP_ACTIVE.store(false, Ordering::SeqCst);
    TOP_SINCE.store(0, Ordering::SeqCst);
    TOP_SHOWN.store(false, Ordering::SeqCst);
    HOVER_ACTIVE.store(false, Ordering::SeqCst);
    HOVER_SINCE.store(0, Ordering::SeqCst);
    HOVER_SHOWN.store(false, Ordering::SeqCst);
}

/// 前端右键菜单等 UI 需要临时强制可交互。
pub fn set_override(on: bool) {
    OVERRIDE.store(on, Ordering::SeqCst);
    if on {
        if !CAPTURING.swap(true, Ordering::SeqCst) {
            if let Some(tx) = TX.get() {
                let _ = tx.send(Msg::Capture(true));
            }
        }
    }
}

/// 前端上报：卡片命中区（窗口逻辑坐标，窗口位于屏幕原点）+ 条带高度。
pub fn set_regions(app: &AppHandle, rects: Vec<(f64, f64, f64, f64)>, panel_h: f64) {
    let (scale, win_w) = app
        .get_webview_window("main")
        .map(|w| {
            let s = w.scale_factor().unwrap_or(1.0);
            let width = w
                .inner_size()
                .map(|sz| sz.width as f64 / s)
                .unwrap_or(1280.0);
            (s, width)
        })
        .unwrap_or((1.0, 1280.0));
    *REGIONS.lock().unwrap() = Some(Regions {
        rects: rects
            .into_iter()
            .map(|(x, y, w, h)| Rect { x, y, w, h })
            .collect(),
        panel_h,
        win_w,
        scale,
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Msg>();
    let _ = TX.set(tx);

    // 应用线程：执行窗口穿透切换 + hover 事件转发
    {
        let app = app.clone();
        std::thread::spawn(move || {
            while let Ok(msg) = rx.recv() {
                match msg {
                    Msg::Capture(capture) => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.set_ignore_cursor_events(!capture);
                        }
                    }
                    Msg::Hover(inside) => {
                        // 窗口隐藏时 hover 无意义，但前端会自行忽略；这里直接转发
                        let _ = app.emit("panel-hover", inside);
                    }
                }
            }
        });
    }

    // 顶部触发检测线程：按住左键停在顶部 100px 持续 0.3s，或光标悬停顶部 20px 持续 0.5s → 请求显示
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(60));
            if !TOP_SHOWN.load(Ordering::SeqCst) && TOP_ACTIVE.load(Ordering::SeqCst) {
                let since = TOP_SINCE.load(Ordering::SeqCst);
                if since > 0 && now_ms().saturating_sub(since) >= 300 {
                    if !TOP_SHOWN.swap(true, Ordering::SeqCst) {
                        let _ = app.emit("show-rope", ());
                    }
                }
            }
            if !HOVER_SHOWN.load(Ordering::SeqCst) && HOVER_ACTIVE.load(Ordering::SeqCst) {
                let since = HOVER_SINCE.load(Ordering::SeqCst);
                if since > 0 && now_ms().saturating_sub(since) >= 500 {
                    if !HOVER_SHOWN.swap(true, Ordering::SeqCst) {
                        let _ = app.emit("show-rope", ());
                    }
                }
            }
        });
    }

    // 钩子线程（需要消息泵）
    std::thread::spawn(|| unsafe {
        use windows::Win32::UI::WindowsAndMessaging::*;
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("mouse hook failed: {e}");
                return;
            }
        };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    });
}

fn in_rect(px: f64, py: f64, r: &Rect) -> bool {
    px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
}

unsafe extern "system" fn hook_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, HC_ACTION, LLMHF_INJECTED, MSLLHOOKSTRUCT};

    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let injected = (info.flags & LLMHF_INJECTED) != 0;
        let msg = wparam.0 as u32;
        // 移动/按键才判断；注入事件忽略，避免程序化输入干扰
        let interesting = matches!(
            msg,
            0x0200 | 0x0201 | 0x0202 | 0x0204 | 0x0205 | 0x0206 | 0x0207 | 0x0208 | 0x020A | 0x020B
        );
        if interesting && !injected {
            let left_down = msg == 0x0201 // WM_LBUTTONDOWN
                || (msg == 0x0200 && (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0);

            let (px, py) = (info.pt.x as f64, info.pt.y as f64);
            let over = OVERRIDE.load(Ordering::SeqCst);
            let guard = REGIONS.lock().unwrap();
            let (capture, in_win, top_zone, hover_zone) = if let Some(r) = guard.as_ref() {
                let (lx, ly) = (px / r.scale, py / r.scale);
                let hit = r.rects.iter().any(|rc| in_rect(lx, ly, rc));
                let in_win = ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                // 顶部拖拽区：主屏顶部 100 物理像素
                let top_zone = px >= 0.0 && py >= 0.0 && py < 100.0 && px <= r.win_w * r.scale;
                // 顶部悬停区：主屏顶部 20 逻辑像素（无需按键）
                let hover_zone = px >= 0.0 && ly >= 0.0 && ly < 20.0 && px <= r.win_w * r.scale;
                (hit, in_win, top_zone, hover_zone)
            } else {
                (false, false, false, false)
            };
            drop(guard);

            // 拖拽中（左键按住，含外部拖文件进来）：条带内强制接收鼠标事件，
            // 否则窗口穿透会让 OLE 拖放目标解析不到 WebView2，drop 落不进来
            let capture = over || capture || (left_down && in_win);
            if CAPTURING.load(Ordering::SeqCst) != capture {
                CAPTURING.store(capture, Ordering::SeqCst);
                if let Some(tx) = TX.get() {
                    let _ = tx.send(Msg::Capture(capture));
                }
            }
            if PANEL_HOVER.load(Ordering::SeqCst) != in_win {
                PANEL_HOVER.store(in_win, Ordering::SeqCst);
                if let Some(tx) = TX.get() {
                    let _ = tx.send(Msg::Hover(in_win));
                }
            }

            // 顶部拖拽状态机（左键按住；整个条带均算"拖到顶部"，0.3s 触发）
            if left_down && (top_zone || in_win) {
                if TOP_SINCE.load(Ordering::SeqCst) == 0 {
                    TOP_SINCE.store(now_ms(), Ordering::SeqCst);
                }
                TOP_ACTIVE.store(true, Ordering::SeqCst);
            } else {
                TOP_ACTIVE.store(false, Ordering::SeqCst);
                TOP_SINCE.store(0, Ordering::SeqCst);
                TOP_SHOWN.store(false, Ordering::SeqCst);
            }

            // 顶部悬停状态机（无需按键，按住左键时交给拖拽状态机）
            if !left_down && hover_zone {
                if HOVER_SINCE.load(Ordering::SeqCst) == 0 {
                    HOVER_SINCE.store(now_ms(), Ordering::SeqCst);
                }
                HOVER_ACTIVE.store(true, Ordering::SeqCst);
            } else {
                HOVER_ACTIVE.store(false, Ordering::SeqCst);
                HOVER_SINCE.store(0, Ordering::SeqCst);
                HOVER_SHOWN.store(false, Ordering::SeqCst);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}
