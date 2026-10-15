//! 拖放目标注册。
//!
//! - Windows：wry 只在 webview 初始化时对当时的子窗口注册 drop target，WebView2
//!   后续创建的深层子窗口（Chrome_WidgetWin_1 / RenderWidgetHostHWND）未注册，需
//!   枚举窗口树统一补注册自己的 IDropTarget（OLE 实现）。
//! - macOS：WebKit 原生处理 HTML5 / 文件拖放，前端通过 Tauri 的 onDragDropEvent
//!   已能直接接收，无需额外注册，这里为空实现。

#[cfg(windows)]
mod imp {
    use tauri::{AppHandle, Emitter, Manager};
    use windows::{
        core::{implement, w, BOOL},
        Win32::{
            Foundation::{HWND, LPARAM, POINT, POINTL},
            Graphics::Gdi::ScreenToClient,
            System::{
                Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
                Ole::{
                    IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP,
                    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
                },
                SystemServices::MODIFIERKEYS_FLAGS,
            },
            UI::{
                Shell::{DragFinish, DragQueryFileW, HDROP},
                WindowsAndMessaging::{EnumChildWindows, GetPropW},
            },
        },
    };

    /// 已注册 drop target 的窗口（HWND 数值）。install 可重复调用：
    /// WebView2 在窗口显示 / 隐藏循环中会销毁并重建深层子窗口，且 HWND 高概率复用。
    /// 窗口销毁时 OLE 注册自动失效，故 REGISTERED 命中时还须用 OLE 的窗口属性
    /// （OleDropTargetInterface）验证注册仍存活，失效则重新注册。
    static REGISTERED: std::sync::Mutex<Vec<isize>> = std::sync::Mutex::new(Vec::new());

    /// 拖拽悬停计数：主窗口与各子窗口都注册了 drop target，光标在其间移动时
    /// enter/leave 交错到达，以计数 >0 表示"拖拽悬停在可放置区"（发给前端驱动绳子变色）。
    static DRAG_DEPTH: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

    type DropFn = dyn Fn(Vec<String>, &str, i32, i32);

    /// 对主窗口全部后代子窗口注册统一的 drop target。必须在主线程（OLE STA）调用。
    /// 可重复调用：只注册 REGISTERED 中不存在的新窗口。
    pub fn install(app: &AppHandle) {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let Ok(root) = win.hwnd() else {
            return;
        };
        let root = HWND(root.0 as *mut _);

        let app = app.clone();
        let handler: std::rc::Rc<DropFn> =
            std::rc::Rc::new(move |paths: Vec<String>, ty: &str, x: i32, y: i32| {
                let _ = app.emit(
                    "native-drop",
                    serde_json::json!({ "paths": paths, "type": ty, "x": x, "y": y }),
                );
            });

        let register = |hwnd: HWND, handler: &std::rc::Rc<DropFn>| {
            let key = hwnd.0 as isize;
            {
                let mut reg = REGISTERED.lock().unwrap();
                if reg.contains(&key) {
                    let alive = unsafe {
                        GetPropW(hwnd, w!("OleDropTargetInterface")).0 as isize != 0
                    };
                    if alive {
                        return;
                    }
                } else {
                    reg.push(key);
                }
            }
            let _ = unsafe { RevokeDragDrop(hwnd) };
            let target: IDropTarget = NativeDropTarget::new(hwnd, handler.clone()).into();
            if unsafe { RegisterDragDrop(hwnd, &target) }.is_ok() {
                std::mem::forget(target);
            }
        };

        register(root, &handler);
        unsafe {
            let cb = |hwnd: HWND, handler: &std::rc::Rc<DropFn>| {
                register(hwnd, handler);
                true
            };
            let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut |h| cb(h, &handler);
            let lparam = LPARAM(&mut trait_obj as *mut &mut dyn FnMut(HWND) -> bool as isize);
            let _ = EnumChildWindows(Some(root), Some(enum_cb), lparam);
        }
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let f = &mut *(lparam.0 as *mut &mut dyn FnMut(HWND) -> bool);
        f(hwnd).into()
    }

    unsafe fn extract_hdrop(data: Option<&IDataObject>) -> Option<HDROP> {
        let obj = data?;
        let fmt = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let medium = obj.GetData(&fmt).ok()?;
        let hglobal = medium.u.hGlobal;
        Some(HDROP(hglobal.0 as *mut _))
    }

    unsafe fn collect_paths(hdrop: HDROP) -> Vec<String> {
        let n = DragQueryFileW(hdrop, u32::MAX, None);
        let mut out = Vec::new();
        for i in 0..n {
            let len = DragQueryFileW(hdrop, i, None);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let copied = DragQueryFileW(hdrop, i, Some(&mut buf));
            out.push(String::from_utf16_lossy(&buf[..copied as usize]));
        }
        out
    }

    #[implement(IDropTarget)]
    pub struct NativeDropTarget {
        hwnd: HWND,
        listener: std::rc::Rc<DropFn>,
        enter_valid: std::cell::Cell<bool>,
    }

    impl NativeDropTarget {
        pub fn new(hwnd: HWND, listener: std::rc::Rc<DropFn>) -> Self {
            Self {
                hwnd,
                listener,
                enter_valid: std::cell::Cell::new(false),
            }
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for NativeDropTarget_Impl {
        fn DragEnter(
            &self,
            pDataObj: windows_core::Ref<'_, IDataObject>,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            if let Some(h) = unsafe { extract_hdrop(pDataObj.as_ref()) } {
                unsafe { DragFinish(h) };
                self.enter_valid.set(true);
                let prev = DRAG_DEPTH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if prev == 0 {
                    (self.listener)(vec![], "enter", 0, 0);
                }
            } else {
                self.enter_valid.set(false);
            }
            unsafe {
                *pdwEffect = if self.enter_valid.get() {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
            Ok(())
        }

        fn DragOver(
            &self,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            unsafe {
                *pdwEffect = if self.enter_valid.get() {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
            Ok(())
        }

        fn DragLeave(&self) -> windows::core::Result<()> {
            if self.enter_valid.replace(false) {
                let prev = DRAG_DEPTH.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                if prev <= 1 {
                    DRAG_DEPTH.store(0, std::sync::atomic::Ordering::SeqCst);
                    if prev == 1 {
                        (self.listener)(vec![], "leave", 0, 0);
                    }
                }
            }
            Ok(())
        }

        fn Drop(
            &self,
            pDataObj: windows_core::Ref<'_, IDataObject>,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            _pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let mut p = POINT { x: pt.x, y: pt.y };
            let _ = unsafe { ScreenToClient(self.hwnd, &mut p) };

            if let Some(h) = unsafe { extract_hdrop(pDataObj.as_ref()) } {
                let paths = unsafe { collect_paths(h) };
                unsafe { DragFinish(h) };
                if !paths.is_empty() {
                    (self.listener)(paths, "drop", p.x, p.y);
                }
            }
            if self.enter_valid.replace(false) {
                DRAG_DEPTH.store(0, std::sync::atomic::Ordering::SeqCst);
                (self.listener)(vec![], "leave", 0, 0);
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use tauri::AppHandle;
    /// macOS 下 WebKit 原生处理拖放，无需 OLE 补注册。
    pub fn install(_app: &AppHandle) {}
}

pub use imp::install;
