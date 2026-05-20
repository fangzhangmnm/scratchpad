// IndexedDB 持久化。两个 store:
//   strokes: 笔画 (keyPath 'id' autoincrement)
//   meta:    单条配置 (key 'viewport' = {tx,ty,scale,gridMode,theme,...})
//
// 阅后即焚 = clearAll() 一键擦库。没有 trash，没有版本。

const DB_NAME = "scratchpad";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
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

function tx(storeNames, mode = "readonly") {
  return openDb().then((db) => db.transaction(storeNames, mode));
}

export async function loadAllStrokes() {
  const t = await tx("strokes", "readonly");
  return new Promise((resolve, reject) => {
    const out = [];
    const req = t.objectStore("strokes").openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) {
        out.push(cur.value);
        cur.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function addStroke(stroke) {
  // stroke 形如 {color, width, points: Float32Array}
  // 写库时 IDB 会分配 id 并写回 stroke.id
  const t = await tx("strokes", "readwrite");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("strokes").add(stroke);
    req.onsuccess = () => {
      stroke.id = req.result;
      resolve(stroke);
    };
    req.onerror = () => reject(req.error);
  });
}

// 直接插入指定 id 的笔画（撤销"擦除"时用）
export async function putStrokeWithId(stroke) {
  const t = await tx("strokes", "readwrite");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("strokes").put(stroke);
    req.onsuccess = () => resolve(stroke);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteStrokes(ids) {
  if (!ids.length) return;
  const t = await tx("strokes", "readwrite");
  const store = t.objectStore("strokes");
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    for (const id of ids) store.delete(id);
  });
}

export async function clearAll() {
  const t = await tx(["strokes", "meta"], "readwrite");
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore("strokes").clear();
    // 保留 meta 里非笔画相关的偏好 — 只删 viewport (其实保留也行，反正还是上次的位置)
  });
}

export async function getMeta(key) {
  const t = await tx("meta", "readonly");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const t = await tx("meta", "readwrite");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("meta").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// debounce 工具
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}
