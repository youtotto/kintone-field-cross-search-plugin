/* desktop.js
 * 一覧サポート（旧: アプリ内横断検索）の一覧画面。
 * - 横断検索: 一覧画面ヘッダーのメニュー領域に検索バーを表示（v1 と同じ UI・同じ URL パラメーター）
 * - クイックフィルター / クイックボタン / 集計: 一覧の上（ヘッダー領域）に表示
 * - 条件付き装飾: 表形式の一覧の行・セルを公式 API（setRecordListStyle）で装飾
 * 検索条件は ls-core.js の readUrlState / buildNavUrl で一元管理し、標準の絞り込み（base）に
 * プラグインの条件（横断検索・クイックフィルター・クイックボタン）を AND で足して query に入れる。
 * 集計は kintone が実際に適用している条件（getQueryCondition）を使うので、表示中のレコードと必ず一致する。
 * getQueryCondition で条件を取得できないときは、標準の絞り込みを落とした query で開き直したり、絞り込みの無い範囲を
 * 集計したりしないよう、条件の変更と集計を中止して案内を出す。
 *
 * 横断検索の注意（v1 から）:
 * - 検索対象は設定時のスナップショット（fieldSnapshotJson）を正とし、現在のフィールド定義と
 *   食い違うものは検索対象から除外する（全滅時は設定値でフォールバック）
 * - app.record.index.show は同一ページ内で複数回発火しうるため、DOM 生成とイベント登録を
 *   必ずセットで行い、既存 DOM があれば再利用する
 */
(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const LS = window.NrcListSupport;

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
    fieldMap: null,           // 現在のフィールド定義（code -> {type, options, ...}）。取得失敗時は null
    lastRecords: null,
    summaryCache: null,       // { key, result } 同じ条件なら再取得しない（ページ送り・並べ替え）
    summarySeq: 0,
    pending: []               // 非同期処理（テストで完了を待つため）
  };

  // =========================
  // 設定の読み取り
  // =========================
  function getPluginConfig() {
    const ls = LS.normalizeConfig(kintone.plugin.app.getConfig(PLUGIN_ID) || {});
    return {
      ls,
      spaceJoin: ls.search.spaceJoin,       // 一覧画面を開いたときの AND / OR の初期値
      maxTokens: ls.search.maxTokens || DEFAULT_MAX_TOKENS,
      targets: ls.search.targets,           // [{code, op}]
      fieldSnapshot: ls.search.fieldSnapshot // [{code,label,type,op,isSubtable,parent...,options}]
    };
  }

  const searchEnabled = () => Boolean(state.config && state.config.ls.search.enabled && state.config.targets.length > 0);

  // =========================
  // URL（検索条件の一元管理）
  // =========================
  function urlState() {
    return LS.readUrlState(location.search);
  }

  function getRawKeywordFromUrl() {
    return urlState().active.kw;
  }

  // URL に保持された検索モード。不正な値・未指定は null（呼び出し側で設定値へフォールバック）
  function getModeFromUrl() {
    return urlState().mode;
  }

  function resolveInitialMode(config) {
    return getModeFromUrl() || (config.spaceJoin === 'or' ? 'or' : 'and');
  }

  function keywordQueryFor(kw) {
    if (!kw || !kw.trim() || !searchEnabled()) return '';
    return analyzeSearch(kw, state.searchTargets, state.mode, state.config.maxTokens, state.optionsMap).query;
  }

  function quickFilterQueryFor(values) {
    const qf = state.config && state.config.ls.quickFilter;
    if (!qf || !qf.enabled) return '';
    return LS.buildQuickFilterQuery(usableQuickFilterItems(), values, runtimeMetaMap(qf.items)).query;
  }

  function buttonQueryFor(id) {
    const qb = state.config && state.config.ls.quickButtons;
    if (!id || !qb || !qb.enabled) return '';
    const button = qb.items.find((b) => b.id === id);
    if (!button) return '';
    const r = LS.buildButtonQuery(button, runtimeMetaMap(button.metas));
    // 条件の一部しか作れないボタンは適用しない（「期限超過」が「未完了すべて」になるのを防ぐ）
    return r.invalid > 0 ? '' : r.query;
  }

  /**
   * kintone が実際に適用している条件（一覧自体の条件・標準の絞り込み・URL の query を含む。フィールドコード）。
   * 標準の絞り込みは URL の q に内部のフィールド ID で入っていて読めないため、getQueryCondition で読む。
   * 空文字列（絞り込みなし）と、取得できない（例外・null・API なし）は ls-core の readCondition で分ける。
   */
  function currentCondition() {
    const available = typeof kintone.app.getQueryCondition === 'function';
    return LS.readCondition(available ? () => kintone.app.getQueryCondition() : null);
  }

  // 条件を取得できないときの対処。理由（例外・null・API なし）によらず同じ文にし、原因は断定しない
  const CONDITION_REMEDY = '画面を再読み込みしてから、もう一度お試しください。解消しない場合は、標準の絞り込み条件を確認するか、アプリ管理者にお問い合わせください。';
  const CONDITION_ERROR = `一覧の絞り込み条件を取得できませんでした。${CONDITION_REMEDY}`;
  const SUMMARY_CONDITION_ERROR = `現在の絞り込み条件を読み取れないため、集計できません。${CONDITION_REMEDY}`;

  /**
   * いま適用されている条件（base）にプラグインの条件を足して一覧を開き直す。
   * changes: { kw, kwQuery, qf, btn, mode } のうち変えるものだけ
   * base の決め方:
   * - プラグインの条件が有効（owned）: 最初に条件を足したときに記録した base（nrc_base）を使う。いまの条件には
   *   プラグインの条件が含まれるため取り直さない。q・一覧・query が変わっていないことは署名で確かめてある
   * - 有効でない状態から条件を足す: getQueryCondition で取り直す。取得できないときは、標準の絞り込みを落とした
   *   query で開き直さないよう、URL を変えずに中止する
   * - 開き直した結果プラグインの条件が無い（解除など）: base は使わない（元の query に戻すだけ）
   * @returns {{ok:true} | {ok:false, reason:string}} ok:false のときは URL も画面の適用状態も変えていない
   */
  function navigateWith(changes) {
    const u = urlState();
    const next = { kw: u.active.kw, qf: u.active.qf, btn: u.active.btn, mode: state.mode, ...changes };
    const parts = [
      changes.kwQuery !== undefined ? changes.kwQuery : keywordQueryFor(next.kw),
      quickFilterQueryFor(next.qf),
      buttonQueryFor(next.btn)
    ];
    let base = '';
    if (u.owned) {
      base = u.base;
    } else if (parts.some((p) => (p || '').trim())) {
      const c = currentCondition();
      if (!c.ok) return { ok: false, reason: c.reason };
      base = c.condition;
    }
    const orig = u.owned ? u.orig : u.query;
    const final = LS.composeQuery([base, ...parts]);
    location.href = LS.buildNavUrl(location.href, { base, orig, final, kw: next.kw, mode: next.mode, qf: next.qf, btn: next.btn });
    return { ok: true };
  }

  const RESET_NOTICE = '標準の絞り込み（または一覧）が変わったため、一覧サポートの条件を解除して表示し直しました。';

  function setQueryAndKeywordAndReload(newQuery, rawKeyword, mode) {
    // 検索モードは検索・解除のどちらでも保持する（解除しても利用者の選択を戻さない）
    return navigateWith({ kw: rawKeyword || '', kwQuery: newQuery || '', mode: mode === 'or' ? 'or' : 'and' });
  }

  // =========================
  // 文字列処理（query用）
  // =========================
  function splitTokens(rawText) {
    const text = (rawText ?? '')
      .toString()
      .replace(/　/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return [];
    return text.split(' ').filter(Boolean);
  }

  function escapeQueryValue(value) {
    return LS.escapeQueryValue(value);
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
      .nrc-xsearch__statusError { color: #991b1b; }

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

      /* ===== 一覧サポート（ヘッダー領域） ===== */
      #nrc-ls-root [hidden] { display: none !important; }
      .nrc-ls { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 10px; font-size: 13px; color: #1f2937; }
      .nrc-ls__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
      .nrc-ls__item { display: inline-flex; align-items: center; gap: 6px; }
      .nrc-ls__label { font-size: 12px; font-weight: 700; color: #4b5563; white-space: nowrap; }
      .nrc-ls__input, .nrc-ls__select {
        box-sizing: border-box; padding: 5px 8px; border: 1px solid #d7d7d7; border-radius: 8px;
        font-size: 13px; background: #fff; color: #111; max-width: 220px;
      }
      .nrc-ls__input[type="number"] { width: 96px; }
      .nrc-ls__input[type="date"] { width: 140px; }
      .nrc-ls__tilde { color: #6b7280; }
      .nrc-ls__btn {
        appearance: none; border: 1px solid #d7d7d7; background: #fff; border-radius: 10px;
        padding: 6px 10px; cursor: pointer; font-size: 13px; line-height: 1; color: #111;
      }
      .nrc-ls__btn--primary { background: #1f2937; border-color: #1f2937; color: #fff; font-weight: 700; }
      .nrc-ls__chip {
        appearance: none; border: 1px solid #cfd4dc; background: #fff; border-radius: 999px;
        padding: 5px 12px; cursor: pointer; font-size: 13px; line-height: 1.2; color: #1f2937;
      }
      .nrc-ls__chip[aria-pressed="true"] { background: #1f2937; border-color: #1f2937; color: #fff; font-weight: 700; }
      .nrc-ls__note { font-size: 12px; color: #92400e; }
      .nrc-ls__sum { gap: 6px 10px; padding: 6px 10px; border: 1px solid #e5e7eb; border-radius: 10px; background: #f9fafb; }
      .nrc-ls__count { font-weight: 700; }
      .nrc-ls__sep { color: #9ca3af; }
      .nrc-ls__metric b { font-variant-numeric: tabular-nums; }
      .nrc-ls__muted { color: #6b7280; font-size: 12px; }
      .nrc-ls__error { color: #991b1b; font-size: 12px; }
      .nrc-ls__input:focus-visible, .nrc-ls__select:focus-visible, .nrc-ls__btn:focus-visible, .nrc-ls__chip:focus-visible {
        outline: 2px solid #1d6fdc; outline-offset: 1px;
      }
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

    const r = setQueryAndKeywordAndReload(a.query, text, state.mode);
    if (!r.ok) renderStatus({ conditionError: r });
  }

  function clearSearch() {
    const input = document.getElementById('nrc-xsearch-input');
    const typed = input ? input.value : '';
    if (input) input.value = '';
    const r = setQueryAndKeywordAndReload('', '', state.mode);
    if (!r.ok) {
      if (input) input.value = typed;
      renderStatus({ conditionError: r });
    }
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
    const prev = state.mode;
    state.mode = next;
    renderMode();

    const applied = getRawKeywordFromUrl();
    if (!applied.trim() || !state.config) return;

    const a = analyzeSearch(applied, state.searchTargets, state.mode, state.config.maxTokens, state.optionsMap);
    if (!a.query) return;
    const r = setQueryAndKeywordAndReload(a.query, applied, state.mode);
    if (!r.ok) {
      // 開き直せなかった: 適用中の検索のモードとトグルの表示を一致させるため元に戻す
      state.mode = prev;
      renderMode();
      renderStatus({ conditionError: r });
    }
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
   * opts.conditionError : 一覧の絞り込み条件を取得できずに中止したとき（navigateWith の戻り値）。
   *                       適用中の表示（検索中・クリア）は URL のまま変えず、案内だけを出す
   */
  function renderStatus(opts) {
    const box = document.getElementById('nrc-xsearch-status');
    const btnClear = document.getElementById('nrc-xsearch-clear');
    if (!box || !state.config) return;

    const raw = getRawKeywordFromUrl();
    const applied = Boolean(raw.trim());
    if (btnClear) btnClear.hidden = !applied;

    if (opts && opts.conditionError) {
      box.innerHTML = `<div class="nrc-xsearch__statusError">${escapeHtml(CONDITION_ERROR)}</div>`;
      box.hidden = false;
      return;
    }

    const pending = opts && opts.pendingAnalysis;
    const lines = [];

    const a = pending || (applied
      ? analyzeSearch(raw, state.searchTargets, state.mode, state.config.maxTokens, state.optionsMap)
      : null);

    if (!a) {
      // 標準の絞り込みを変えたためにプラグインの条件を外して開き直したときは、その旨だけを出す
      if (urlState().resetNotice) {
        box.innerHTML = `<div class="nrc-xsearch__statusNote">${escapeHtml(RESET_NOTICE)}</div>`;
        box.hidden = false;
        return;
      }
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

  function sortedOptions(f) {
    const opt = f && f.options && typeof f.options === 'object' ? f.options : {};
    return Object.keys(opt)
      .filter(k => k !== '__proto__')
      .sort((a, b) => Number((opt[a] && opt[a].index) || 0) - Number((opt[b] && opt[b].index) || 0));
  }

  async function fetchCurrentFieldMap() {
    const props = await kintone.app.getFormFields();

    const map = {}; // code -> {type, options[], label, ...}
    const put = (f, parent) => {
      if (!f || !f.code) return;
      const type = f.type || 'UNKNOWN';
      map[f.code] = {
        code: f.code,
        type,
        label: f.label || f.code,
        options: (IN_TYPES.has(type)) ? sortedOptions(f) : [],
        unit: f.unit, unitPosition: f.unitPosition, displayScale: f.displayScale, format: f.format,
        inSubtable: Boolean(parent)
      };
    };

    Object.keys(props || {}).forEach((code) => {
      const f = props[code];
      if (!f) return;
      if (f.type === 'SUBTABLE') {
        const sub = f.fields || {};
        Object.keys(sub).forEach((subCode) => put(sub[subCode], f));
        map[f.code || code] = { code: f.code || code, type: 'SUBTABLE', label: f.label, options: [] };
        return;
      }
      put(f, null);
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
      state.fieldMap = currentMap;
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
      state.fieldMap = null;
      state.mismatch = false;
      state.fallback = false;
      state.excludedCodes = new Set();
      state.searchTargets = config.targets;
    }
  }

  // =========================
  // 一覧サポート: フィールド情報
  // =========================
  /**
   * 設定時のスナップショットと現在の定義を合わせる。
   * 現在の定義が取れたときは、フィールドが無い・型が変わったものを使わない（null）。
   */
  function runtimeMeta(snapshot) {
    if (!snapshot || !snapshot.code) return null;
    if (!state.fieldMap) return snapshot;
    const cur = state.fieldMap[snapshot.code];
    if (!cur || cur.inSubtable) return null;
    if (snapshot.type && cur.type !== snapshot.type) return null;
    const merged = { ...snapshot, ...cur };
    // ステータスの選択肢は getFormFields に無いので設定時の値を使う
    if ((!cur.options || cur.options.length === 0) && Array.isArray(snapshot.options)) merged.options = snapshot.options;
    return merged;
  }

  function runtimeMetaMap(list) {
    const map = {};
    (list || []).forEach((m) => {
      const r = runtimeMeta(m);
      if (r) map[m.code] = r;
    });
    return map;
  }

  function usableQuickFilterItems() {
    const qf = state.config.ls.quickFilter;
    return qf.items.map((i) => runtimeMeta(i)).filter(Boolean);
  }

  // =========================
  // 一覧サポート: ヘッダー領域のパネル
  // =========================
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach((c) => { if (c !== null && c !== undefined) node.append(c); });
    return node;
  }

  function track(promise) {
    state.pending.push(promise);
    return promise;
  }

  /** パネルを用意する。URL（条件）が変わったら作り直す */
  function ensurePanel() {
    const host = kintone.app.getHeaderSpaceElement ? kintone.app.getHeaderSpaceElement() : null;
    if (!host) return null;
    let root = document.getElementById('nrc-ls-root');
    if (root && host.contains(root) && root.dataset.url === location.search) return root;
    if (root) root.remove();
    root = el('div', { id: 'nrc-ls-root', className: 'nrc-ls' });
    root.dataset.url = location.search;
    host.appendChild(root);
    buildPanel(root);
    return root;
  }

  function buildPanel(root) {
    const ls = state.config.ls;
    const u = urlState();

    if (u.resetNotice && !searchEnabled()) {
      root.append(el('div', { className: 'nrc-ls__row nrc-ls__note', id: 'nrc-ls-notice', role: 'status', text: RESET_NOTICE }));
    }

    if (ls.quickFilter.enabled) {
      const items = usableQuickFilterItems();
      if (items.length) root.append(buildQuickFilterRow(items, u.active.qf));
    }
    if (ls.quickButtons.enabled && ls.quickButtons.items.length) {
      root.append(buildQuickButtonsRow(ls.quickButtons.items, u.active.btn));
    }
    if (ls.summary.enabled) {
      root.append(el('div', { className: 'nrc-ls__row nrc-ls__sum', id: 'nrc-ls-summary', role: 'status', 'aria-live': 'polite' }));
    }
    bindPanelEvents(root);
  }

  // ---------- クイックフィルター ----------
  function buildQuickFilterRow(items, values) {
    const row = el('div', { className: 'nrc-ls__row nrc-ls__qf', id: 'nrc-ls-qf', role: 'search', 'aria-label': 'クイックフィルター' });
    items.forEach((meta) => {
      const g = LS.typeGroup(meta.type);
      const v = values[meta.code];
      const wrap = el('span', { className: 'nrc-ls__item', 'data-code': meta.code, 'data-group': g });
      const label = el('span', { className: 'nrc-ls__label', text: meta.label || meta.code });
      wrap.append(label);
      const aria = meta.label || meta.code;
      if (g === 'text') {
        wrap.append(el('input', { className: 'nrc-ls__input', type: 'text', 'data-part': 'value', 'aria-label': `${aria}（含む）`, placeholder: 'を含む', value: typeof v === 'string' ? v : '' }));
      } else if (g === 'select' || g === 'multi') {
        const sel = el('select', { className: 'nrc-ls__select', 'data-part': 'value', 'aria-label': aria });
        sel.append(el('option', { value: '', text: 'すべて' }));
        (meta.options || []).forEach((o) => sel.append(el('option', { value: o, text: o })));
        sel.value = typeof v === 'string' ? v : '';
        wrap.append(sel);
      } else if (g === 'number') {
        wrap.append(
          el('input', { className: 'nrc-ls__input', type: 'number', 'data-part': 'from', 'aria-label': `${aria}（下限）`, placeholder: '下限', value: v && v.from !== undefined ? v.from : '' }),
          el('span', { className: 'nrc-ls__tilde', text: '〜' }),
          el('input', { className: 'nrc-ls__input', type: 'number', 'data-part': 'to', 'aria-label': `${aria}（上限）`, placeholder: '上限', value: v && v.to !== undefined ? v.to : '' })
        );
      } else if (g === 'date' || g === 'datetime') {
        wrap.append(
          el('input', { className: 'nrc-ls__input', type: 'date', 'data-part': 'from', 'aria-label': `${aria}（開始）`, value: v && v.from ? v.from : '' }),
          el('span', { className: 'nrc-ls__tilde', text: '〜' }),
          el('input', { className: 'nrc-ls__input', type: 'date', 'data-part': 'to', 'aria-label': `${aria}（終了）`, value: v && v.to ? v.to : '' })
        );
      } else if (g === 'user') {
        const sel = el('select', { className: 'nrc-ls__select', 'data-part': 'value', 'aria-label': aria });
        sel.append(el('option', { value: '', text: 'すべて' }), el('option', { value: 'me', text: '自分' }));
        sel.value = v === 'me' ? 'me' : '';
        wrap.append(sel);
      } else {
        return;
      }
      row.append(wrap);
    });
    const active = Object.keys(values || {}).length > 0;
    row.append(
      el('button', { className: 'nrc-ls__btn nrc-ls__btn--primary', type: 'button', 'data-act': 'qf-apply', text: '絞り込む' }),
      el('button', { className: 'nrc-ls__btn', type: 'button', 'data-act': 'qf-clear', text: '解除', hidden: !active }),
      el('span', { className: 'nrc-ls__note', 'data-part': 'qf-note', role: 'status' })
    );
    return row;
  }

  function readQuickFilterValues(row) {
    const values = {};
    row.querySelectorAll('.nrc-ls__item[data-code]').forEach((wrap) => {
      const code = wrap.dataset.code;
      const g = wrap.dataset.group;
      const part = (p) => wrap.querySelector(`[data-part="${p}"]`);
      if (g === 'number' || g === 'date' || g === 'datetime') {
        const from = part('from') ? part('from').value.trim() : '';
        const to = part('to') ? part('to').value.trim() : '';
        if (from || to) values[code] = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
      } else {
        const v = part('value') ? part('value').value.trim() : '';
        if (v) values[code] = v;
      }
    });
    return values;
  }

  function applyQuickFilter(row) {
    const values = LS.cleanQuickFilterValues(readQuickFilterValues(row));
    const items = usableQuickFilterItems();
    const r = LS.buildQuickFilterQuery(items, values, runtimeMetaMap(state.config.ls.quickFilter.items));
    const note = row.querySelector('[data-part="qf-note"]');
    if (note) {
      note.textContent = '';
      note.classList.remove('nrc-ls__error');
    }
    if (r.problems.length) {
      const labels = r.problems.map((c) => (items.find((i) => i.code === c) || {}).label || c);
      if (note) note.textContent = `入力を確認してください：${labels.join('、')}`;
      return;
    }
    showRowError(row, 'qf-note', navigateWith({ qf: values }));
  }

  /** 条件を取得できずに中止したときは、操作した行に案内を出す（押した状態・「解除」の表示は URL のまま変えない） */
  function showRowError(row, part, result) {
    if (result.ok || !row) return;
    const note = row.querySelector(`[data-part="${part}"]`);
    if (!note) return;
    note.textContent = CONDITION_ERROR;
    note.classList.add('nrc-ls__error');
  }

  // ---------- クイックボタン ----------
  function buildQuickButtonsRow(buttons, activeId) {
    const row = el('div', { className: 'nrc-ls__row nrc-ls__qb', id: 'nrc-ls-qb', role: 'group', 'aria-label': 'クイックボタン' });
    buttons.forEach((b) => {
      const built = LS.buildButtonQuery(b, runtimeMetaMap(b.metas));
      const usable = Boolean(built.query) && built.invalid === 0;
      row.append(el('button', {
        className: 'nrc-ls__chip', type: 'button', 'data-act': 'qb', 'data-id': b.id,
        'aria-pressed': activeId === b.id ? 'true' : 'false',
        disabled: !usable,
        title: usable ? '' : '条件のフィールドが変更されたため使えません。管理者にプラグイン設定の見直しを依頼してください。',
        text: b.label || '（名前なし）'
      }));
    });
    row.append(el('span', { className: 'nrc-ls__note', 'data-part': 'qb-note', role: 'status' }));
    return row;
  }

  function bindPanelEvents(root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || !root.contains(btn)) return;
      const act = btn.dataset.act;
      if (act === 'qf-apply') applyQuickFilter(btn.closest('.nrc-ls__qf'));
      else if (act === 'qf-clear') showRowError(btn.closest('.nrc-ls__qf'), 'qf-note', navigateWith({ qf: {} }));
      else if (act === 'qb') {
        const active = urlState().active.btn;
        showRowError(btn.closest('.nrc-ls__qb'), 'qb-note', navigateWith({ btn: active === btn.dataset.id ? '' : btn.dataset.id }));
      }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.closest('.nrc-ls__qf') || e.target.tagName === 'BUTTON') return;
      // 日本語入力の変換確定 Enter では絞り込まない
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      applyQuickFilter(e.target.closest('.nrc-ls__qf'));
    });
  }

  // ---------- 集計 ----------
  function summaryItems() {
    const out = [];
    const notes = [];
    state.config.ls.summary.items.forEach((i) => {
      const meta = runtimeMeta(i);
      if (!meta || !LS.isNumericField(meta)) { notes.push(i.label || i.code); return; }
      out.push({ ...meta, method: i.method, label: i.label || meta.label || meta.code });
    });
    return { items: out, notes };
  }

  function renderSummaryText(row, parts) {
    row.replaceChildren(...parts);
  }

  function formatCount(n) {
    return `${LS.formatNumberDisplay(String(n), {})}件`;
  }

  function renderSummary(row, result, items, notes) {
    const parts = [el('span', { className: 'nrc-ls__count', text: formatCount(result.total) })];
    if (result.overLimit) {
      parts.push(el('span', { className: 'nrc-ls__muted', text: `（${LS.formatNumberDisplay(String(LS.SUMMARY_MAX_RECORDS), {})}件を超えるため、合計・平均は表示しません。条件を絞り込んでください）` }));
    } else {
      items.forEach((item) => {
        const acc = result.acc[item.code];
        if (!acc) return;
        const dec = LS.displayDecimals(item, acc);
        const value = item.method === 'avg' ? LS.averageString(acc, dec) : LS.sumString(acc, dec);
        parts.push(el('span', { className: 'nrc-ls__sep', text: '｜', 'aria-hidden': 'true' }));
        const metric = el('span', { className: 'nrc-ls__metric' });
        metric.append(`${item.label} ${LS.METHOD_LABELS[item.method]} `, el('b', { text: value === null ? '―' : LS.formatNumberDisplay(value, item) }));
        const extra = [];
        if (item.method === 'avg' && acc.empty) extra.push(`空欄${acc.empty}件を除く`);
        if (acc.invalid) extra.push(`数値でない値${acc.invalid}件を除く`);
        if (extra.length) metric.append(el('span', { className: 'nrc-ls__muted', text: `（${extra.join('・')}）` }));
        parts.push(metric);
      });
    }
    if (notes && notes.length) {
      parts.push(el('span', { className: 'nrc-ls__muted', text: `（集計できないフィールド：${notes.join('、')}）` }));
    }
    renderSummaryText(row, parts);
  }

  function errorMessage(e) {
    if (!e) return '不明なエラー';
    if (typeof e === 'string') return e;
    return e.message || e.code || String(e);
  }

  async function updateSummary() {
    const row = document.getElementById('nrc-ls-summary');
    if (!row) return;
    const seq = ++state.summarySeq;

    const c = currentCondition();
    if (!c.ok) {
      // 取得できない条件で集計すると、絞り込みの無い広い範囲を集計してしまう。0 件や集計結果としては出さない
      renderSummaryText(row, [el('span', { className: 'nrc-ls__error', text: SUMMARY_CONDITION_ERROR })]);
      return;
    }
    const condition = c.condition;

    const { items, notes } = summaryItems();
    const key = JSON.stringify([condition, items.map((i) => `${i.code}:${i.method}`)]);
    if (state.summaryCache && state.summaryCache.key === key) {
      renderSummary(row, state.summaryCache.result, items, notes);
      return;
    }

    renderSummaryText(row, [el('span', { className: 'nrc-ls__muted', text: '集計中…' })]);
    try {
      const result = await LS.fetchSummary({
        getRecords: (params) => kintone.api(kintone.api.url('/k/v1/records.json', true), 'GET', { app: kintone.app.getId(), ...params }),
        condition,
        items,
        onProgress: (fetched, total) => {
          if (seq !== state.summarySeq) return;
          renderSummaryText(row, [el('span', { className: 'nrc-ls__muted', text: `集計中…（${LS.formatNumberDisplay(String(fetched), {})} / ${LS.formatNumberDisplay(String(total), {})}件）` })]);
        }
      });
      if (seq !== state.summarySeq) return; // より新しい条件の集計が始まっている
      state.summaryCache = { key, result };
      renderSummary(row, result, items, notes);
    } catch (e) {
      if (seq !== state.summarySeq) return;
      renderSummaryText(row, [el('span', { className: 'nrc-ls__error', text: `集計できませんでした（${errorMessage(e)}）。` })]);
    }
  }

  // ---------- 条件付き装飾 ----------
  // setRecordListStyle で装飾できない型（公式ドキュメントの制限）
  const UNSTYLABLE_TYPES = new Set(['SUBTABLE', 'REFERENCE_TABLE', 'GROUP', 'LABEL', 'SPACER', 'HR']);

  function presetToStyle(name, type) {
    const p = LS.STYLE_PRESETS[name];
    if (!p) return null;
    const style = {};
    if (p.background) style.background = { backgroundColor: p.background };
    if ((p.color || p.bold) && type !== 'RICH_TEXT') {
      style.content = {};
      if (p.color) style.content.color = p.color;
      if (p.bold) style.content.fontWeight = 'bold';
    }
    return Object.keys(style).length ? style : null;
  }

  async function listColumns(records) {
    let fields = null;
    try {
      if (typeof kintone.app.getView === 'function') {
        const v = await kintone.app.getView();
        if (v && Array.isArray(v.fields)) fields = v.fields.slice();
      }
    } catch (e) {
      fields = null;
    }
    if (!fields) fields = Object.keys((records && records[0]) || {});
    return fields.filter((code) => {
      const m = state.fieldMap ? state.fieldMap[code] : null;
      if (state.fieldMap && !m) return code === '$id' ? false : !code.startsWith('$');
      return !(m && (m.inSubtable || UNSTYLABLE_TYPES.has(m.type)));
    });
  }

  async function applyHighlight(event) {
    const rules = state.config.ls.highlight.rules;
    const records = (event && event.records) || [];
    const metaMap = {};
    rules.forEach((r) => {
      const m = runtimeMeta({ code: r.code, type: r.type });
      if (m) metaMap[r.code] = m;
    });
    const me = typeof kintone.getLoginUser === 'function' ? kintone.getLoginUser() : null;
    const results = LS.evaluateHighlights(rules, records, metaMap, { now: new Date(), loginUserCode: me && me.code });
    const columns = await listColumns(records);

    if (typeof kintone.app.setRecordListStyle === 'function') {
      const body = results.map((r) => {
        const style = [];
        columns.forEach((code) => {
          const type = state.fieldMap && state.fieldMap[code] ? state.fieldMap[code].type : '';
          const s = presetToStyle(r.cells[code] || r.row, type);
          if (s) style.push({ columnType: 'FIELD', column: code, ...s });
        });
        if (r.row) {
          const s = presetToStyle(r.row, '');
          if (s && s.background) {
            style.push({ columnType: 'ACTION', column: 'OPEN_DETAIL', background: s.background });
            style.push({ columnType: 'ACTION', column: 'RECORD_ACTIONS', background: s.background });
          }
        }
        return { recordId: r.recordId, style };
      }).filter((b) => b.style.length > 0);
      try {
        await kintone.app.setRecordListStyle(body.length ? { body } : { body: 'DEFAULT' });
        return;
      } catch (e) {
        // 公式 API が使えない環境では、一覧のセル要素（getFieldElements）で装飾する
      }
    }
    applyHighlightByElements(results, records, columns);
  }

  function applyHighlightByElements(results, records, columns) {
    if (typeof kintone.app.getFieldElements !== 'function') return;
    const byId = {};
    results.forEach((r) => { byId[r.recordId] = r; });
    const indexToId = records.map((rec) => (rec.$id ? String(rec.$id.value) : null));
    columns.forEach((code) => {
      const cells = kintone.app.getFieldElements(code) || [];
      cells.forEach((cell, i) => {
        const r = byId[indexToId[i]];
        const name = r ? (r.cells[code] || r.row) : null;
        const p = name ? LS.STYLE_PRESETS[name] : null;
        cell.style.backgroundColor = p && p.background ? p.background : '';
        cell.style.color = p && p.color ? p.color : '';
        cell.style.fontWeight = p && p.bold ? 'bold' : '';
      });
    });
  }

  // ---------- まとめて実行 ----------
  function runListSupport(event) {
    const ls = state.config.ls;
    const viewType = event && event.viewType;
    const isTable = !viewType || viewType === 'list';
    const needPanel = ls.quickFilter.enabled || ls.quickButtons.enabled || (ls.summary.enabled && isTable);
    if (needPanel) {
      const root = ensurePanel();
      const sum = root && root.querySelector('#nrc-ls-summary');
      if (sum) sum.hidden = !isTable;
    }
    if (isTable && ls.highlight.enabled && ls.highlight.rules.length) track(applyHighlight(event).catch(() => {}));
    if (isTable && ls.summary.enabled) track(updateSummary().catch(() => {}));
  }

  // テストから非同期処理の完了を待つための入口
  window.NrcListSupportRuntime = {
    idle: () => Promise.all(state.pending.splice(0))
  };

  // =========================
  // 一覧表示イベント
  // =========================
  kintone.events.on('app.record.index.show', async function (event) {
    const config = getPluginConfig();
    const ls = config.ls;
    const searchOn = ls.search.enabled && config.targets && config.targets.length > 0;
    const lsOn = ls.quickFilter.enabled || ls.quickButtons.enabled || ls.summary.enabled || ls.highlight.enabled;
    if (!searchOn && !lsOn) return event;

    // プラグインの query が残ったまま標準の絞り込み（q）か一覧が変わった: query があると新しい絞り込みが
    // 使われないので、プラグインの条件を外して開き直す（開き直した先で「解除しました」と知らせる）
    if (urlState().reset) {
      const url = LS.buildResetUrl(location.href);
      if (typeof location.replace === 'function') location.replace(url); else location.href = url;
      return event;
    }

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
    const searchUi = searchOn ? ensureSearchUI() : null;
    if (searchUi) {
      ensureOutsideClickHandler();
      // まず設定値ベースで表示（照合完了前でも検索できる）
      fillKeywordIfExists();
      renderMode();
      renderTargetsInfo();
      renderStatus();
    }

    // 現在のフィールド定義との照合はページ内で 1 回だけ
    if (!state.validation) state.validation = runValidation(config);
    await state.validation;

    // 照合中にヘッダーが作り直された場合に備えて UI を確保し直してから反映
    if (searchOn && ensureSearchUI()) {
      fillKeywordIfExists();
      renderMode();
      renderTargetsInfo();
      renderStatus();
    }

    // 一覧サポート（集計・装飾は一覧の表示を待たせないよう非同期で進める）
    if (lsOn) runListSupport(event);

    return event;
  });

})();
