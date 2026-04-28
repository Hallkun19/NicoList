/**
 * ============================================================
 * NicoList - ニコニコ動画 Content Script
 * ============================================================
 *
 * ニコニコ動画のページに「NicoListに追加」ボタンと
 * リスト選択モーダル、連続再生パネルを注入する。
 */

(function () {
  'use strict';

  if (window.__nicoListContentLoaded) return;
  window.__nicoListContentLoaded = true;

  let cachedNextUrl = null;

  function getCurrentVideoId() {
    const match = location.pathname.match(/\/watch\/((?:sm|nm|so|ca|ax|yo|nl|ig|na|cw|z[a-z]|om|sk|yk)\d+)/i);
    return match ? match[1] : null;
  }

  // ═════════════════════════════════════════════════════════
  //  動画情報取得 (v1.5: さらに堅牢なデータパース)
  // ═════════════════════════════════════════════════════════

  function safeParseJSON(str) {
    if (!str) return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  }



  async function getVideoInfoFromPage() {
    const videoId = getCurrentVideoId();
    if (!videoId) return null;

    let info = {
      videoId: videoId, title: '', thumbnailUrl: '', viewCount: 0, mylistCount: 0,
      likeCount: 0, postedAt: 0, ownerName: '', ownerIcon: '', description: '',
      site: 'niconico'
    };

    // =========================================================
    // 1. JSON解析からの取得 (最優先)
    // =========================================================
    const jsonSources = [];
    
    const initDataEl = document.getElementById('js-initial-watch-data');
    if (initDataEl) {
      jsonSources.push(safeParseJSON(initDataEl.textContent.trim()));
      jsonSources.push(safeParseJSON(initDataEl.getAttribute('data-api-data')));
    }
    const nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl) {
      jsonSources.push(safeParseJSON(nextDataEl.textContent.trim()));
    }
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    ldScripts.forEach(sc => jsonSources.push(safeParseJSON(sc.textContent.trim())));

    for (const data of jsonSources) {
      if (!data) continue;

      // JSON-LD
      if (data['@type'] === 'VideoObject') {
         if (!info.title) info.title = data.name || '';
         if (!info.ownerName) info.ownerName = data.author?.name || '';
         if (!info.postedAt && data.uploadDate) info.postedAt = new Date(data.uploadDate).getTime();
         if (!info.thumbnailUrl && data.thumbnailUrl) info.thumbnailUrl = Array.isArray(data.thumbnailUrl) ? data.thumbnailUrl[0] : data.thumbnailUrl;
         if (!info.description) info.description = data.description || '';
         continue;
      }

      // __NEXT_DATA__ / js-initial-watch-data
      let mainVideoNode = null;
      let mainOwnerNode = null;

      // [最優先] NVPC Next (React Router) のアーキテクチャから抽出
      const rvData = window.__reactRouterContext?.loaderData?.[`routes/watch.$videoId`]?.video;
      if (rvData && (rvData.id === videoId || rvData.contentId === videoId)) {
        mainVideoNode = rvData;
        mainOwnerNode = window.__reactRouterContext?.loaderData?.[`routes/watch.$videoId`]?.owner || 
                        window.__reactRouterContext?.loaderData?.[`routes/watch.$videoId`]?.channel;
        console.log('NicoList: [NVPC-Direct] ReactRouterContext からデータを特定しました');
      }

      // [次点] モダンな Niconico Watch ページ (__NEXT_DATA__)
      const nextProps = data?.props?.pageProps;
      const iwd = nextProps?.initialWatchData || data?.data?.response; 
      const istate = nextProps?.initialState?.video?.watch; // Redux state fallback

      if (iwd && iwd.video && (iwd.video.id === videoId || iwd.video.contentId === videoId)) {
          const v = iwd.video;
          mainVideoNode = v;
          mainOwnerNode = iwd.owner || iwd.channel;
          console.log('NicoList: [JSON-Direct] initialWatchData からデータを特定しました');
      } else if (istate && (istate.id === videoId || istate.videoId === videoId)) {
          mainVideoNode = istate;
          mainOwnerNode = istate.owner || istate.channel;
          console.log('NicoList: [JSON-Direct] initialState からデータを特定しました');
      }

      function searchId(obj, depth = 0) {
         if (!obj || typeof obj !== 'object' || depth > 20) return;
         
         // 動画ノードの判定
         if ((obj.id === videoId || obj.videoId === videoId || obj.contentId === videoId) && (obj.count || obj.viewCount || obj.owner)) {
            if (!mainVideoNode) {
                mainVideoNode = obj;
                if (obj.owner && typeof obj.owner === 'object') mainOwnerNode = obj.owner;
                else if (obj.channel && typeof obj.channel === 'object') mainOwnerNode = obj.channel;
            }
         }
         
         // いいね数の直接探索 (videoIdノードが見つからない場合のバックアップ)
         if (obj.count && typeof obj.count === 'object' && obj.count.like !== undefined) {
             if (info.likeCount === 0) {
                 // コンテキストが不明な場合は一時保持するが、videoId一致を優先する
                 // ただし、この階層が videoId と兄弟関係にある可能性を考慮
             }
         }
         
         for (const key in obj) {
             if (Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === 'object') {
                 searchId(obj[key], depth + 1);
             }
         }
      }
      if (!mainVideoNode) searchId(data);

      if (mainVideoNode) {
        if (!info.title) info.title = mainVideoNode.title || '';
        let vc = mainVideoNode.count?.view ?? mainVideoNode.viewCount; if (vc !== undefined) info.viewCount = vc;
        let mc = mainVideoNode.count?.mylist ?? mainVideoNode.mylistCount; if (mc !== undefined) info.mylistCount = mc;
        let lc = mainVideoNode.count?.like ?? mainVideoNode.likeCount; 
        if (lc !== undefined) {
             info.likeCount = parseInt(lc, 10) || 0;
        }
        let reg = mainVideoNode.registeredAt || mainVideoNode.postedAt; if (reg) info.postedAt = new Date(reg).getTime();
        if (!info.thumbnailUrl) info.thumbnailUrl = mainVideoNode.thumbnail?.largeUrl || mainVideoNode.thumbnail?.middleUrl || mainVideoNode.thumbnail?.url || mainVideoNode.thumbnailUrl || '';
        if (!info.description) info.description = mainVideoNode.description || '';
      }
      if (mainOwnerNode) {
        if (!info.ownerName) info.ownerName = mainOwnerNode.nickname || mainOwnerNode.name || '';
        if (!info.ownerIcon && mainOwnerNode.iconUrl) info.ownerIcon = mainOwnerNode.iconUrl;
        if (!info.ownerIcon && mainOwnerNode.thumbnailUrl) info.ownerIcon = mainOwnerNode.thumbnailUrl;
      }
    }

    // =========================================================
    // 1.5. APIからの確実な取得 (v3_guest API)
    // =========================================================
    try {
      const trackId = Math.random().toString(36).substring(2, 12) + '_' + Math.floor(Date.now() / 1000);
      const apiRes = await fetch(`https://www.nicovideo.jp/api/watch/v3_guest/${videoId}?actionTrackId=${trackId}&noSideEffect=true`, {
        headers: { 'X-Frontend-Id': '6', 'X-Frontend-Version': '0' }
      });
      if (apiRes.ok) {
        const apiJson = await apiRes.json();
        const v = apiJson?.data?.video || apiJson?.data?.response?.video;
        if (v) {
          if (v.count?.like !== undefined) info.likeCount = parseInt(v.count.like, 10) || info.likeCount;
          if (v.count?.view !== undefined) info.viewCount = v.count.view;
          if (v.count?.mylist !== undefined) info.mylistCount = v.count.mylist;
          // サムネイルもAPIから補完
          if (!info.thumbnailUrl || info.thumbnailUrl.includes('blank')) {
            info.thumbnailUrl = v.thumbnail?.ogp || v.thumbnail?.largeUrl || v.thumbnail?.middleUrl || v.thumbnail?.url || info.thumbnailUrl;
          }
        }
        const o = apiJson?.data?.owner || apiJson?.data?.channel || apiJson?.data?.response?.owner || apiJson?.data?.response?.channel;
        if (o) {
          if (!info.ownerName) info.ownerName = o.nickname || o.name || '';
          if (!info.ownerIcon && o.iconUrl) info.ownerIcon = o.iconUrl;
          if (!info.ownerIcon && o.thumbnailUrl) info.ownerIcon = o.thumbnailUrl;
        }
      }
    } catch(e) { console.warn('NicoList: v3_guest API failed', e); }

    // =========================================================
    // 1.6. スナップショット検索API (フォールバック)
    // =========================================================
    if (info.likeCount === 0 || !info.title || info.viewCount === 0) {
        try {
            const snapUrl = `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?q=${videoId}&targets=contentId&fields=likeCounter,title,viewCounter,mylistCounter,lengthSeconds&_limit=1`;
            const snapRes = await fetch(snapUrl);
            if (snapRes.ok) {
                const snapJson = await snapRes.json();
                if (snapJson.data && snapJson.data.length > 0) {
                    const sn = snapJson.data[0];
                    if (sn.likeCounter !== undefined && info.likeCount === 0) info.likeCount = sn.likeCounter;
                    if (sn.viewCounter !== undefined && info.viewCount === 0) info.viewCount = sn.viewCounter;
                    if (sn.mylistCounter !== undefined && info.mylistCount === 0) info.mylistCount = sn.mylistCounter;
                    if (sn.title && !info.title) info.title = sn.title;
                }
            }
        } catch(e) { console.warn('NicoList: Snapshot API fallback failed'); }
    }

    // =========================================================
    // 2. DOMからの取得 (JSONやAPIで不足しているものを補完・自身のアイコン排除)
    // =========================================================
    if (!info.ownerIcon) {
        // 【重要修正】ヘッダーやナビゲーション(自分自身のログインアイコン等)を厳密に排除する
        const ownerLinks = document.querySelectorAll('a[href^="/user/"], a[href^="/channel/"]');
        for (const link of Array.from(ownerLinks)) {
            // ヘッダーやマイページ関連の要素ツリーにあるものはスキップ（viewer排除）
            if (link.closest('header') || link.closest('nav') || link.closest('#CommonHeader') || link.href.includes('/my/')) continue;
            
            const innerImg = link.querySelector('img');
            if (innerImg && innerImg.src && !innerImg.src.includes('defaults/blank.jpg')) {
                info.ownerIcon = innerImg.src;
                console.log('NicoList: [DOM] 動画下部の投稿者リンクからOwnerアイコンを取得成功:', info.ownerIcon);
                break;
            }
        }
    }
    if (!info.title || info.viewCount === 0 || info.likeCount === 0 || !info.ownerName) {
        console.log('NicoList: JSON情報が不完全なためDOMから補完を実行します', JSON.parse(JSON.stringify(info)));
        
        if (!info.title) {
            const titleMeta = document.querySelector('meta[property="og:title"]');
            if (titleMeta) info.title = titleMeta.content.replace(/ - ニコニコ動画$/, '').trim();
        }
        if (!info.thumbnailUrl || info.thumbnailUrl.includes('blank')) {
            // OGP meta から取得
            const imgMeta = document.querySelector('meta[property="og:image"]');
            if (imgMeta && imgMeta.content && !imgMeta.content.includes('blank')) {
              info.thumbnailUrl = imgMeta.content;
            }
            // JSON-LD から取得 (デバイス規制対策フォールバック)
            if (!info.thumbnailUrl || info.thumbnailUrl.includes('blank')) {
              const ldScriptsThumb = document.querySelectorAll('script[type="application/ld+json"]');
              for (const sc of ldScriptsThumb) {
                try {
                  const ld = JSON.parse(sc.textContent.trim());
                  if (ld.thumbnail && Array.isArray(ld.thumbnail) && ld.thumbnail[0]?.url) {
                    info.thumbnailUrl = ld.thumbnail[0].url;
                    break;
                  }
                  if (ld.thumbnailUrl) {
                    info.thumbnailUrl = Array.isArray(ld.thumbnailUrl) ? ld.thumbnailUrl[0] : ld.thumbnailUrl;
                    break;
                  }
                } catch(e) {}
              }
            }
        }

        const extractCountByKeyword = (keyword) => {
           const els = Array.from(document.querySelectorAll('span, div, li'));
           for (const el of els) {
              const text = el.textContent;
              if (text.includes(keyword)) {
                 const match = text.match(new RegExp(`${keyword}\\s*[:：]?\\s*([\\d,]+)(?!\\s*[:：])`));
                 if (match) return parseInt(match[1].replace(/[,，]/g, ''), 10);
              }
           }
           return 0;
        };

        if (info.viewCount === 0) info.viewCount = extractCountByKeyword('再生');
        if (info.mylistCount === 0) info.mylistCount = extractCountByKeyword('マイリスト');
        if (info.likeCount === 0) {
             console.log('NicoList: JSONおよびAPIすべてでいいね数が0だったため、最終手段としてDOM正規表現を使用します');
             const likeUI = document.querySelectorAll('[data-title="いいね"], [aria-label*="いいね" i], [data-name*="like" i], button[class*="like" i]');
             for (const el of Array.from(likeUI)) {
                 const txt = el.textContent || '';
                 if (txt.includes('いいね') || /^[\d,]+$/.test(txt)) {
                     const matched = txt.replace(/,/g, '').match(/\d+/);
                     if (matched) {
                         const num = parseInt(matched[0], 10);
                         if (num > 0 && num < 10000000) {
                             info.likeCount = num;
                             console.log('NicoList: [DOM抽出] テキストからいいね数を取得:', info.likeCount);
                             break;
                         }
                     }
                  }
             }
        }

        if (!info.ownerName) {
            const ownerLink = document.querySelector('a[class*="VideoOwnerInfo-pageLink"], a[class*="owner-name"], a[href^="/user/"]');
            if (ownerLink) info.ownerName = ownerLink.textContent.trim();
        }

        if (!info.duration || info.duration === '0:00') {
            const timeEl = document.querySelector('.VideoLength, [data-testid="video-length"]');
            if (timeEl && /^\d{1,2}:\d{2}(:\d{2})?$/.test(timeEl.textContent.trim())) {
                info.duration = timeEl.textContent.trim();
            }
        }
        if (!info.postedAt) {
            const dateEl = document.querySelector('.VideoUploadDateMeta-dateTime, [data-title="投稿日時"]');
            if (dateEl) {
                const parsed = new Date(dateEl.textContent.trim()).getTime();
                if (!isNaN(parsed) && parsed > 0) info.postedAt = parsed;
            }
        }
    }

    // =========================================================
    // 3. SPA待機処理 (重要なデータが取れない場合は少し待つ)
    // =========================================================
    if (info.likeCount === 0 || !info.title || info.viewCount === 0) {
        console.log('NicoList: SPAマウント待機リトライを開始します...');
        info = await new Promise((resolve) => {
            let attempt = 0;
            const interval = setInterval(() => {
                attempt++;
                if (!info.title) {
                    const dTitle = document.querySelector('meta[property="og:title"]')?.content.replace(/ - ニコニコ動画$/, '') || document.title.replace(/ - ニコニコ動画$/, '');
                    if (dTitle && dTitle !== videoId) info.title = dTitle;
                }
                if (info.likeCount === 0) {
                   const likeBtn = document.querySelector('button[aria-label="いいね"], button[data-title="いいね"], [data-testid="like-button"]');
                   if (likeBtn) {
                      const m = likeBtn.textContent.match(/([\d,]+)/);
                      if (m) info.likeCount = parseInt(m[1].replace(/,/g, ''), 10);
                   }
                }
                if (info.viewCount === 0) {
                   const els = Array.from(document.querySelectorAll('span, div'));
                   for (const el of els) {
                      if (el.textContent.includes('再生')) {
                         const match = el.textContent.match(/再生\s*[:：]?\s*([\d,]+)(?!\s*[:：])/);
                         if (match) info.viewCount = parseInt(match[1].replace(/[,，]/g, ''), 10);
                         break;
                      }
                   }
                }
                
                if ((info.title && info.likeCount > 0 && info.viewCount > 0) || attempt >= 10) {
                    clearInterval(interval);
                    resolve(info);
                }
            }, 200); // 200ms × 10 = 最大2秒待機
        });
    }

    // =========================================================
    // 4. データ検証と最終整形
    // =========================================================
    if (!info.title || info.title.trim() === '') info.title = document.title.replace(/ - ニコニコ動画$/, '').trim() || videoId;
    if (!info.ownerName) info.ownerName = '不明なユーザー';
    if (!info.ownerIcon) info.ownerIcon = 'https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/defaults/blank.jpg';
    if (!info.postedAt || isNaN(info.postedAt)) info.postedAt = 0; 

    // サムネイルURLの高画質化・統一化
    if (info.thumbnailUrl) {
        // ニコニコCDNの旧形式サムネイルのみ .L 変換を適用
        if (info.thumbnailUrl.includes('nicovideo.cdn.nimg.jp/thumbnails/')) {
            if (!info.thumbnailUrl.includes('.L')) {
                // サイズサフィックス (.M, .S, .S2 等) があれば .L に置換
                const sizeReplaced = info.thumbnailUrl.replace(/\.[A-Z]\d?(\?.*)?$/, '.L$1');
                if (sizeReplaced !== info.thumbnailUrl) {
                    info.thumbnailUrl = sizeReplaced;
                } else {
                    // サイズサフィックスなし (例: 123.456789) → .L を末尾に追加
                    info.thumbnailUrl = info.thumbnailUrl.replace(/(\?.*)?$/, '.L$1');
                }
            }
        }
        // img.cdn.nimg.jp の新形式はそのまま使用
    }

    console.log('NicoList: 最終データマッピング完了', info);
    return info;
  }

  // formatSeconds function removed as we no longer show duration


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
  //  UI: リスト追加ボタン (v1.5: 参照コードベースの完全統合)
  // ═════════════════════════════════════════════════════════
  let buttonObserver = null;
  let insertionInterval = null;

  function createAddButtonWithObserver() {
    if (buttonObserver) buttonObserver.disconnect();
    if (insertionInterval) clearInterval(insertionInterval);
    
    const tryInsert = () => {
      // 既に挿入済みの場合は成功とする
      if (document.getElementById('nicolist-add-btn')) return true;

      // 案1: 動画ホバー時の操作UI（設定ボタンの左隣）に統合
      let settingButton = document.querySelector("button[aria-label='設定'], [data-testid='setting-button']");
      if (settingButton && settingButton.parentElement) {
        settingButton.insertAdjacentHTML("beforebegin", `
          <button id="nicolist-add-btn" aria-label="NicoListに追加" title="NicoListに追加" 
            style="color:white; margin-right:8px; cursor:pointer; background:none; border:none; display:flex; align-items:center; gap:2px;" 
            class="nicolist-player-control-btn">
             ${ICONS.playList}
          </button>
        `);
        bindAddBtnEvents(document.getElementById('nicolist-add-btn'));
        return true;
      }

      // 案2: 投稿者アイコンの右隣に統合
      let ownerNameEl = document.querySelector('.VideoOwnerInfo-pageLink, .owner-name, [data-testid="owner-name"]');
      if (ownerNameEl && ownerNameEl.parentElement) {
         ownerNameEl.parentElement.insertAdjacentHTML("beforeend", `
          <button id="nicolist-add-btn" class="nicolist-inline-owner-btn" style="margin-left: 10px;" title="NicoList に追加">
            ${ICONS.plus} リスト
          </button>
        `);
        bindAddBtnEvents(document.getElementById('nicolist-add-btn'));
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
      }, 100);
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
      // クリック即追加モード: click → 即追加、dblclick → モーダル
      let clickTimer = null;
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          handleDoubleClickAdd(); // 即追加（名前は旧来のまま）
        }, 250);
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openModal();
      });
    } else {
      // ダブルクリック即追加モード（デフォルト）: click → モーダル、dblclick → 即追加
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

  // SPAの再描画による消滅を監視して何度も挿入する
  function observeContainerRemovals() {
    if (buttonObserver) buttonObserver.disconnect();
    buttonObserver = new MutationObserver(() => {
      if (!document.getElementById('nicolist-add-btn')) {
        createAddButtonWithObserver();
      }
    });
    const player = document.querySelector('.VideoContainer, #MainContainer, body');
    if (player) buttonObserver.observe(player, { childList: true, subtree: true });
  }

  // ═════════════════════════════════════════════════════════
  //  UI: リスト選択モーダル
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
        throw new Error('動画情報の取得に失敗（画面のリロードをお試しください）');
      }

      const result = await chrome.runtime.sendMessage({ action: 'addVideo', listId, videoInfo });
      
      if (result.success) {
        // v2.0: 最後に使用したリストを記憶（ダブルクリック即追加用）
        await chrome.storage.local.set({ lastUsedListId: listId });
        showToast(`「${videoInfo.title}」を追加しました`, 'success');
      } else {
        throw new Error(result.message || '追加失敗');
      }
    } catch (err) {
      console.warn('NicoList: 追加エラー', err);
      showToast('追加失敗: ' + err.message, 'error');
      btnEl.innerHTML = originalText;
      btnEl.disabled = false;
      if (!isAlreadyAdded) {
        listItemEl.classList.remove('nicolist-added');
      }
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
  //  連続再生 パネル (v1.5: インデックスバグとバックグランドフリーズ対策済)
  // ═════════════════════════════════════════════════════════
  let playbackState = null;
  async function setupPlaybackDetection() {
    playbackState = await chrome.runtime.sendMessage({ action: 'getPlaybackState' });
    if (!playbackState || !playbackState.isPlaying) return;

    // 9. インデックスループバグ対策：現在のIDが再生キューとズレていないか検証・同期
    await syncPlaybackIndex();

    cachedNextUrl = playbackState.nextUrl || null;
    showPlaybackPanel(playbackState);
    attachVideoEndedListener();
  }

  // v2.0: ループ動画バグ修正 + 提供表示バグ修正
  let watchdogTimer = null;
  let loopObserver = null;

  function attachVideoEndedListener() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (loopObserver) { loopObserver.disconnect(); loopObserver = null; }

    const attach = () => {
      const video = document.querySelector('video[data-name="video-content"], video');
      if (video) {
        // === ループ動画修正: loop属性を強制的にfalseにする ===
        if (video.loop) {
          video.loop = false;
          console.log('NicoList: [Playback] loop属性を強制解除しました');
        }
        // MutationObserverでloop属性の再設定を監視
        loopObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'loop' && video.loop) {
              video.loop = false;
              console.log('NicoList: [Playback] loop属性の再設定を検知し、再度解除しました');
            }
          }
        });
        loopObserver.observe(video, { attributes: true, attributeFilter: ['loop'] });

        // === endedイベントリスナー ===
        video.removeEventListener('ended', onVideoEnded);
        video.addEventListener('ended', onVideoEnded, { once: true });

        // === 提供表示バグ修正: 再生時間監視watchdog ===
        let lastTime = -1;
        let stallCount = 0;
        watchdogTimer = setInterval(() => {
          if (!video || video.paused && video.ended) {
            // endedが発火済みの場合はwatchdog不要
            clearInterval(watchdogTimer); watchdogTimer = null;
            return;
          }
          const ct = video.currentTime;
          const dur = video.duration;

          // ケース1: 動画の末尾近くで停滞している
          if (dur && ct >= dur - 2 && Math.abs(ct - lastTime) < 0.1) {
            stallCount++;
            if (stallCount >= 3) {
              console.log('NicoList: [Watchdog] 動画末尾で停滞を検知、強制的に次へ遷移します');
              clearInterval(watchdogTimer); watchdogTimer = null;
              onVideoEnded();
              return;
            }
          } else {
            stallCount = 0;
          }

          // ケース2: 一時停止状態が異常に長い(paused && !ended)
          if (video.paused && !video.ended && dur && ct >= dur - 3) {
            stallCount += 2;
            if (stallCount >= 5) {
              console.log('NicoList: [Watchdog] paused状態で末尾付近、強制的に次へ遷移します');
              clearInterval(watchdogTimer); watchdogTimer = null;
              onVideoEnded();
              return;
            }
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
    if(!playbackState) return;
    const currentVideoId = getCurrentVideoId();
    if (playbackState.queue[playbackState.currentIndex]?.videoId !== currentVideoId) {
      // 実際開いている動画を探す
      const actualIdx = playbackState.queue.findIndex(v => v.videoId === currentVideoId);
      if (actualIdx !== -1) {
        playbackState.currentIndex = actualIdx;
        // 背景のストレージにも同期（拡張機能間共有）
        await chrome.storage.local.set({ playbackState });
        // playbackStateが更新されたので nextUrl 等も再計算
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

    // 停止ハンドラ共通化
    const stopPlaybackAndRemove = async () => {
      await chrome.runtime.sendMessage({ action: 'stopPlayback' });
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      panel.remove();
      showToast('連続再生を停止', 'info');
    };

    document.getElementById('nicolist-panel-skip').addEventListener('click', onVideoEnded);
    document.getElementById('nicolist-panel-stop').addEventListener('click', stopPlaybackAndRemove);
    // v2.1: ×ボタンで閉じたら再生停止
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
    let offsetX = 0; let offsetY = 0;
    handle.style.cursor = 'grab';

    const onMouseDown = (e) => {
      if (e.target.closest('#nicolist-panel-toggle')) return;
      isDragging = true;
      handle.style.cursor = 'grabbing';
      const rect = element.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      element.style.right = 'auto'; element.style.bottom = 'auto';
      element.style.left = rect.left + 'px'; element.style.top = rect.top + 'px';
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const newLeft = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - element.offsetWidth));
      const newTop = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - element.offsetHeight));
      element.style.left = newLeft + 'px'; element.style.top = newTop + 'px';
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      handle.style.cursor = 'grab';
    };

    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function escapeHtml(str) {
    const div = document.createElement('div'); div.textContent = str; return div.innerHTML;
  }

  // ═════════════════════════════════════════════════════════
  //  v2.1: ダブルクリック即追加（ボタンのdblclickから呼ばれる）
  //  モーダルは一切表示しない。設定のdefaultListIdに直接追加。
  // ═════════════════════════════════════════════════════════
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
      if (!videoInfo || !videoInfo.title) {
        showToast('動画情報の取得に失敗しました', 'error');
        return;
      }
      const res = await chrome.runtime.sendMessage({ action: 'addVideo', listId: defaultListId, videoInfo });
      if (res.success) {
        showToast(`「${videoInfo.title}」を追加しました`, 'success');
      } else {
        showToast(res.message || '追加に失敗しました', 'error');
      }
    } catch (err) {
      showToast('エラー: ' + err.message, 'error');
    }
  }

  // ═════════════════════════════════════════════════════════
  //  初期化 (URL変更検知)
  // ═════════════════════════════════════════════════════════
  function init() {
    if (!getCurrentVideoId()) return;
    
    createAddButtonWithObserver();
    setupPlaybackDetection();
    
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        
        // クリーンアップ
        document.getElementById('nicolist-add-btn')?.remove();
        if (buttonObserver) buttonObserver.disconnect();
        if (insertionInterval) clearInterval(insertionInterval);
        if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
        if (loopObserver) { loopObserver.disconnect(); loopObserver = null; }
        
        if (getCurrentVideoId()) {
          createAddButtonWithObserver();
          setupPlaybackDetection();
        }
      }
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 連続再生の停止はbackground.jsのtabs.onRemovedで管理
  // beforeunloadではstopPlaybackを呼ばない（次の動画への遷移時にも発火してしまうため）

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
