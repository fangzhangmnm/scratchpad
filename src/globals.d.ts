// 运行时注入的 vendor 全局（<script> 读 window.*，非 ESM import）+ app 自定义窗口事件。
// vendor 库物理在 src/vendor/，运行时按需注入；这里只给它们一个最小类型面。
// 这些 interface 放进 `declare global`，故 KatexStatic / JsPdfNamespace 等是全局环境类型
// （textbox.ts / export.ts 直接按名引用，无需 import）。

import type { ToolName } from "./types";

declare global {
  // ---- KaTeX（src/vendor/katex）----
  interface KatexStatic {
    renderToString(
      tex: string,
      options?: { displayMode?: boolean; throwOnError?: boolean },
    ): string;
  }

  // ---- jsPDF（src/vendor/jspdf.umd.min.js，UMD → window.jspdf）----
  interface JsPdfOptions {
    orientation?: "portrait" | "landscape";
    unit?: string;
    format?: number[] | string;
    compress?: boolean;
  }
  interface JsPdfInstance {
    addImage(
      data: string,
      format: string,
      x: number,
      y: number,
      w: number,
      h: number,
    ): void;
    save(filename: string): void;
  }
  interface JsPdfConstructor {
    new (options?: JsPdfOptions): JsPdfInstance;
  }
  interface JsPdfNamespace {
    jsPDF: JsPdfConstructor;
  }

  // ---- html2canvas（src/vendor/html2canvas）----
  type Html2Canvas = (
    element: HTMLElement,
    options?: {
      backgroundColor?: string | null;
      scale?: number;
      logging?: boolean;
      useCORS?: boolean;
    },
  ) => Promise<HTMLCanvasElement>;

  interface Window {
    katex?: KatexStatic;
    jspdf?: JsPdfNamespace;
    html2canvas?: Html2Canvas;
    SCRATCHPAD_VERSION?: string;
  }

  // app 层用 CustomEvent 在 window 上广播工具/网格/历史变更。
  interface WindowEventMap {
    "sp:settool": CustomEvent<ToolName>;
    "sp:gridcycle": CustomEvent<undefined>;
    "sp:doubletap": CustomEvent<undefined>;
    "sp:histchange": CustomEvent<{ canUndo: boolean; canRedo: boolean }>;
  }
}

export {};
