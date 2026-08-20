// IndexedDB 極簡封裝。
//
// 用途是把 TCGdex 查過的卡片與系列存下來：一來離線時還查得到，
// 二來在卡店翻卡不用每張都重打一次網路請求。

const DB_NAME = 'pokecard';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 快取：卡片、系列、匯率等 API 回應，key 自己組
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
      // 收藏：之後要做的話直接用這個 store
      if (!db.objectStoreNames.contains('collection')) {
        db.createObjectStore('collection', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/** 讀快取。回傳 {value, ts, age} 或 null；過期與否交給呼叫端判斷。 */
export async function cacheGet(key) {
  try {
    const row = await tx('cache', 'readonly', (s) => s.get(key));
    if (!row) return null;
    return { value: row.value, ts: row.ts, age: Date.now() - row.ts };
  } catch (err) {
    return null; // 私密瀏覽模式等情況下 IndexedDB 可能不能用，不該讓整個 App 掛掉
  }
}

export async function cacheSet(key, value) {
  try {
    await tx('cache', 'readwrite', (s) => s.put({ key: key, value: value, ts: Date.now() }));
  } catch (err) {
    /* 存不進去就算了，下次重抓 */
  }
}

export async function cacheClear() {
  try {
    await tx('cache', 'readwrite', (s) => s.clear());
  } catch (err) {
    /* 忽略 */
  }
}

/** 粗估快取了幾筆，設定頁用來顯示。 */
export async function cacheCount() {
  try {
    return (await tx('cache', 'readonly', (s) => s.count())) || 0;
  } catch (err) {
    return 0;
  }
}
