/*
 * Practical eval - response cache: IndexedDB in the extension's origin, with an
 * in-memory LRU in front. Survives service-worker restarts and serves every tab.
 *
 * Records are { k, t, v }: key, time stored, compact API response. Expiry is checked on
 * read (the TTL belongs to the caller), so nothing needs sweeping.
 */

var DB_NAME = 'qx-pe';
var STORES = ['explorer', 'chessdb'];
var LRU_MAX = 3000;

export function createCache(idb) {
  idb = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  var lru = new Map();
  var dbp = null;

  function open() {
    if (!idb) return Promise.resolve(null);
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      var req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        STORES.forEach(function (s) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'k' });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      // A broken IndexedDB degrades to memory-only rather than failing searches.
      req.onerror = function () { resolve(null); };
    });
    return dbp;
  }

  function remember(id, rec) {
    lru.delete(id);
    lru.set(id, rec);
    if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value);
  }

  function get(store, key, ttl) {
    var id = store + '|' + key;
    var now = Date.now();
    var m = lru.get(id);
    if (m) {
      if (now - m.t < ttl) { remember(id, m); return Promise.resolve(m.v); }
      lru.delete(id);
    }
    return open().then(function (db) {
      if (!db) return undefined;
      return new Promise(function (resolve) {
        var r = db.transaction(store, 'readonly').objectStore(store).get(key);
        r.onsuccess = function () {
          var rec = r.result;
          if (!rec || now - rec.t >= ttl) { resolve(undefined); return; }
          remember(id, rec);
          resolve(rec.v);
        };
        r.onerror = function () { resolve(undefined); };
      });
    });
  }

  function put(store, key, v) {
    var rec = { k: key, t: Date.now(), v: v };
    remember(store + '|' + key, rec);
    return open().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(rec);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    });
  }

  function count() {
    return open().then(function (db) {
      if (!db) return { explorer: 0, chessdb: 0 };
      return Promise.all(STORES.map(function (s) {
        return new Promise(function (resolve) {
          var r = db.transaction(s, 'readonly').objectStore(s).count();
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { resolve(0); };
        });
      })).then(function (n) { return { explorer: n[0], chessdb: n[1] }; });
    });
  }

  return { get: get, put: put, count: count };
}

// Memory-only stand-in with the same interface, for tests.
export function createMemoryCache(now) {
  var m = new Map();
  now = now || Date.now;
  return {
    get: function (store, key, ttl) {
      var rec = m.get(store + '|' + key);
      return Promise.resolve(rec && now() - rec.t < ttl ? rec.v : undefined);
    },
    put: function (store, key, v) {
      m.set(store + '|' + key, { t: now(), v: v });
      return Promise.resolve();
    },
    count: function () { return Promise.resolve({ size: m.size }); },
    _map: m
  };
}
