/* desktop.js
 * 一覧画面ヘッダーに横断検索バーを表示する。
 * - 検索対象は設定時のスナップショット（fieldSnapshotJson）を正とし、現在のフィールド定義と
 *   食い違うものは検索対象から除外する（全滅時は設定値でフォールバック）
 * - app.record.index.show は同一ページ内で複数回発火しうるため、DOM 生成とイベント登録を
 *   必ずセットで行い、既存 DOM があれば再利用する
 */
(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  // 検索語の上限（設定値が無い・不正な場合の既定値）。config.js / config.html と同じ値にすること
  const DEFAULT_MAX_TOKENS = 5;

  // 選択肢の完全一致（in）で検索するフィールド型
  const IN_TYPES = new Set(['DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT']);

  // ページ内で共有する状態（イベントハンドラは常にここを参照する）
  const state = {
    config: null,
    mode: 'and',              // 現在の検索モード（'and' | 'or'）。初期値は URL > プラグイン設定 > AND
    searchTargets: [],        // 実際に検索へ使う targets
    excludedCodes: new Set(), // スナップショット不一致で除外したフィールドコード
    mismatch: false,
    fallback: false,          // 使えるフィールドが 0 件のため設定値でフォールバック中
    optionsMap: {},
    validation: null,         // 現在のフィールド定義との照合（ページ内で 1 回だけ実行）
    lastRecords: null
  };

  // =========================
  // 設定の読み取り
  // =========================
  function parseJsonArray(str) {
    try {
      const v = str ? JSON.parse(str) : [];
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  function getPluginConfig() {
    const cfg = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
    const maxTokens = Number(cfg.maxTokens);

    return {
      spaceJoin: (cfg.spaceJoin === 'or') ? 'or' : 'and', // 一覧画面を開いたときの AND / OR の初期値
      maxTokens: (Number.isFinite(maxTokens) && maxTokens >= 1 && maxTokens <= 10) ? maxTokens : DEFAULT_MAX_TOKENS,
      targets: parseJsonArray(cfg.targetsJson),             // [{code, op}]
      fieldSnapshot: parseJsonArray(cfg.fieldSnapshotJson)  // [{code,label,type,op,isSubtable,parent...,options}]
    };
  }

  // =========================
  // URL操作：検索語保持用（nrc_q）
  // =========================
  function getRawKeywordFromUrl() {
    const params = new URLSearchParams(location.search);
    return params.get('nrc_q') || '';
  }

  // URL に保持された検索モード。不正な値・未指定は null（呼び出し側で設定値へフォールバック）
  function getModeFromUrl() {
    const v = new URLSearchParams(location.search).get('nrc_mode');
    return (v === 'and' || v === 'or') ? v : null;
  }

  function resolveInitialMode(config) {
    return getModeFromUrl() || (config.spaceJoin === 'or' ? 'or' : 'and');
  }

  function setQueryAndKeywordAndReload(newQuery, rawKeyword, mode) {
    const url = new URL(location.href);
    const params = url.searchParams;

    // 検索モードは検索・解除のどちらでも保持する（解除しても利用者の選択を戻さない）
    params.set('nrc_mode', mode === 'or' ? 'or' : 'and');

    if (newQuery && newQuery.trim()) params.set('query', newQuery);
    else params.delete('query');

    if (rawKeyword && rawKeyword.trim()) params.set('nrc_q', rawKeyword);
    else params.delete('nrc_q');

    params.delete('offset');
    url.search = params.toString();
    location.href = url.toString();
  }

  // =========================
  // 文字列処理（query用）
  // =========================
  function splitTokens(rawText) {
    const text = (rawText ?? '')
      .toString()
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return [];
    return text.split(' ').filter(Boolean);
  }

  function escapeQueryValue(value) {
    return (value ?? '')
      .toString()
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, ' ')
      .trim();
  }

  function escapeHtml(s) {
    return (s ?? '')
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // =========================
  // 検索語の解析と query 生成
  // =========================
  /**
   * @returns {{
   *   allTokens: string[],      入力されたすべての語
   *   usedTokens: string[],     実際に検索条件になった語
   *   overflowTokens: string[], 上限超過で対象外になった語
   *   unusableTokens: string[], どのフィールドでも条件を作れなかった語（選択肢に一致しない等）
   *   query: string
   * }}
   */
  function analyzeSearch(rawText, targets, mode, maxTokens, optionsMap) {
    const allTokens = splitTokens(rawText);
    const limit = Math.max(1, maxTokens);
    const tokens = allTokens.slice(0, limit);
    const overflowTokens = allTokens.slice(limit);

    const usedTokens = [];
    const unusableTokens = [];
    const clauses = [];

    tokens.forEach((token) => {
      const escaped = escapeQueryValue(token);
      const orParts = [];

      (targets || []).forEach((t) => {
        if (!t || !t.code || !t.op) return;

        if (t.op === 'like') {
          orParts.push(`(${t.code} like "${escaped}")`);
          return;
        }

        if (t.op === 'in') {
          const opts = optionsMap ? optionsMap[t.code] : null;
          if (!Array.isArray(opts) || opts.length === 0) return;
          // 選択肢と完全一致する語だけ採用（存在しない値を in に入れるとクエリエラーになるため）
          if (!opts.includes(token)) return;
          orParts.push(`(${t.code} in ("${escaped}"))`);
        }
      });

      if (orParts.length === 0) {
        unusableTokens.push(token);
        return;
      }
      usedTokens.push(token);
      clauses.push(`(${orParts.join(' or ')})`);
    });

    const joiner = (mode === 'or') ? ' or ' : ' and ';
    return { allTokens, usedTokens, overflowTokens, unusableTokens, query: clauses.join(joiner) };
  }

  // =========================
  // スタイル
  // =========================
  function ensureStyles() {
    if (document.getElementById('nrc-xsearch-style')) return;

    const style = document.createElement('style');
    style.id = 'nrc-xsearch-style';
    style.textContent = `
      #nrc-xsearch-root { display: inline-block; vertical-align: middle; max-width: 100%; margin-left: 8px; }
      #nrc-xsearch-root [hidden] { display: none !important; }

      .nrc-xsearch { position: relative; margin: 0; }
      .nrc-xsearch__bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

      .nrc-xsearch__input {
        width: 240px;
        max-width: 100%;
        box-sizing: border-box;
        padding: 6px 10px;
        border: 1px solid #d7d7d7;
        border-radius: 10px;
        font-size: 13px;
        background: #fff;
      }

      .nrc-xsearch__btn {
        appearance: none;
        border: 1px solid #d7d7d7;
        background: #fff;
        border-radius: 10px;
        padding: 6px 10px;
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
      }
      .nrc-xsearch__btn--primary {
        background: #1f2937;
        border-color: #1f2937;
        color: #fff;
        font-weight: 700;
      }

      .nrc-xsearch__mode { display: inline-flex; border: 1px solid #d7d7d7; border-radius: 10px; overflow: hidden; background: #fff; }
      .nrc-xsearch__modeBtn {
        appearance: none;
        border: none;
        background: transparent;
        padding: 6px 9px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        color: #555;
      }
      .nrc-xsearch__modeBtn + .nrc-xsearch__modeBtn { border-left: 1px solid #d7d7d7; }
      .nrc-xsearch__modeBtn[aria-pressed="true"] { background: #e8eef9; color: #111; font-weight: 700; }

      .nrc-xsearch__meta {
        appearance: none;
        border: none;
        background: transparent;
        padding: 2px 0;
        font-size: 12px;
        color: #666;
        cursor: pointer;
        white-space: nowrap;
      }
      .nrc-xsearch__meta:hover { text-decoration: underline; }

      .nrc-xsearch__input:focus-visible,
      .nrc-xsearch__btn:focus-visible,
      .nrc-xsearch__modeBtn:focus-visible,
      .nrc-xsearch__meta:focus-visible,
      .nrc-xsearch__close:focus-visible {
        outline: 2px solid #1d6fdc;
        outline-offset: 1px;
      }
      .nrc-xsearch__modeBtn:focus-visible { outline-offset: -2px; }

      .nrc-xsearch__warn { margin-left: 6px; color: #b45309; font-weight: 700; }

      .nrc-xsearch__status {
        margin-top: 4px;
        font-size: 12px;
        line-height: 1.5;
        color: #333;
        max-width: 560px;
        word-break: break-all;
      }
      .nrc-xsearch__statusMain { font-weight: 700; }
      .nrc-xsearch__statusNote { color: #92400e; }

      .nrc-xsearch__panel {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        width: min(720px, 100vw - 24px);
        max-height: 240px;
        overflow: auto;
        border: 1px solid #e5e7eb;
        background: #fff;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 12px;
        color: #111;
        z-index: 9999;
        box-shadow: 0 10px 25px rgba(0,0,0,.12);
      }

      .nrc-xsearch__panelTitle { display: flex; justify-content: space-between; align-items: center; gap: 8px; }

      .nrc-xsearch__close { border: none; background: transparent; cursor: pointer; font-size: 12px; color: #666; padding: 0; }
      .nrc-xsearch__close:hover { text-decoration: underline; }

      .nrc-xsearch__panelAlert {
        margin-top: 6px;
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid #fde68a;
        background: #fffbeb;
        color: #92400e;
        font-size: 11px;
        line-height: 1.4;
      }

      .nrc-xsearch__groups { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
      .nrc-xsearch__group { border: 1px solid #eef0f3; border-radius: 10px; padding: 8px 10px; background: #fbfcfe; }
      .nrc-xsearch__groupTitle { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 12px; color: #111; margin-bottom: 8px; }
      .nrc-xsearch__groupIcon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; border-radius: 6px; border: 1px solid #e5e7eb; background: #fff; font-size: 12px; line-height: 1;
      }
      .nrc-xsearch__groupChips { display: flex; flex-wrap: wrap; gap: 6px; }

      .nrc-xsearch__chip { border: 1px solid #e5e7eb; border-radius: 999px; padding: 3px 8px; background: #fff; }
      .nrc-xsearch__chip.is-excluded { color: #6b7280; background: #f3f4f6; }
      .nrc-xsearch__chip.is-excluded .nrc-xsearch__chipLabel { text-decoration: line-through; }
      .nrc-xsearch__chipTag { margin-left: 4px; font-size: 11px; font-weight: 700; color: #92400e; }
    `;
    document.head.appendChild(style);
  }

  // =========================
  // UI 生成（生成とイベント登録は必ずセット）
  // =========================
  function buildSearchUI(root) {
    root.innerHTML = `
      <div class="nrc-xsearch" id="nrc-xsearch-wrap">
        <div class="nrc-xsearch__bar">
          <input id="nrc-xsearch-input" class="nrc-xsearch__input" type="text"
            aria-label="横断検索キーワード" placeholder="キーワードで検索（スペース区切り）" />
          <span class="nrc-xsearch__mode" role="group" aria-label="複数の検索語の組み合わせ方">
            <button id="nrc-xsearch-mode-and" class="nrc-xsearch__modeBtn" type="button" data-mode="and"
              aria-pressed="true" title="AND：すべての検索語を含むレコードを探します">AND</button>
            <button id="nrc-xsearch-mode-or" class="nrc-xsearch__modeBtn" type="button" data-mode="or"
              aria-pressed="false" title="OR：いずれかの検索語を含むレコードを探します">OR</button>
          </span>
          <button id="nrc-xsearch-btn" class="nrc-xsearch__btn nrc-xsearch__btn--primary" type="button">検索</button>
          <button id="nrc-xsearch-clear" class="nrc-xsearch__btn" type="button" hidden>クリア</button>

          <button id="nrc-xsearch-toggle" class="nrc-xsearch__meta" type="button"
            aria-expanded="false" aria-controls="nrc-xsearch-panel">
            対象：<span id="nrc-xsearch-count">0</span>件<span id="nrc-xsearch-excluded"></span>
            <span id="nrc-xsearch-warn" class="nrc-xsearch__warn" hidden>⚠︎ 一部除外</span>
          </button>
        </div>

        <div id="nrc-xsearch-status" class="nrc-xsearch__status" role="status" aria-live="polite" hidden></div>

        <div id="nrc-xsearch-panel" class="nrc-xsearch__panel" hidden>
          <div class="nrc-xsearch__panelTitle">
            <span>検索対象フィールド</span>
            <button id="nrc-xsearch-close" class="nrc-xsearch__close" type="button">閉じる</button>
          </div>
          <div id="nrc-xsearch-panelAlert" class="nrc-xsearch__panelAlert" hidden></div>
          <div id="nrc-xsearch-chips" class="nrc-xsearch__groups"></div>
        </div>
      </div>
    `;
    bindRootEvents(root);
  }

  /**
   * 検索 UI を用意する。ヘッダー内に既存の UI が残っていれば再利用し、
   * 無ければ（kintone 側でヘッダーが作り直された場合など）生成し直してイベントも登録する。
   */
  function ensureSearchUI() {
    const host = kintone.app.getHeaderMenuSpaceElement();
    if (!host) return null;

    let root = document.getElementById('nrc-xsearch-root');
    const reusable = root && host.contains(root) && root.querySelector('#nrc-xsearch-input');
    if (reusable) return root;

    if (root) root.remove();
    root = document.createElement('div');
    root.id = 'nrc-xsearch-root';
    host.appendChild(root);
    buildSearchUI(root);
    return root;
  }

  function setPanelOpen(open) {
    const panel = document.getElementById('nrc-xsearch-panel');
    const toggle = document.getElementById('nrc-xsearch-toggle');
    if (!panel) return;
    panel.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function isPanelOpen() {
    const panel = document.getElementById('nrc-xsearch-panel');
    return Boolean(panel && !panel.hidden);
  }

  // =========================
  // 検索の実行・解除
  // =========================
  function runSearch() {
    const input = document.getElementById('nrc-xsearch-input');
    if (!input || !state.config) return;

    const text = input.value || '';
    if (!text.trim()) {
      // 空で検索 = 適用中なら解除、未適用なら何もしない
      if (getRawKeywordFromUrl()) clearSearch();
      return;
    }

    const a = analyzeSearch(text, state.searchTargets, state.mode, state.config.maxTokens, state.optionsMap);
    if (!a.query) {
      // どの語も条件を作れない場合は、絞り込み無しの一覧に「検索中」と出さないよう再読込しない
      renderStatus({ pendingAnalysis: a });
      return;
    }

    setQueryAndKeywordAndReload(a.query, text, state.mode);
  }

  function clearSearch() {
    const input = document.getElementById('nrc-xsearch-input');
    if (input) input.value = '';
    setQueryAndKeywordAndReload('', '', state.mode);
  }

  function renderMode() {
    ['and', 'or'].forEach((m) => {
      const btn = document.getElementById(`nrc-xsearch-mode-${m}`);
      if (btn) btn.setAttribute('aria-pressed', state.mode === m ? 'true' : 'false');
    });
  }

  /**
   * 利用者による AND / OR の切り替え。
   * - 未検索時: 次回の検索から使う（画面は再読込しない）
   * - 検索中  : 適用中の検索語のまま新しいモードで検索し直す
   *             （トグルの状態と「検索中: … / AND|OR」の表示を常に一致させるため）
   */
  function setMode(mode) {
    const next = (mode === 'or') ? 'or' : 'and';
    if (next === state.mode) return;
    state.mode = next;
    renderMode();

    const applied = getRawKeywordFromUrl();
    if (!applied.trim() || !state.config) return;

    const a = analyzeSearch(applied, state.searchTargets, state.mode, state.config.maxTokens, state.optionsMap);
    if (a.query) setQueryAndKeywordAndReload(a.query, applied, state.mode);
  }

  function bindRootEvents(root) {
    root.addEventListener('click', (e) => {
      // 検索 UI 内のクリックは「パネル外クリック」として扱わない
      e.stopPropagation();
      const el = e.target.closest('button');
      if (!el || !root.contains(el)) return;
      if (el.dataset.mode) { setMode(el.dataset.mode); return; }
      switch (el.id) {
        case 'nrc-xsearch-btn': runSearch(); break;
        case 'nrc-xsearch-clear': clearSearch(); break;
        case 'nrc-xsearch-toggle': setPanelOpen(!isPanelOpen()); break;
        case 'nrc-xsearch-close': setPanelOpen(false); break;
        default: break;
      }
    });

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isPanelOpen()) {
        setPanelOpen(false);
        return;
      }
      if (e.target.id !== 'nrc-xsearch-input') return;
      if (e.key !== 'Enter') return;
      // 日本語入力の変換確定 Enter では検索しない
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      runSearch();
    });
  }

  // パネル外クリックで閉じる（document への登録はページで 1 回だけ）
  let outsideClickBound = false;
  function ensureOutsideClickHandler() {
    if (outsideClickBound) return;
    outsideClickBound = true;
    document.addEventListener('click', () => setPanelOpen(false));
  }

  // =========================
  // 表示の更新
  // =========================
  function joinLabel(mode) {
    return (mode === 'or') ? 'OR（いずれかを含む）' : 'AND（すべて含む）';
  }

  /**
   * 検索適用中の表示・通知を更新する。
   * opts.pendingAnalysis: 再読込せずにその場で通知だけ出す場合（条件を 1 つも作れなかったとき）
   */
  function renderStatus(opts) {
    const box = document.getElementById('nrc-xsearch-status');
    const btnClear = document.getElementById('nrc-xsearch-clear');
    if (!box || !state.config) return;

    const raw = getRawKeywordFromUrl();
    const applied = Boolean(raw.trim());
    if (btnClear) btnClear.hidden = !applied;

    const pending = opts && opts.pendingAnalysis;
    const lines = [];

    const a = pending || (applied
      ? analyzeSearch(raw, state.searchTargets, state.mode, state.config.maxTokens, state.optionsMap)
      : null);

    if (!a) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    if (!pending && a.usedTokens.length > 0) {
      lines.push(`<div class="nrc-xsearch__statusMain">検索中: ${escapeHtml(a.usedTokens.join(' '))} / ${escapeHtml(joinLabel(state.mode))}</div>`);
    }

    if (pending && a.usedTokens.length === 0) {
      lines.push('<div class="nrc-xsearch__statusNote">入力された語は、対象フィールドでは検索できませんでした（選択肢は完全一致で検索します）。</div>');
    }

    if (a.overflowTokens.length > 0) {
      lines.push(`<div class="nrc-xsearch__statusNote">検索語は最大${state.config.maxTokens}件までです。${state.config.maxTokens + 1}件目以降は検索対象になりません：${escapeHtml(a.overflowTokens.join(' '))}</div>`);
    }

    if (a.unusableTokens.length > 0 && !(pending && a.usedTokens.length === 0)) {
      lines.push(`<div class="nrc-xsearch__statusNote">一部の検索語は対象フィールドで検索できませんでした：${escapeHtml(a.unusableTokens.join(' '))}</div>`);
    }

    if (!pending && applied && Array.isArray(state.lastRecords) && state.lastRecords.length === 0) {
      lines.push(`<div>「${escapeHtml(a.usedTokens.join(' '))}」に一致するレコードはありません。</div>`);
    }

    box.innerHTML = lines.join('');
    box.hidden = lines.length === 0;
  }

  function renderTargetsInfo() {
    const config = state.config;
    if (!config) return;

    const countEl = document.getElementById('nrc-xsearch-count');
    const excludedEl = document.getElementById('nrc-xsearch-excluded');
    const warn = document.getElementById('nrc-xsearch-warn');
    const alertBox = document.getElementById('nrc-xsearch-panelAlert');
    const box = document.getElementById('nrc-xsearch-chips');

    const excludedCount = state.excludedCodes.size;
    const usableCount = (config.targets || []).filter(t => t && t.code && !state.excludedCodes.has(t.code)).length;

    if (countEl) countEl.textContent = String(usableCount);
    if (excludedEl) excludedEl.textContent = excludedCount > 0 ? `（除外${excludedCount}件）` : '';
    if (warn) warn.hidden = !state.mismatch;

    if (alertBox) {
      alertBox.hidden = !state.mismatch;
      alertBox.textContent = state.fallback
        ? '設定後にフィールドが変更されています。検索結果が正しく表示されない場合は、管理者にプラグイン設定の見直しを依頼してください。'
        : '設定後に変更されたフィールドがあるため、一部を検索対象から除外しています。';
    }

    if (!box) return;

    const snapMap = {};
    (config.fieldSnapshot || []).forEach(s => { if (s && s.code) snapMap[s.code] = s; });

    const GROUP_DEF = [
      { key: 'LIKE', icon: '🔤', title: 'テキスト（部分一致）', match: (m) => (m && m.op === 'like') && (m.type !== 'FILE') },
      { key: 'IN', icon: '🔽', title: '選択肢（完全一致）', match: (m) => (m && m.op === 'in') },
      { key: 'FILE', icon: '📎', title: '添付ファイル', match: (m) => (m && m.type === 'FILE') }
    ];

    const grouped = {};
    GROUP_DEF.forEach(g => { grouped[g.key] = []; });
    const others = [];

    (config.targets || []).forEach((t) => {
      if (!t || !t.code) return;
      const m = snapMap[t.code];
      const hit = GROUP_DEF.find(g => g.match(m));
      if (hit) grouped[hit.key].push({ t, m });
      else others.push({ t, m });
    });

    const groups = GROUP_DEF.map(g => ({ ...g, items: grouped[g.key] })).filter(g => g.items.length > 0);
    if (others.length > 0) groups.push({ key: 'OTHER', icon: '🧩', title: 'その他', items: others });

    const html = groups.map((g) => {
      const chips = g.items.map(({ t, m }) => {
        const label = m ? (m.isSubtable ? `${m.parentLabel} / ${m.label}` : m.label) : t.code;
        const excluded = state.excludedCodes.has(t.code);
        return `
          <span class="nrc-xsearch__chip${excluded ? ' is-excluded' : ''}" data-code="${escapeHtml(t.code)}" data-excluded="${excluded ? '1' : '0'}">
            <span class="nrc-xsearch__chipLabel">${escapeHtml(`${label}（${t.code}）`)}</span>${excluded ? '<span class="nrc-xsearch__chipTag">除外</span>' : ''}
          </span>
        `;
      }).join('');

      return `
        <section class="nrc-xsearch__group">
          <div class="nrc-xsearch__groupTitle">
            <span class="nrc-xsearch__groupIcon" aria-hidden="true">${escapeHtml(g.icon)}</span>
            <span>${escapeHtml(g.title)}</span>
          </div>
          <div class="nrc-xsearch__groupChips">${chips}</div>
        </section>
      `;
    }).join('');

    box.innerHTML = html || '<span class="nrc-xsearch__chip">（対象フィールドなし）</span>';
  }

  function fillKeywordIfExists() {
    const input = document.getElementById('nrc-xsearch-input');
    if (!input) return;
    const raw = getRawKeywordFromUrl();
    // 利用者が入力途中の内容は上書きしない（index.show の再発火対策）
    if (raw && !input.value) input.value = raw;
  }

  // =========================
  // スナップショットと現在のフィールド定義の照合
  // =========================
  function buildOptionsMapFromSnapshot(fieldSnapshot) {
    const map = {};
    (fieldSnapshot || []).forEach((s) => {
      if (!s || !s.code || !IN_TYPES.has(s.type)) return;
      if (Array.isArray(s.options) && s.options.length > 0) map[s.code] = s.options.slice();
    });
    return map;
  }

  async function fetchCurrentFieldMap() {
    const props = await kintone.app.getFormFields();

    const map = {}; // code -> {type, options[]}
    const put = (f) => {
      if (!f || !f.code) return;
      const type = f.type || 'UNKNOWN';
      const options = IN_TYPES.has(type)
        ? Object.keys(f.options || {}).filter(k => k !== '__proto__')
        : [];
      map[f.code] = { type, options };
    };

    Object.keys(props || {}).forEach((code) => {
      const f = props[code];
      if (!f) return;
      if (f.type === 'SUBTABLE') {
        const sub = f.fields || {};
        Object.keys(sub).forEach((subCode) => put(sub[subCode]));
        return;
      }
      put(f);
    });

    return map;
  }

  function toSet(arr) {
    return new Set((arr || []).map(x => String(x).trim()).filter(Boolean));
  }

  function validateTargetsBySnapshot(config, currentMap) {
    const snapMap = {};
    (config.fieldSnapshot || []).forEach(s => { if (s && s.code) snapMap[s.code] = s; });

    const usable = [];
    const excluded = [];

    (config.targets || []).forEach((t) => {
      if (!t || !t.code) return;

      const saved = snapMap[t.code];
      const cur = currentMap ? currentMap[t.code] : null;

      // 現在存在しない / 型が変わった
      if (!cur || !saved || saved.type !== cur.type) { excluded.push(t.code); return; }

      // 選択肢系は「保存時の選択肢が今も存在するか」を見る（追加は許容）
      if (IN_TYPES.has(saved.type)) {
        const curSet = toSet(cur.options);
        let ok = true;
        toSet(saved.options).forEach((v) => { if (!curSet.has(v)) ok = false; });
        if (!ok) { excluded.push(t.code); return; }
      }

      usable.push(t);
    });

    return { usableTargets: usable, excludedCodes: excluded };
  }

  async function runValidation(config) {
    try {
      const currentMap = await fetchCurrentFieldMap();
      const v = validateTargetsBySnapshot(config, currentMap);

      state.mismatch = v.excludedCodes.length > 0;

      if (v.usableTargets.length > 0) {
        state.searchTargets = v.usableTargets;
        state.excludedCodes = new Set(v.excludedCodes);
        state.fallback = false;
      } else {
        // 使えるフィールドが 0 件になるのは UX 的に最悪なので、設定値でフォールバック（警告は出す）
        state.searchTargets = config.targets;
        state.excludedCodes = new Set();
        state.fallback = state.mismatch;
      }
    } catch (e) {
      // 取得や比較に失敗しても検索不能にしない
      state.mismatch = false;
      state.fallback = false;
      state.excludedCodes = new Set();
      state.searchTargets = config.targets;
    }
  }

  // =========================
  // 一覧表示イベント
  // =========================
  kintone.events.on('app.record.index.show', async function (event) {
    const config = getPluginConfig();
    if (!config.targets || config.targets.length === 0) return event;

    const firstTime = !state.config;
    state.config = config;
    state.lastRecords = Array.isArray(event && event.records) ? event.records : null;

    if (firstTime) {
      // 検索モードの初期値: URL（nrc_mode）> プラグイン設定 > AND。
      // 同一ページ内の再発火では利用者の選択を維持する
      state.mode = resolveInitialMode(config);
      state.searchTargets = config.targets;
      state.optionsMap = buildOptionsMapFromSnapshot(config.fieldSnapshot);
    }

    ensureStyles();
    if (!ensureSearchUI()) return event;
    ensureOutsideClickHandler();

    // まず設定値ベースで表示（照合完了前でも検索できる）
    fillKeywordIfExists();
    renderMode();
    renderTargetsInfo();
    renderStatus();

    // 現在のフィールド定義との照合はページ内で 1 回だけ
    if (!state.validation) state.validation = runValidation(config);
    await state.validation;

    // 照合中にヘッダーが作り直された場合に備えて UI を確保し直してから反映
    if (ensureSearchUI()) {
      fillKeywordIfExists();
      renderMode();
      renderTargetsInfo();
      renderStatus();
    }

    return event;
  });

})();
