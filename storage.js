/**
 * ============================================================
 * NicoList - IndexedDB ストレージマネージャー
 * ============================================================
 * 
 * リストと動画データをIndexedDBで管理するラッパークラス。
 * Background / Content Script / Popup の全てから利用可能。
 * 
 * Object Stores:
 *   - lists   : リスト情報（id, name, createdAt, updatedAt）
 *   - videos  : 動画情報（id, listId, videoId, title, ...）
 */

const DB_NAME = 'NicoListDB';
const DB_VERSION = 2; // v2: likeCountインデックス追加（background.jsと一致）

class NicoListStorage {
  constructor() {
    this.db = null;
  }

  // ─── データベースを開く ───────────────────────────────
  open() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        resolve(this.db);
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      // データベースの初期化・アップグレード
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // v1: 基本構造
        if (!db.objectStoreNames.contains('lists')) {
          const listStore = db.createObjectStore('lists', { keyPath: 'id' });
          listStore.createIndex('name', 'name', { unique: false });
          listStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains('videos')) {
          const videoStore = db.createObjectStore('videos', { keyPath: 'id' });
          videoStore.createIndex('listId', 'listId', { unique: false });
          videoStore.createIndex('videoId', 'videoId', { unique: false });
          videoStore.createIndex('listId_videoId', ['listId', 'videoId'], { unique: true });
          videoStore.createIndex('addedAt', 'addedAt', { unique: false });
          videoStore.createIndex('postedAt', 'postedAt', { unique: false });
          videoStore.createIndex('viewCount', 'viewCount', { unique: false });
          videoStore.createIndex('mylistCount', 'mylistCount', { unique: false });
        }

        // v2: likeCountインデックス追加
        if (oldVersion < 2) {
          if (db.objectStoreNames.contains('videos')) {
            const videoStore = event.target.transaction.objectStore('videos');
            if (!videoStore.indexNames.contains('likeCount')) {
              videoStore.createIndex('likeCount', 'likeCount', { unique: false });
            }
          }
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(new Error('IndexedDB open failed: ' + event.target.error));
      };
    });
  }

  // ─── ユーティリティ: UUID生成 ──────────────────────────
  generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ═════════════════════════════════════════════════════════
  //  リスト操作
  // ═════════════════════════════════════════════════════════

  /**
   * 新しいリストを作成する
   * @param {string} name - リスト名
   * @returns {Promise<object>} 作成されたリスト
   */
  async createList(name) {
    const db = await this.open();
    const now = Date.now();
    const list = {
      id: this.generateId(),
      name: name,
      createdAt: now,
      updatedAt: now
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction('lists', 'readwrite');
      tx.objectStore('lists').add(list);
      tx.oncomplete = () => resolve(list);
      tx.onerror = (e) => reject(new Error('リスト作成失敗: ' + e.target.error));
    });
  }

  /**
   * 全リストを取得する
   * @returns {Promise<Array>} リストの配列
   */
  async getAllLists() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('lists', 'readonly');
      const request = tx.objectStore('lists').getAll();
      request.onsuccess = () => {
        // 作成日時でソート（新しい順）
        const lists = request.result.sort((a, b) => b.createdAt - a.createdAt);
        resolve(lists);
      };
      request.onerror = (e) => reject(new Error('リスト取得失敗: ' + e.target.error));
    });
  }

  /**
   * 指定IDのリストを取得する
   * @param {string} id - リストID
   * @returns {Promise<object|null>}
   */
  async getList(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('lists', 'readonly');
      const request = tx.objectStore('lists').get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = (e) => reject(new Error('リスト取得失敗: ' + e.target.error));
    });
  }

  /**
   * リスト名を更新する
   * @param {string} id - リストID
   * @param {string} newName - 新しいリスト名
   * @returns {Promise<object>}
   */
  async updateListName(id, newName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('lists', 'readwrite');
      const store = tx.objectStore('lists');
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const list = getReq.result;
        if (!list) {
          reject(new Error('リストが見つかりません'));
          return;
        }
        list.name = newName;
        list.updatedAt = Date.now();
        store.put(list);
      };
      tx.oncomplete = () => resolve({ success: true });
      tx.onerror = (e) => reject(new Error('リスト更新失敗: ' + e.target.error));
    });
  }

  /**
   * リストとその中の動画をすべて削除する
   * @param {string} id - リストID
   * @returns {Promise<object>}
   */
  async deleteList(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['lists', 'videos'], 'readwrite');

      // リスト削除
      tx.objectStore('lists').delete(id);

      // リスト内の動画をすべて削除
      const videoStore = tx.objectStore('videos');
      const index = videoStore.index('listId');
      const cursor = index.openCursor(IDBKeyRange.only(id));
      cursor.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          c.delete();
          c.continue();
        }
      };

      tx.oncomplete = () => resolve({ success: true });
      tx.onerror = (e) => reject(new Error('リスト削除失敗: ' + e.target.error));
    });
  }

  // ═════════════════════════════════════════════════════════
  //  動画操作
  // ═════════════════════════════════════════════════════════

  /**
   * リストに動画を追加する
   * @param {string} listId - 追加先リストID
   * @param {object} videoInfo - 動画情報
   * @returns {Promise<object>}
   */
  async addVideo(listId, videoInfo) {
    const db = await this.open();

    // 重複チェック
    const exists = await this.isVideoInList(listId, videoInfo.videoId);
    if (exists) {
      return { success: false, message: 'この動画は既にリストに追加されています' };
    }

    const video = {
      id: this.generateId(),
      listId: listId,
      videoId: videoInfo.videoId,
      title: videoInfo.title || '',
      thumbnailUrl: videoInfo.thumbnailUrl || '',
      viewCount: videoInfo.viewCount || 0,
      mylistCount: videoInfo.mylistCount || 0,
      likeCount: videoInfo.likeCount || 0,
      postedAt: videoInfo.postedAt || 0,
      addedAt: Date.now(),
      duration: videoInfo.duration || '',
      ownerName: videoInfo.ownerName || '',
      ownerIcon: videoInfo.ownerIcon || '',
      description: videoInfo.description || '',
      site: videoInfo.site || 'niconico'
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['videos', 'lists'], 'readwrite');

      tx.objectStore('videos').add(video);

      // リストのupdatedAtを更新
      const listStore = tx.objectStore('lists');
      const getReq = listStore.get(listId);
      getReq.onsuccess = () => {
        const list = getReq.result;
        if (list) {
          list.updatedAt = Date.now();
          listStore.put(list);
        }
      };

      tx.oncomplete = () => resolve({ success: true, video: video });
      tx.onerror = (e) => reject(new Error('動画追加失敗: ' + e.target.error));
    });
  }

  /**
   * 指定リスト内の動画一覧を取得する
   * @param {string} listId - リストID
   * @param {string} sortKey - ソートキー (addedAt, postedAt, viewCount, mylistCount)
   * @param {string} sortOrder - ソート順 (asc, desc)
   * @returns {Promise<Array>}
   */
  async getVideos(listId, sortKey = 'addedAt', sortOrder = 'desc') {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readonly');
      const store = tx.objectStore('videos');
      const index = store.index('listId');
      const request = index.getAll(IDBKeyRange.only(listId));

      request.onsuccess = () => {
        let videos = request.result;

        // ソート処理
        videos.sort((a, b) => {
          const valA = a[sortKey] || 0;
          const valB = b[sortKey] || 0;
          return sortOrder === 'asc' ? valA - valB : valB - valA;
        });

        resolve(videos);
      };

      request.onerror = (e) => reject(new Error('動画取得失敗: ' + e.target.error));
    });
  }

  /**
   * 指定リスト内の動画数を取得する
   * @param {string} listId
   * @returns {Promise<number>}
   */
  async getVideoCount(listId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readonly');
      const index = tx.objectStore('videos').index('listId');
      const request = index.count(IDBKeyRange.only(listId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(new Error('動画数取得失敗: ' + e.target.error));
    });
  }

  /**
   * 動画がリストに既に存在するかチェック
   * @param {string} listId
   * @param {string} videoId
   * @returns {Promise<boolean>}
   */
  async isVideoInList(listId, videoId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readonly');
      const index = tx.objectStore('videos').index('listId_videoId');
      const request = index.get([listId, videoId]);
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = (e) => reject(new Error('重複チェック失敗: ' + e.target.error));
    });
  }

  /**
   * 動画をリストから削除する
   * @param {string} videoDbId - 動画のDB内ID
   * @returns {Promise<object>}
   */
  async removeVideo(videoDbId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readwrite');
      tx.objectStore('videos').delete(videoDbId);
      tx.oncomplete = () => resolve({ success: true });
      tx.onerror = (e) => reject(new Error('動画削除失敗: ' + e.target.error));
    });
  }

  // ═════════════════════════════════════════════════════════
  //  インポート / エクスポート
  // ═════════════════════════════════════════════════════════

  /**
   * 全データをJSON形式でエクスポートする
   * @returns {Promise<object>} エクスポートデータ
   */
  async exportAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['lists', 'videos'], 'readonly');
      const listsReq = tx.objectStore('lists').getAll();
      const videosReq = tx.objectStore('videos').getAll();

      tx.oncomplete = () => {
        resolve({
          version: 1,
          exportedAt: new Date().toISOString(),
          lists: listsReq.result,
          videos: videosReq.result
        });
      };
      tx.onerror = (e) => reject(new Error('エクスポート失敗: ' + e.target.error));
    });
  }

  /**
   * JSONデータをインポートする（既存データにマージ）
   * @param {object} data - インポートデータ
   * @param {boolean} overwrite - trueの場合は全データを置換、falseの場合はマージ
   * @returns {Promise<object>}
   */
  async importData(data, overwrite = false) {
    const db = await this.open();

    // バリデーション
    if (!data || !data.lists || !data.videos) {
      throw new Error('無効なインポートデータ形式です');
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['lists', 'videos'], 'readwrite');
      const listStore = tx.objectStore('lists');
      const videoStore = tx.objectStore('videos');

      if (overwrite) {
        // 既存データを全クリア
        listStore.clear();
        videoStore.clear();
      }

      // リストを追加
      let listsAdded = 0;
      for (const list of data.lists) {
        const req = listStore.put(list); // putで重複時は上書き
        req.onsuccess = () => listsAdded++;
      }

      // 動画を追加
      let videosAdded = 0;
      for (const video of data.videos) {
        const req = videoStore.put(video);
        req.onsuccess = () => videosAdded++;
      }

      tx.oncomplete = () => {
        resolve({
          success: true,
          listsAdded: listsAdded,
          videosAdded: videosAdded
        });
      };
      tx.onerror = (e) => reject(new Error('インポート失敗: ' + e.target.error));
    });
  }
}

// グローバルにインスタンスを公開
// Content Script と Popup で共有
if (typeof window !== 'undefined') {
  window.nicoListStorage = new NicoListStorage();
}
