/**
 * ============================================================
 * NicoList - Background Service Worker
 * ============================================================
 *
 * ニコニコ動画・YouTube対応のリスト管理拡張機能
 * - IndexedDB によるリスト・動画データの永続化
 * - chrome.storage.local による動画情報キャッシュ (24h TTL)
 * - ニコニコ: スナップショット検索API → v3_guest API フォールバック
 * - YouTube: ページHTML解析 → oEmbed フォールバック
 */

import './storage.js';

// ═════════════════════════════════════════════════════════════
//  Update Notifier (GitHub API)
// ═════════════════════════════════════════════════════════════
async function checkForUpdates() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/Hallkun19/NicoList/refs/heads/main/meta.yaml', { cache: 'no-store' });
    if (!res.ok) return;
    const text = await res.text();

    let latestVersion = '';
    let releaseNote = '';

    const vMatch = text.match(/^version:\s*"([^"]+)"/m) || text.match(/^version:\s*'([^']+)'/m) || text.match(/^version:\s*([^\s]+)/m);
    if (vMatch) latestVersion = vMatch[1];

    const rMatch = text.match(/^releaseNote:\s*"([^"]+)"/m) || text.match(/^releaseNote:\s*'([^']+)'/m) || text.match(/^releaseNote:\s*(.+)/m);
    if (rMatch) releaseNote = rMatch[1].replace(/\\n/g, '\n');

    if (!latestVersion) return;
    latestVersion = latestVersion.replace(/^v/, '');
    const currentVersion = chrome.runtime.getManifest().version;

    if (latestVersion !== currentVersion) {
      const vL = latestVersion.split('.').map(Number);
      const vC = currentVersion.split('.').map(Number);
      let isNewer = false;
      for (let i = 0; i < Math.max(vL.length, vC.length); i++) {
        const numL = vL[i] || 0;
        const numC = vC[i] || 0;
        if (numL > numC) { isNewer = true; break; }
        if (numL < numC) { break; }
      }

      if (isNewer) {
        chrome.storage.local.set({
          updateAvailable: {
            version: latestVersion,
            releaseNote: releaseNote,
            url: 'https://github.com/Hallkun19/NicoList/releases/latest'
          }
        });
      } else {
        chrome.storage.local.remove('updateAvailable');
      }
    } else {
      chrome.storage.local.remove('updateAvailable');
    }
  } catch (e) {
    console.warn('NicoList: 更新確認に失敗', e);
  }
}

chrome.runtime.onStartup.addListener(checkForUpdates);
chrome.runtime.onInstalled.addListener(() => {
  checkForUpdates();
  chrome.alarms.create('checkUpdateAlarm', { periodInMinutes: 10 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkUpdateAlarm') checkForUpdates();
});

// ─── キャッシュ機能 (chrome.storage.local) ────────────────
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24時間
const CACHE_VERSION = 2; // キャッシュスキーマバージョン（変更時にインクリメント）

// 拡張機能インストール/更新時に古いキャッシュをクリア
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      const all = await chrome.storage.local.get(null);
      const keysToRemove = Object.keys(all).filter(k => k.startsWith('vc_'));
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
        console.log(`NicoList: キャッシュクリア完了 (${keysToRemove.length}件)`);
      }
    } catch (e) { console.warn('NicoList: キャッシュクリア失敗', e); }
  }
});

async function getCachedVideoInfo(videoId) {
  try {
    const key = `vc_${videoId}`;
    const data = await chrome.storage.local.get(key);
    const entry = data[key];
    if (entry && entry.cachedAt && entry.cacheVer === CACHE_VERSION && (Date.now() - entry.cachedAt < CACHE_TTL)) {
      return entry;
    }
  } catch (e) { }
  return null;
}

async function setCachedVideoInfo(videoId, info) {
  try {
    const key = `vc_${videoId}`;
    // キャッシュサイズ削減: description は除外（共有リスト表示時に再取得）
    const { description, ...cacheData } = info;
    await chrome.storage.local.set({ [key]: { ...cacheData, cachedAt: Date.now(), cacheVer: CACHE_VERSION } });
  } catch (e) {
    console.warn('NicoList: キャッシュ書き込み失敗', videoId, e.message);
  }
}

// キャッシュ付きフェッチ（forceRefresh で強制再取得）
async function cachedFetchVideoInfo(videoId, site, forceRefresh) {
  if (!forceRefresh) {
    const cached = await getCachedVideoInfo(videoId);
    if (cached) return cached;
  }
  let info = null;
  if (site === 'youtube') info = await fetchYouTubeVideoInfo(videoId);
  else if (site === 'bilibili') info = await fetchBilibiliVideoInfo(videoId);
  else if (site === 'soundcloud') info = await fetchSoundCloudVideoInfo(videoId);
  else info = await fetchVideoInfo(videoId);
  
  if (info && !info.error) {
    await setCachedVideoInfo(videoId, info);
  }
  return info;
}

// ─── タブ閉じ時に連続再生を自動停止 ─────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const data = await chrome.storage.local.get('playbackState');
    const state = data.playbackState;
    if (state && state.isPlaying) {
      // tabIdが一致する場合、または tabIdが未設定の場合は現在開いているタブを確認
      if (state.tabId === tabId || !state.tabId) {
        await chrome.storage.local.remove('playbackState');
        console.log('NicoList BG: タブ閉じにより連続再生を停止 (tabId:', tabId, ')');
      }
    }
  } catch (e) { }
});

// ─── メッセージハンドラ ───────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.action) {
    // ─── リスト操作 ─────────────────────────────
    case 'createList': return await createList(msg.name);
    case 'getAllLists': return await getAllLists();
    case 'getList': return await nicoListStorage.getList(msg.id);
    case 'updateListName': return await nicoListStorage.updateListName(msg.id, msg.name);
    case 'updateListShareId': return await nicoListStorage.updateListShareId(msg.id, msg.shareId);
    case 'deleteList': return await deleteList(msg.id);
    case 'saveListOrder': return await saveListOrder(msg.order);

    // ─── 動画操作 ─────────────────────────────
    case 'addVideo': return await addVideo(msg.listId, msg.videoInfo);
    case 'getVideos': return await nicoListStorage.getVideos(msg.listId, msg.sortKey, msg.sortOrder);
    case 'getVideoCount': return await nicoListStorage.getVideoCount(msg.listId);
    case 'removeVideo': return await nicoListStorage.removeVideo(msg.videoDbId);
    case 'updateVideoMemo': return await nicoListStorage.updateVideoMemo(msg.videoDbId, msg.memo);
    case 'isVideoInList': return await nicoListStorage.isVideoInList(msg.listId, msg.videoId);

    // ─── 連続再生 ─────────────────────────────
    case 'startPlayback': return await startPlayback(msg.listId, msg.sortKey, msg.sortOrder, msg.shuffle, msg.startIndex);
    case 'getPlaybackState': return await getPlaybackState();
    case 'playNext': return await playNext();
    case 'stopPlayback': return await stopPlayback();
    case 'jumpToPlayback': return await jumpToPlayback(msg.index);

    // ─── インポート / エクスポート ───────────────
    case 'exportAll': return await exportAll();
    case 'importData': return await importData(msg.data, msg.overwrite);

    // ─── 動画情報取得（API） ────────────────────
    case 'fetchVideoInfo': return await cachedFetchVideoInfo(msg.videoId, 'niconico', msg.forceRefresh);
    case 'fetchYouTubeVideoInfo': return await cachedFetchVideoInfo(msg.videoId, 'youtube', msg.forceRefresh);
    case 'fetchBilibiliVideoInfo': return await cachedFetchVideoInfo(msg.videoId, 'bilibili', msg.forceRefresh);
    case 'fetchSoundCloudVideoInfo': return await cachedFetchVideoInfo(msg.videoId, 'soundcloud', msg.forceRefresh);

    // ─── リスト内動画の情報一括更新 ───────────────
    case 'refreshVideos': return await refreshVideos(msg.listId);

    // ─── マイリスト取得（CORS回避のためBG経由） ──
    case 'fetchMylistVideos': return await fetchMylistVideos(msg.mylistId);

    // ─── 設定管理 ─────────────────────────────
    case 'getSettings':
      return (await chrome.storage.local.get('nicolistSettings'))?.nicolistSettings || {};
    case 'saveSettings':
      await chrome.storage.local.set({ nicolistSettings: msg.settings });
      return { success: true };

    // ─── 大画面ビュー用 ─────────────────────────
    case 'openFullView':
      await chrome.tabs.create({ url: chrome.runtime.getURL('fullview.html') });
      return { success: true };

    // ─── クラウド共有 ─────────────────────────
    case 'createShareLink':
      return await createShareLink(msg.data);
    case 'getSharedList':
      return await getSharedList(msg.id);

    default:
      return { error: '不明なアクション: ' + msg.action };
  }
}

// ═════════════════════════════════════════════════════════════
//  リスト操作
// ═════════════════════════════════════════════════════════════

async function createList(name) {
  try {
    const list = await nicoListStorage.createList(name);
    return new Promise((resolve) => {
      chrome.storage.local.get(['listOrder'], (res) => {
        const order = res.listOrder || [];
        order.push(list.id);
        chrome.storage.local.set({ listOrder: order }, () => resolve(list));
      });
    });
  } catch (e) {
    throw new Error('リスト作成失敗');
  }
}

async function getAllLists() {
  try {
    const lists = await nicoListStorage.getAllLists();
    return new Promise((resolve) => {
      chrome.storage.local.get(['listOrder'], (res) => {
        if (res.listOrder && res.listOrder.length > 0) {
          const orderMap = new Map();
          res.listOrder.forEach((id, index) => orderMap.set(id, index));
          lists.sort((a, b) => {
            const idxA = orderMap.has(a.id) ? orderMap.get(a.id) : 99999;
            const idxB = orderMap.has(b.id) ? orderMap.get(b.id) : 99999;
            if (idxA !== idxB) return idxA - idxB;
            return b.createdAt - a.createdAt; // フォールバックは日付降順
          });
        }
        resolve(lists);
      });
    });
  } catch (e) {
    throw new Error('リスト取得失敗');
  }
}

async function deleteList(id) {
  try {
    await nicoListStorage.deleteList(id);
    return new Promise((resolve) => {
      chrome.storage.local.get(['listOrder'], (res) => {
        if (res.listOrder) {
          const order = res.listOrder.filter(lid => lid !== id);
          chrome.storage.local.set({ listOrder: order }, () => resolve({ success: true }));
        } else {
          resolve({ success: true });
        }
      });
    });
  } catch (e) {
    throw new Error('リスト削除失敗');
  }
}

async function saveListOrder(order) {
  await chrome.storage.local.set({ listOrder: order });
  return { success: true };
}

// ═════════════════════════════════════════════════════════════
//  動画操作
// ═════════════════════════════════════════════════════════════

async function addVideo(listId, videoInfo) {
  const exists = await nicoListStorage.isVideoInList(listId, videoInfo.videoId);
  if (exists) return { success: false, message: 'この動画は既に追加されています' };

  let finalInfo = { ...videoInfo };

  // ニコニコ動画でいいね数が0（または不足）の場合、バックグラウンドで最新情報を取得し直す
  if (finalInfo.site === 'niconico' && (finalInfo.likeCount === 0 || !finalInfo.ownerName)) {
    try {
      console.log(`NicoList [BG]: ss動画等の不足情報を補完中... (${finalInfo.videoId})`);
      const fresh = await fetchVideoInfo(finalInfo.videoId);
      if (fresh && !fresh.error) {
        finalInfo.title = finalInfo.title || fresh.title;
        finalInfo.thumbnailUrl = finalInfo.thumbnailUrl || fresh.thumbnailUrl;
        finalInfo.viewCount = Math.max(finalInfo.viewCount, fresh.viewCount);
        finalInfo.mylistCount = Math.max(finalInfo.mylistCount, fresh.mylistCount);
        finalInfo.likeCount = Math.max(finalInfo.likeCount, fresh.likeCount);
        finalInfo.ownerName = finalInfo.ownerName || fresh.ownerName;
        finalInfo.ownerIcon = fresh.ownerIcon || fresh.ownerIcon;
        finalInfo.description = finalInfo.description || fresh.description;
      }
    } catch (e) {
      console.warn('NicoList [BG]: 追加時の情報補完に失敗', e);
    }
  }

  return await nicoListStorage.addVideo(listId, finalInfo);
}

// ═════════════════════════════════════════════════════════════
//  連続再生
// ═════════════════════════════════════════════════════════════

function buildWatchUrl(videoId, site) {
  if (site === 'youtube') return `https://www.youtube.com/watch?v=${videoId}`;
  if (site === 'bilibili') return `https://www.bilibili.com/video/${videoId}`;
  if (site === 'soundcloud') return `https://soundcloud.com/${videoId}`;
  return `https://www.nicovideo.jp/watch/${videoId}`;
}

async function startPlayback(listId, sortKey = 'addedAt', sortOrder = 'desc', shuffle = false, startIndex = 0) {
  const videos = await getVideos(listId, sortKey, sortOrder);
  if (!videos || videos.length === 0) {
    return { success: false, message: 'リストに動画がありません' };
  }

  let queue = videos.map(v => ({
    videoId: v.videoId,
    title: v.title,
    thumbnailUrl: v.thumbnailUrl,
    site: v.site || 'niconico'
  }));

  if (shuffle) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    startIndex = 0;
  }

  const state = {
    isPlaying: true,
    listId,
    currentIndex: startIndex,
    sortKey,
    sortOrder,
    shuffle,
    queue
  };

  await chrome.storage.local.set({ playbackState: state });
  const first = queue[startIndex];
  const tab = await chrome.tabs.create({ url: buildWatchUrl(first.videoId, first.site) });
  // タブIDを保存して閉じた時に停止できるようにする
  state.tabId = tab.id;
  await chrome.storage.local.set({ playbackState: state });

  return { success: true, totalVideos: queue.length };
}

async function getPlaybackState() {
  const result = await chrome.storage.local.get('playbackState');
  const state = result.playbackState || null;
  if (state && state.isPlaying) {
    const nextIndex = state.currentIndex + 1;
    if (nextIndex < state.queue.length) {
      const next = state.queue[nextIndex];
      state.nextUrl = buildWatchUrl(next.videoId, next.site);
    } else {
      state.nextUrl = null;
    }
  }
  return state;
}

async function playNext() {
  const result = await chrome.storage.local.get('playbackState');
  const state = result.playbackState;
  if (!state || !state.isPlaying) {
    return { success: false, message: '再生中ではありません' };
  }

  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.queue.length) {
    await stopPlayback();
    return { success: false, message: '全動画の再生完了', finished: true };
  }

  state.currentIndex = nextIndex;
  await chrome.storage.local.set({ playbackState: state });

  const next = state.queue[nextIndex];
  return { success: true, nextUrl: buildWatchUrl(next.videoId, next.site), currentIndex: nextIndex, total: state.queue.length };
}

async function jumpToPlayback(index) {
  const result = await chrome.storage.local.get('playbackState');
  const state = result.playbackState;
  if (!state || !state.isPlaying) return { success: false };

  if (index >= 0 && index < state.queue.length) {
    state.currentIndex = index;
    await chrome.storage.local.set({ playbackState: state });
    const item = state.queue[index];
    return { success: true, url: buildWatchUrl(item.videoId, item.site) };
  }
  return { success: false };
}

async function stopPlayback() {
  await chrome.storage.local.set({
    playbackState: { isPlaying: false, listId: null, currentIndex: 0, queue: [] }
  });
  return { success: true };
}

// ═════════════════════════════════════════════════════════════
//  インポート / エクスポート
// ═════════════════════════════════════════════════════════════

async function exportAll() {
  try {
    const data = await nicoListStorage.exportAll();
    return new Promise((resolve) => {
      chrome.storage.local.get('listOrder', (res) => {
        data.listOrder = res.listOrder || [];
        resolve(data);
      });
    });
  } catch (e) {
    throw new Error('エクスポート失敗');
  }
}

async function importData(data, overwrite = false) {
  try {
    const res = await nicoListStorage.importData(data, overwrite);
    if (data.listOrder && overwrite) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ listOrder: data.listOrder }, () => {
          resolve(res);
        });
      });
    }
    return res;
  } catch (e) {
    throw new Error('インポート失敗');
  }
}

function unifyThumb(url) {
  if (!url) return '';
  if (url.includes('nicovideo.cdn.nimg.jp/thumbnails/')) {
    if (!url.includes('.L')) {
      // サイズサフィックス (.M, .S, .S2 等) があれば .L に置換
      const sizeReplaced = url.replace(/\.[A-Z]\d?(\?.*)?$/, '.L$1');
      if (sizeReplaced !== url) {
        return sizeReplaced;
      }
      // サイズサフィックスなし (例: 123.456789) → .L を末尾に追加
      return url.replace(/(\?.*)?$/, '.L$1');
    }
  }
  // 新形式（img.cdn.nimg.jp 等）やその他はそのまま返す
  return url;
}

// ═════════════════════════════════════════════════════════════
//  ニコニコ動画情報取得
//  方法1: スナップショット検索API (軽量・安定)
//  方法2: v3_guest API (詳細情報・投稿者情報あり)
// ═════════════════════════════════════════════════════════════

async function fetchVideoInfo(videoId) {
  let info = null;

  // --- 方法1: スナップショット検索API v2 (軽量・基本情報) ---
  try {
    const params = new URLSearchParams({
      targets: 'title',
      fields: 'contentId,title,viewCounter,mylistCounter,likeCounter,thumbnailUrl,startTime',
      _context: 'NicoList', q: '', _limit: '1', _offset: '0', _sort: '-viewCounter',
      'filters[contentId][0]': videoId
    });
    const res = await fetch(`https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params}`);
    if (res.ok) {
      const json = await res.json();
      const item = json.data?.[0];
      if (item) {
        info = {
          videoId: item.contentId,
          title: item.title ?? '',
          thumbnailUrl: unifyThumb(item.thumbnailUrl ?? ''),
          viewCount: item.viewCounter ?? 0,
          mylistCount: item.mylistCounter ?? 0,
          likeCount: item.likeCounter ?? 0,
          postedAt: item.startTime ? new Date(item.startTime).getTime() : 0,
          ownerName: '', ownerIcon: '', description: '', site: 'niconico'
        };
      }
    }
  } catch (e) { }

  // --- 方法2: NVAPI (詳細・投稿者情報・非公開ステータス対応) ---
  // Method 1が失敗、または情報不足（タイトルがID、投稿者名がない等）の場合に実行
  if (!info || !info.ownerName || info.title === videoId) {
    try {
      const res = await fetch(
        `https://nvapi.nicovideo.jp/v1/videos?watchIds=${videoId}`,
        { headers: { 'X-Frontend-Id': '6', 'X-Frontend-Version': '0', 'Referer': 'https://www.nicovideo.jp/', 'Origin': 'https://www.nicovideo.jp' } }
      );
      if (res.ok) {
        const json = await res.json();
        const item = json.data?.items?.[0];
        const v = item?.video;
        const o = v?.owner;
        if (v) {
          const counts = v.count || {};
          const icon = o?.iconUrl || 'https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/defaults/blank.jpg';
          const fresh = {
            videoId: v.id || videoId,
            title: v.title ?? '',
            thumbnailUrl: unifyThumb(v.thumbnail?.largeUrl || v.thumbnail?.middleUrl || v.thumbnail?.url || ''),
            viewCount: counts.view ?? 0,
            mylistCount: counts.mylist ?? 0,
            likeCount: counts.like ?? 0,
            postedAt: v.registeredAt ? new Date(v.registeredAt).getTime() : 0,
            ownerName: o?.name || '',
            ownerIcon: icon,
            description: v.shortDescription ?? '',
            site: 'niconico'
          };
          // API(NVAPI)から取れた確定情報を優先して上書き
          if (info) {
            info = {
              ...info,
              title: fresh.title || info.title,
              thumbnailUrl: fresh.thumbnailUrl || info.thumbnailUrl,
              viewCount: fresh.viewCount || info.viewCount,
              mylistCount: fresh.mylistCount || info.mylistCount,
              likeCount: fresh.likeCount || info.likeCount,
              ownerName: fresh.ownerName || info.ownerName,
              ownerIcon: fresh.ownerIcon || info.ownerIcon,
              description: fresh.description || info.description
            };
          } else {
            info = fresh;
          }
        }
      }
    } catch (e) { }
  }

  // --- 方法3: getthumbinfo (最終フォールバック) ---
  if (!info || !info.title || info.title === videoId) {
    try {
      const res = await fetch(`https://ext.nicovideo.jp/api/getthumbinfo/${videoId}`);
      if (res.ok) {
        const xml = await res.text();
        const titleMatch = xml.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          const title = titleMatch[1];
          const thumbMatch = xml.match(/<thumbnail_url>([^<]+)<\/thumbnail_url>/);
          const viewMatch = xml.match(/<view_counter>(\d+)<\/view_counter>/);
          const mylistMatch = xml.match(/<mylist_counter>(\d+)<\/mylist_counter>/);
          const dateMatch = xml.match(/<first_retrieve>([^<]+)<\/first_retrieve>/);
          const ownerMatch = xml.match(/<user_nickname>([^<]+)<\/user_nickname>/) || xml.match(/<ch_name>([^<]+)<\/ch_name>/);

          const fallback = {
            videoId,
            title: title,
            thumbnailUrl: thumbMatch ? thumbMatch[1] : `https://nicovideo.cdn.nimg.jp/thumbnails/${videoId.replace(/\D/g,'')}/${videoId.replace(/\D/g,'')}.L`,
            viewCount: viewMatch ? parseInt(viewMatch[1], 10) : 0,
            mylistCount: mylistMatch ? parseInt(mylistMatch[1], 10) : 0,
            likeCount: 0,
            postedAt: dateMatch ? new Date(dateMatch[1]).getTime() : 0,
            ownerName: ownerMatch ? ownerMatch[1] : '',
            ownerIcon: '', description: '', site: 'niconico'
          };
          if (info) info = { ...fallback, ...info, title: fallback.title || info.title };
          else info = fallback;
        }
      }
    } catch (e) { }
  }

  if (info) return info;
  return { error: '動画情報を取得できませんでした', videoId };
}

// ═════════════════════════════════════════════════════════════
//  マイリスト取得
// ═════════════════════════════════════════════════════════════

async function fetchMylistVideos(mylistId) {
  try {
    let allVideos = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://nvapi.nicovideo.jp/v2/mylists/${mylistId}?pageSize=100&page=${page}`;
      const response = await fetch(url, {
        headers: { 'X-Frontend-Id': '6', 'X-Frontend-Version': '0', 'Referer': 'https://www.nicovideo.jp/', 'Origin': 'https://www.nicovideo.jp' }
      });
      if (!response.ok) break;
      const json = await response.json();
      const items = json.data?.mylist?.items || json.data?.items || [];
      if (items.length === 0) break;

      const videos = items.map(item => {
        const v = item.video || item;
        const icon = v.owner?.iconUrl || v.owner?.thumbnailUrl || v.channel?.iconUrl || v.channel?.thumbnailUrl
          || 'https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/defaults/blank.jpg';
        return {
          videoId: v.id || v.contentId || '',
          title: v.title ?? '',
          thumbnailUrl: unifyThumb(v.thumbnail?.largeUrl || v.thumbnail?.middleUrl || v.thumbnail?.url || ''),
          viewCount: v.count?.view ?? 0,
          mylistCount: v.count?.mylist ?? 0,
          likeCount: v.count?.like ?? 0,
          postedAt: v.registeredAt ? new Date(v.registeredAt).getTime() : 0,
          ownerName: v.owner?.nickname || v.owner?.name || v.channel?.name || '',
          ownerIcon: icon,
          description: v.description ?? ''
        };
      });
      allVideos = allVideos.concat(videos);
    }
    if (allVideos.length > 0) {
      allVideos.reverse();
      return { success: true, videos: allVideos };
    }
  } catch (e) { console.warn('NicoList: マイリスト取得失敗', e.message); }

  try {
    const rssUrl = `https://www.nicovideo.jp/mylist/${mylistId}?rss=2.0`;
    const response = await fetch(rssUrl);
    if (response.ok) {
      const text = await response.text();
      const videoIds = [];
      const regex = /nicovideo\.jp\/watch\/((?:sm|ss|nm|so)\d+)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (!videoIds.includes(match[1])) videoIds.push(match[1]);
      }
      if (videoIds.length > 0) {
        const videos = [];
        for (const vid of videoIds) {
          const info = await fetchVideoInfo(vid);
          if (info && !info.error) videos.push(info);
        }
        videos.reverse();
        return { success: true, videos };
      }
    }
  } catch (e) { console.warn('NicoList: RSS マイリスト取得失敗', e); }

  return { success: false, error: 'マイリスト取得に失敗', videos: [] };
}

// ═════════════════════════════════════════════════════════════
//  Bilibili動画情報取得
// ═════════════════════════════════════════════════════════════

async function fetchBilibiliVideoInfo(bvid) {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (res.ok) {
      const json = await res.json();
      const data = json.data;
      if (data) {
        return {
          videoId: bvid,
          title: data.title || '',
          thumbnailUrl: data.pic || '',
          viewCount: data.stat?.view || 0,
          mylistCount: data.stat?.favorite || 0,
          likeCount: data.stat?.like || 0,
          postedAt: data.pubdate ? data.pubdate * 1000 : 0,
          ownerName: data.owner?.name || '',
          ownerIcon: data.owner?.face || '',
          description: data.desc || '',
          site: 'bilibili'
        };
      }
    }
  } catch (e) {
    console.warn('NicoList: Bilibili API失敗', bvid, e.message);
  }
  return { error: '動画情報を取得できませんでした', videoId: bvid };
}

// ═════════════════════════════════════════════════════════════
//  SoundCloud動画情報取得
// ═════════════════════════════════════════════════════════════

async function fetchSoundCloudVideoInfo(urlPath) {
  const fullUrl = urlPath.startsWith('http') ? urlPath : `https://soundcloud.com/${urlPath.replace(/^\//, '')}`;
  const videoId = fullUrl.replace(/^https?:\/\/(www\.)?soundcloud\.com\//, '');
  
  let info = {
    videoId: videoId,
    title: videoId,
    thumbnailUrl: '',
    viewCount: 0,
    mylistCount: 0,
    likeCount: 0,
    postedAt: 0,
    ownerName: '',
    ownerIcon: '',
    description: '',
    site: 'soundcloud'
  };

  // 1. 基本情報 (oEmbed)
  try {
    const oembedRes = await fetch(`https://soundcloud.com/oembed?url=${encodeURIComponent(fullUrl)}&format=json`);
    if (oembedRes.ok) {
      const oembedData = await oembedRes.json();
      info.title = oembedData.title || info.title;
      info.thumbnailUrl = oembedData.thumbnail_url || info.thumbnailUrl;
      info.ownerName = oembedData.author_name || info.ownerName;
      info.description = oembedData.description || info.description;
    }
  } catch(e) { console.warn("NicoList: SC oEmbed API失敗", e); }

  // 2. 詳細情報 (HTMLスクレイピング - 再生数・いいね数・投稿日)
  try {
    const htmlRes = await fetch(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const playMatch = html.match(/<meta\s+property="soundcloud:play_count"\s+content="(\d+)"/i);
      if (playMatch) info.viewCount = parseInt(playMatch[1], 10) || 0;
      
      const likeMatch = html.match(/<meta\s+property="soundcloud:like_count"\s+content="(\d+)"/i);
      if (likeMatch) info.likeCount = parseInt(likeMatch[1], 10) || 0;
      
      const dateMatch = html.match(/"created_at":"([^"]+)"/);
      if (dateMatch) {
         info.postedAt = new Date(dateMatch[1]).getTime() || 0;
      }
    }
  } catch(e) { console.warn("NicoList: SC HTML parse失敗", e); }

  if (info.title === videoId && info.viewCount === 0) {
     return { error: '動画情報を取得できませんでした', videoId };
  }
  return info;
}

// ═════════════════════════════════════════════════════════════
//  YouTube動画情報取得 (oEmbed / noembed.com)
// ═════════════════════════════════════════════════════════════

async function fetchYouTubeVideoInfo(videoId) {
  // 方法1: YouTube動画ページから ytInitialPlayerResponse を抽出 (高精度)
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(watchUrl, { headers: { 'Accept-Language': 'ja-JP' } });
    if (response.ok) {
      const html = await response.text();
      // 複数パターンで ytInitialPlayerResponse を取得
      const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:var\s|const\s|let\s|<)/) ||
        html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
      if (match) {
        const data = JSON.parse(match[1]);
        const v = data.videoDetails;
        // microformat から投稿日時を取得
        const mf = data.microformat?.playerMicroformatRenderer;
        let postedAt = 0;
        if (mf) {
          const dateStr = mf.publishDate || mf.uploadDate;
          if (dateStr) {
            const parsed = new Date(dateStr).getTime();
            if (!isNaN(parsed) && parsed > 0) postedAt = parsed;
          }
        }
        if (v) {
          // いいね数をHTMLから抽出を試行
          let likeCount = 0;
          const likePatterns = [
            /"defaultText"\s*:\s*\{\s*"accessibility"\s*:\s*\{\s*"accessibilityData"\s*:\s*\{\s*"label"\s*:\s*"[^"]*?(\d[\d,.]*)\s*件\s*の高\u8a55価/,
            /"高\u304f\u8a55\u4fa1[^"]*?(\d[\d,.]*)\s*/,
            /"like this video along with ([\d,]+)/i,
            /"likeCount"\s*:\s*"?(\d+)/,
            /"label"\s*:\s*"[^"]*?(\d[\d,.]*)\s*likes/i
          ];
          for (const pat of likePatterns) {
            const lm = html.match(pat);
            if (lm) {
              likeCount = parseInt(lm[1].replace(/[,.]/g, ''), 10) || 0;
              if (likeCount > 0) break;
            }
          }

          return {
            videoId,
            title: v.title || '',
            thumbnailUrl: v.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            viewCount: parseInt(v.viewCount || '0', 10),
            mylistCount: -1,
            likeCount,
            postedAt,
            ownerName: v.author || '',
            ownerIcon: '',
            description: v.shortDescription || '',
            site: 'youtube'
          };
        }
      }

      // ytInitialPlayerResponseが取れなかった場合、JSON-LDから取得を試行
      const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
      if (ldMatch) {
        try {
          const ld = JSON.parse(ldMatch[1]);
          let viewCount = 0;
          let postedAt = 0;
          if (ld.interactionStatistic) {
            const stats = Array.isArray(ld.interactionStatistic) ? ld.interactionStatistic : [ld.interactionStatistic];
            for (const stat of stats) {
              if (stat.interactionType === 'http://schema.org/WatchAction' || stat.interactionType === 'https://schema.org/WatchAction') {
                viewCount = parseInt(stat.userInteractionCount, 10) || 0;
              }
            }
          }
          if (ld.uploadDate) {
            const parsed = new Date(ld.uploadDate).getTime();
            if (!isNaN(parsed) && parsed > 0) postedAt = parsed;
          }
          if (ld.name) {
            return {
              videoId,
              title: ld.name || '',
              thumbnailUrl: (ld.thumbnailUrl && ld.thumbnailUrl[0]) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              viewCount,
              mylistCount: -1,
              likeCount: 0,
              postedAt,
              ownerName: ld.author || '',
              ownerIcon: '',
              description: ld.description || '',
              site: 'youtube'
            };
          }
        } catch (e) { }
      }
    }
  } catch (e) {
    console.warn('NicoList: YouTubeページ取得失敗', e);
  }

  // 方法2: oEmbed / noembed.com (フォールバック)
  try {
    const url = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data.title) {
        return {
          videoId,
          title: data.title || '',
          thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          viewCount: 0,
          mylistCount: 0,
          likeCount: 0,
          postedAt: 0,
          ownerName: data.author_name || '',
          ownerIcon: '',
          description: '',
          site: 'youtube'
        };
      }
    }
  } catch (e) {
    console.warn('NicoList: YouTube oEmbed取得失敗', e);
  }
  return { error: 'YouTube動画情報を取得できませんでした', videoId, site: 'youtube' };
}

// ═════════════════════════════════════════════════════════════════
//  リスト内動画の情報一括更新
// ═════════════════════════════════════════════════════════════════

async function refreshVideos(listId) {
  const videos = await nicoListStorage.getVideos(listId, 'addedAt', 'desc');
  let updated = 0;
  const chunkSize = 5;

  for (let i = 0; i < videos.length; i += chunkSize) {
    const chunk = videos.slice(i, i + chunkSize);
    
    const freshInfos = await Promise.all(chunk.map(async (video) => {
      try {
        const site = video.site || (video.videoId?.startsWith('sm') || video.videoId?.startsWith('ss') || video.videoId?.startsWith('nm') ? 'niconico' : 'youtube');
        const info = await cachedFetchVideoInfo(video.videoId, site, true); // forceRefresh
        if (info && !info.error) {
          return { video, info };
        }
      } catch (e) {
        console.warn('NicoList: refreshVideos fetch error', video.videoId, e);
      }
      return null;
    }));

    const validFresh = freshInfos.filter(x => x !== null);
    if (validFresh.length > 0) {
      try {
        const db = await nicoListStorage.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('videos', 'readwrite');
          const store = tx.objectStore('videos');

          tx.oncomplete = () => resolve();
          tx.onerror = (e) => reject(e.target.error);

          for (const { video, info } of validFresh) {
            const getReq = store.get(video.id);
            getReq.onsuccess = () => {
              const existing = getReq.result;
              if (existing) {
                existing.title = info.title || existing.title;
                existing.thumbnailUrl = info.thumbnailUrl || existing.thumbnailUrl;
                
                // データ破壊防止マージ処理: oEmbedフォールバック等で0が返ってきた場合に、既存の正しいデータを破壊するのを防ぐ
                if (info.viewCount !== undefined && (info.viewCount > 0 || !existing.viewCount)) {
                  existing.viewCount = info.viewCount;
                }
                if (info.likeCount !== undefined && (info.likeCount > 0 || !existing.likeCount)) {
                  existing.likeCount = info.likeCount;
                }
                if (info.mylistCount !== undefined && (info.mylistCount >= 0 || existing.mylistCount === undefined)) {
                  if (info.mylistCount >= 0 || (info.mylistCount === -1 && existing.mylistCount === undefined)) {
                    existing.mylistCount = info.mylistCount;
                  }
                }
                if (info.postedAt && (info.postedAt > 0 || !existing.postedAt)) {
                  existing.postedAt = info.postedAt;
                }

                existing.ownerName = info.ownerName || existing.ownerName;
                existing.ownerIcon = info.ownerIcon || existing.ownerIcon;
                
                store.put(existing);
                updated++;
              }
            };
          }
        });
      } catch (err) {
        console.warn('NicoList: refreshVideos DB write error', err);
      }
    }

    // API負荷軽減
    if (i + chunkSize < videos.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return { success: true, updated, total: videos.length };
}

// ═════════════════════════════════════════════════════════════
//  クラウド共有（Cloudflare D1 バックエンド）
// ═════════════════════════════════════════════════════════════

const SHARE_API_BASE = 'https://nicolist-share-api.halkun19.workers.dev';

async function createShareLink(data) {
  try {
    const body = JSON.stringify(data);
    if (body.length > 500000) {
      return { success: false, error: 'データサイズが大きすぎます（500KB制限）' };
    }
    const res = await fetch(`${SHARE_API_BASE}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const json = await res.json();
    return { success: true, id: json.id };
  } catch (e) {
    console.error('NicoList: クラウド共有リンク作成失敗', e);
    return { success: false, error: e.message };
  }
}

async function getSharedList(id) {
  try {
    if (!id || id.length > 10) {
      return { success: false, error: '無効な共有コードです' };
    }
    const res = await fetch(`${SHARE_API_BASE}/api/share/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      return { success: false, error: '共有コードが見つかりません（期限切れの可能性があります）' };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { success: true, data };
  } catch (e) {
    console.error('NicoList: クラウド共有リスト取得失敗', e);
    return { success: false, error: e.message };
  }
}
