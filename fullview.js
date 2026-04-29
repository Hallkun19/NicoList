/**
 * ============================================================
 * NicoList - FullView Script
 * ============================================================
 *
 * 別タブで開くリスト閲覧・管理画面。
 * グリッド/リスト表示切替、ソート、連続再生、共有コード生成を提供する。
 */

(function () {
  'use strict';

  // SVG Icons
  const ICONS = {
    view: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    // v1.4 フォルダ風アイコン
    mylist: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    like: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
    edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    drag: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>',
    share: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'
  };

  // State
  let currentListId = null;
  let viewMode = 'grid'; // 'grid' | 'list'
  let draggedItem = null;

  // DOM
  const listsContainer = document.getElementById('fv-lists-container');
  const videosContainer = document.getElementById('fv-videos-container');
  const titleEl = document.getElementById('fv-current-list-title');
  const countEl = document.getElementById('fv-current-list-count');
  const controlsEl = document.getElementById('fv-controls');

  // View Toggle Buttons
  const btnGrid = document.getElementById('btn-view-grid');
  const btnList = document.getElementById('btn-view-list');

  // Load ViewMode preference and check for updates
  chrome.storage.local.get(['fvViewMode', 'updateAvailable'], (res) => {
    if (res.fvViewMode === 'list') {
      setViewMode('list');
    } else {
      setViewMode('grid');
    }

    if (res.updateAvailable) {
      const banner = document.createElement('div');
      banner.className = 'fv-update-banner';

      const releaseNoteHtml = res.updateAvailable.releaseNote
        ? `<div style="font-size: 12px; margin-top: 6px; color: var(--nl-text-secondary); line-height: 1.4;">${escapeHtml(res.updateAvailable.releaseNote).replace(/\n/g, '<br>')}</div>`
        : '';

      banner.innerHTML = `
        <div style="display:flex; flex-direction:column; flex:1;">
          <span style="font-weight:bold;">NicoListの新しいバージョン (v${escapeHtml(res.updateAvailable.version)}) が利用可能です！</span>
          ${releaseNoteHtml}
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-left:16px;">
          <a href="${escapeHtml(res.updateAvailable.url)}" target="_blank" class="fv-update-btn">ダウンロード</a>
          <button class="fv-update-close" title="閉じる">✕</button>
        </div>
      `;
      document.body.insertBefore(banner, document.querySelector('.fv-header'));
      banner.querySelector('.fv-update-close').addEventListener('click', () => {
        banner.remove();
        chrome.storage.local.remove('updateAvailable');
      });
    }
  });

  // Bind Events
  btnGrid.addEventListener('click', () => setViewMode('grid'));
  btnList.addEventListener('click', () => setViewMode('list'));

  document.getElementById('btn-fv-create-list').addEventListener('click', handleCreateList);
  document.getElementById('input-fv-new-list').addEventListener('keypress', e => { if (e.key === 'Enter') handleCreateList(); });

  document.getElementById('fv-select-sort').addEventListener('change', loadVideos);
  document.getElementById('btn-fv-play-cont').addEventListener('click', () => handlePlay(false));
  document.getElementById('btn-fv-play-shuffle').addEventListener('click', () => handlePlay(true));
  document.getElementById('btn-fv-refresh').addEventListener('click', handleRefreshVideos);

  document.getElementById('btn-fv-load-code').addEventListener('click', () => {
    showFvTextInputModal('共有コードを読み込む', '', '6桁のコードを入力', (val) => {
      if (!val || val.length !== 6) {
        showToast('無効なコードです');
        return;
      }
      const url = chrome.runtime.getURL(`shared.html?c=${val}`);
      window.open(url, '_blank');
    });
  });

  document.getElementById('btn-fv-export').addEventListener('click', handleExport);
  document.getElementById('input-fv-import').addEventListener('change', handleImport);
  document.getElementById('btn-fv-settings').addEventListener('click', openSettingsPanel);

  // Initialize
  loadListsAndSelectFirst();

  // ═══════════════════════════════════════════════════════════
  //  v2.1: 設定パネル（デフォルトリスト選択）
  // ═══════════════════════════════════════════════════════════
  async function openSettingsPanel() {
    document.getElementById('fv-settings-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'fv-settings-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(2px);';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const panel = document.createElement('div');
    panel.style.cssText = 'width:480px;max-height:80vh;background:var(--nl-bg-card);border:1px solid var(--nl-border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:var(--nl-font);overflow:hidden;display:flex;flex-direction:column;';

    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' }) || {};
    const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' }) || [];

    let listOptions = '<option value="">(未設定 - ダブルクリック無効)</option>';
    let importOptions = '<option value="new">(新しいリストとして取り込む)</option>';
    for (const list of lists) {
      const sel1 = settings.defaultListId === list.id ? 'selected' : '';
      listOptions += `<option value="${list.id}" ${sel1}>${escapeHtml(list.name)}</option>`;
      importOptions += `<option value="${list.id}">${escapeHtml(list.name)}</option>`;
    }

    const sectionStyle = 'padding:16px 20px;border-bottom:1px solid var(--nl-border);';
    const labelStyle = 'font-size:14px;font-weight:600;color:var(--nl-text);margin-bottom:6px;';
    const descStyle = 'font-size:12px;color:var(--nl-text-muted);margin-bottom:10px;line-height:1.5;';
    const selectStyle = 'width:100%;padding:8px 12px;background:var(--nl-bg-input);color:var(--nl-text);border:1px solid var(--nl-border);border-radius:4px;font-size:13px;font-family:var(--nl-font);outline:none;';
    const inputStyle = 'flex:1;padding:8px 12px;background:var(--nl-bg-input);color:var(--nl-text);border:1px solid var(--nl-border);border-radius:4px;font-size:13px;font-family:var(--nl-font);outline:none;';
    const btnStyle = 'padding:8px 16px;border-radius:4px;border:1px solid var(--nl-border);background:var(--nl-bg-input);color:var(--nl-text);cursor:pointer;font-size:13px;font-family:var(--nl-font);display:inline-flex;align-items:center;gap:6px;transition:0.2s;';
    const btnPrimaryStyle = btnStyle + 'background:var(--nl-primary);border-color:var(--nl-primary);color:#fff;';

    panel.innerHTML = `
      <div style="padding:16px 20px;background:var(--nl-bg-header);border-bottom:1px solid var(--nl-border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <h3 style="margin:0;font-size:16px;font-weight:600;color:var(--nl-text);">⚙ 設定 / 連携</h3>
        <button id="fv-settings-close" style="background:none;border:none;color:var(--nl-text-muted);cursor:pointer;padding:4px;font-size:18px;">✕</button>
      </div>
      <div style="overflow-y:auto;flex:1;">
        <!-- セクション1: ダブルクリック即追加 -->
        <div style="${sectionStyle}">
          <div style="${labelStyle}">ダブルクリック即追加</div>
          <div style="${descStyle}">リスト追加ボタンをダブルクリックした時に、選択したリストへ即座に追加します。<br>シングルクリックは従来通りリスト選択ウィンドウが開きます。</div>
          <select id="fv-settings-default-list" style="${selectStyle}">
            ${listOptions}
          </select>
        </div>

        <!-- セクション2: マイリスト取り込み -->
        <div style="${sectionStyle}">
          <div style="${labelStyle}">マイリスト取り込み</div>
          <div style="${descStyle}">ニコニコ動画の既存マイリストをNicoListに取り込みます。（※公開設定のマイリストのみ）</div>
          <select id="fv-settings-import-target" style="${selectStyle}margin-bottom:8px;">
            ${importOptions}
          </select>
          <div style="display:flex;gap:8px;">
            <input type="text" id="fv-settings-mylist-id" placeholder="マイリストID (例: 1234567)" style="${inputStyle}">
            <button id="fv-settings-import-btn" style="${btnPrimaryStyle}">取り込み</button>
          </div>
          <div id="fv-settings-mylist-status" style="font-size:12px;margin-top:6px;color:var(--nl-text-muted);"></div>
        </div>

        <!-- セクション3: データ管理 -->
        <div style="${sectionStyle}border-bottom:none;">
          <div style="${labelStyle}">データ管理</div>
          <div style="${descStyle}">リストデータのバックアップとリストアを行います。</div>
          <div style="display:flex;gap:8px;">
            <button id="fv-settings-export" style="${btnStyle}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              エクスポート (JSON)
            </button>
            <label style="${btnStyle}cursor:pointer;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              インポート
              <input type="file" id="fv-settings-import-file" accept=".json" style="display:none;">
            </label>
          </div>
        </div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--nl-border);flex-shrink:0;">
        <button id="fv-settings-save" style="width:100%;padding:10px;background:var(--nl-primary);color:#fff;border:none;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--nl-font);transition:0.2s;">保存</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // イベントバインド
    document.getElementById('fv-settings-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });

    // 保存ボタン
    document.getElementById('fv-settings-save').addEventListener('click', async () => {
      const sel = document.getElementById('fv-settings-default-list');
      const newSettings = { ...settings, defaultListId: sel.value || '' };
      await chrome.runtime.sendMessage({ action: 'saveSettings', settings: newSettings });
      showToast('設定を保存しました');
      overlay.remove();
    });

    // マイリスト取り込み
    document.getElementById('fv-settings-import-btn').addEventListener('click', async () => {
      const mylistId = document.getElementById('fv-settings-mylist-id').value.trim();
      const targetListId = document.getElementById('fv-settings-import-target').value;
      const statusEl = document.getElementById('fv-settings-mylist-status');
      if (!mylistId) { statusEl.textContent = 'マイリストIDを入力してください'; statusEl.style.color = 'var(--nl-danger)'; return; }
      statusEl.textContent = '取得中...'; statusEl.style.color = 'var(--nl-text-muted)';
      try {
        const result = await chrome.runtime.sendMessage({ action: 'fetchMylistVideos', mylistId });
        if (!result.success || !result.videos.length) {
          statusEl.textContent = result.error || '取得失敗'; statusEl.style.color = 'var(--nl-danger)'; return;
        }
        let listId = targetListId;
        if (targetListId === 'new') {
          const newList = await chrome.runtime.sendMessage({ action: 'createList', name: `マイリスト ${mylistId}` });
          listId = newList.id;
        }
        let added = 0;
        for (const v of result.videos) {
          try { const r = await chrome.runtime.sendMessage({ action: 'addVideo', listId, videoInfo: v }); if (r.success) added++; } catch (e) { }
        }
        statusEl.textContent = `${added}/${result.videos.length} 件を取り込みました`; statusEl.style.color = 'var(--nl-success)';
      } catch (e) {
        statusEl.textContent = 'エラー: ' + e.message; statusEl.style.color = 'var(--nl-danger)';
      }
    });

    // エクスポート
    document.getElementById('fv-settings-export').addEventListener('click', async () => {
      const data = await chrome.runtime.sendMessage({ action: 'exportAll' });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `nicolist_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      showToast('エクスポート完了');
    });

    // インポート
    document.getElementById('fv-settings-import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await chrome.runtime.sendMessage({ action: 'importData', data, overwrite: false });
        showToast('インポート完了');
        overlay.remove();
        loadListsAndSelectFirst();
      } catch (err) {
        showToast('インポート失敗: ' + err.message);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Generic Modal Logic
  // ═══════════════════════════════════════════════════════════
  function showFvTextInputModal(title, initialValue, placeholder, onSave) {
    const modal = document.getElementById('fv-modal-text-input');
    const titleEl = document.getElementById('fv-modal-text-title');
    const inputEl = document.getElementById('fv-modal-text-input-field');
    const btnCancel = document.getElementById('btn-fv-modal-text-cancel');
    const btnSave = document.getElementById('btn-fv-modal-text-save');

    titleEl.textContent = title;
    inputEl.value = initialValue || '';
    inputEl.placeholder = placeholder || '';

    modal.classList.remove('hidden');
    inputEl.focus();

    const handleOutsideClick = (e) => { if (e.target === modal) close(); };
    modal.addEventListener('mousedown', handleOutsideClick);

    const close = () => {
      modal.classList.add('hidden');
      btnCancel.onclick = null;
      btnSave.onclick = null;
      inputEl.onkeydown = null;
      modal.removeEventListener('mousedown', handleOutsideClick);
    };

    btnCancel.onclick = close;
    btnSave.onclick = () => {
      onSave(inputEl.value.trim());
      close();
    };
    inputEl.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); btnSave.onclick(); }
      if (e.key === 'Escape') btnCancel.onclick();
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  View Mode Logic
  // ═══════════════════════════════════════════════════════════
  function setViewMode(mode) {
    viewMode = mode;
    videosContainer.className = `fv-scrollable ${mode}`;

    // UI update
    btnGrid.classList.toggle('active', mode === 'grid');
    btnList.classList.toggle('active', mode === 'list');

    chrome.storage.local.set({ fvViewMode: mode });
  }

  // ═══════════════════════════════════════════════════════════
  //  List Management
  // ═══════════════════════════════════════════════════════════
  async function loadListsAndSelectFirst() {
    await loadLists();
    const firstList = listsContainer.querySelector('.fv-list-item');
    if (firstList && !currentListId) {
      firstList.click();
    }
  }

  async function loadLists() {
    try {
      const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' });
      if (!lists || lists.length === 0) {
        listsContainer.innerHTML = '<div class="fv-empty">リストがありません</div>';
        return;
      }
      listsContainer.innerHTML = '';
      for (const list of lists) {
        const count = await chrome.runtime.sendMessage({ action: 'getVideoCount', listId: list.id });
        const el = createListElement(list, count);
        listsContainer.appendChild(el);
      }
      setupDragAndDrop();
      if (currentListId) {
        const activeItem = listsContainer.querySelector(`[data-id="${currentListId}"]`);
        if (activeItem) activeItem.classList.add('active');
        else { currentListId = null; videosContainer.innerHTML = ''; titleEl.textContent = 'リストを選択'; countEl.textContent = ''; controlsEl.classList.add('hidden'); }
      }
    } catch (err) {
      listsContainer.innerHTML = `<div class="fv-empty" style="color:var(--nl-danger);">エラー: ${err.message}</div>`;
    }
  }

  function createListElement(list, count) {
    const el = document.createElement('div');
    el.className = 'fv-list-item';
    el.dataset.id = list.id;

    el.innerHTML = `
      <div class="fv-list-drag-handle" title="ドラッグして並び替え">${ICONS.drag}</div>
      <div class="fv-list-info">
        <div class="fv-list-name">${escapeHtml(list.name)}</div>
        <div class="fv-list-meta">${count}動画</div>
      </div>
      <div class="fv-list-actions">
        <button class="fv-icon-btn btn-share" title="共有">${ICONS.share}</button>
        <button class="fv-icon-btn btn-rename" title="名前変更">${ICONS.edit}</button>
        <button class="fv-icon-btn btn-delete" style="color:var(--nl-danger);" title="削除">${ICONS.trash}</button>
      </div>
    `;

    el.addEventListener('click', (e) => {
      if (e.target.closest('.fv-list-actions') || e.target.closest('.fv-list-drag-handle')) return;
      listsContainer.querySelectorAll('.fv-list-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
      currentListId = list.id;
      titleEl.textContent = list.name;
      loadVideos();
    });

    el.querySelector('.btn-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      showFvTextInputModal('リスト名の変更', list.name, '新しいリスト名', async (newName) => {
        if (newName && newName !== list.name) {
          await chrome.runtime.sendMessage({ action: 'updateListName', id: list.id, name: newName });
          loadLists();
          if (currentListId === list.id) { titleEl.textContent = newName; }
        }
      });
    });

    el.querySelector('.btn-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`本当に「${list.name}」を削除しますか？`)) {
        await chrome.runtime.sendMessage({ action: 'deleteList', id: list.id });
        if (currentListId === list.id) currentListId = null;
        loadListsAndSelectFirst();
      }
    });

    // v3.0: 共有ボタン
    el.querySelector('.btn-share').addEventListener('click', async (e) => {
      e.stopPropagation();
      openShareModal(list.id, list.name);
    });

    return el;
  }

  function setupDragAndDrop() {
    const items = Array.from(listsContainer.querySelectorAll('.fv-list-item'));
    items.forEach(item => {
      const handle = item.querySelector('.fv-list-drag-handle');
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
        saveListOrder();
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        if (item === draggedItem) return;

        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        items.forEach(i => i.classList.remove('drag-over', 'drag-up', 'drag-down'));
        item.classList.add('drag-over');

        if (e.clientY < midY) listsContainer.insertBefore(draggedItem, item);
        else listsContainer.insertBefore(draggedItem, item.nextSibling);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    });
  }

  async function saveListOrder() {
    const ids = Array.from(listsContainer.querySelectorAll('.fv-list-item')).map(el => el.dataset.id);
    await chrome.runtime.sendMessage({ action: 'saveListOrder', order: ids });
  }

  async function handleCreateList() {
    const input = document.getElementById('input-fv-new-list');
    const name = input.value.trim();
    if (!name) return;
    try {
      await chrome.runtime.sendMessage({ action: 'createList', name });
      input.value = '';
      loadLists();
    } catch (e) { alert('作成失敗: ' + e.message); }
  }

  // ═══════════════════════════════════════════════════════════
  //  Video Management
  // ═══════════════════════════════════════════════════════════
  async function loadVideos() {
    if (!currentListId) return;
    videosContainer.innerHTML = '<div class="fv-loading">読み込み中...</div>';

    const sortVal = document.getElementById('fv-select-sort').value;
    const [sortKey, sortOrder] = sortVal.split('_');

    try {
      const videos = await chrome.runtime.sendMessage({
        action: 'getVideos', listId: currentListId, sortKey, sortOrder
      });

      if (!videos || videos.length === 0) {
        videosContainer.innerHTML = '<div class="fv-empty">動画がありません。<br>ニコニコ動画またはYouTubeから動画を追加してください。</div>';
        countEl.textContent = '0件';
        controlsEl.classList.add('hidden');
        return;
      }

      countEl.textContent = `${videos.length}件`;
      controlsEl.classList.remove('hidden');
      videosContainer.innerHTML = '';

      // v2.0: 段階ロード（50件ずつ）
      const PAGE_SIZE = 50;
      let loadedCount = 0;

      function loadBatch() {
        const end = Math.min(loadedCount + PAGE_SIZE, videos.length);
        for (let i = loadedCount; i < end; i++) {
          videosContainer.appendChild(createVideoCard(videos[i]));
        }
        loadedCount = end;

        if (loadedCount < videos.length) {
          let sentinel = document.getElementById('fv-load-more');
          if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = 'fv-load-more';
            sentinel.className = 'fv-loading';
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
      videosContainer.innerHTML = `<div class="fv-empty" style="color:var(--nl-danger);">エラー: ${err.message}</div>`;
    }
  }

  async function handleRefreshVideos() {
    if (!currentListId) return;
    const btn = document.getElementById('btn-fv-refresh');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> 更新中...';
    try {
      const res = await chrome.runtime.sendMessage({ action: 'refreshVideos', listId: currentListId });
      if (res.success) {
        await loadVideos();
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> ${res.updated}/${res.total} 件更新`;
        setTimeout(() => { btn.innerHTML = originalHTML; }, 3000);
      } else {
        throw new Error(res.error || '更新失敗');
      }
    } catch (e) {
      alert('情報更新に失敗しました: ' + e.message);
      btn.innerHTML = originalHTML;
    }
    btn.disabled = false;
  }

  function createVideoCard(video) {
    const el = document.createElement('div');
    el.className = 'fv-video-card';

    // v2.0: site対応のURL生成
    const watchUrl = video.site === 'youtube'
      ? `https://www.youtube.com/watch?v=${video.videoId}`
      : `https://www.nicovideo.jp/watch/${video.videoId}`;

    // v1.4: 投稿日と追加日の分離
    const postedDateStr = new Date(video.postedAt || 0).toLocaleDateString();
    const addedDateStr = new Date(video.addedAt || video.postedAt).toLocaleDateString();



    const ownerAvatar = video.ownerIcon ? `<img src="${escapeHtml(video.ownerIcon)}" alt="owner" class="fv-owner-icon-small">` : '';
    const ownerName = video.ownerName ? `<span class="fv-owner-name-small">${escapeHtml(video.ownerName)}</span>` : '';

    el.innerHTML = `
      <a href="${watchUrl}" target="_blank" class="fv-video-thumb">
        ${video.thumbnailUrl ? `<img src="${escapeHtml(video.thumbnailUrl)}" loading="lazy">` : ''}
      </a>
      <div class="fv-video-info">
        <a href="${watchUrl}" target="_blank" class="fv-video-title">${escapeHtml(video.title)}</a>

        <div class="fv-video-posted-date">${postedDateStr}</div>
        
        ${ownerName ? `<div class="fv-video-owner-area">${ownerAvatar}${ownerName}</div>` : ''}
        
        <div class="fv-video-stats-row">
          <div class="fv-video-stats">
            <span title="再生数">${ICONS.view} ${formatCount(video.viewCount)}</span>
            <span title="いいね数">${ICONS.like} ${formatCount(video.likeCount)}</span>
            ${video.mylistCount >= 0 ? `<span title="マイリスト数">${ICONS.mylist} ${formatCount(video.mylistCount)}</span>` : ''}
          </div>
          <div style="display:flex; gap:4px;">
            <button class="fv-btn-memo-vid" title="メモを編集">${ICONS.edit}</button>
            <button class="fv-btn-remove-vid" title="リストから削除">${ICONS.trash}</button>
          </div>
        </div>
        
        ${video.memo ? `<div class="fv-video-memo">${escapeHtml(video.memo)}</div>` : ''}
        <div class="fv-video-desc">${escapeHtml(video.description || '説明文なし')}</div>
        
        <div class="fv-video-footer">
          <div class="fv-video-added-date">登録: ${addedDateStr}</div>
        </div>
      </div>
    `;

    const memoEl = el.querySelector('.fv-video-memo');
    if (memoEl) {
      memoEl.addEventListener('click', (e) => {
        e.stopPropagation();
        memoEl.classList.toggle('expanded');
      });
    }

    el.querySelector('.fv-btn-remove-vid').addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (confirm(`削除しますか？\n「${video.title}」`)) {
        await chrome.runtime.sendMessage({ action: 'removeVideo', videoDbId: video.id });
        el.remove();
        // Update count
        const count = videosContainer.children.length;
        countEl.textContent = `${count}件`;
        if (count === 0) {
          videosContainer.innerHTML = '<div class="fv-empty">動画がありません。</div>';
          controlsEl.classList.add('hidden');
        }
        loadLists();
      }
    });

    el.querySelector('.fv-btn-memo-vid').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      showFvTextInputModal('メモを編集', video.memo, 'メモ内容を入力 (空で削除)', async (newMemo) => {
        try {
          await chrome.runtime.sendMessage({ action: 'updateVideoMemo', videoDbId: video.id, memo: newMemo });
          loadVideos();
        } catch (err) { alert('メモの更新に失敗しました'); }
      });
    });

    return el;
  }

  async function handlePlay(shuffle) {
    if (!currentListId) return;
    const sortVal = document.getElementById('fv-select-sort').value;
    const [sortKey, sortOrder] = sortVal.split('_');

    const res = await chrome.runtime.sendMessage({
      action: 'startPlayback', listId: currentListId, sortKey, sortOrder, shuffle
    });
    if (!res.success) alert(res.message || '再生開始に失敗しました');
  }

  // ═══════════════════════════════════════════════════════════
  //  Import / Export
  // ═══════════════════════════════════════════════════════════
  async function handleExport() {
    try {
      const data = await chrome.runtime.sendMessage({ action: 'exportAll' });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `nicolist_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { alert('エクスポート失敗: ' + e.message); }
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('データをすべて上書きインポートしますか？')) { e.target.value = ''; return; }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const res = await chrome.runtime.sendMessage({ action: 'importData', data, overwrite: true });
        if (res.success) {
          showToast(`インポート完了 (リスト:${res.listsAdded} 動画:${res.videosAdded})`);
          currentListId = null;
          loadListsAndSelectFirst();
        } else throw new Error('失敗');
      } catch (err) { alert('不正なJSONファイルです'); }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  // ═══════════════════════════════════════════════════════════
  //  Utils
  // ═══════════════════════════════════════════════════════════
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

  function showToast(msg) {
    let t = document.getElementById('fv-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'fv-toast'; t.className = 'fv-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), 3000);
  }

  // ═════════════════════════════════════════════════════════
  //  v3.1: リスト共有機能（軽量化v2フォーマット）
  // ═════════════════════════════════════════════════════════

  function encodeShareCode(data) {
    const json = JSON.stringify(data);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function openShareModal(listId, listName) {
    const existing = document.getElementById('fv-share-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'fv-share-overlay';
    overlay.className = 'fv-share-overlay';
    overlay.addEventListener('click', () => overlay.remove());

    const modal = document.createElement('div');
    modal.className = 'fv-share-modal';
    modal.addEventListener('click', e => e.stopPropagation());

    modal.innerHTML = `
      <div class="fv-share-header">
        <h3>${ICONS.share} リストを共有</h3>
        <button class="fv-share-close" title="閉じる">✕</button>
      </div>
      <div class="fv-share-body">
        <div class="fv-share-loading">共有データを生成中...</div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
    modal.querySelector('.fv-share-close').addEventListener('click', () => overlay.remove());

    try {
      const videos = await chrome.runtime.sendMessage({ action: 'getVideos', listId });
      const list = await chrome.runtime.sendMessage({ action: 'getList', id: listId });

      if (!videos || videos.length === 0) {
        modal.querySelector('.fv-share-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--nl-text-muted);">リストに動画がありません</div>';
        return;
      }

      // クラウド共有用データ（v3: メモ・投稿者情報含む完全版）
      const shareData = {
        v: 3,
        n: listName,
        d: videos.map(v => {
          const entry = { id: v.videoId, s: v.site === 'youtube' ? 'y' : 'n' };
          if (v.memo) entry.m = v.memo;
          if (v.ownerName) entry.on = v.ownerName;
          if (v.ownerIcon) entry.oi = v.ownerIcon;
          return entry;
        })
      };

      // 既に共有IDを持っていれば上書き更新用に追加
      if (list && list.shareId) {
        shareData.i = list.shareId;
      }

      // クラウドAPIに送信
      modal.querySelector('.fv-share-body').innerHTML = '<div class="fv-share-loading">クラウドにアップロード中...</div>';
      const result = await chrome.runtime.sendMessage({ action: 'createShareLink', data: shareData });

      if (!result.success) {
        // クラウド失敗時は旧方式にフォールバック
        const fallbackData = { v: 2, n: listName, d: videos.map(v => [v.videoId, v.site === 'youtube' ? 'y' : 'n']) };
        const fallbackCode = encodeShareCode(fallbackData);
        modal.querySelector('.fv-share-body').innerHTML = `
          <div style="padding:12px;color:var(--nl-warning);font-size:12px;">⚠ クラウド共有に失敗しました（${escapeHtml(result.error || '不明なエラー')}）。旧方式のコードを生成しました（メモは含まれません）。</div>
          <div class="fv-share-section">
            <label>共有コード（旧方式）</label>
            <div class="fv-share-code-row">
              <input type="text" class="fv-share-input" id="fv-share-code" value="${fallbackCode}" readonly>
              <button class="fv-share-copy-btn" id="btn-copy-code">コピー</button>
            </div>
          </div>
        `;
        document.getElementById('btn-copy-code').addEventListener('click', async () => {
          await navigator.clipboard.writeText(fallbackCode);
          const b = document.getElementById('btn-copy-code');
          b.textContent = '✓ コピー済'; setTimeout(() => { b.textContent = 'コピー'; }, 2000);
        });
        return;
      }

      const shareId = result.id;

      // 新しいIDを発行した場合、次回から同じIDを使うために保存する
      if (!list || list.shareId !== shareId) {
        await chrome.runtime.sendMessage({ action: 'updateListShareId', id: listId, shareId });
      }

      modal.querySelector('.fv-share-body').innerHTML = `
        <div class="fv-share-info"><strong>${escapeHtml(listName)}</strong> — ${videos.length}本の動画</div>
        <div class="fv-share-section">
          <label>共有コード</label>
          <div class="fv-share-code-row">
            <input type="text" class="fv-share-input" id="fv-share-code" value="${shareId}" readonly style="font-size:18px;text-align:center;letter-spacing:2px;font-weight:bold;">
            <button class="fv-share-copy-btn" id="btn-copy-code">コピー</button>
          </div>
          <div class="fv-share-hint">この短いコードを相手に送ってください（有効期限: 30日）</div>
        </div>
        <div class="fv-share-section" style="border-top:1px solid var(--nl-border);padding-top:14px;margin-top:6px;">
          <label>共有コードを読み込む</label>
          <div class="fv-share-code-row">
            <input type="text" class="fv-share-input" id="fv-share-paste" placeholder="受け取ったコードをペースト...">
            <button class="fv-share-copy-btn" id="btn-load-paste" style="background:var(--nl-success);">開く</button>
          </div>
        </div>
      `;

      document.getElementById('btn-copy-code').addEventListener('click', async () => {
        await navigator.clipboard.writeText(shareId);
        const b = document.getElementById('btn-copy-code');
        b.textContent = '✓ コピー済'; setTimeout(() => { b.textContent = 'コピー'; }, 2000);
      });
      document.getElementById('btn-load-paste').addEventListener('click', async () => {
        const code = document.getElementById('fv-share-paste').value.trim();
        if (!code) return;
        const btn = document.getElementById('btn-load-paste');
        btn.textContent = '読込中...'; btn.disabled = true;

        // 短いコード（10文字以下）ならクラウドAPI、長ければ旧方式
        if (code.length <= 10) {
          window.open(chrome.runtime.getURL(`shared.html?c=${code}`), '_blank');
        } else {
          // 旧方式のBase64コード
          window.open(chrome.runtime.getURL('shared.html') + '#' + code, '_blank');
        }
        btn.textContent = '開く'; btn.disabled = false;
      });
    } catch (err) {
      modal.querySelector('.fv-share-body').innerHTML = `<div style="text-align:center;padding:20px;color:var(--nl-danger);">エラー: ${escapeHtml(err.message)}</div>`;
    }
  }

})();
