//! OLE 拖放补注册：wry 只在 webview 初始化时对当时的子窗口注册 drop target，
//! WebView2 运行时后续创建的深层子窗口（Chrome_WidgetWin_1 / RenderWidgetHostHWND）
//! 未注册，OLE 的 WindowFromPoint 深层解析导致 drop 事件到不了应用。
//! 这里在前端就绪后枚举窗口树全部后代，统一 revoke + 注册自己的 IDropTarget，
//! drop 时提取文件路径直接发给前端。

use tauri::{AppHandle, Emitter, Manager};
use windows::{
    core::{implement, BOOL},
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
            WindowsAndMessaging::EnumChildWindows,
        },
    },
};

/// 防重复安装（dev 重载等场景）。
static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 拖拽悬停计数：主窗口与各子窗口都注册了 drop target，光标在其间移动时
/// enter/leave 交错到达，以计数 >0 表示"拖拽悬停在可放置区"（发给前端驱动绳子变色）。
static DRAG_DEPTH: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

type DropFn = dyn Fn(Vec<String>, &str, i32, i32);

/// 对主窗口全部后代子窗口注册统一的 drop target。必须在主线程（OLE STA）调用。
pub fn install(app: &AppHandle) {
    if INSTALLED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }

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
        // revoke 旧的（可能是 wry 注册的），再注册我们的
        let _ = unsafe { RevokeDragDrop(hwnd) };
        let target: IDropTarget = NativeDropTarget::new(hwnd, handler.clone()).into();
        if unsafe { RegisterDragDrop(hwnd, &target) }.is_ok() {
            // COM 引用移交 OLE：泄漏一个引用计数保住生命周期（进程退出统一回收）
            std::mem::forget(target);
        }
    };

    // 根窗口自身 + 全部后代
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

/// 从 IDataObject 提取 CF_HDROP 文件列表（返回 HDROP，调用方负责 DragFinish）。
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
    // STGMEDIUM 的 u.hGlobal 联合体字段
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
        // 探测是否携带文件；真实路径在 Drop 时提取
        if let Some(h) = unsafe { extract_hdrop(pDataObj.as_ref()) } {
            unsafe { DragFinish(h) };
            self.enter_valid.set(true);
            // 拖着文件进入可放置区：0→1 时通知前端（绳子变色反馈）
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
                // 归零（并防御计数异常为负）
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
        // Drop 后 OLE 不再调 DragLeave：主动结束悬停反馈
        if self.enter_valid.replace(false) {
            DRAG_DEPTH.store(0, std::sync::atomic::Ordering::SeqCst);
            (self.listener)(vec![], "leave", 0, 0);
        }
        Ok(())
    }
}
