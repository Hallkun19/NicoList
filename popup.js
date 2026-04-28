/**
 * ============================================================
 * NicoList - Popup Script
 * ============================================================
 */

(function () {
  'use strict';

  // SVG Icons
  const ICONS = {
    play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
    edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    drag: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>',
    view: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    mylist: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>', // フォルダ風アイコン (v1.4)
    like: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  };

  // State
  let currentListId = null;
  let currentListName = '';
  // ドラッグ操作保存用
  let draggedItem = null;

  // DOM Elements
  const viewLists = document.getElementById('view-lists');
  const viewVideos = document.getElementById('view-videos');
  const viewSettings = document.getElementById('view-settings');

  const listsContainer = document.getElementById('lists-container');
  const videosContainer = document.getElementById('videos-container');

  // Handlers binding
  document.getElementById('btn-create-list').addEventListener('click', handleCreateList);
  document.getElementById('input-new-list').addEventListener('keypress', (e) => { if (e.key === 'Enter') handleCreateList(); });

  document.getElementById('btn-back-to-lists').addEventListener('click', () => switchView(viewLists));
  document.getElementById('btn-back-to-lists-from-settings').addEventListener('click', () => { switchView(viewLists); loadLists(); });
  document.getElementById('btn-settings').addEventListener('click', () => { switchView(viewSettings); loadImportTargets(); loadSettings(); });

  document.getElementById('select-sort').addEventListener('change', loadVideos);
  document.getElementById('btn-play-continuous').addEventListener('click', () => handlePlay(false));
  document.getElementById('btn-play-shuffle').addEventListener('click', () => handlePlay(true));
  document.getElementById('btn-refresh-videos').addEventListener('click', handleRefreshVideos);

  document.getElementById('btn-export-json').addEventListener('click', handleExport);
  document.getElementById('input-import-json').addEventListener('change', handleImport);
  document.getElementById('btn-import-mylist').addEventListener('click', handleMylistImport);
  document.getElementById('btn-fullview').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'openFullView' });
    window.close();
  });

  // v2.1: デフォルトリスト選択（クイック追加用）
  const defaultListSelect = document.getElementById('select-default-list');
  if (defaultListSelect) {
    defaultListSelect.addEventListener('change', async () => {
      const settings = await chrome.runtime.sendMessage({ action: 'getSettings' }) || {};
      settings.defaultListId = defaultListSelect.value || '';
      await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
    });
  }

  // クイック追加モード設定
  const quickAddModeSelect = document.getElementById('select-quick-add-mode');
  if (quickAddModeSelect) {
    quickAddModeSelect.addEventListener('change', async () => {
      const settings = await chrome.runtime.sendMessage({ action: 'getSettings' }) || {};
      settings.quickAddMode = quickAddModeSelect.value || 'dblclick';
      await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
    });
  }

  async function loadSettings() {
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' }) || {};
    // クイック追加モードの復元
    if (quickAddModeSelect) {
      quickAddModeSelect.value = settings.quickAddMode || 'dblclick';
    }
    // デフォルトリスト選択の選択肢を構築
    if (defaultListSelect) {
      const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' }) || [];
      defaultListSelect.innerHTML = '<option value="">(未設定 - クイック追加無効)</option>';
      for (const list of lists) {
        const opt = document.createElement('option');
        opt.value = list.id;
        opt.textContent = list.name;
        if (settings.defaultListId === list.id) opt.selected = true;
        defaultListSelect.appendChild(opt);
      }
    }
  }

  // Initialization
  loadLists();


  // ═══════════════════════════════════════════════════════════
  //  View Navigation
  // ═══════════════════════════════════════════════════════════
  function switchView(viewElement) {
    viewLists.classList.remove('active'); viewLists.classList.add('hidden');
    viewVideos.classList.remove('active'); viewVideos.classList.add('hidden');
    viewSettings.classList.remove('active'); viewSettings.classList.add('hidden');

    viewElement.classList.remove('hidden');
    viewElement.classList.add('active');
  }

  // ═══════════════════════════════════════════════════════════
  //  List Management (w/ Drag and Drop)
  // ═══════════════════════════════════════════════════════════
  async function loadLists() {
    listsContainer.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' });
      if (!lists || lists.length === 0) {
        listsContainer.innerHTML = '<div class="empty">リストがありません</div>';
        return;
      }

      listsContainer.innerHTML = '';
      for (const list of lists) {
        const count = await chrome.runtime.sendMessage({ action: 'getVideoCount', listId: list.id });
        const item = createListItemElement(list, count);
        listsContainer.appendChild(item);
      }
      setupDragAndDrop();

      // バックグラウンドでセレクトボックスを更新しておく
      if (document.getElementById('select-import-target')) loadImportTargets(lists);
    } catch (err) {
      listsContainer.innerHTML = `<div class="empty" style="color:var(--nl-danger);">エラー: ${err.message}</div>`;
    }
  }

  // 設定画面のリスト選択肢をロード
  async function loadImportTargets(cachedLists = null) {
    const selectTarget = document.getElementById('select-import-target');
    if (!selectTarget) return;

    let lists = cachedLists;
    if (!lists) {
      try {
        lists = await chrome.runtime.sendMessage({ action: 'getAllLists' });
      } catch (e) {
        lists = [];
      }
    }

    selectTarget.innerHTML = '<option value="new">(新しいリストとして取り込む)</option>';
    if (lists) {
      for (const list of lists) {
        const opt = document.createElement('option');
        opt.value = list.id;
        opt.textContent = truncateStr(`追加: ${list.name}`, 30);
        selectTarget.appendChild(opt);
      }
    }
  }

  function createListItemElement(list, videoCount) {
    const el = document.createElement('div');
    el.className = 'list-item';
    el.dataset.id = list.id;

    el.innerHTML = `
      <div class="list-header" tabindex="0">
        <div class="drag-handle" title="ドラッグして並び替え">${ICONS.drag}</div>
        <div class="list-info">
          <div class="list-title">${escapeHtml(list.name)}</div>
          <div class="list-meta">${videoCount} 動画 • ${new Date(list.createdAt).toLocaleDateString()}</div>
        </div>
      </div>
      <div class="list-body">
        <div class="list-action-row">
          <button class="action-btn primary btn-open">${ICONS.play} 開く</button>
          <button class="action-btn btn-rename">${ICONS.edit} 変更</button>
          <button class="action-btn danger btn-delete">${ICONS.trash} 削除</button>
        </div>
      </div>
    `;

    el.querySelector('.list-header').addEventListener('click', (e) => {
      if (e.target.closest('.drag-handle')) return;
      const expanded = document.querySelector('.list-item.expanded');
      if (expanded && expanded !== el) expanded.classList.remove('expanded');
      el.classList.toggle('expanded');
    });

    el.querySelector('.btn-open').addEventListener('click', (e) => {
      e.stopPropagation();
      openVideoList(list.id, list.name);
    });

    el.querySelector('.btn-rename').addEventListener('click', async (e) => {
      e.stopPropagation();
      const newName = prompt('新しいリスト名:', list.name);
      if (newName && newName.trim() !== '' && newName !== list.name) {
        try {
          await chrome.runtime.sendMessage({ action: 'updateListName', id: list.id, name: newName.trim() });
          loadLists();
        } catch (e) { alert('更新に失敗しました'); }
      }
    });

    el.querySelector('.btn-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`本当に「${list.name}」を削除しますか？\n(含まれる動画もすべてリストから削除されます)`)) {
        try {
          await chrome.runtime.sendMessage({ action: 'deleteList', id: list.id });
          loadLists();
        } catch (e) { alert('削除に失敗しました'); }
      }
    });

    return el;
  }

  function setupDragAndDrop() {
    const items = Array.from(listsContainer.querySelectorAll('.list-item'));

    items.forEach(item => {
      const handle = item.querySelector('.drag-handle');

      handle.addEventListener('mousedown', () => { item.setAttribute('draggable', 'true'); });
      handle.addEventListener('mouseup', () => { item.removeAttribute('draggable'); });
      handle.addEventListener('mouseleave', () => { item.removeAttribute('draggable'); });

      item.addEventListener('dragstart', (e) => {
        draggedItem = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.id);
      });

      item.addEventListener('dragend', () => {
        draggedItem = null;
        item.classList.remove('dragging');
        item.removeAttribute('draggable');
        items.forEach(i => i.classList.remove('drag-over', 'drag-up', 'drag-down'));
        saveCurrentListOrder();
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (item === draggedItem) return;

        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        items.forEach(i => i.classList.remove('drag-over', 'drag-up', 'drag-down'));
        item.classList.add('drag-over');

        if (e.clientY < midY) {
          item.classList.add('drag-up');
          listsContainer.insertBefore(draggedItem, item);
        } else {
          item.classList.add('drag-down');
          listsContainer.insertBefore(draggedItem, item.nextSibling);
        }
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over', 'drag-up', 'drag-down');
      });
    });
  }

  async function saveCurrentListOrder() {
    const listElements = Array.from(listsContainer.querySelectorAll('.list-item'));
    const newOrder = listElements.map(el => el.dataset.id);
    await chrome.runtime.sendMessage({ action: 'saveListOrder', order: newOrder });
  }

  async function handleCreateList() {
    const input = document.getElementById('input-new-list');
    const name = input.value.trim();
    if (!name) return;

    try {
      await chrome.runtime.sendMessage({ action: 'createList', name });
      input.value = '';
      loadLists();
    } catch (e) { alert('作成に失敗しました: ' + e.message); }
  }

  // ═══════════════════════════════════════════════════════════
  //  Video Management
  // ═══════════════════════════════════════════════════════════
  async function openVideoList(listId, listName) {
    currentListId = listId;
    currentListName = listName;
    document.getElementById('current-list-name').textContent = listName;
    switchView(viewVideos);
    await loadVideos();
  }

  async function loadVideos() {
    if (!currentListId) return;
    videosContainer.innerHTML = '<div class="loading">読み込み中...</div>';

    const sortVal = document.getElementById('select-sort').value;
    const [sortKey, sortOrder] = sortVal.split('_');

    try {
      const videos = await chrome.runtime.sendMessage({
        action: 'getVideos', listId: currentListId, sortKey, sortOrder
      });

      if (!videos || videos.length === 0) {
        videosContainer.innerHTML = '<div class="empty">動画がありません。<br>ニコニコ動画視聴ページから追加してください。</div>';
        return;
      }

      videosContainer.innerHTML = '';

      // v2.0: 段階ロード（50件ずつ）
      const PAGE_SIZE = 50;
      let loadedCount = 0;

      function loadBatch() {
        const end = Math.min(loadedCount + PAGE_SIZE, videos.length);
        for (let i = loadedCount; i < end; i++) {
          videosContainer.appendChild(createVideoItemElement(videos[i]));
        }
        loadedCount = end;

        // まだ残りがある場合はセンチネル要素を配置
        if (loadedCount < videos.length) {
          let sentinel = document.getElementById('nicolist-load-more');
          if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = 'nicolist-load-more';
            sentinel.className = 'loading';
            sentinel.style.padding = '12px';
            sentinel.textContent = `さらに読み込み中... (${loadedCount}/${videos.length})`;
          }
          videosContainer.appendChild(sentinel);

          const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
              observer.disconnect();
              sentinel.remove();
              loadBatch();
            }
          }, { threshold: 0.1 });
          observer.observe(sentinel);
        }
      }

      loadBatch();
    } catch (err) {
      videosContainer.innerHTML = `<div class="empty" style="color:var(--nl-danger);">エラー: ${err.message}</div>`;
    }
  }

  function createVideoItemElement(video) {
    const el = document.createElement('div');
    el.className = 'video-item';

    // v2.0: site対応URL
    const watchUrl = video.site === 'youtube'
      ? `https://www.youtube.com/watch?v=${video.videoId}`
      : `https://www.nicovideo.jp/watch/${video.videoId}`;
    const postedDateStr = new Date(video.postedAt || 0).toLocaleDateString();
    const addedDateStr = new Date(video.addedAt || video.postedAt).toLocaleDateString();


    // v1.4+: 再生時間(duration)削除, 投稿日時上部移動, 登録日時右下固定
    el.innerHTML = `
      <a href="${watchUrl}" target="_blank" class="video-thumb" title="新しいタブで開く">
        ${video.thumbnailUrl ? `<img src="${escapeHtml(video.thumbnailUrl)}" alt="thumb" loading="lazy">` : ''}
      </a>
      <div class="video-info">
        <a href="${watchUrl}" target="_blank" class="video-title">${escapeHtml(video.title)}</a>
        
        <div class="video-posted-date">${postedDateStr}</div>

        <div class="video-meta">
          <div class="video-owner-area">
            ${video.ownerIcon ? `<img src="${escapeHtml(video.ownerIcon)}" class="owner-icon-small">` : ''}
            ${video.ownerName ? `<span class="owner-name-small">${escapeHtml(video.ownerName)}</span>` : ''}
          </div>
        </div>

        <div class="video-stats-row">
          <span title="再生数">${ICONS.view} ${formatCount(video.viewCount)}</span>
          <span title="いいね数">${ICONS.like} ${formatCount(video.likeCount)}</span>
            ${video.mylistCount >= 0 ? `<span title="マイリスト数">${ICONS.mylist} ${formatCount(video.mylistCount)}</span>` : ''}
        </div>

        <div class="video-added-date">登録: ${addedDateStr}</div>
      </div>
      <div class="video-actions">
        <button class="icon-btn btn-remove" title="リストから削除">${ICONS.trash}</button>
      </div>
    `;

    el.querySelector('.btn-remove').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (confirm(`リストから削除しますか？\n「${video.title}」`)) {
        try {
          await chrome.runtime.sendMessage({ action: 'removeVideo', videoDbId: video.id });
          el.remove();
          if (videosContainer.children.length === 0) {
            videosContainer.innerHTML = '<div class="empty">動画がありません。</div>';
          }
        } catch (e) { alert('削除に失敗しました'); }
      }
    });

    return el;
  }

  async function handlePlay(shuffle) {
    if (!currentListId) return;
    const sortVal = document.getElementById('select-sort').value;
    const [sortKey, sortOrder] = sortVal.split('_');

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'startPlayback', listId: currentListId, sortKey, sortOrder, shuffle
      });
      if (!res.success) alert(res.message || '再生開始に失敗しました');
    } catch (e) { alert('エラーが発生しました: ' + e.message); }
  }

  async function handleRefreshVideos() {
    if (!currentListId) return;
    const btn = document.getElementById('btn-refresh-videos');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    try {
      const res = await chrome.runtime.sendMessage({ action: 'refreshVideos', listId: currentListId });
      if (res.success) {
        await loadVideos();
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>完了';
        setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
      } else {
        throw new Error(res.error || '更新失敗');
      }
    } catch (e) {
      alert('情報更新に失敗しました: ' + e.message);
      btn.innerHTML = originalHTML;
    }
    btn.disabled = false;
  }

  // ═══════════════════════════════════════════════════════════
  //  Settings & Utils
  // ═══════════════════════════════════════════════════════════
  async function handleExport() {
    try {
      const data = await chrome.runtime.sendMessage({ action: 'exportAll' });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nicolist_export_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert('エクスポート失敗: ' + e.message); }
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm('現在のデータをすべて上書きインポートしますか？\n(取り消しはできません)')) {
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const res = await chrome.runtime.sendMessage({ action: 'importData', data, overwrite: true });
        if (res.success) {
          alert(`インポート完了\nリスト: ${res.listsAdded} 件\n動画: ${res.videosAdded} 件`);
          switchView(viewLists);
          loadLists();
        } else throw new Error('失敗');
      } catch (err) {
        alert('インポート失敗: JSONファイルが不正か処理エラーです');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  async function handleMylistImport() {
    const targetSelect = document.getElementById('select-import-target');
    const mlInput = document.getElementById('input-mylist-id');
    const mylistIdRaw = mlInput.value.trim();
    if (!mylistIdRaw) return;

    const mylistIdMatch = mylistIdRaw.match(/\d+/);
    if (!mylistIdMatch) { alert('有効なマイリストIDを入力してください'); return; }

    const mylistId = mylistIdMatch[0];
    const statusEl = document.getElementById('mylist-status');
    const btn = document.getElementById('btn-import-mylist');

    statusEl.textContent = 'マイリストを取得中... (上限500件)';
    statusEl.className = 'status-msg';
    btn.disabled = true;

    try {
      const resp = await chrome.runtime.sendMessage({ action: 'fetchMylistVideos', mylistId });

      if (!resp || !resp.success || !resp.videos || resp.videos.length === 0) {
        throw new Error(resp?.error || '動画が見つかりません。公開設定になっているか確認してください。');
      }

      // 上限500件
      const fetchedVideos = resp.videos.slice(0, 500);

      const targetVal = targetSelect ? targetSelect.value : 'new';
      let targetListId;

      if (targetVal === 'new') {
        statusEl.textContent = `取得完了(${fetchedVideos.length}件)。新規リスト作成中...`;
        const listRes = await chrome.runtime.sendMessage({ action: 'createList', name: `マイリスト ${mylistId}` });
        if (!listRes || !listRes.id) throw new Error('リストの作成に失敗しました');
        targetListId = listRes.id;
      } else {
        statusEl.textContent = `取得完了(${fetchedVideos.length}件)。対象リストへ追加中...`;
        targetListId = targetVal;
      }

      let addedCount = 0;
      // 古い順に逆転して追加することで追加日時の順番（addedAtソート時）を維持（バックグラウンドロジック外）
      const reverseList = [...fetchedVideos].reverse();

      for (let i = 0; i < reverseList.length; i++) {
        statusEl.textContent = `追加中... (${i + 1}/${reverseList.length})`;
        // 少し遅延を入れて addedAt の一意性/順序性を担保
        const addRes = await chrome.runtime.sendMessage({ action: 'addVideo', listId: targetListId, videoInfo: reverseList[i] });
        if (addRes && addRes.success) addedCount++;
        await new Promise(r => setTimeout(r, 2));
      }

      statusEl.textContent = `完了! ${addedCount}件の動画を取り込みました。`;
      statusEl.className = 'status-msg success';
      mlInput.value = '';

      loadLists(); // 背景でリスト再ロード
    } catch (e) {
      statusEl.textContent = `エラー: ${e.message}`;
      statusEl.className = 'status-msg error';
    } finally {
      btn.disabled = false;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatCount(num) {
    if (num == null) return '0';
    if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return num.toLocaleString();
  }

  function truncateStr(str, limit) {
    if (!str) return '';
    if (str.length > limit) return str.substring(0, limit) + '...';
    return str;
  }

})();
