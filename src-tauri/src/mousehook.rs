//! 动态切换窗口点击穿透 + 悬停事件 + 顶部拖拽检测。
//! 卡片命中区内可交互；其余全穿透（条带空白不吞鼠标，桌面内容正常 hover）。
//!
//! - Windows：全局低级鼠标钩子（WH_MOUSE_LL）+ 消息泵，外加轮询线程做顶部触发。
//! - macOS：NSEvent 轮询（mouseLocation / pressedMouseButtons），无需辅助功能权限，
//!   等价于 Windows 的轮询线程，并据此切换点击穿透。

#[cfg(target_os = "macos")]
use std::ffi::c_void;
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
    // Windows 路径做物理→逻辑坐标转换时读取（r.scale）；macOS 光标坐标已是逻辑点，
    // 不读。结构体跨平台赋值（set_hit_rects），无法用 cfg 守卫字段本身，故仅抑制非 Windows 的 dead_code。
    #[cfg_attr(not(windows), allow(dead_code))]
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

/// 顶部拖拽检测：光标进入顶部触发区且左键按住（Win 贴顶 / mac 顶部 20px），
/// 进入即唤出；已唤出后条带内拖拽仅维持状态。TOP_SHOWN 为防重复 emit 的锁。
static TOP_SHOWN: AtomicBool = AtomicBool::new(false);

/// 顶部悬停检测：光标（无需按键）停留在主屏顶部 20px 内
static HOVER_ACTIVE: AtomicBool = AtomicBool::new(false);
static HOVER_SINCE: AtomicU64 = AtomicU64::new(0);
static HOVER_SHOWN: AtomicBool = AtomicBool::new(false);

/// 全局左键按下起点（Windows 物理像素 / macOS 逻辑点）。
/// 鼠标钩子层面拿不到 OLE 拖拽 payload（那只有拖放目标窗口能收到），
/// 只能用启发式排除非文件场景：
/// - 点击浏览器 tab/标题栏：起点就在顶部触发区内、几乎无位移 → 排除；
/// - 拖动窗口：前台进入移动循环（fg_in_move_size）→ 排除；
/// - 拖动浏览器 tab：不进系统移动循环，但起点在标签栏（顶部）→ 被起点排除覆盖；
/// - 真正拖文件：从条带外部拖入、有明显位移 → 放行。
static DRAG_ORIGIN: Mutex<Option<(f64, f64)>> = Mutex::new(None);
/// 按下起点到当前光标的最小位移（像素），低于它视为点击而非拖拽
const DRAG_MOVE_PX: f64 = 20.0;

enum Msg {
    Capture(bool),
    Hover(bool),
    /// 条带区域内滚轮（dx/dy：与前端 WheelEvent 增量同向）
    Wheel { dx: i32, dy: i32 },
    /// 条带区域内鼠标逻辑坐标（Dock 放大联动；None = 离开条带）
    Mouse { pos: Option<(f64, f64)> },
}
static TX: OnceLock<Sender<Msg>> = OnceLock::new();

/// 往应用线程发消息（窗口穿透切换 / 事件转发都走这里，避免在非主线程直接操作窗口）。
/// 仅 macOS CGEventTap 回调使用（Windows 钩子路径内联发送）。
#[cfg(target_os = "macos")]
fn tx_send(msg: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(msg);
    }
}

/// 上次转发给前端的条带内鼠标位置（节流：移动 ≥1 逻辑像素或进出条带才发）
static LAST_MOUSE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// 绳子隐藏时重置全部顶部触发状态，保证下次悬停/拖拽能重新触发。
pub fn reset_triggers() {
    TOP_SHOWN.store(false, Ordering::SeqCst);
    HOVER_ACTIVE.store(false, Ordering::SeqCst);
    HOVER_SINCE.store(0, Ordering::SeqCst);
    HOVER_SHOWN.store(false, Ordering::SeqCst);
    // 若残留「可命中」状态（如拖拽收起瞬间的竞态），恢复鼠标穿透：
    // 否则隐藏/收起中的条带会吃掉下方窗口在顶部区域的点击与拖拽
    if CAPTURING.swap(false, Ordering::SeqCst) {
        if let Some(tx) = TX.get() {
            let _ = tx.send(Msg::Capture(false));
        }
    }
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
    } else if !REVEALED.load(Ordering::SeqCst) {
        // 面板已收起 / 隐藏：立刻恢复穿透，不等下一次鼠标事件。
        // 否则残留的强制交互态会让「看不见」的条带继续吞掉下方窗口的
        // 点击与拖动（升级/收起瞬间尤其容易被感知成"拖不动窗口"）
        if CAPTURING.swap(false, Ordering::SeqCst) {
            if let Some(tx) = TX.get() {
                let _ = tx.send(Msg::Capture(false));
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

fn in_rect(px: f64, py: f64, r: &Rect) -> bool {
    px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
}

/// 启动：应用线程（穿透切换 + 事件转发）始终运行；
/// 平台特定的全局鼠标监听分别在 Windows / macOS 中实现。
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
                        let _ = app.emit("panel-hover", inside);
                    }
                    Msg::Wheel { dx, dy } => {
                        let _ = app.emit("panel-wheel", (dx, dy));
                    }
                    Msg::Mouse { pos } => {
                        let _ = app.emit("panel-mouse", pos);
                    }
                }
            }
        });
    }

    #[cfg(windows)]
    start_windows(app);
    #[cfg(target_os = "macos")]
    start_macos(app);
}

// ======================================================================
// Windows：全局 LL 钩子 + 轮询线程
// ======================================================================

#[cfg(windows)]
fn start_windows(app: AppHandle) {
    // 顶部触发检测线程：主动轮询光标位置与左键状态，而非依赖鼠标消息驱动。
    // 光标贴屏幕最顶端静止时消息流可能中断（坐标钳位/注入过滤等），
    // 轮询保证悬停 1s 计时稳定进行。
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

                // 按下起点跟踪：钩子侧事件级记录为主，此处沿检测兜底
                // （钩子缺失或漏事件时最多滞后一个采样周期，不影响判定）
                {
                    let mut origin = DRAG_ORIGIN.lock().unwrap();
                    if lbutton {
                        if origin.is_none() {
                            *origin = Some((px, py));
                        }
                    } else {
                        *origin = None;
                    }
                }

                let (in_win, hover_zone, edge_zone, drag_entered) = {
                    let guard = REGIONS.lock().unwrap();
                    guard
                        .as_ref()
                        .map(|r| {
                            let (lx, ly) = (px / r.scale, py / r.scale);
                            let in_win = ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                            // 悬停触发区：主屏最顶端 2 物理像素内（停留 1s 唤出）
                            let hover_zone = px >= 0.0 && py >= 0.0 && py <= 2.0 && px <= r.win_w * r.scale;
                            // 拖拽触发区：顶部 50 逻辑像素内，拖入即唤出
                            let edge_zone = ly >= 0.0 && ly <= 20.0 && lx >= 0.0 && lx <= r.win_w;
                            // 「拖入」手势：按下起点在顶部触发区之外（点击/拖动浏览器
                            // 标签栏、标题栏的起点都在顶部条带内，不属于拖入文件），
                            // 且从按下点已实际拖动（排除原地点击与手抖微移）
                            let drag_entered = DRAG_ORIGIN
                                .lock()
                                .unwrap()
                                .map(|(sx, sy)| {
                                    let moved =
                                        ((px - sx) * (px - sx) + (py - sy) * (py - sy)).sqrt();
                                    sy / r.scale > 50.0 && moved >= DRAG_MOVE_PX
                                })
                                .unwrap_or(false);
                            (in_win, hover_zone, edge_zone, drag_entered)
                        })
                        .unwrap_or((false, false, false, false))
                };

                // 顶部拖拽状态机：拖拽文件从条带外拖入顶部触发区立即唤出；
                // 已唤出后条带内（in_win）拖拽仅维持状态不重复触发，
                // 松开时钩子侧 in_win 保持接收事件，放置区域不变
                if left_down && edge_zone && drag_entered {
                    if !TOP_SHOWN.swap(true, Ordering::SeqCst) {
                        let _ = app.emit("show-rope", ());
                    }
                } else if !(left_down && in_win) {
                    TOP_SHOWN.store(false, Ordering::SeqCst);
                }

                // 顶部悬停状态机（无需按键，按住左键/拖动窗口时交给拖拽状态机）
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

/// 前台线程是否处于窗口移动/缩放模态循环（正在拖动标题栏/窗口边缘）。
/// 拖动窗口经过屏幕顶部（含 Windows 贴边分屏手势）时不应唤出晾衣绳；
/// 拖拽文件（OLE）不会进入该循环，两者由此区分。
#[cfg(windows)]
fn fg_in_move_size() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetGUIThreadInfo, GUITHREADINFO, GUI_INMOVESIZE,
    };
    let mut info = GUITHREADINFO::default();
    info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    unsafe { GetGUIThreadInfo(0, &mut info).is_ok() && (info.flags & GUI_INMOVESIZE).0 != 0 }
}

#[cfg(windows)]
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

        // 滚轮（WM_MOUSEWHEEL / WM_MOUSEHWHEEL）：面板显示时，条带内可滚动，
        // 或光标正压在卡片上（卡片接管全部事件）→ 由本应用消费并转发前端，
        // 不穿透到底下的桌面窗口，避免下方的页面/列表跟着滚
        if !injected && (msg == 0x020A || msg == 0x020B) {
            let wheel = {
                let guard = REGIONS.lock().unwrap();
                guard.as_ref().and_then(|r| {
                    let (lx, ly) = (info.pt.x as f64 / r.scale, info.pt.y as f64 / r.scale);
                    let in_win =
                        ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                    let on_card = r.rects.iter().any(|rc| in_rect(lx, ly, rc));
                    if in_win && (r.scrollable || on_card) && REVEALED.load(Ordering::SeqCst) {
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
        // 左键按下/抬起：事件级精确记录全局按下起点（物理像素）。
        // 轮询线程据此判定「拖入文件」——起点在顶部条带内的按住（点击/拖动
        // 浏览器标签栏、标题栏）不是拖入；事件级记录无采样延迟，
        // 避免快速甩动 tab 时起点被 60ms 轮询记到条带外造成误判
        if !injected && (msg == 0x0201 || msg == 0x0202) {
            let mut origin = DRAG_ORIGIN.lock().unwrap();
            if msg == 0x0201 {
                *origin = Some((info.pt.x as f64, info.pt.y as f64));
            } else {
                *origin = None;
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
            // 拖动其他软件的窗口（前台线程进入移动/缩放循环）不是拖文件：
            // 与轮询线程一致排除，否则条带会在收起动画期间挡住下方窗口的拖拽
            let drag_file = left_down && !fg_in_move_size();

            let (px, py) = (info.pt.x as f64, info.pt.y as f64);
            let over = OVERRIDE.load(Ordering::SeqCst);
            let revealed = REVEALED.load(Ordering::SeqCst);
            let guard = REGIONS.lock().unwrap();
            let (hit, in_win, lx, ly) = if let Some(r) = guard.as_ref() {
                let (lx, ly) = (px / r.scale, py / r.scale);
                let hit = r.rects.iter().any(|rc| in_rect(lx, ly, rc));
                let in_win = ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                (hit, in_win, lx, ly)
            } else {
                (false, false, 0.0, 0.0)
            };
            drop(guard);

            // 仅在面板已唤出（REVEALED）时条带才可命中：
            // - 拖文件中（drag_file）条带内强制接收鼠标事件，否则窗口穿透
            //   会让 OLE 拖放目标解析不到 WebView2，drop 落不进来；
            // - 卡片命中区（hit）同样门控，避免隐藏后残留的 rects 吞点击；
            // - 强制交互（over，右键菜单 / 说明弹窗拖动）也必须门控：它可能被
            //   异常路径残留成 true，若不受 revealed 约束，收起后的条带会一直
            //   处于可命中状态，把下方窗口的点击与拖动整片吞掉。
            // 面板隐藏 / 收起动画期间一律穿透，顶部区域的点击与
            // 拖拽（含拖其他软件窗口）直达下方窗口
            let capture = revealed && (over || hit || (drag_file && in_win));
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

            // Dock 放大联动：面板显示时光标在条带内 → 转发逻辑坐标；
            // 离开条带 → None（前端把全部卡片缩回）。节流避免 IPC 洪泛。
            let mouse_pos = if REVEALED.load(Ordering::SeqCst) && in_win {
                Some((lx, ly))
            } else {
                None
            };
            let mouse_changed = {
                let mut last = LAST_MOUSE.lock().unwrap();
                let changed = match (*last, mouse_pos) {
                    (None, None) => false,
                    (Some((x0, y0)), Some((x1, y1))) => {
                        (x1 - x0).abs() >= 1.0 || (y1 - y0).abs() >= 1.0
                    }
                    _ => true,
                };
                if changed {
                    *last = mouse_pos;
                }
                changed
            };
            if mouse_changed {
                if let Some(tx) = TX.get() {
                    let _ = tx.send(Msg::Mouse { pos: mouse_pos });
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

// ======================================================================
// macOS：NSEvent 轮询（mouseLocation / pressedMouseButtons）
// ======================================================================

#[cfg(target_os = "macos")]
static APP: OnceLock<AppHandle> = OnceLock::new();
#[cfg(target_os = "macos")]
static TAP_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn start_macos(app: AppHandle) {
    let _ = APP.set(app.clone());
    // 优先用 CGEventTap 做精细穿透（事件分发前判断命中区，仅卡片截点击，
    // 其余透传下方窗口，对齐 Windows）。需要「辅助功能 / 输入监控」授权；
    // 未授权时回退到轮询粗粒度方案，并通过事件提示用户去授权。
    if ensure_tap(&app) {
        return;
    }
    let _ = app.emit("mac-tap-denied", ());
    start_macos_poll(app);
}

/// 未获授权时的粗粒度回退方案（保留原行为：面板显示时整条面板不可穿透）。
#[cfg(target_os = "macos")]
fn start_macos_poll(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        loop {
            // 后续授权生效：退出轮询，改由 CGEventTap 精细驱动
            if TAP_ACTIVE.load(Ordering::SeqCst) {
                break;
            }
            // 20ms：没有事件钩子时只能轮询，间隔越短，鼠标压到卡片上后窗口
            // 越快从穿透态切回可交互（点击/滚轮不再漏给下方窗口）
            std::thread::sleep(std::time::Duration::from_millis(20));

            // macOS 全局坐标原点在「主屏左下角、y 向上」，这里翻转为与窗口一致的
            // 「左上角、y 向下」逻辑坐标（Core Graphics 点，已含 Retina 缩放）。
            let (lx, ly) = mouse_pos_logical();
            let lbutton = pressed_left_button();

            // 按下起点跟踪（沿检测；tap 版由事件级记录，两者共用同一状态）
            {
                let mut origin = DRAG_ORIGIN.lock().unwrap();
                if lbutton {
                    if origin.is_none() {
                        *origin = Some((lx, ly));
                    }
                } else {
                    *origin = None;
                }
            }

            let (in_win, hover_zone, edge_zone, drag_entered) = {
                let guard = REGIONS.lock().unwrap();
                guard
                    .as_ref()
                    .map(|r| {
                        // macOS 光标坐标已是逻辑点，无需除以 scale。
                        // 悬停触发区：最顶端 2 逻辑像素内（停留 1s 唤出）；
                        // 拖拽触发区：顶部 20 逻辑像素内，拖入即唤出
                        let in_win = ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                        let hover_zone = ly >= 0.0 && ly <= 2.0 && lx >= 0.0 && lx <= r.win_w;
                        let edge_zone = ly >= 0.0 && ly <= 20.0 && lx >= 0.0 && lx <= r.win_w;
                        // 「拖入」手势：按下起点在顶部触发区外且已实际拖动
                        // （与 Windows 一致：点击/拖动窗口标题栏、标签栏不算拖入）
                        let drag_entered = DRAG_ORIGIN
                            .lock()
                            .unwrap()
                            .map(|(sx, sy)| {
                                let moved =
                                    ((lx - sx) * (lx - sx) + (ly - sy) * (ly - sy)).sqrt();
                                sy > 20.0 && moved >= DRAG_MOVE_PX
                            })
                            .unwrap_or(false);
                        (in_win, hover_zone, edge_zone, drag_entered)
                    })
                    .unwrap_or((false, false, false, false))
            };

            // 顶部拖拽状态机：拖拽文件从条带外拖入顶部触发区立即唤出；
            // 已唤出后条带内（in_win）拖拽仅维持状态不重复触发，
            // 松开时轮询侧 in_win 保持接收事件，放置区域不变
            if lbutton && edge_zone && drag_entered {
                if !TOP_SHOWN.swap(true, Ordering::SeqCst) {
                    let _ = app.emit("show-rope", ());
                }
            } else if !(lbutton && in_win) {
                TOP_SHOWN.store(false, Ordering::SeqCst);
            }

            // 顶部悬停状态机（无需按键）
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

            if !HOVER_SHOWN.load(Ordering::SeqCst) && HOVER_ACTIVE.load(Ordering::SeqCst) {
                let since = HOVER_SINCE.load(Ordering::SeqCst);
                if since > 0 && now_ms().saturating_sub(since) >= 500 {
                    if !HOVER_SHOWN.swap(true, Ordering::SeqCst) {
                        let _ = app.emit("show-rope", ());
                    }
                }
            }

            // 命中区判定：光标落在某个卡片矩形内 → 可交互（不穿透）
            let over = OVERRIDE.load(Ordering::SeqCst);
            let hit = {
                let guard = REGIONS.lock().unwrap();
                guard
                    .as_ref()
                    .map(|r| r.rects.iter().any(|rc| in_rect(lx, ly, rc)))
                    .unwrap_or(false)
            };
            // 精细穿透（与 CGEventTap 分支对齐）：只拦截卡片命中区 / 覆盖层 / 面板内按住
            // 左键拖拽，其余区域一律透传下方窗口。不再用「面板显示即整条不可穿透」，
            // 否则绳子收起后（尤其 hover 触发把它重新唤出时）顶部整条会吞掉下方窗口的点击。
            // 卡片命中区 REGIONS.rects 由前端实时上报，这里直接复用即可做到精细穿透。
            // 面板收起后（revealed=false）一律穿透，残留的强制交互态也不例外。
            let capture = REVEALED.load(Ordering::SeqCst) && (over || hit || (lbutton && in_win));
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

            // Dock 放大联动：面板显示时光标在条带内 → 转发逻辑坐标；离开 → None
            let mouse_pos = if REVEALED.load(Ordering::SeqCst) && in_win {
                Some((lx, ly))
            } else {
                None
            };
            let mouse_changed = {
                let mut last = LAST_MOUSE.lock().unwrap();
                let changed = match (*last, mouse_pos) {
                    (None, None) => false,
                    (Some((x0, y0)), Some((x1, y1))) => {
                        (x1 - x0).abs() >= 1.0 || (y1 - y0).abs() >= 1.0
                    }
                    _ => true,
                };
                if changed {
                    *last = mouse_pos;
                }
                changed
            };
            if mouse_changed {
                if let Some(tx) = TX.get() {
                    let _ = tx.send(Msg::Mouse { pos: mouse_pos });
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct NSPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGRect {
    origin: NSPoint,
    size: CGSize,
}

/// 当前鼠标在「主屏为基准、左上角原点、y 向下」的逻辑坐标（CG 点）。
#[cfg(target_os = "macos")]
unsafe fn mouse_pos_logical() -> (f64, f64) {
    use objc::class;
    use objc::msg_send;
    use objc::sel;
    use objc::sel_impl;
    use objc::runtime::Object;

    let point: NSPoint = msg_send![class!(NSEvent), mouseLocation];
    let screens: *mut Object = msg_send![class!(NSScreen), screens];
    let n: usize = msg_send![screens, count];
    let primary: *mut Object =
        if n > 0 { msg_send![screens, objectAtIndex: 0usize] } else { std::ptr::null_mut() };
    let h = if !primary.is_null() {
        let frame: CGRect = msg_send![primary, frame];
        frame.size.height
    } else {
        0.0
    };
    (point.x, h - point.y)
}

/// 当前是否按住鼠标左键（bit 0）。
#[cfg(target_os = "macos")]
unsafe fn pressed_left_button() -> bool {
    use objc::class;
    use objc::msg_send;
    use objc::sel;
    use objc::sel_impl;
    let buttons: usize = msg_send![class!(NSEvent), pressedMouseButtons];
    (buttons & 1) != 0
}

// ======================================================================
// macOS 精细点击穿透：Core Graphics 事件钩子（等价 Windows 的 WH_MOUSE_LL）
// 在事件分发前判断命中区：仅卡片 / 覆盖层 / 面板内拖拽截点击，其余透传下方窗口。
// 需要「辅助功能 / 输入监控」授权；未授权时 start_macos 已回退到轮询粗粒度方案。
// ======================================================================

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGEventTapCreate(
        tapLocation: u32,
        place: u32,
        options: u32,
        eventsOfInterest: u64,
        callback: CGEventTapCallBack,
        userInfo: *mut c_void,
    ) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: u8);
    fn CGEventTapIsEnabled(tap: *mut c_void) -> u8;
    fn CFMachPortCreateRunLoopSource(allocator: *mut c_void, port: *mut c_void, order: i32)
        -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *mut c_void);
    fn CFRunLoopRun();
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *mut c_void) -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopCommonModes: *mut c_void;
    static kCFAllocatorDefault: *mut c_void;
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
type CGEventTapCallBack = extern "C" fn(
    proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    user_info: *mut c_void,
) -> *mut c_void;

#[cfg(target_os = "macos")]
mod cg_consts {
    pub const LEFT_DOWN: u32 = 1;
    pub const LEFT_UP: u32 = 2;
    pub const RIGHT_DOWN: u32 = 3;
    pub const RIGHT_UP: u32 = 4;
    pub const MOUSE_MOVED: u32 = 5;
    pub const SCROLL_WHEEL: u32 = 22;
    pub const OTHER_DOWN: u32 = 25;
    pub const OTHER_UP: u32 = 26;
    pub const BUTTON_STATE: u32 = 11;
    pub const WHEEL_AXIS1: u32 = 88;
    pub const WHEEL_AXIS2: u32 = 89;
    pub const SESSION_TAP: u32 = 1;
    pub const HEAD_INSERT: u32 = 0;
    pub const TAP_OPTION_DEFAULT: u32 = 0;
}

/// 事件钩子回调：在事件分发前判定命中区并切换穿透；返回原事件放行，
/// 仅面板内滚轮（可滚动时）返回 NULL 吞掉，交前端处理。
#[cfg(target_os = "macos")]
extern "C" fn cg_tap_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    _user_info: *mut c_void,
) -> *mut c_void {
    use cg_consts::*;
    unsafe {
    let pt = CGEventGetLocation(event);
    let (lx, ly) = (pt.x, pt.y);
    let lbutton = (CGEventGetIntegerValueField(event, BUTTON_STATE) & 1) != 0;

    // 按下起点跟踪：事件级精确记录（LEFT_DOWN/LEFT_UP），
    // 沿检测兜底（漏 DOWN 事件时最多滞后一个事件）
    if event_type == LEFT_DOWN {
        *DRAG_ORIGIN.lock().unwrap() = Some((lx, ly));
    } else if event_type == LEFT_UP {
        *DRAG_ORIGIN.lock().unwrap() = None;
    } else {
        let mut origin = DRAG_ORIGIN.lock().unwrap();
        if lbutton {
            if origin.is_none() {
                *origin = Some((lx, ly));
            }
        } else {
            *origin = None;
        }
    }

    let (in_win, hover_zone, edge_zone, drag_entered, hit, scrollable, revealed) = {
        let guard = REGIONS.lock().unwrap();
        match guard.as_ref() {
            Some(r) => {
                let in_win = ly >= 0.0 && ly <= r.panel_h && lx >= 0.0 && lx <= r.win_w;
                // 悬停触发区：最顶端 2 逻辑像素内（停留 1s 唤出）；
                // 拖拽触发区：顶部 20 逻辑像素内，拖入即唤出
                let hover_zone = ly >= 0.0 && ly <= 2.0 && lx >= 0.0 && lx <= r.win_w;
                let edge_zone = ly >= 0.0 && ly <= 20.0 && lx >= 0.0 && lx <= r.win_w;
                // 「拖入」手势：按下起点在顶部触发区外且已实际拖动
                // （与 Windows 一致：点击/拖动窗口标题栏、标签栏不算拖入）
                let drag_entered = DRAG_ORIGIN
                    .lock()
                    .unwrap()
                    .map(|(sx, sy)| {
                        let moved = ((lx - sx) * (lx - sx) + (ly - sy) * (ly - sy)).sqrt();
                        sy > 20.0 && moved >= DRAG_MOVE_PX
                    })
                    .unwrap_or(false);
                let hit = r.rects.iter().any(|rc| in_rect(lx, ly, rc));
                (
                    in_win,
                    hover_zone,
                    edge_zone,
                    drag_entered,
                    hit,
                    r.scrollable,
                    REVEALED.load(Ordering::SeqCst),
                )
            }
            None => (false, false, false, false, false, false, false),
        }
    };

    // 顶部拖拽状态机（与轮询版一致）：拖拽文件从条带外拖入顶部触发区立即唤出；
    // 已唤出后条带内（in_win）拖拽仅维持状态不重复触发，放置区域不变
    if lbutton && edge_zone && drag_entered {
        if !TOP_SHOWN.swap(true, Ordering::SeqCst) {
            if let Some(app) = APP.get() {
                let _ = app.emit("show-rope", ());
            }
        }
    } else if !(lbutton && in_win) {
        TOP_SHOWN.store(false, Ordering::SeqCst);
    }
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
    if !HOVER_SHOWN.load(Ordering::SeqCst) && HOVER_ACTIVE.load(Ordering::SeqCst) {
        let since = HOVER_SINCE.load(Ordering::SeqCst);
        if since > 0 && now_ms().saturating_sub(since) >= 500 {
            if !HOVER_SHOWN.swap(true, Ordering::SeqCst) {
                if let Some(app) = APP.get() {
                    let _ = app.emit("show-rope", ());
                }
            }
        }
    }

    // 精细穿透：仅卡片命中区 / 覆盖层 / 面板内按住左键拖拽时截点击，其余透传下方窗口；
    // 面板收起（revealed=false）后一律穿透，残留的强制交互态也不例外
    let over = OVERRIDE.load(Ordering::SeqCst);
    let capture = revealed && (over || hit || (lbutton && in_win));
    if CAPTURING.load(Ordering::SeqCst) != capture {
        CAPTURING.store(capture, Ordering::SeqCst);
        tx_send(Msg::Capture(capture));
    }
    if PANEL_HOVER.load(Ordering::SeqCst) != in_win {
        PANEL_HOVER.store(in_win, Ordering::SeqCst);
        tx_send(Msg::Hover(in_win));
    }

    // Dock 放大联动
    let mouse_pos = if revealed && in_win {
        Some((lx, ly))
    } else {
        None
    };
    let mouse_changed = {
        let mut last = LAST_MOUSE.lock().unwrap();
        let changed = match (*last, mouse_pos) {
            (None, None) => false,
            (Some((x0, y0)), Some((x1, y1))) => {
                (x1 - x0).abs() >= 1.0 || (y1 - y0).abs() >= 1.0
            }
            _ => true,
        };
        if changed {
            *last = mouse_pos;
        }
        changed
    };
    if mouse_changed {
        tx_send(Msg::Mouse { pos: mouse_pos });
    }

    // 滚轮：面板内可滚动，或光标正压在卡片上时由本应用消费并转发前端，
    // 避免下方窗口同时滚动（卡片接管全部事件，不再穿透）
    if event_type == SCROLL_WHEEL && revealed && in_win && (scrollable || hit) {
        let dy = CGEventGetIntegerValueField(event, WHEEL_AXIS1);
        let dx = CGEventGetIntegerValueField(event, WHEEL_AXIS2);
        tx_send(Msg::Wheel {
            dx: dx as i32,
            dy: -dy as i32,
        });
        return std::ptr::null_mut();
    }

    event
    }
}

/// 创建并启动 CGEventTap（精细穿透）。已生效或成功则返回 true。
#[cfg(target_os = "macos")]
fn ensure_tap(app: &AppHandle) -> bool {
    if TAP_ACTIVE.load(Ordering::SeqCst) {
        return true;
    }
    // 未授权则无法创建有效事件 tap（CGEventTapIsEnabled 会为 false）
    if unsafe { AXIsProcessTrusted() } == 0 {
        return false;
    }
    let events: u64 = (1u64 << cg_consts::LEFT_DOWN)
        | (1u64 << cg_consts::LEFT_UP)
        | (1u64 << cg_consts::RIGHT_DOWN)
        | (1u64 << cg_consts::RIGHT_UP)
        | (1u64 << cg_consts::MOUSE_MOVED)
        | (1u64 << cg_consts::SCROLL_WHEEL)
        | (1u64 << cg_consts::OTHER_DOWN)
        | (1u64 << cg_consts::OTHER_UP);
    let tap = unsafe {
        CGEventTapCreate(
            cg_consts::SESSION_TAP,
            cg_consts::HEAD_INSERT,
            cg_consts::TAP_OPTION_DEFAULT,
            events,
            cg_tap_callback,
            std::ptr::null_mut(),
        )
    };
    if tap.is_null() {
        return false;
    }
    unsafe { CGEventTapEnable(tap, 1) };
    if unsafe { CGEventTapIsEnabled(tap) } == 0 {
        return false;
    }
    // 裸指针非 Send，先转 usize 再跨线程，避免 move 捕获指针
    let tap_addr = tap as usize;
    std::thread::spawn(move || unsafe {
        let tap = tap_addr as *mut c_void;
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
        if !source.is_null() {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        }
        CFRunLoopRun();
    });
    TAP_ACTIVE.store(true, Ordering::SeqCst);
    let _ = app;
    true
}

/// 弹出系统授权框请求「辅助功能 / 输入监控」权限；授权成功后即时启用精细穿透。
#[cfg(target_os = "macos")]
pub fn mac_request_permission(app: &AppHandle) -> bool {
    unsafe {
        let _ = prompt_trust();
    }
    let trusted = unsafe { AXIsProcessTrusted() } != 0;
    if trusted && !TAP_ACTIVE.load(Ordering::SeqCst) {
        ensure_tap(app);
    }
    trusted
}

#[cfg(not(target_os = "macos"))]
pub fn mac_request_permission(_app: &AppHandle) -> bool {
    true
}

#[cfg(target_os = "macos")]
unsafe fn prompt_trust() -> bool {
    use objc::class;
    use objc::msg_send;
    use objc::runtime::Object;
    use objc::sel;
    use objc::sel_impl;
    let key: *mut Object = msg_send![class!(NSString), stringWithUTF8String: b"AXTrustedCheckOptionPrompt\0".as_ptr() as *const i8];
    let val: *mut Object = msg_send![class!(NSNumber), numberWithBool: 1i8];
    let dict_class = class!(NSDictionary);
    let dict: *mut Object =
        msg_send![dict_class, dictionaryWithObject: val forKey: key];
    AXIsProcessTrustedWithOptions(dict as *mut c_void) != 0
}
