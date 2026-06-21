// platform-guards.js — 全局移动端护栏：防系统抢手势、防长按弹奇怪对话框。
// 抄自 WebPaint (v216/v232 血泪)，按 ScratchPad 调整：
//   - ScratchPad 用"三指 tap = 重做"。这里 preventDefault 只压制系统 touch 默认动作，
//     pointerdown/up 照常 fire，所以不会破坏三指重做，反而把它从 iPad 系统三指手势
//     (分屏/Slide Over/截图) 手里抢回来。
//   - 文本编辑用 <textarea>，需要可选中/可弹 callout → 对输入框放行。
// 全程 capture 阶段 + 非 passive，确保抢在系统前面。

const EDITABLE = (t) =>
  t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);

export function installPlatformGuards({ onLostPointers } = {}) {
  const opts = { passive: false, capture: true };

  // iOS Safari 私有双指缩放事件 — 不拦会把整页 (PWA 外壳) 放大错位
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(t, (e) => e.preventDefault(), opts);
  }

  // 三指及以上 touchstart：挡掉 iPad 系统三指手势 / 分屏 / Slide Over 抢手势。
  // 三指重做走指针事件，不受影响 (见文件头注释)。
  document.addEventListener("touchstart", (e) => {
    if (e.touches && e.touches.length >= 3) e.preventDefault();
  }, opts);

  // 系统双击：选词 / 拖窗。ScratchPad 的双击切工具走指针事件，不靠这个。
  document.addEventListener("dblclick", (e) => {
    if (EDITABLE(e.target)) return;     // 文本框里仍允许双击选词
    e.preventDefault();
  }, opts);

  // callout 双保险：非输入框区域禁止起选区 → 画板长按不再弹 Copy/查询/分享 菜单。
  document.addEventListener("selectstart", (e) => {
    if (EDITABLE(e.target)) return;
    e.preventDefault();
  }, opts);

  // 失焦 / 切后台 → 丢弃所有在途指针。iOS 常吞 pointerup，残留 ghost 会假装多指误撤销。
  if (onLostPointers) {
    window.addEventListener("blur", onLostPointers);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) onLostPointers();
    });
  }
}
