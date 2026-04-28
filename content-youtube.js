/**
 * ============================================================
 * NicoList - YouTube Content Script
 * ============================================================
 *
 * YouTubeのページに「NicoListに追加」ボタンと
 * リスト選択モーダル、連続再生パネルを注入する。
 */

(function () {
  'use strict';

  if (window.__nicoListYTContentLoaded) return;
  window.__nicoListYTContentLoaded = true;

  let cachedNextUrl = null;

  function getCurrentVideoId() {
    const params = new URLSearchParams(location.search);
    return params.get('v') || null;
  }

  // ═════════════════════════════════════════════════════════
  //  動画情報取得 (YouTube)
  // ═════════════════════════════════════════════════════════

  function safeParseJSON(str) {
    if (!str) return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  async function getVideoInfoFromPage() {
    // v2.3: 必ず呼び出し時点のURLから取得（キャッシュ禁止）
    const videoId = new URL(location.href).searchParams.get('v');
    if (!videoId) return null;

    let info = {
      videoId, title: '', thumbnailUrl: '', viewCount: 0, mylistCount: -1,
      likeCount: 0, postedAt: 0, ownerName: '', ownerIcon: '', description: '',
      site: 'youtube'
    };

    // ────────────────────────────────────────────────
    // 1. DOM優先: SPA遷移後も確実に更新されるDOM要素から取得
    // ────────────────────────────────────────────────

    // タイトル
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.style-scope.ytd-watch-metadata, #title h1 yt-formatted-string');
    if (titleEl) info.title = titleEl.textContent.trim();
    if (!info.title) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) info.title = ogTitle.content;
    }

    // チャンネル名
    const chEl = document.querySelector('#channel-name a, ytd-channel-name a, #owner #channel-name yt-formatted-string a');
    if (chEl) info.ownerName = chEl.textContent.trim();

    // チャンネルアイコン
    const chImg = document.querySelector('ytd-video-owner-renderer img#img, #owner img');
    if (chImg && chImg.src) info.ownerIcon = chImg.src;

    // いいね数
    const likeEl = document.querySelector('#segmented-like-button button, like-button-view-model button');
    if (likeEl) {
      const txt = likeEl.getAttribute('aria-label') || likeEl.textContent || '';
      const m = txt.replace(/[,.\s]/g, '').match(/(\d+)/);
      if (m) info.likeCount = parseInt(m[1], 10) || 0;
    }

    // ★ 投稿日: meta[itemprop="datePublished"] を最優先（ISO形式で確実にパース可能）
    const dateMeta = document.querySelector('meta[itemprop="datePublished"]');
    if (dateMeta && dateMeta.content) {
      const parsed = new Date(dateMeta.content).getTime();
      if (!isNaN(parsed) && parsed > 0) info.postedAt = parsed;
    }
    // fallback: meta[property="og:video:release_date"] or uploadDate
    if (!info.postedAt) {
      const dateUpload = document.querySelector('meta[itemprop="uploadDate"]');
      if (dateUpload && dateUpload.content) {
        const parsed = new Date(dateUpload.content).getTime();
        if (!isNaN(parsed) && parsed > 0) info.postedAt = parsed;
      }
    }

    // ★ 再生数: JSON-LD (application/ld+json) 内の interactionStatistic から取得
    // player-microformat-renderer 内の script[type="application/ld+json"] を優先
    try {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const sc of ldScripts) {
        try {
          const ld = JSON.parse(sc.textContent.trim());
          // interactionStatistic から WatchAction の userInteractionCount を取得
          if (ld.interactionStatistic) {
            const stats = Array.isArray(ld.interactionStatistic) ? ld.interactionStatistic : [ld.interactionStatistic];
            for (const stat of stats) {
              if (stat.interactionType === 'http://schema.org/WatchAction' || stat.interactionType === 'https://schema.org/WatchAction') {
                const count = parseInt(stat.userInteractionCount, 10);
                if (!isNaN(count) && count > 0) {
                  info.viewCount = count;
                }
              }
            }
          }
          // JSON-LDから投稿日も取得可能
          if (!info.postedAt && ld.uploadDate) {
            const parsed = new Date(ld.uploadDate).getTime();
            if (!isNaN(parsed) && parsed > 0) info.postedAt = parsed;
          }
        } catch(e) {}
      }
    } catch(e) {}

    // フォールバック: meta[itemprop="interactionCount"] （削除されている場合がある）
    if (!info.viewCount) {
      const viewMeta = document.querySelector('meta[itemprop="interactionCount"]');
      if (viewMeta && viewMeta.content) {
        info.viewCount = parseInt(viewMeta.content, 10) || 0;
      }
    }

    // フォールバック: DOMから直接取得 (視聴回数のテキスト)
    if (!info.viewCount) {
      const viewEl = document.querySelector('ytd-video-primary-info-renderer #info-text .view-count, ytd-watch-metadata #info span.view-count, #info-container yt-formatted-string.view-count');
      if (viewEl) {
        const m = viewEl.textContent.replace(/[,\s回再生]/g, '').match(/(\d+)/);
        if (m) info.viewCount = parseInt(m[1], 10) || 0;
      }
    }

    // 説明文
    const descEl = document.querySelector('#description-inline-expander yt-formatted-string, ytd-text-inline-expander > yt-formatted-string');
    if (descEl) info.description = descEl.textContent.trim().slice(0, 500);

    // サムネイル（常に確実に取得可能）
    info.thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // ────────────────────────────────────────────────
    // 2. スクリプトタグ fallback（videoID一致検証付き）
    //    タイトル・チャンネル名・再生数・投稿日のいずれかが未取得の場合に実行
    // ────────────────────────────────────────────────
    if (!info.title || !info.ownerName || !info.viewCount || !info.postedAt) {
      try {
        const scripts = document.querySelectorAll('script');
        for (const sc of scripts) {
          const text = sc.textContent || '';
          const prMatch = text.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s) ||
                           text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
          if (prMatch) {
            const pr = safeParseJSON(prMatch[1]);
            // ★ videoIdが一致しない場合はスキップ（SPA遷移後の古いデータ防止）
            if (pr?.videoDetails?.videoId === videoId) {
              const vd = pr.videoDetails;
              if (!info.title && vd.title) info.title = vd.title;
              if (!info.viewCount && vd.viewCount) info.viewCount = parseInt(vd.viewCount, 10) || 0;
              if (!info.ownerName && vd.author) info.ownerName = vd.author;
              if (!info.description && vd.shortDescription) info.description = vd.shortDescription;
              const thumb = vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url;
              if (thumb) info.thumbnailUrl = thumb;
              // 投稿日 (microformat)
              if (!info.postedAt) {
                const pubDate = pr.microformat?.playerMicroformatRenderer?.publishDate;
                if (pubDate) {
                  const parsed = new Date(pubDate).getTime();
                  if (!isNaN(parsed) && parsed > 0) info.postedAt = parsed;
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('NicoList YT: スクリプトfallback失敗', e);
      }
    }

    // ────────────────────────────────────────────────
    // 3. oEmbed API fallback（最終手段）
    // ────────────────────────────────────────────────
    if (!info.title) {
      try {
        const apiInfo = await chrome.runtime.sendMessage({ action: 'fetchYouTubeVideoInfo', videoId });
        if (apiInfo && !apiInfo.error) {
          if (!info.title) info.title = apiInfo.title;
          if (!info.ownerName) info.ownerName = apiInfo.ownerName;
          if (!info.thumbnailUrl) info.thumbnailUrl = apiInfo.thumbnailUrl;
        }
      } catch (e) {}
    }

    // 最終整形
    if (!info.title) info.title = document.title.replace(/ - YouTube$/, '').trim() || videoId;
    if (!info.ownerName) info.ownerName = '不明なチャンネル';

    // SPA遷移後にデータが不足している場合はリトライ
    if (!info.viewCount || !info.title || info.title === videoId) {
      info = await new Promise((resolve) => {
        let attempt = 0;
        const interval = setInterval(() => {
          attempt++;
          // JSON-LDから再取得
          if (!info.viewCount) {
            const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const sc of ldScripts) {
              try {
                const ld = JSON.parse(sc.textContent.trim());
                if (ld.interactionStatistic) {
                  const stats = Array.isArray(ld.interactionStatistic) ? ld.interactionStatistic : [ld.interactionStatistic];
                  for (const stat of stats) {
                    if ((stat.interactionType === 'http://schema.org/WatchAction' || stat.interactionType === 'https://schema.org/WatchAction') && stat.userInteractionCount) {
                      info.viewCount = parseInt(stat.userInteractionCount, 10) || 0;
                    }
                  }
                }
              } catch(e) {}
            }
          }
          if (!info.title || info.title === videoId) {
            const titleEl2 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
            if (titleEl2) info.title = titleEl2.textContent.trim();
          }
          if ((info.viewCount && info.title && info.title !== videoId) || attempt >= 8) {
            clearInterval(interval);
            resolve(info);
          }
        }, 250);
      });
    }

    console.log('NicoList YT: 最終データ', JSON.stringify({ videoId: info.videoId, title: info.title, viewCount: info.viewCount }));
    return info;
  }

  // ═════════════════════════════════════════════════════════
  //  UI: SVGアイコン定義
  // ═════════════════════════════════════════════════════════
  const ICONS = {
    addList: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    playList: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
    skip: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
    stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12"/></svg>',
    chevronDown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    chevronUp: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    cross: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  };

  // ═════════════════════════════════════════════════════════
  //  UI: リスト追加ボタン (YouTube)
  // ═════════════════════════════════════════════════════════
  let buttonObserver = null;
  let insertionInterval = null;

  function createAddButtonWithObserver() {
    if (buttonObserver) buttonObserver.disconnect();
    if (insertionInterval) clearInterval(insertionInterval);

    // v2.3: YouTube風ボタンを生成するヘルパー（1箇所で管理）
    function createYTNativeBtn() {
      const btn = document.createElement('button');
      btn.id = 'nicolist-add-btn';
      btn.title = 'NicoList に追加';

      // YouTube のダーク/ライトモードを動的に判定
      const isDark = () => document.documentElement.hasAttribute('dark');
      const applyTheme = () => {
        const dark = isDark();
        btn.style.background = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
        btn.style.color = dark ? '#f1f1f1' : '#0f0f0f';
      };

      btn.style.cssText = `
        display:inline-flex;align-items:center;gap:6px;
        padding:0 16px;height:36px;border-radius:18px;
        border:none;cursor:pointer;font-size:14px;font-weight:500;
        font-family:'Roboto','Arial',sans-serif;
        transition:background 0.2s;margin-left:8px;
        letter-spacing:0.3px;flex-shrink:0;
      `;
      applyTheme();

      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>リスト`;
      btn.addEventListener('mouseenter', () => {
        btn.style.background = isDark() ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';
      });
      btn.addEventListener('mouseleave', applyTheme);

      // テーマ切替時に色を追従
      const themeObs = new MutationObserver(applyTheme);
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
      bindAddBtnEvents(btn);
      return btn;
    }

    const tryInsert = () => {
      if (document.getElementById('nicolist-add-btn')) return true;

      // ★ 既存UIを破壊しない: insertAdjacentElement('afterend') で兄弟要素として追加
      // #top-level-buttons-computed の「外側の後ろ」に配置
      const actionsRow = document.querySelector('#top-level-buttons-computed');
      if (actionsRow) {
        const btn = createYTNativeBtn();
        actionsRow.insertAdjacentElement('afterend', btn);
        return true;
      }

      // フォールバック: #actions の中にある最後の要素の後ろ
      const actionsContainer = document.querySelector('ytd-watch-metadata #actions, #above-the-fold #actions');
      if (actionsContainer) {
        const btn = createYTNativeBtn();
        actionsContainer.appendChild(btn);
        return true;
      }
      return false;
    };

    if (!tryInsert()) {
      insertionInterval = setInterval(() => {
        if (tryInsert()) {
          clearInterval(insertionInterval);
          observeContainerRemovals();
        }
      }, 300);
    } else {
      observeContainerRemovals();
    }
  }

  // v2.3: click/dblclick 遅延ゼロ + モーダル2回表示防止
  // quickAddMode: 'dblclick'(デフォルト) → dblclickで即追加、clickでモーダル
  //               'click' → clickで即追加、dblclickでモーダル
  let lastModalOpenTime = 0;
  async function bindAddBtnEvents(btn) {
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' }) || {};
    const quickAddMode = settings.quickAddMode || 'dblclick';

    if (quickAddMode === 'click') {
      let clickTimer = null;
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          handleDoubleClickAdd();
        }, 250);
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openModal();
      });
    } else {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const now = Date.now();
        if (now - lastModalOpenTime < 400) return;
        lastModalOpenTime = now;
        openModal();
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        closeModal();
        handleDoubleClickAdd();
      });
    }
  }

  function observeContainerRemovals() {
    if (buttonObserver) buttonObserver.disconnect();
    buttonObserver = new MutationObserver(() => {
      if (!document.getElementById('nicolist-add-btn')) {
        createAddButtonWithObserver();
      }
    });
    const container = document.querySelector('#content, body');
    if (container) buttonObserver.observe(container, { childList: true, subtree: true });
  }

  // ═════════════════════════════════════════════════════════
  //  UI: リスト選択モーダル (共通ロジック)
  // ═════════════════════════════════════════════════════════
  function openModal() {
    const existing = document.getElementById('nicolist-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'nicolist-modal-overlay';
    // ★ overlayクリック: dblclick判定と外クリック閉じの両立
    overlay.addEventListener('click', () => {
      if (Date.now() - lastModalOpenTime < 400) {
        // 400ms以内 = ダブルクリックの2回目 → 即追加
        closeModal();
        handleDoubleClickAdd();
        return;
      }
      // 400ms以降 = 通常の外クリック → モーダルを閉じる
      closeModal();
    });

    const modal = document.createElement('div');
    modal.id = 'nicolist-modal';
    // ★ モーダル内部クリックはoverlayに伝播させない
    modal.addEventListener('click', (e) => { e.stopPropagation(); });
    modal.innerHTML = `
      <div class="nicolist-modal-header">
        <h3 style="display:flex;align-items:center;gap:8px;">${ICONS.playList} NicoList に追加</h3>
        <button id="nicolist-modal-close" title="閉じる">${ICONS.cross}</button>
      </div>
      <div class="nicolist-modal-body">
        <div id="nicolist-list-container"><div class="nicolist-loading">読み込み中...</div></div>
        <div class="nicolist-new-list-form">
          <input type="text" id="nicolist-new-list-input" placeholder="新しいリスト名..." maxlength="100" />
          <button id="nicolist-new-list-btn" title="作成">${ICONS.plus}</button>
        </div>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.getElementById('nicolist-modal-close').addEventListener('click', closeModal);
    document.getElementById('nicolist-new-list-btn').addEventListener('click', createNewListFromModal);
    document.getElementById('nicolist-new-list-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') createNewListFromModal();
    });

    loadListsInModal();
    requestAnimationFrame(() => overlay.classList.add('nicolist-modal-visible'));
  }

  function closeModal() {
    const overlay = document.getElementById('nicolist-modal-overlay');
    if (overlay) {
      overlay.classList.remove('nicolist-modal-visible');
      setTimeout(() => overlay.remove(), 200);
    }
  }

  async function loadListsInModal() {
    const container = document.getElementById('nicolist-list-container');
    if (!container) return;
    try {
      const lists = await chrome.runtime.sendMessage({ action: 'getAllLists' });
      const videoId = getCurrentVideoId();
      if (!lists || lists.length === 0) {
        container.innerHTML = '<div class="nicolist-empty">リストがありません。<br>下の入力欄から作成してください。</div>';
        return;
      }
      let html = '';
      for (const list of lists) {
        const isAdded = await chrome.runtime.sendMessage({ action: 'isVideoInList', listId: list.id, videoId });
        const count = await chrome.runtime.sendMessage({ action: 'getVideoCount', listId: list.id });
        html += `
          <div class="nicolist-list-item ${isAdded ? 'nicolist-added' : ''}" data-list-id="${list.id}">
            <div class="nicolist-list-info">
              <span class="nicolist-list-name" style="display:flex;align-items:center;gap:6px;">${ICONS.list} ${escapeHtml(list.name)}</span>
              <span class="nicolist-list-count">${count} 動画</span>
            </div>
            <button class="nicolist-list-add-btn" ${isAdded ? 'disabled' : ''}>
              ${isAdded ? ICONS.check + ' 追加済み' : ICONS.plus + ' 追加'}
            </button>
          </div>
        `;
      }
      container.innerHTML = html;
      container.querySelectorAll('.nicolist-list-add-btn:not([disabled])').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const listItem = e.target.closest('.nicolist-list-item');
          await addVideoToList(listItem.dataset.listId, btn, listItem);
        });
      });
    } catch (err) {
      container.innerHTML = `<div class="nicolist-error">エラー: ${err.message}</div>`;
    }
  }

  async function addVideoToList(listId, btnEl, listItemEl) {
    const originalText = btnEl.innerHTML;
    const isAlreadyAdded = listItemEl.classList.contains('nicolist-added');

    btnEl.disabled = true;
    btnEl.innerHTML = `${ICONS.check} 追加済み`;
    listItemEl.classList.add('nicolist-added');
    showToast('リストへ追加しています...', 'info');

    try {
      const videoInfo = await getVideoInfoFromPage();
      if (!videoInfo || !videoInfo.title) {
        throw new Error('動画情報の取得に失敗');
      }
      const result = await chrome.runtime.sendMessage({ action: 'addVideo', listId, videoInfo });
      if (result.success) {
        await chrome.storage.local.set({ lastUsedListId: listId });
        showToast(`「${videoInfo.title}」を追加しました`, 'success');
      } else {
        throw new Error(result.message || '追加失敗');
      }
    } catch (err) {
      console.warn('NicoList YT: 追加エラー', err);
      showToast('追加失敗: ' + err.message, 'error');
      btnEl.innerHTML = originalText;
      btnEl.disabled = false;
      if (!isAlreadyAdded) listItemEl.classList.remove('nicolist-added');
    }
  }

  async function createNewListFromModal() {
    const input = document.getElementById('nicolist-new-list-input');
    const name = input.value.trim();
    if (!name) return;
    try {
      await chrome.runtime.sendMessage({ action: 'createList', name });
      input.value = '';
      await loadListsInModal();
      showToast(`「${name}」を作成しました`, 'success');
    } catch (err) {
      showToast('リスト作成失敗', 'error');
    }
  }

  function showToast(message, type = 'info') {
    const existing = document.querySelector('.nicolist-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `nicolist-toast nicolist-toast-${type}`;
    toast.innerHTML = `<span style="display:flex;align-items:center;gap:8px;">
      ${type==='success'?ICONS.check:(type==='error'?ICONS.cross:ICONS.list)}
      ${escapeHtml(message)}
    </span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('nicolist-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('nicolist-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ═════════════════════════════════════════════════════════
  //  連続再生パネル (YouTube)
  // ═════════════════════════════════════════════════════════
  let playbackState = null;
  let watchdogTimer = null;

  async function setupPlaybackDetection() {
    playbackState = await chrome.runtime.sendMessage({ action: 'getPlaybackState' });
    if (!playbackState || !playbackState.isPlaying) return;

    await syncPlaybackIndex();
    cachedNextUrl = playbackState.nextUrl || null;
    showPlaybackPanel(playbackState);
    attachVideoEndedListener();
  }

  function attachVideoEndedListener() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }

    const attach = () => {
      const video = document.querySelector('video.html5-main-video, video');
      if (video) {
        // ループ解除
        if (video.loop) {
          video.loop = false;
          console.log('NicoList YT: [Playback] loop属性を強制解除');
        }

        video.removeEventListener('ended', onVideoEnded);
        video.addEventListener('ended', onVideoEnded, { once: true });

        // Watchdog
        let lastTime = -1;
        let stallCount = 0;
        watchdogTimer = setInterval(() => {
          if (!video || (video.paused && video.ended)) {
            clearInterval(watchdogTimer); watchdogTimer = null;
            return;
          }
          const ct = video.currentTime;
          const dur = video.duration;
          if (dur && ct >= dur - 2 && Math.abs(ct - lastTime) < 0.1) {
            stallCount++;
            if (stallCount >= 3) {
              console.log('NicoList YT: [Watchdog] 動画末尾で停滞、強制遷移');
              clearInterval(watchdogTimer); watchdogTimer = null;
              onVideoEnded();
              return;
            }
          } else {
            stallCount = 0;
          }
          lastTime = ct;
        }, 1000);

        return true;
      }
      return false;
    };

    if (!attach()) {
      const observer = new MutationObserver(() => {
        if (attach()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function syncPlaybackIndex() {
    if (!playbackState) return;
    const currentVideoId = getCurrentVideoId();
    if (playbackState.queue[playbackState.currentIndex]?.videoId !== currentVideoId) {
      const actualIdx = playbackState.queue.findIndex(v => v.videoId === currentVideoId);
      if (actualIdx !== -1) {
        playbackState.currentIndex = actualIdx;
        await chrome.storage.local.set({ playbackState });
        const result = await chrome.runtime.sendMessage({ action: 'getPlaybackState' });
        playbackState = result;
      }
    }
  }

  async function onVideoEnded() {
    if (cachedNextUrl) {
      location.href = cachedNextUrl;
    } else {
      const res = await chrome.runtime.sendMessage({ action: 'playNext' });
      if (res.success && res.nextUrl) location.href = res.nextUrl;
      else if (res.finished) {
        showToast('全動画の再生完了', 'success');
        document.getElementById('nicolist-playback-panel')?.remove();
      }
    }
  }

  function showPlaybackPanel(state) {
    const existing = document.getElementById('nicolist-playback-panel');
    if (existing) existing.remove();
    const panel = document.createElement('div');
    panel.id = 'nicolist-playback-panel';
    panel.innerHTML = `
      <div class="nicolist-panel-header" id="nicolist-panel-drag">
        <span class="nicolist-panel-title" style="display:flex;align-items:center;gap:6px;">${ICONS.playList} NicoList 再生中</span>
        <div style="display:flex;align-items:center;gap:4px;">
          <button id="nicolist-panel-toggle" class="nicolist-icon-btn" title="展開/折りたたみ">${ICONS.chevronDown}</button>
          <button id="nicolist-panel-close" class="nicolist-icon-btn" title="閉じて停止">${ICONS.cross}</button>
        </div>
      </div>
      <div class="nicolist-panel-body">
        <div class="nicolist-panel-progress">
          ${state.currentIndex + 1} <span style="font-size:12px;color:var(--nl-text-muted);">/ ${state.queue.length}</span>
        </div>
        <div class="nicolist-panel-controls">
          <button id="nicolist-panel-skip" class="nicolist-panel-btn" style="display:flex;align-items:center;justify-content:center;gap:4px;">${ICONS.skip} 次へ</button>
          <button id="nicolist-panel-stop" class="nicolist-panel-btn nicolist-panel-btn-stop" style="display:flex;align-items:center;justify-content:center;gap:4px;">${ICONS.stop} 停止</button>
        </div>
      </div>
      <div class="nicolist-panel-expanded" id="nicolist-panel-expanded" style="display:none;"></div>
    `;
    document.body.appendChild(panel);

    const stopPlaybackAndRemove = async () => {
      await chrome.runtime.sendMessage({ action: 'stopPlayback' });
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      panel.remove();
      showToast('連続再生を停止', 'info');
    };

    document.getElementById('nicolist-panel-skip').addEventListener('click', onVideoEnded);
    document.getElementById('nicolist-panel-stop').addEventListener('click', stopPlaybackAndRemove);
    document.getElementById('nicolist-panel-close').addEventListener('click', stopPlaybackAndRemove);

    let expanded = false;
    document.getElementById('nicolist-panel-toggle').addEventListener('click', () => {
      expanded = !expanded;
      document.getElementById('nicolist-panel-toggle').innerHTML = expanded ? ICONS.chevronUp : ICONS.chevronDown;
      const exBody = document.getElementById('nicolist-panel-expanded');
      if (expanded) {
        exBody.style.display = 'block';
        renderExpandedList(state, exBody);
      } else {
        exBody.style.display = 'none';
      }
    });

    makeDraggable(panel, document.getElementById('nicolist-panel-drag'));
  }

  function renderExpandedList(state, container) {
    let html = '';
    state.queue.forEach((v, index) => {
      const isCurrent = index === state.currentIndex;
      const title = v.title || v.videoId;
      const thumb = v.thumbnailUrl || '';
      html += `
        <div class="nicolist-queue-item ${isCurrent ? 'current' : ''}" data-index="${index}">
          ${thumb ? `<img src="${thumb}">` : '<div class="ncl-no-thumb"></div>'}
          <div class="ncl-title">${escapeHtml(title)}</div>
        </div>
      `;
    });
    container.innerHTML = html;
    container.querySelectorAll('.nicolist-queue-item').forEach(item => {
      item.addEventListener('click', async () => {
        const idx = parseInt(item.dataset.index, 10);
        if (idx !== state.currentIndex) {
          const res = await chrome.runtime.sendMessage({ action: 'jumpToPlayback', index: idx });
          if (res.success && res.url) location.href = res.url;
        }
      });
    });
    setTimeout(() => {
      const cur = container.querySelector('.current');
      if (cur) cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  function makeDraggable(element, handle) {
    let isDragging = false;
    let offsetX = 0, offsetY = 0;
    handle.style.cursor = 'grab';
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('#nicolist-panel-toggle')) return;
      isDragging = true;
      handle.style.cursor = 'grabbing';
      const rect = element.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      element.style.right = 'auto'; element.style.bottom = 'auto';
      element.style.left = rect.left + 'px'; element.style.top = rect.top + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      element.style.left = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - element.offsetWidth)) + 'px';
      element.style.top = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - element.offsetHeight)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      handle.style.cursor = 'grab';
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div'); div.textContent = str; return div.innerHTML;
  }

  // v2.1: ダブルクリック即追加（ボタンのdblclickから呼ばれる）
  async function handleDoubleClickAdd() {
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    const defaultListId = settings.defaultListId;
    if (!defaultListId) {
      showToast('設定画面でデフォルトリストを選択してください', 'error');
      return;
    }
    try {
      showToast('追加中...', 'info');
      const videoInfo = await getVideoInfoFromPage();
      if (!videoInfo || !videoInfo.title) { showToast('動画情報の取得に失敗', 'error'); return; }
      const res = await chrome.runtime.sendMessage({ action: 'addVideo', listId: defaultListId, videoInfo });
      if (res.success) showToast(`「${videoInfo.title}」を追加しました`, 'success');
      else showToast(res.message || '追加に失敗', 'error');
    } catch (err) { showToast('エラー: ' + err.message, 'error'); }
  }

  // ═════════════════════════════════════════════════════════
  //  初期化 (YouTube SPA対応)
  // ═════════════════════════════════════════════════════════
  function init() {
    if (!getCurrentVideoId()) return;
    createAddButtonWithObserver();
    setupPlaybackDetection();
  }

  // YouTube SPAのページ遷移対応
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById('nicolist-add-btn')?.remove();
      if (buttonObserver) buttonObserver.disconnect();
      if (insertionInterval) clearInterval(insertionInterval);
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }

      if (getCurrentVideoId()) {
        setTimeout(() => {
          createAddButtonWithObserver();
          setupPlaybackDetection();
        }, 500);
      }
    }
  });

  // YouTube SPAナビゲーションイベント
  document.addEventListener('yt-navigate-finish', () => {
    if (getCurrentVideoId()) {
      setTimeout(() => {
        document.getElementById('nicolist-add-btn')?.remove();
        createAddButtonWithObserver();
        setupPlaybackDetection();
      }, 300);
    }
  });

  // 連続再生の停止はbackground.jsのtabs.onRemovedで管理
  // beforeunloadではstopPlaybackを呼ばない（次の動画への遷移時にも発火してしまうため）

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); urlObserver.observe(document.body, { childList: true, subtree: true }); });
  } else {
    init();
    urlObserver.observe(document.body, { childList: true, subtree: true });
  }

})();
