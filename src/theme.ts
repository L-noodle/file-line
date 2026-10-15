import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Theme = "light" | "dark";

/** 是否运行在 Tauri 容器里（浏览器 dev 下只有 matchMedia 可用） */
export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mediaQuery = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** WebView 自己认为的主题（浏览器 dev / 兜底来源） */
export const mediaTheme = (): Theme =>
  mediaQuery()?.matches ? "dark" : "light";

/**
 * 落地主题：CSS 全部以 <html data-theme> 分支，不再依赖
 * prefers-color-scheme 媒体查询（Windows WebView2 / macOS WebView
 * 的媒体查询可能与系统主题不一致，导致暗色下仍是浅色样式）。
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * 跟踪系统主题：
 * - Tauri：以原生 getCurrentWindow().theme() 为准（Windows / macOS 都准确），
 *   并监听 onThemeChanged 实时切换；
 * - 浏览器：退回 matchMedia 的 prefers-color-scheme 变化。
 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(mediaTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // WebView 媒体查询（兜底 + 浏览器预览）
  useEffect(() => {
    const mq = mediaQuery();
    if (!mq) return;
    const onChange = (e: { matches: boolean }) =>
      setTheme(e.matches ? "dark" : "light");
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  // 原生主题（优先级更高，覆盖媒体查询的结果）
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const win = getCurrentWindow();
    win
      .theme()
      .then((t) => {
        if (!disposed && t) setTheme(t);
      })
      .catch(() => {});
    win
      .onThemeChanged(({ payload }) => setTheme(payload))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return theme;
}
