import type { UndoEntry } from "./types.js";

// 撤销/重做栈 —— 手写编辑（input）与文字编辑（app 的 TextManager 回调）共享的属主。
// 只管存储 + 策略（封顶 100、新动作清 redo）；每种条目的 apply/revert 仍在 InputController
// （那里有 board/db 依赖）。emit 在每个"完成的操作"后触发一次（wire 到 sp:histchange 派发）。
export class History {
  undoStack: UndoEntry[] = [];
  redoStack: UndoEntry[] = [];
  onChange: (() => void) | null = null;

  // 新动作：入 undo 栈，封顶 100，清 redo 栈。
  record(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit();
  }
  takeUndo(): UndoEntry | undefined { return this.undoStack.pop(); }   // 不 emit（操作还没完）
  takeRedo(): UndoEntry | undefined { return this.redoStack.pop(); }   // 不 emit
  restoreRedo(entry: UndoEntry): void { this.redoStack.push(entry); this.emit(); }  // undo 施完
  restoreUndo(entry: UndoEntry): void { this.undoStack.push(entry); this.emit(); }  // redo 施完（不清 redo）
  clear(): void { this.undoStack.length = 0; this.redoStack.length = 0; this.emit(); }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  emit(): void { if (this.onChange) this.onChange(); }
}
