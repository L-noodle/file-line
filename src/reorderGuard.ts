// 夹子拖拽重排的全局会话标记（App 的 startReorder / endReorder 维护）。
//
// 背景：重排进行中左键始终按住，被拖卡片跟随鼠标移动，指针会掠过
// 其它卡片（也会压在被拖卡片自己身上）。卡片 pointermove 里的
// 「首按丢失兜底」分支只看 buttons 位，会把这种移动误判成
// 「正在把这张卡片拖出去」，从而对被掠过的卡片发起原生拖拽——
// 拖影 / 拖出内容就变成了别人的图片或文字。
//
// 因此卡片的拖出逻辑（文件拖出 / 文字拖出）动手前必须先过问本标记，
// 重排会话期间一律不触发。单指针场景下同一时刻只会有一个重排会话，
// 普通模块级状态即可，无需上下文传递。
let reordering = false;

/** 当前是否正在拖夹子重排 */
export function isReordering(): boolean {
  return reordering;
}

/** 设置 / 清除重排会话标记 */
export function setReordering(on: boolean): void {
  reordering = on;
}
