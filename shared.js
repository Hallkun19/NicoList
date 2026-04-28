/**
 * ============================================================
 * NicoList - Shared List Viewer (v3.1)
 * ============================================================
 * v2最小化フォーマット対応: videoId + site のみからAPI取得
 * fullview統一UI: grid/list切替 + ソート + プログレッシブ読み込み
 */
(function () {
  'use strict';

  const ICONS = {
    view: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    like: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    mylist: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
  };

  const root = document.getElementById('shared-root');
  let videosData = [];
  let currentSortedData = []; // ソート・遅延読み込み用
  let renderLimit = 50;       // 一度に表示する件数
  let viewMode = 'grid';

  // ── ユーティリティ ──
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function formatCount(n) {
    if (n == null || n < 0) return '-';
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '億';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return n.toLocaleString();
  }
  function formatDate(ts) {
    if (!ts || ts <= 0) return '-';
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  }
  function buildWatchUrl(vid, site) {
    return site === 'youtube' ? `https://www.youtube.com/watch?v=${vid}` : `https://www.nicovideo.jp/watch/${vid}`;
  }

  // ── Base64デコード ──
  function decodeShareCode(code) {
    try {
      let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }

  // ── 動画カード生成（fullviewと同一構造） ──
  function createVideoCard(video, index) {
    const url = buildWatchUrl(video.videoId, video.site);
    const postedDateStr = video.postedAt ? formatDate(video.postedAt) : '-';
    const ownerName = video.ownerName ? escapeHtml(video.ownerName) : '';
    const ownerAvatar = video.ownerIcon
      ? `<img src="${escapeHtml(video.ownerIcon)}" style="width:20px;height:20px;border-radius:50%;margin-right:4px;">`
      : '';

    const el = document.createElement('div');
    el.className = 'fv-video-card';
    el.dataset.index = index;
    el.dataset.vid = video.videoId; // 個別更新用

    let thumbUrl = video.thumbnailUrl;
    let fallbackUrl = '';
    
    // URL未取得時の推測ロジック（ケースA対応）
    if (!thumbUrl) {
      if (video.site === 'youtube') {
        thumbUrl = `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
        fallbackUrl = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
      } else {
        const numericId = video.videoId.replace(/^sm|nm|so/, '');
        thumbUrl = `https://nicovideo.cdn.nimg.jp/thumbnails/${numericId}/${numericId}.jpg`;
        fallbackUrl = `https://tn.smilevideo.jp/smile?i=${numericId}`;
      }
    } else {
      // 取得済みの場合は汎用フォールバック
      if (video.site === 'youtube') {
        fallbackUrl = `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
      } else {
        const numericId = video.videoId.replace(/^sm|nm|so/, '');
        fallbackUrl = `https://tn.smilevideo.jp/smile?i=${numericId}`;
      }
    }

    el.innerHTML = `
      <a href="${url}" target="_blank" class="fv-video-thumb">
        <img src="${escapeHtml(thumbUrl)}" loading="lazy" onerror="this.onerror=null; this.src='${escapeHtml(fallbackUrl)}';">
      </a>
      <div class="fv-video-info">
        <a href="${url}" target="_blank" class="fv-video-title">${escapeHtml(video.title || video.videoId)}</a>
        <div class="fv-video-posted-date">${postedDateStr}</div>
        ${ownerName ? `<div class="fv-video-owner-area">${ownerAvatar}${ownerName}</div>` : ''}
        <div class="fv-video-stats-row">
          <div class="fv-video-stats">
            <span title="再生数">${ICONS.view} ${formatCount(video.viewCount)}</span>
            <span title="いいね数">${ICONS.like} ${formatCount(video.likeCount)}</span>
            ${video.mylistCount >= 0 ? `<span title="マイリスト数">${ICONS.mylist} ${formatCount(video.mylistCount)}</span>` : ''}
          </div>
        </div>
        <div class="fv-video-desc">${escapeHtml(video.description || '')}</div>
      </div>
    `;
    return el;
  }

  // ── ビューモード切替 ──
  function setViewMode(mode) {
    viewMode = mode;
    const container = document.getElementById('fv-videos-container');
    if (container) {
      container.classList.remove('grid', 'list');
      container.classList.add(mode);
    }
    document.getElementById('btn-view-grid')?.classList.toggle('active', mode === 'grid');
    document.getElementById('btn-view-list')?.classList.toggle('active', mode === 'list');
  }

  // ── 動画一覧を遅延レンダリング ──
  function renderVideos(sortedData) {
    currentSortedData = sortedData;
    const container = document.getElementById('fv-videos-container');
    if (!container) return;
    container.innerHTML = '';
    
    const slice = currentSortedData.slice(0, renderLimit);
    slice.forEach((v, i) => container.appendChild(createVideoCard(v, i)));

    // スクロール追加読み込み (IntersectionObserver)
    if (renderLimit < currentSortedData.length) {
      const sentinel = document.createElement('div');
      sentinel.style.cssText = 'width: 100%; height: 20px; grid-column: 1 / -1;';
      container.appendChild(sentinel);

      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          renderLimit += 50;
          renderVideos(currentSortedData); // 再レンダリング
        }
      }, { rootMargin: '200px' });
      observer.observe(sentinel);
    }
  }

  // ── 特定のカードのみDOM更新 ──
  function updateCardInDOM(video) {
    const card = document.querySelector(`.fv-video-card[data-vid="${CSS.escape(video.videoId)}"]`);
    if (card) {
      const newCard = createVideoCard(video, card.dataset.index);
      card.replaceWith(newCard);
    }
  }

  // ── ソート ──
  function sortVideos(key) {
    const sorted = [...videosData];
    switch (key) {
      case 'viewCount_desc': sorted.sort((a,b) => (b.viewCount||0) - (a.viewCount||0)); break;
      case 'viewCount_asc':  sorted.sort((a,b) => (a.viewCount||0) - (b.viewCount||0)); break;
      case 'postedAt_desc':  sorted.sort((a,b) => (b.postedAt||0) - (a.postedAt||0)); break;
      case 'postedAt_asc':   sorted.sort((a,b) => (a.postedAt||0) - (b.postedAt||0)); break;
      case 'likeCount_desc': sorted.sort((a,b) => (b.likeCount||0) - (a.likeCount||0)); break;
      default: break; // original order
    }
    renderLimit = 50; // ソート時はリセット
    renderVideos(sorted);
  }

  // ── メインUI ──
  function renderSharedUI(listName, entries) {
    document.getElementById('view-toggle').style.display = '';

    root.innerHTML = `
      <div class="shared-page">
        <div class="shared-toolbar">
          <div class="shared-toolbar-left">
            <span class="shared-badge">共有</span>
            <h2>${escapeHtml(listName)}</h2>
            <span class="shared-count" id="shared-count">${entries.length}本</span>
          </div>
          <div class="shared-toolbar-right">
            <select id="shared-sort" class="fv-select" style="padding:6px 10px;background:var(--nl-bg-input);border:1px solid var(--nl-border);color:var(--nl-text);border-radius:var(--nl-radius-sm);font-size:13px;">
              <option value="original">元の順序</option>
              <option value="viewCount_desc">再生数 (多い順)</option>
              <option value="postedAt_desc">投稿日 (新しい順)</option>
              <option value="postedAt_asc">投稿日 (古い順)</option>
              <option value="likeCount_desc">いいね (多い順)</option>
            </select>
            <span class="shared-progress" id="shared-progress">情報取得中...</span>
            <button class="shared-import-btn" id="btn-import-all">マイリストに追加</button>
          </div>
        </div>
        <div class="shared-content">
          <div id="fv-videos-container" class="fv-scrollable grid"></div>
        </div>
      </div>
    `;

    setViewMode('grid');
    document.getElementById('btn-view-grid').addEventListener('click', () => setViewMode('grid'));
    document.getElementById('btn-view-list').addEventListener('click', () => setViewMode('list'));
    document.getElementById('shared-sort').addEventListener('change', (e) => sortVideos(e.target.value));

    // 初期表示: プレースホルダーカード
    videosData = entries.map(([vid, siteCode]) => ({
      videoId: vid,
      site: siteCode === 'y' ? 'youtube' : 'niconico',
      title: vid,
      thumbnailUrl: siteCode === 'y' ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '',
      viewCount: 0, likeCount: 0, mylistCount: siteCode === 'y' ? -1 : 0,
      postedAt: 0, ownerName: '', ownerIcon: '', description: ''
    }));
    renderVideos(videosData);

    // プログレッシブ情報取得
    fetchAllVideoInfo(entries);

    // インポートボタン
    document.getElementById('btn-import-all').addEventListener('click', () => importToMyList(listName));
  }

  // ── API経由で動画情報を取得・カード更新 ──
  async function fetchAllVideoInfo(entries) {
    const progress = document.getElementById('shared-progress');
    let loaded = 0;
    const chunkSize = 5; // API負荷軽減のため同時リクエスト数を制限

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const chunkIndices = Array.from({length: chunk.length}, (_, idx) => i + idx);

      await Promise.all(chunk.map(async ([vid, siteCode], chunkIdx) => {
        const site = siteCode === 'y' ? 'youtube' : 'niconico';
        const action = site === 'youtube' ? 'fetchYouTubeVideoInfo' : 'fetchVideoInfo';
        const globalIdx = chunkIndices[chunkIdx];

        try {
          const info = await chrome.runtime.sendMessage({ action, videoId: vid });
          if (info && !info.error) {
            Object.assign(videosData[globalIdx], {
              title: info.title || vid,
              thumbnailUrl: info.thumbnailUrl || videosData[globalIdx].thumbnailUrl,
              viewCount: info.viewCount ?? 0,
              likeCount: info.likeCount ?? 0,
              mylistCount: info.mylistCount ?? (site === 'youtube' ? -1 : 0),
              postedAt: info.postedAt ?? 0,
              ownerName: info.ownerName || '',
              ownerIcon: info.ownerIcon || '',
              description: (info.description || '').slice(0, 300)
            });
            
            // 描画済みならDOMだけ更新
            updateCardInDOM(videosData[globalIdx]);
          }
        } catch (e) {
          console.warn('Fetch failed:', vid, e);
        }
        loaded++;
        if (progress) progress.textContent = `${loaded}/${entries.length} 取得済`;
      }));

      // API負荷軽減のため少し待機
      await new Promise(r => setTimeout(r, 300));
    }

    if (progress) {
      progress.textContent = '✓ 取得完了';
      progress.style.color = 'var(--nl-success)';
    }
  }

  // ── インポート（順序維持） ──
  async function importToMyList(listName) {
    const btn = document.getElementById('btn-import-all');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'インポート中...';

    try {
      const importName = (listName || '共有リスト') + ' (コピー)';
      const listRes = await chrome.runtime.sendMessage({ action: 'createList', name: importName });
      if (!listRes || listRes.error) throw new Error(listRes?.error || 'リスト作成失敗');

      const listId = listRes.id;
      let added = 0;
      const baseTime = Date.now();

      // ★ 順序維持: addedAt を index * 1ms ずらして元順序を保持
      for (let i = 0; i < videosData.length; i++) {
        const v = videosData[i];
        try {
          await chrome.runtime.sendMessage({
            action: 'addVideo', listId,
            videoInfo: {
              videoId: v.videoId,
              title: v.title || v.videoId,
              thumbnailUrl: v.thumbnailUrl || '',
              viewCount: v.viewCount || 0,
              mylistCount: v.mylistCount ?? 0,
              likeCount: v.likeCount || 0,
              postedAt: v.postedAt || 0,
              ownerName: v.ownerName || '',
              ownerIcon: v.ownerIcon || '',
              description: v.description || '',
              site: v.site || 'niconico',
              addedAt: baseTime + (videosData.length - i)  // ★ 先頭が最大値 → addedAt_desc で元順序維持
            }
          });
          added++;
        } catch (e) { /* 重複エラー無視 */ }
      }

      btn.textContent = `✓ ${added}本をインポートしました`;
      btn.classList.add('done');
    } catch (err) {
      btn.textContent = 'エラー: ' + err.message;
      btn.disabled = false;
    }
  }

  // ── ペースト入力UI ──
  function showPasteUI() {
    root.innerHTML = `
      <div class="shared-page">
        <div class="shared-content">
          <div class="shared-paste-area">
            <h3>共有コードを入力</h3>
            <p>受け取った共有コードをペーストしてください</p>
            <textarea class="shared-paste-input" id="share-code-input" placeholder="ここに共有コードをペースト..."></textarea>
            <button class="shared-paste-btn" id="btn-load-code">リストを読み込む</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('btn-load-code').addEventListener('click', () => {
      const code = document.getElementById('share-code-input').value.trim();
      if (!code) return;
      const data = decodeShareCode(code);
      if (data) {
        processShareData(data);
      } else {
        alert('共有コードが無効です。');
      }
    });
  }

  // ── v1/v2フォーマット判定・処理 ──
  function processShareData(data) {
    if (data.v === 2) {
      // v2 最小化フォーマット
      document.title = `NicoList - ${data.n || '共有リスト'}`;
      renderSharedUI(data.n || '共有リスト', data.d);
    } else if (data.v === 1 || data.videos) {
      // v1 互換: 旧フォーマットも読める
      document.title = `NicoList - ${data.name || '共有リスト'}`;
      const entries = data.videos.map(v => [v.videoId, v.site === 'youtube' ? 'y' : 'n']);
      renderSharedUI(data.name || '共有リスト', entries);
    } else {
      root.innerHTML = '<div class="shared-empty"><h3>無効な共有データ</h3></div>';
    }
  }

  // ── 初期化 ──
  const hash = location.hash.slice(1);
  if (hash) {
    const data = decodeShareCode(hash);
    if (data) {
      processShareData(data);
    } else {
      root.innerHTML = '<div class="shared-page"><div class="shared-content"><div class="shared-empty"><h3>共有データの読み込みに失敗しました</h3><p>リンクが壊れている可能性があります。</p></div></div></div>';
    }
  } else {
    showPasteUI();
  }

})();
