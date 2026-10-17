//! 便笺文本拖出（把便笺文字拖进输入框 / 编辑器，松手即粘贴）。
//!
//! - Windows：tauri-plugin-drag 的 `DragItem::Data` 在 Windows 上是空实现
//!   （只做一次会被立即取消的假拖拽），这里自己用 OLE 的 `DoDragDrop` +
//!   自定义 `IDataObject` 提供 `CF_UNICODETEXT`。
//! - macOS：继续走 tauri-plugin-drag 的 `DragItem::Data`（NSPasteboard 类型
//!   public.utf8-plain-text），这里不需要实现。

#[cfg(windows)]
mod imp {
    use tauri::AppHandle;
    use windows::core::{implement, BOOL, HRESULT};
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, E_NOTIMPL, HGLOBAL, S_OK,
    };
    use windows::Win32::System::Com::{
        IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, FORMATETC,
        STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, CF_UNICODETEXT, DROPEFFECT,
        DROPEFFECT_COPY,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};

    /// 只提供 CF_UNICODETEXT 的最小 IDataObject（拖到输入框即可粘贴文字）。
    #[implement(IDataObject)]
    struct TextDataObject {
        /// UTF-16 文本，含结尾 \0
        wide: Vec<u16>,
    }

    impl TextDataObject {
        fn new(text: &str) -> Self {
            let mut wide: Vec<u16> = text.encode_utf16().collect();
            wide.push(0);
            Self { wide }
        }

        fn supported(pformatetc: *const FORMATETC) -> bool {
            match unsafe { pformatetc.as_ref() } {
                Some(f) => {
                    f.cfFormat == CF_UNICODETEXT.0
                        && (f.tymed as i32 & TYMED_HGLOBAL.0) != 0
                }
                None => false,
            }
        }

        unsafe fn to_hglobal(&self) -> windows::core::Result<HGLOBAL> {
            let bytes: Vec<u8> = self.wide.iter().flat_map(|u| u.to_le_bytes()).collect();
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
            let ptr = GlobalLock(h);
            if ptr.is_null() {
                let _ = GlobalUnlock(h);
                return Err(windows::core::Error::new(E_NOTIMPL, "内存分配失败"));
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            let _ = GlobalUnlock(h);
            Ok(h)
        }
    }

    #[allow(non_snake_case)]
    impl IDataObject_Impl for TextDataObject_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
            if !TextDataObject::supported(pformatetcin) {
                return Err(windows::core::Error::new(
                    E_NOTIMPL,
                    "不支持的剪贴板格式",
                ));
            }
            let h = unsafe { self.to_hglobal()? };
            Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: h },
                pUnkForRelease: std::mem::ManuallyDrop::new(None),
            })
        }

        fn GetDataHere(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *mut STGMEDIUM,
        ) -> windows::core::Result<()> {
            Err(windows::core::Error::new(E_NOTIMPL, ""))
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            if TextDataObject::supported(pformatetc) {
                S_OK
            } else {
                E_NOTIMPL
            }
        }

        fn GetCanonicalFormatEtc(
            &self,
            _pformatectin: *const FORMATETC,
            pformatetcout: *mut FORMATETC,
        ) -> HRESULT {
            if !pformatetcout.is_null() {
                unsafe { (*pformatetcout).ptd = std::ptr::null_mut() };
            }
            E_NOTIMPL
        }

        fn SetData(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *const STGMEDIUM,
            _frelease: BOOL,
        ) -> windows::core::Result<()> {
            Err(windows::core::Error::new(E_NOTIMPL, ""))
        }

        fn EnumFormatEtc(&self, _dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
            Err(windows::core::Error::new(E_NOTIMPL, ""))
        }

        fn DAdvise(
            &self,
            _pformatetc: *const FORMATETC,
            _advf: u32,
            _padvsink: windows::core::Ref<'_, IAdviseSink>,
        ) -> windows::core::Result<u32> {
            Err(windows::core::Error::new(E_NOTIMPL, ""))
        }

        fn DUnadvise(&self, _dwconnection: u32) -> windows::core::Result<()> {
            Err(windows::core::Error::new(E_NOTIMPL, ""))
        }

        fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
            Err(windows::core::Error::new(E_NOTIMPL, ""))
        }
    }

    #[implement(IDropSource)]
    struct TextDropSource(());

    #[allow(non_snake_case)]
    impl IDropSource_Impl for TextDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            if fescapepressed.as_bool() {
                DRAGDROP_S_CANCEL
            } else if (grfkeystate & MK_LBUTTON) == MODIFIERKEYS_FLAGS(0) {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// 同步发起一次文本拖拽（DoDragDrop 会阻塞直到松手 / 取消）。
    pub fn start_text_drag(_app: &AppHandle, text: &str) -> Result<(), String> {
        unsafe {
            // OLE 初始化可重复调用（同线程引用计数）
            OleInitialize(None).map_err(|e| format!("OLE 初始化失败：{e}"))?;
            let data: IDataObject = TextDataObject::new(text).into();
            let source: IDropSource = TextDropSource(()).into();
            let mut effect = DROPEFFECT::default();
            // 句柄必须活到 DoDragDrop 返回
            let _ = DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect);
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;
    /// 非 Windows 由前端直接走 tauri-plugin-drag 的 Data 拖放。
    pub fn start_text_drag(_app: &AppHandle, _text: &str) -> Result<(), String> {
        Err("该平台由前端插件负责文本拖拽".into())
    }
}

pub use imp::start_text_drag;
