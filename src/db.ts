// IndexedDB 持久化。两个 store:
//   strokes: 笔画 (keyPath 'id' autoincrement)
//   meta:    单条配置 (key 'viewport' = {tx,ty,scale,gridMode,theme,...})
//
// 阅后即焚 = clearAll() 一键擦库。没有 trash，没有版本。

import type { Stroke } from "./types.js";

const DB_NAME = "scratchpad";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("strokes")) {
        db.createObjectStore("strokes", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames: string | string[], mode: IDBTransactionMode = "readonly"): Promise<IDBTransaction> {
  return openDb().then((db) => db.transaction(storeNames, mode));
}

export async function loadAllStrokes(): Promise<Stroke[]> {
  const t = await tx("strokes", "readonly");
  return new Promise((resolve, reject) => {
    const out: Stroke[] = [];
    const req = t.objectStore("strokes").openCursor();
    req.onsuccess = (e) => {
      const cur = req.result;
      if (cur) {
        out.push(cur.value as Stroke);
        cur.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function addStroke(stroke: Stroke): Promise<Stroke> {
  // stroke 形如 {color, width, points: Float32Array}
  // 写库时 IDB 会分配 id 并写回 stroke.id
  const t = await tx("strokes", "readwrite");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("strokes").add(stroke);
    req.onsuccess = () => {
      stroke.id = req.result as number;
      resolve(stroke);
    };
    req.onerror = () => reject(req.error);
  });
}

// 直接插入指定 id 的笔画（撤销"擦除"时用）
export async function putStrokeWithId(stroke: Stroke): Promise<Stroke> {
  const t = await tx("strokes", "readwrite");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("strokes").put(stroke);
    req.onsuccess = () => resolve(stroke);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteStrokes(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const t = await tx("strokes", "readwrite");
  const store = t.objectStore("strokes");
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    for (const id of ids) store.delete(id);
  });
}

export async function clearAll(): Promise<void> {
  const t = await tx(["strokes", "meta"], "readwrite");
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore("strokes").clear();
    // 保留 meta 里非笔画相关的偏好 — 只删 viewport (其实保留也行，反正还是上次的位置)
  });
}

export async function getMeta(key: string): Promise<any> {
  const t = await tx("meta", "readonly");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const t = await tx("meta", "readwrite");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("meta").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// debounce 工具
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}
