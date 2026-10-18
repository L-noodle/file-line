import type { Item } from "../types";

// 卡片内容：图片 / 文件夹 / 文件。PeggedCard 与折叠堆叠（OverflowFan）共用，
// 保证两种场景下的卡片视觉完全一致。
export default function CardContent({ item }: { item: Item }) {
  // 便笺管理入口卡片（折叠堆叠里的预览）：左右两张小图
  if (item.kind === "entry") {
    return (
      <div className="card-tile entry">
        <div className="entry-mini">
          <img src="/note.png" alt="新增便笺" draggable={false} />
          <img src="/notebook.png" alt="打开笔记本" draggable={false} />
        </div>
      </div>
    );
  }
  // 便笺卡片（折叠堆叠里的预览）
  if (item.kind === "note") {
    return (
      <div className="card-tile note">
        <div className={"note-mini" + (item.text ? "" : " empty")}>
          {item.text || "（空便笺）"}
        </div>
      </div>
    );
  }
  // 待办卡片（折叠堆叠里的预览）：只展示标题
  if (item.kind === "todo") {
    return (
      <div className="card-tile note todo">
        <div className="note-mini">{item.name || "（无标题）"}</div>
      </div>
    );
  }
  if (item.thumb?.kind === "image" && item.thumb.b64) {
    return (
      <img
        className="card-img"
        src={`data:image/png;base64,${item.thumb.b64}`}
        alt={item.name}
        draggable={false}
      />
    );
  }
  if (item.thumb?.kind === "folder") {
    return (
      <div className="card-tile folder">
        {item.thumb.b64 ? (
          <img
            className="folder-img"
            src={`data:image/png;base64,${item.thumb.b64}`}
            alt={item.name}
            draggable={false}
          />
        ) : (
          <svg viewBox="0 0 48 40" className="folder-icon" aria-hidden>
            <path d="M2 8a4 4 0 0 1 4-4h10l5 5h21a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
            <path d="M2 13h44v4H2z" fill="rgba(0,0,0,0.08)" />
          </svg>
        )}
        <div className="card-name">{item.name}</div>
      </div>
    );
  }
  if (item.thumb?.b64) {
    return (
      <div className="card-tile file">
        <img
          className="file-img"
          src={`data:image/png;base64,${item.thumb.b64}`}
          alt={item.name}
          draggable={false}
        />
        <div className="card-name">{item.name}</div>
      </div>
    );
  }
  const ext = item.name.includes(".")
    ? item.name.split(".").pop()!.toUpperCase().slice(0, 4)
    : "FILE";
  return (
    <div className="card-tile file">
      <svg viewBox="0 0 36 44" className="file-icon" aria-hidden>
        <path d="M4 4a3 3 0 0 1 3-3h14l11 11v28a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V4z" />
        <path d="M21 1l11 11H21V1z" fill="rgba(255,255,255,0.45)" />
      </svg>
      <div className="file-ext">{ext}</div>
      <div className="card-name">{item.name}</div>
    </div>
  );
}
