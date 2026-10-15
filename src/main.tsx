import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, mediaTheme } from "./theme";
import "./styles.css";

// 首帧前先用 WebView 已知的主题落地，避免渲染瞬间闪一下浅色
applyTheme(mediaTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
