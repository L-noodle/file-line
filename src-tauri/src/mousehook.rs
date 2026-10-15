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
    /// 有折叠堆叠（滚轮可滚动可见窗口）
    scrollable: bool,
}

static REGIONS: Mutex<Option<Regions>> = Mutex::new(None);
static CAPTURING: AtomicBool = AtomicBool::new(false);
static OVERRIDE: AtomicBool = AtomicBool::new(false);
static PANEL_HOVER: AtomicBool = AtomicBool::new(false);
/// 面板是否显示（show_rope / hide_rope 同步），滚轮拦截仅在显示时生效。
static REVEALED: AtomicBool = AtomicBool::new(false);

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
    /// 条带区域内滚轮（dx/dy：与前端 WheelEvent 增量同向）
    Wheel { dx: i32, dy: i32 },
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

/// 面板显示 / 隐藏（show_rope / hide_rope 命令调用处同步）。
pub fn set_revealed(on: bool) {
    REVEALED.store(on, Ordering::SeqCst);
}

/// 面板当前是否显示（启动预热结束时判断是否该隐藏窗口）。
pub fn is_revealed() -> bool {
    REVEALED.load(Ordering::SeqCst)
}

/// 前端上报：卡片命中区（窗口逻辑坐标，窗口位于屏幕原点）+ 条带高度 + 是否可滚动。
pub fn set_regions(
    app: &AppHandle,
    rects: Vec<(f64, f64, f64, f64)>,
    panel_h: f64,
    scrollable: bool,
) {
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
        scrollable,
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 前台线程是否处于窗口移动/缩放模态循环（正在拖动标题栏/窗口边缘）。
/// 拖动窗口经过屏幕顶部（含 Windows 贴边分屏手势）时不应唤出晾衣绳；
/// 拖拽文件（OLE）不会进入该循环，两者由此区分。
fn fg_in_move_size() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetGUIThreadInfo, GUITHREADINFO, GUI_INMOVESIZE,
    };
    let mut info = GUITHREADINFO::default();
    info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    unsafe { GetGUIThreadInfo(0, &mut info).is_ok() && (info.flags & GUI_INMOVESIZE).0 != 0 }
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
                    Msg::Wheel { dx, dy } => {
                        // 条带区域内的滚轮穿透捕获：转发给前端滚动卡片
                        let _ = app.emit("panel-wheel", (dx, dy));
                    }
                }
            }
        });
    }

    // 顶部触发检测线程：主动轮询光标位置与左键状态，而非依赖鼠标消息驱动。
    // 光标贴屏幕最顶端静止时消息流可能中断（坐标钳位/注入过滤等），
    // 轮询保证悬停 0.5s / 拖拽 0.3s 计时稳定进行。
    {
        let app = app.clone();
        std::thread::spawn(move || unsafe {
            use windows::Win32::Foundation::POINT;
            use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
            use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

            loop {
                std::thread::sleep(std::time::Duration::from_millis(60));

                let mut pt = POINT::default();
                if GetCursorPos(&mut pt).is_err() {
                    continue;
                }
                let (px, py) = (pt.x as f64, pt.y as f64);
                let lbutton = (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0;
                // 拖动窗口（前台线程处于移动/缩放循环）不算拖入文件，晾衣绳不出现
                let left_down = lbutton && !fg_in_move_size();

                let (in_win, top_zone, hover_zone, edge_zone) = {
                    let guard = REGIONS.lock().unwrap();
                    guard
                        .as_ref()
                        .map(|r| {
                            let (lx, ly) = (px / r.scale, py / r.scale);
                            let in_win = ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                            // 顶部拖拽区：主屏顶部 100 物理像素
                            let top_zone = px >= 0.0 && py >= 0.0 && py < 100.0 && px <= r.win_w * r.scale;
                            // 顶部悬停区：主屏顶部 20 逻辑像素（无需按键）
                            let hover_zone = px >= 0.0 && ly >= 0.0 && ly < 20.0 && px <= r.win_w * r.scale;
                            // 贴边区：主屏最顶端 2 物理像素内
                            let edge_zone = px >= 0.0 && py >= 0.0 && py <= 2.0 && px <= r.win_w * r.scale;
                            (in_win, top_zone, hover_zone, edge_zone)
                        })
                        .unwrap_or((false, false, false, false))
                };

                // 顶部拖拽状态机：贴到屏幕最顶端（≤2px）立即唤出，
                // 其余顶部区域/条带内停留 0.3s 才触发
                if left_down && edge_zone {
                    TOP_SINCE.store(now_ms(), Ordering::SeqCst);
                    TOP_ACTIVE.store(true, Ordering::SeqCst);
                    if !TOP_SHOWN.swap(true, Ordering::SeqCst) {
                        let _ = app.emit("show-rope", ());
                    }
                } else if left_down && (top_zone || in_win) {
                    if TOP_SINCE.load(Ordering::SeqCst) == 0 {
                        TOP_SINCE.store(now_ms(), Ordering::SeqCst);
                    }
                    TOP_ACTIVE.store(true, Ordering::SeqCst);
                } else {
                    TOP_ACTIVE.store(false, Ordering::SeqCst);
                    TOP_SINCE.store(0, Ordering::SeqCst);
                    TOP_SHOWN.store(false, Ordering::SeqCst);
                }

                // 顶部悬停状态机（无需按键，按住左键/拖动窗口时交给拖拽状态机）
                // 注意用真实按键状态 lbutton：拖动窗口时 left_down 已被置 false，
                // 若用 !left_down 会让悬停计时误启动
                if !lbutton && hover_zone {
                    if HOVER_SINCE.load(Ordering::SeqCst) == 0 {
                        HOVER_SINCE.store(now_ms(), Ordering::SeqCst);
                    }
                    HOVER_ACTIVE.store(true, Ordering::SeqCst);
                } else {
                    HOVER_ACTIVE.store(false, Ordering::SeqCst);
                    HOVER_SINCE.store(0, Ordering::SeqCst);
                    HOVER_SHOWN.store(false, Ordering::SeqCst);
                }

                if !TOP_SHOWN.load(Ordering::SeqCst) && TOP_ACTIVE.load(Ordering::SeqCst) {
                    let since = TOP_SINCE.load(Ordering::SeqCst);
                    // 拖文件进顶部是明确意图：停留 150ms 即唤出，
                    // 缩短"窗口还在显示中就松手导致 drop 落空"的时间窗
                    if since > 0 && now_ms().saturating_sub(since) >= 150 {
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
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, HC_ACTION, LLMHF_INJECTED, MSLLHOOKSTRUCT};

    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let injected = (info.flags & LLMHF_INJECTED) != 0;
        let msg = wparam.0 as u32;

        // 滚轮（WM_MOUSEWHEEL / WM_MOUSEHWHEEL）：面板显示且有堆叠时，
        // 条带区域内滚轮由本应用消费并转发前端，不穿透到底下的桌面窗口
        if !injected && (msg == 0x020A || msg == 0x020B) {
            let wheel = {
                let guard = REGIONS.lock().unwrap();
                guard.as_ref().and_then(|r| {
                    let (lx, ly) = (info.pt.x as f64 / r.scale, info.pt.y as f64 / r.scale);
                    let in_win =
                        ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                    if in_win && r.scrollable && REVEALED.load(Ordering::SeqCst) {
                        // mouseData 高 16 位为有符号 delta；正 = 向上/向右，
                        // 映射到前端 WheelEvent 的 deltaY / deltaX 方向
                        let delta = ((info.mouseData >> 16) & 0xFFFF) as u16 as i16 as i32;
                        Some(if msg == 0x020A { (0, -delta) } else { (delta, 0) })
                    } else {
                        None
                    }
                })
            };
            if let Some((dx, dy)) = wheel {
                if let Some(tx) = TX.get() {
                    let _ = tx.send(Msg::Wheel { dx, dy });
                }
                return LRESULT(1); // 拦截，避免底下的窗口同时滚动
            }
        }
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
            let (capture, in_win) = if let Some(r) = guard.as_ref() {
                let (lx, ly) = (px / r.scale, py / r.scale);
                let hit = r.rects.iter().any(|rc| in_rect(lx, ly, rc));
                let in_win = ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                (hit, in_win)
            } else {
                (false, false)
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
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}
