/* ls-core.js
 * 一覧サポートの共通ロジック（DOM・画面に依存しない部分）。desktop.js と config.js の両方から使う。
 * - 設定: 旧形式（横断検索 v1: spaceJoin / maxTokens / targetsJson / fieldSnapshotJson）からの移行と保存形式
 * - 検索条件: 標準の絞り込み（Base）とプラグインの条件（横断検索・クイックフィルター・クイックボタン）の合成、URL の状態
 * - 条件付き装飾: レコードの値の判定
 * - 集計: 桁落ちしない合計・平均、表示用の書式、全件取得
 * ブラウザでは window.NrcListSupport、Node（テスト）では module.exports として公開する。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NrcListSupport = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // =========================
  // 版と上限（＋版では LIMITS を差し替える想定）
  // =========================
  const EDITION = 'free';
  const LIMITS = {
    free: { quickFilter: 5, quickButtons: 5, buttonConds: 3, summary: 2, highlight: 3 }
  };
  const SUMMARY_MAX_RECORDS = 10000; // これを超える件数では合計・平均を計算しない（件数だけ出す）
  const SUMMARY_PAGE_SIZE = 500;

  // =========================
  // フィールド型の分類
  // =========================
  const TEXT_TYPES = new Set(['SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'RICH_TEXT', 'LINK']);
  const EQ_TEXT_TYPES = new Set(['SINGLE_LINE_TEXT', 'LINK']); // = / != が使える文字列
  const NUMBER_TYPES = new Set(['NUMBER', 'CALC']);
  const DATE_TYPES = new Set(['DATE']);
  const DATETIME_TYPES = new Set(['DATETIME', 'CREATED_TIME', 'UPDATED_TIME']);
  const SELECT_SINGLE_TYPES = new Set(['DROP_DOWN', 'RADIO_BUTTON', 'STATUS']);
  const SELECT_MULTI_TYPES = new Set(['CHECK_BOX', 'MULTI_SELECT']);
  const USER_TYPES = new Set(['USER_SELECT', 'CREATOR', 'MODIFIER', 'STATUS_ASSIGNEE']);

  function typeGroup(type) {
    if (TEXT_TYPES.has(type)) return 'text';
    if (NUMBER_TYPES.has(type)) return 'number';
    if (DATE_TYPES.has(type)) return 'date';
    if (DATETIME_TYPES.has(type)) return 'datetime';
    if (SELECT_SINGLE_TYPES.has(type)) return 'select';
    if (SELECT_MULTI_TYPES.has(type)) return 'multi';
    if (USER_TYPES.has(type)) return 'user';
    return null;
  }

  /** 計算フィールドは数値の表示形式のときだけ数値として扱う */
  function isNumericField(meta) {
    if (!meta) return false;
    if (meta.type === 'NUMBER') return true;
    if (meta.type === 'CALC') return !meta.format || meta.format === 'NUMBER' || meta.format === 'NUMBER_DIGIT';
    return false;
  }

  // =========================
  // 演算子（クイックボタン = クエリ、条件付き装飾 = 画面上の判定）
  // =========================
  const OP_LABELS = {
    contains: 'を含む', not_contains: 'を含まない', eq: 'と等しい', neq: 'と等しくない',
    gt: 'より大きい', gte: '以上', lt: 'より小さい', lte: '以下',
    in: 'のいずれか', not_in: 'のいずれでもない', empty: 'が空', not_empty: 'が空でない',
    me: 'が自分', not_me: 'が自分ではない'
  };
  const DATE_OP_LABELS = { eq: 'が', neq: 'が次と異なる', gt: 'が次より後', gte: 'が次以降', lt: 'が次より前', lte: 'が次以前' };

  /**
   * フィールド型ごとに使える演算子。
   * @returns {Array<{op:string,label:string,value:'text'|'number'|'date'|'options'|'none'}>}
   */
  function operatorsFor(meta) {
    const g = typeGroup(meta && meta.type);
    const list = [];
    const add = (op, value, label) => list.push({ op, value, label: label || OP_LABELS[op] });
    if (g === 'text') {
      add('contains', 'text');
      add('not_contains', 'text');
      if (EQ_TEXT_TYPES.has(meta.type)) { add('eq', 'text'); add('neq', 'text'); }
      add('empty', 'none'); add('not_empty', 'none');
    } else if (g === 'number') {
      ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].forEach((op) => add(op, 'number'));
      add('empty', 'none'); add('not_empty', 'none');
    } else if (g === 'date' || g === 'datetime') {
      ['eq', 'gt', 'gte', 'lt', 'lte'].forEach((op) => add(op, 'date', DATE_OP_LABELS[op]));
      add('empty', 'none'); add('not_empty', 'none');
    } else if (g === 'select' || g === 'multi') {
      add('in', 'options'); add('not_in', 'options');
    } else if (g === 'user') {
      add('me', 'none'); add('not_me', 'none');
    }
    return list;
  }

  // =========================
  // 日付
  // =========================
  const pad2 = (n) => String(n).padStart(2, '0');
  function localDateString(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function parseDateString(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return (d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) ? d : null;
  }
  function addDays(dateStr, n) {
    const d = parseDateString(dateStr);
    if (!d) return null;
    d.setDate(d.getDate() + Number(n || 0));
    return localDateString(d);
  }
  /** ローカル時刻の 0:00 を kintone のクエリで使える UTC 表記にする（例: 2026-09-28T15:00:00Z） */
  function localStartIso(dateStr) {
    const d = parseDateString(dateStr);
    if (!d) return null;
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** 条件の日付の値（{kind:'today',offset} / {kind:'fixed',date} / {kind:'period',period}）を日付文字列にする */
  function resolveDateValue(value, now) {
    const v = value || {};
    if (v.kind === 'fixed') return parseDateString(v.date) ? v.date : null;
    if (v.kind === 'today' || v.kind === undefined) return addDays(localDateString(now || new Date()), Number(v.offset || 0));
    return null;
  }

  const PERIODS = {
    THIS_WEEK: '今週', LAST_WEEK: '先週', NEXT_WEEK: '来週',
    THIS_MONTH: '今月', LAST_MONTH: '先月', NEXT_MONTH: '来月', THIS_YEAR: '今年'
  };

  // =========================
  // クエリ
  // =========================
  function escapeQueryValue(value) {
    return (value ?? '')
      .toString()
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, ' ')
      .trim();
  }
  const q = (v) => `"${escapeQueryValue(v)}"`;

  /** 複数の条件を AND で合成する。1 つだけならそのまま（横断検索だけの従来の query と同じ文字列になる） */
  function composeQuery(parts) {
    const ps = (parts || []).map((s) => (s || '').trim()).filter(Boolean);
    if (ps.length <= 1) return ps[0] || '';
    return ps.map((p) => `(${p})`).join(' and ');
  }

  const QUERY_OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

  function dateQueryValue(value, meta) {
    const v = value || {};
    if (v.kind === 'period') return PERIODS[v.period] ? `${v.period}()` : null;
    if (v.kind === 'fixed') {
      if (!parseDateString(v.date)) return null;
      return q(v.date);
    }
    const off = Math.trunc(Number(v.offset || 0));
    if (!Number.isFinite(off)) return null;
    return off === 0 ? 'TODAY()' : `FROM_TODAY(${off}, DAYS)`;
  }

  /**
   * 条件 1 つをクエリにする（クイックボタン用）。作れない場合は null。
   * @param {{code:string, op:string, value:any}} cond
   * @param {{type:string, options?:string[]}} meta
   */
  function buildCondClause(cond, meta) {
    if (!cond || !cond.code || !meta) return null;
    const code = cond.code;
    const g = typeGroup(meta.type);
    const op = cond.op;
    if (op === 'empty') return (g === 'text' || g === 'number' || g === 'date' || g === 'datetime') ? `${code} is empty` : null;
    if (op === 'not_empty') return (g === 'text' || g === 'number' || g === 'date' || g === 'datetime') ? `${code} is not empty` : null;

    if (g === 'text') {
      const s = String(cond.value ?? '').trim();
      if (!s) return null;
      if (op === 'contains') return `${code} like ${q(s)}`;
      if (op === 'not_contains') return `${code} not like ${q(s)}`;
      if ((op === 'eq' || op === 'neq') && EQ_TEXT_TYPES.has(meta.type)) return `${code} ${QUERY_OPS[op]} ${q(s)}`;
      return null;
    }
    if (g === 'number') {
      const n = normalizeNumberInput(cond.value);
      if (n === null || !QUERY_OPS[op]) return null;
      return `${code} ${QUERY_OPS[op]} ${n}`;
    }
    if (g === 'date' || g === 'datetime') {
      const val = dateQueryValue(cond.value, meta);
      if (!val || !QUERY_OPS[op]) return null;
      if (cond.value && cond.value.kind === 'period' && op !== 'eq') return null; // 期間は「が（期間内）」だけ
      return `${code} ${QUERY_OPS[op]} ${val}`;
    }
    if (g === 'select' || g === 'multi') {
      const vals = (Array.isArray(cond.value) ? cond.value : []).map(String).filter((x) => x !== '');
      const opts = Array.isArray(meta.options) ? meta.options : null;
      const usable = opts && opts.length ? vals.filter((x) => opts.includes(x)) : vals;
      if (usable.length === 0) return null;
      const list = usable.map(q).join(', ');
      if (op === 'in') return `${code} in (${list})`;
      if (op === 'not_in') return `${code} not in (${list})`;
      return null;
    }
    if (g === 'user') {
      if (op === 'me') return `${code} in (LOGINUSER())`;
      if (op === 'not_me') return `${code} not in (LOGINUSER())`;
      return null;
    }
    return null;
  }

  /** クイックボタン 1 つ分のクエリ（条件はすべて AND） */
  function buildButtonQuery(button, metaMap) {
    if (!button || !Array.isArray(button.conds)) return { query: '', invalid: 0 };
    let invalid = 0;
    const clauses = [];
    button.conds.forEach((c) => {
      const clause = buildCondClause(c, metaMap ? metaMap[c && c.code] : null);
      if (clause) clauses.push(clause); else invalid += 1;
    });
    return { query: composeQuery(clauses), invalid };
  }

  function normalizeNumberInput(v) {
    const s = String(v ?? '').trim().replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,，]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return s;
  }

  /**
   * クイックフィルターの入力値をクエリにする。
   * values: { [code]: string | {from,to} | 'me' }
   * @returns {{query:string, applied:string[], problems:string[]}}
   */
  function buildQuickFilterQuery(items, values, metaMap) {
    const clauses = [];
    const applied = [];
    const problems = [];
    (items || []).forEach((item) => {
      const code = item && item.code;
      if (!code || !values || values[code] === undefined || values[code] === null || values[code] === '') return;
      const meta = (metaMap && metaMap[code]) || item;
      const g = typeGroup(meta.type);
      const v = values[code];
      const before = clauses.length;
      if (g === 'text') {
        const s = String(v).trim();
        if (s) clauses.push(`${code} like ${q(s)}`);
      } else if (g === 'select' || g === 'multi') {
        const s = String(v);
        const opts = Array.isArray(meta.options) ? meta.options : [];
        if (opts.length && !opts.includes(s)) problems.push(code);
        else clauses.push(`${code} in (${q(s)})`);
      } else if (g === 'number') {
        const from = normalizeNumberInput(v && v.from);
        const to = normalizeNumberInput(v && v.to);
        if (v && v.from !== undefined && v.from !== '' && from === null) problems.push(code);
        if (v && v.to !== undefined && v.to !== '' && to === null) problems.push(code);
        if (from !== null) clauses.push(`${code} >= ${from}`);
        if (to !== null) clauses.push(`${code} <= ${to}`);
      } else if (g === 'date') {
        if (v && v.from && parseDateString(v.from)) clauses.push(`${code} >= ${q(v.from)}`);
        if (v && v.to && parseDateString(v.to)) clauses.push(`${code} <= ${q(v.to)}`);
      } else if (g === 'datetime') {
        // 日時は利用者の端末の日付の 0:00 〜 翌日 0:00 未満で比較する
        if (v && v.from && parseDateString(v.from)) clauses.push(`${code} >= ${q(localStartIso(v.from))}`);
        if (v && v.to && parseDateString(v.to)) clauses.push(`${code} < ${q(localStartIso(addDays(v.to, 1)))}`);
      } else if (g === 'user') {
        if (v === 'me') clauses.push(`${code} in (LOGINUSER())`);
      }
      if (clauses.length > before) applied.push(code);
    });
    return { query: clauses.join(' and '), applied, problems };
  }

  /** クイックフィルターの値から空のものを除く（URL を短く保つ） */
  function cleanQuickFilterValues(values) {
    const out = {};
    Object.keys(values || {}).forEach((code) => {
      const v = values[code];
      if (v === undefined || v === null) return;
      if (typeof v === 'string') { if (v.trim() !== '') out[code] = v.trim(); return; }
      if (typeof v === 'object') {
        const r = {};
        if (v.from !== undefined && String(v.from).trim() !== '') r.from = String(v.from).trim();
        if (v.to !== undefined && String(v.to).trim() !== '') r.to = String(v.to).trim();
        if (Object.keys(r).length) out[code] = r;
      }
    });
    return out;
  }

  // =========================
  // URL の状態（検索条件の一元管理）
  // =========================
  // kintone の一覧の URL（公式に記載があるのは query と view だけ。q は実機・公開事例での観測）:
  //   q         : 標準の絞り込み（漏斗アイコン）。フィールドコードではなく内部のフィールド ID で書かれる
  //   query     : フィールドコードで書く条件。query があると q（標準の絞り込み）は使われない
  //               （2.0.0 MVP の実機テストで「標準の絞り込み＋横断検索」が期待 20 件に対し 30 件になった結果からの推定）
  // このため、プラグインの条件を足すときは、kintone が実際に適用している条件（getQueryCondition）を base として
  // query に含める。プラグインの条件をすべて外したら query を消し、q（標準の絞り込み）をそのまま生かす。
  //
  // プラグインが使うパラメーター:
  //   nrc_q / nrc_mode : 横断検索の入力語と AND / OR（v1 から同じ名前）
  //   nrc_qf           : クイックフィルターの値（JSON）
  //   nrc_btn          : 選択中のクイックボタン
  //   nrc_base         : プラグインが条件を足す前に適用されていた条件（フィールドコード）
  //   nrc_orig         : プラグインが条件を足す前の query（外部リンクなどで付いていたもの。無ければ空）
  //   nrc_sig          : プラグインが作った query の署名
  //   nrc_qsig / nrc_view : そのときの q の署名と一覧 ID。変わっていたら、利用者が標準の絞り込みか一覧を変えたとみなす
  //   nrc_reset        : 上の理由でプラグインの条件を外して開き直したことを知らせる印
  const PARAMS = {
    query: 'query', stdq: 'q', view: 'view',
    kw: 'nrc_q', mode: 'nrc_mode', qf: 'nrc_qf', btn: 'nrc_btn',
    base: 'nrc_base', orig: 'nrc_orig', sig: 'nrc_sig', qsig: 'nrc_qsig', vsig: 'nrc_view', reset: 'nrc_reset'
  };
  const PLUGIN_STATE_PARAMS = ['kw', 'qf', 'btn', 'base', 'orig', 'sig', 'qsig', 'vsig'];

  /** 署名の前に空白の違いをならす（kintone が再エンコードしても同じ署名になるように） */
  function normalizeForSig(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /** FNV-1a 32bit（署名用。暗号用途ではない） */
  function hashQuery(s) {
    let h = 0x811c9dc5;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function parseJsonObject(str) {
    try {
      const v = str ? JSON.parse(str) : {};
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) {
      return {};
    }
  }

  /**
   * URL から、プラグインが条件を足す前の条件（base）とプラグインの条件を読み分ける。
   * - owned : プラグインが作った query がそのまま適用されている（プラグインの条件が有効）
   * - legacy: v1.0.1 の URL（nrc_q だけ。v1 は標準の絞り込みを置き換えていたので base は空）
   * - reset : プラグインの query が残ったまま、利用者が標準の絞り込み（q）か一覧を変えた。
   *           query があると新しい q が使われないので、プラグインの条件を外して開き直す必要がある
   * - stale : query 自体が変わった（外部リンクなど）。いまの条件を新しい base とする
   * base はプラグインの条件が無いときは URL の query。ただし owned でないときに条件を足す呼び出し側は、標準の絞り込みを
   * 含む getQueryCondition を使い、取得できなければ条件を変えない（URL の query だけでは標準の絞り込みが落ちるため）
   */
  function readUrlState(search) {
    const p = new URLSearchParams(search || '');
    const query = p.get(PARAMS.query) || '';
    const stdq = p.get(PARAMS.stdq) || '';
    const view = p.get(PARAMS.view) || '';
    const kw = p.get(PARAMS.kw) || '';
    const qf = cleanQuickFilterValues(parseJsonObject(p.get(PARAMS.qf)));
    const btn = p.get(PARAMS.btn) || '';
    const sig = p.get(PARAMS.sig) || '';
    const qsig = p.get(PARAMS.qsig);   // null = 2.0.0 MVP の URL（記録なし）
    const vsig = p.get(PARAMS.vsig);
    const modeRaw = p.get(PARAMS.mode);
    const mode = (modeRaw === 'and' || modeRaw === 'or') ? modeRaw : null;

    let base = query;
    let orig = query;
    let owned = false;
    let legacy = false;
    let stale = false;
    let reset = false;
    if (sig) {
      const sigOk = sig === hashQuery(normalizeForSig(query));
      const qOk = qsig === null || qsig === hashQuery(normalizeForSig(stdq));
      // kintone が後から view を付けることがあるので、両方あって違うときだけ「一覧を変えた」とみなす
      const viewOk = !vsig || !view || vsig === view;
      if (sigOk && qOk && viewOk) {
        owned = true;
        base = p.get(PARAMS.base) || '';
        orig = p.get(PARAMS.orig) || '';
      } else if (sigOk && query) {
        reset = true;
      } else {
        stale = true;
      }
    } else if (kw) {
      owned = true; legacy = true; base = ''; orig = '';
    }
    const active = owned ? { kw, qf, btn } : { kw: '', qf: {}, btn: '' };
    return {
      query, stdq, view, base, orig, active, owned, legacy, stale, reset, mode,
      resetNotice: p.get(PARAMS.reset) === '1'
    };
  }

  /**
   * 遷移先の URL を作る。
   * next: { base, orig, final, kw, mode, qf, btn }
   *   base : プラグインが条件を足す前に適用されていた条件（final に含まれている）
   *   orig : プラグインが条件を足す前の URL の query（プラグインの条件をすべて外したときに戻す）
   */
  function buildNavUrl(href, next) {
    const url = new URL(href);
    const p = url.searchParams;
    p.set(PARAMS.mode, next.mode === 'or' ? 'or' : 'and');

    const kw = (next.kw || '').trim() ? next.kw : '';
    if (kw) p.set(PARAMS.kw, kw); else p.delete(PARAMS.kw);
    const qf = cleanQuickFilterValues(next.qf);
    if (Object.keys(qf).length) p.set(PARAMS.qf, JSON.stringify(qf)); else p.delete(PARAMS.qf);
    if (next.btn) p.set(PARAMS.btn, next.btn); else p.delete(PARAMS.btn);

    const final = (next.final || '').trim();
    const pluginActive = Boolean(kw || next.btn || Object.keys(qf).length) && Boolean(final);
    if (pluginActive) {
      p.set(PARAMS.query, final);
      if (next.base) p.set(PARAMS.base, next.base); else p.delete(PARAMS.base);
      if (next.orig) p.set(PARAMS.orig, next.orig); else p.delete(PARAMS.orig);
      p.set(PARAMS.sig, hashQuery(normalizeForSig(final)));
      p.set(PARAMS.qsig, hashQuery(normalizeForSig(p.get(PARAMS.stdq))));
      p.set(PARAMS.vsig, p.get(PARAMS.view) || '');
    } else {
      // プラグインの条件が無い: 元の query（外部リンクなど）だけを戻す。標準の絞り込み（q）には触れない
      if (next.orig) p.set(PARAMS.query, next.orig); else p.delete(PARAMS.query);
      ['base', 'orig', 'sig', 'qsig', 'vsig'].forEach((k) => p.delete(PARAMS[k]));
    }
    p.delete(PARAMS.reset);
    p.delete('offset');
    url.search = p.toString();
    return url.toString();
  }

  /** プラグインの条件（query と nrc_*）を外し、標準の絞り込み（q）と一覧（view）だけで開き直す URL */
  function buildResetUrl(href) {
    const url = new URL(href);
    const p = url.searchParams;
    p.delete(PARAMS.query);
    PLUGIN_STATE_PARAMS.forEach((k) => p.delete(PARAMS[k]));
    p.set(PARAMS.reset, '1');
    p.delete('offset');
    url.search = p.toString();
    return url.toString();
  }

  /**
   * kintone が実際に適用している条件（getQueryCondition）を読む。
   * 空文字列は「絞り込みなし」として取得できた扱い。例外（削除されたユーザー・組織・グループ・選択肢・ステータスを
   * 含む条件）と、文字列以外（一覧画面以外で返る null など）は「取得できない」として分ける。
   * @param {(() => any) | null} get  getQueryCondition を呼ぶ関数（API が無ければ null）
   * @returns {{ok:true, condition:string} | {ok:false, reason:'unavailable'|'error'|'invalid', error?:any}}
   */
  function readCondition(get) {
    if (typeof get !== 'function') return { ok: false, reason: 'unavailable' };
    try {
      const c = get();
      if (typeof c === 'string') return { ok: true, condition: c };
      return { ok: false, reason: 'invalid' };
    } catch (e) {
      return { ok: false, reason: 'error', error: e };
    }
  }

  // =========================
  // 条件付き装飾（画面上での判定）
  // =========================
  function toNumber(v) {
    const s = normalizeNumberInput(v);
    return s === null ? null : Number(s);
  }

  function userCodes(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map((u) => u && u.code).filter(Boolean);
    return value.code ? [value.code] : [];
  }

  /**
   * 1 件のレコードが条件に合うか。判定できない（フィールドが無い等）ときは false。
   * @param {{code:string, op:string, value:any}} cond
   * @param {object} record  kintone のレコード（{code:{type,value}}）
   * @param {{type:string}} meta
   * @param {{now?:Date, loginUserCode?:string}} ctx
   */
  function evaluateCond(cond, record, meta, ctx) {
    if (!cond || !record || !meta) return false;
    const f = record[cond.code];
    if (!f) return false;
    const g = typeGroup(meta.type);
    const op = cond.op;
    const raw = f.value;
    const c = ctx || {};

    const isEmptyValue = Array.isArray(raw) ? raw.length === 0 : (raw === null || raw === undefined || String(raw) === '');
    if (op === 'empty') return isEmptyValue;
    if (op === 'not_empty') return !isEmptyValue;

    if (g === 'text') {
      const s = String(raw ?? '');
      const needle = String(cond.value ?? '').trim();
      if (!needle && (op === 'contains' || op === 'not_contains')) return false;
      const plain = meta.type === 'RICH_TEXT' ? s.replace(/<[^>]*>/g, '') : s;
      if (op === 'contains') return plain.toLowerCase().includes(needle.toLowerCase());
      if (op === 'not_contains') return !plain.toLowerCase().includes(needle.toLowerCase());
      if (op === 'eq') return plain === needle;
      if (op === 'neq') return plain !== needle;
      return false;
    }
    if (g === 'number') {
      if (isEmptyValue) return false;
      const a = toNumber(raw);
      const b = toNumber(cond.value);
      if (a === null || b === null) return false;
      return compare(a, b, op);
    }
    if (g === 'date') {
      if (isEmptyValue) return false;
      const target = resolveDateValue(cond.value, c.now);
      if (!target || !parseDateString(raw)) return false;
      return compare(String(raw), target, op);
    }
    if (g === 'datetime') {
      if (isEmptyValue) return false;
      const target = resolveDateValue(cond.value, c.now);
      const t = Date.parse(raw);
      if (!target || !Number.isFinite(t)) return false;
      const start = parseDateString(target).getTime();
      const end = parseDateString(addDays(target, 1)).getTime();
      if (op === 'eq') return t >= start && t < end;
      if (op === 'neq') return t < start || t >= end;
      if (op === 'gt') return t >= end;
      if (op === 'gte') return t >= start;
      if (op === 'lt') return t < start;
      if (op === 'lte') return t < end;
      return false;
    }
    if (g === 'select') {
      const vals = Array.isArray(cond.value) ? cond.value.map(String) : [];
      if (op === 'in') return vals.includes(String(raw ?? ''));
      if (op === 'not_in') return !vals.includes(String(raw ?? ''));
      return false;
    }
    if (g === 'multi') {
      const vals = Array.isArray(cond.value) ? cond.value.map(String) : [];
      const have = Array.isArray(raw) ? raw.map(String) : [];
      const any = have.some((x) => vals.includes(x));
      if (op === 'in') return any;
      if (op === 'not_in') return !any;
      return false;
    }
    if (g === 'user') {
      const me = c.loginUserCode;
      if (!me) return false;
      const has = userCodes(raw).includes(me);
      if (op === 'me') return has;
      if (op === 'not_me') return !has;
      return false;
    }
    return false;
  }

  function compare(a, b, op) {
    if (op === 'eq') return a === b;
    if (op === 'neq') return a !== b;
    if (op === 'gt') return a > b;
    if (op === 'gte') return a >= b;
    if (op === 'lt') return a < b;
    if (op === 'lte') return a <= b;
    return false;
  }

  // 装飾の見本（背景は淡色、文字は既定の濃い色のまま読める組み合わせ）
  const STYLE_PRESETS = {
    danger: { label: '赤（警告）', background: '#FDE2E1' },
    warning: { label: '黄（注意）', background: '#FEF3C7' },
    info: { label: '青（情報）', background: '#DBEAFE' },
    success: { label: '緑（完了）', background: '#DCFCE7' },
    muted: { label: 'グレー（目立たせない）', background: '#F1F2F4', color: '#6B7280' },
    redText: { label: '赤字・太字', color: '#B91C1C', bold: true },
    bold: { label: '太字のみ', bold: true }
  };

  /**
   * 表示中のレコードに装飾ルールを当てはめる。
   * 行ルールは最初に一致したもの、セルルールは列ごとに最初に一致したものを使う。
   * @returns {Array<{recordId:string, row:string|null, cells:Object<string,string>}>} style はプリセット名
   */
  function evaluateHighlights(rules, records, metaMap, ctx) {
    const out = [];
    (records || []).forEach((rec) => {
      const idField = rec && (rec.$id || rec['$id']);
      const recordId = idField ? String(idField.value) : null;
      if (!recordId) return;
      let row = null;
      const cells = {};
      (rules || []).forEach((rule) => {
        if (!rule || !STYLE_PRESETS[rule.style]) return;
        const meta = metaMap ? metaMap[rule.code] : null;
        if (!evaluateCond(rule, rec, meta, ctx)) return;
        if (rule.target === 'cell') { if (!cells[rule.code]) cells[rule.code] = rule.style; }
        else if (!row) row = rule.style;
      });
      if (row || Object.keys(cells).length) out.push({ recordId, row, cells });
    });
    return out;
  }

  // =========================
  // 集計（桁落ちしない合計・平均）
  // =========================
  /** 数値文字列を「整数（BigInt）× 10^-scale」に分解する。数値でなければ null */
  function parseDecimal(str) {
    const s = String(str ?? '').trim();
    const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return null;
    const frac = m[3] || '';
    const int = BigInt(m[2] + frac) * (m[1] ? -1n : 1n);
    return { int, scale: frac.length };
  }

  function createAccumulator() {
    return { sum: 0n, scale: 0, count: 0, empty: 0, invalid: 0 };
  }

  function accumulate(acc, str) {
    const s = String(str ?? '').trim();
    if (s === '') { acc.empty += 1; return acc; }
    const p = parseDecimal(s);
    if (!p) { acc.invalid += 1; return acc; }
    if (p.scale > acc.scale) {
      acc.sum *= 10n ** BigInt(p.scale - acc.scale);
      acc.scale = p.scale;
    }
    acc.sum += p.int * 10n ** BigInt(acc.scale - p.scale);
    acc.count += 1;
    return acc;
  }

  /** scaled（BigInt）を小数点以下 decimals 桁の文字列にする（四捨五入） */
  function scaledToString(value, scale, decimals) {
    let v = value;
    let sc = scale;
    if (decimals < sc) {
      const div = 10n ** BigInt(sc - decimals);
      const neg = v < 0n;
      const abs = neg ? -v : v;
      let q2 = abs / div;
      if ((abs % div) * 2n >= div) q2 += 1n;
      v = neg ? -q2 : q2;
      sc = decimals;
    } else if (decimals > sc) {
      v *= 10n ** BigInt(decimals - sc);
      sc = decimals;
    }
    const neg = v < 0n;
    let digits = (neg ? -v : v).toString();
    if (sc > 0) {
      digits = digits.padStart(sc + 1, '0');
      digits = `${digits.slice(0, -sc)}.${digits.slice(-sc)}`;
    }
    return (neg && /[1-9]/.test(digits) ? '-' : '') + digits;
  }

  function sumString(acc, decimals) {
    return scaledToString(acc.sum, acc.scale, decimals === undefined ? acc.scale : decimals);
  }

  function averageString(acc, decimals) {
    if (!acc.count) return null;
    const d = decimals === undefined ? acc.scale : decimals;
    // sum / count を d 桁で四捨五入: (sum * 10^(d+1) / count) を 1 桁余分に計算してから丸める
    const extra = 10n ** BigInt(d + 1);
    const scaledSum = acc.sum * extra; // 小数点以下 acc.scale + d + 1 桁
    const q2 = scaledSum / BigInt(acc.count);
    return scaledToString(q2, acc.scale + d + 1, d);
  }

  /** 表示用の桁数: フィールドの小数点以下の表示桁数があればそれ、無ければデータの桁数 */
  function displayDecimals(meta, acc) {
    const ds = meta && meta.displayScale !== undefined && meta.displayScale !== null && String(meta.displayScale) !== ''
      ? Number(meta.displayScale) : null;
    if (Number.isInteger(ds) && ds >= 0 && ds <= 10) return ds;
    return Math.min(acc ? acc.scale : 0, 10);
  }

  /** 桁区切りと単位を付ける（集計行では桁区切りを常に表示する） */
  function formatNumberDisplay(str, meta) {
    if (str === null || str === undefined) return '―';
    const s = String(str);
    const neg = s.startsWith('-');
    const [ip, fp] = (neg ? s.slice(1) : s).split('.');
    const grouped = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const num = `${neg ? '-' : ''}${grouped}${fp !== undefined ? `.${fp}` : ''}`;
    const unit = meta && meta.unit ? String(meta.unit) : '';
    if (!unit) return num;
    return meta.unitPosition === 'BEFORE' ? `${unit}${num}` : `${num}${unit}`;
  }

  const METHOD_LABELS = { sum: '合計', avg: '平均' };

  /**
   * 条件に一致するレコードを $id 順に全件たどって集計する（offset の 1 万件上限を避けるため $id で送る）。
   * @param {object} o
   * @param {(params:object)=>Promise<{records:object[], totalCount?:string}>} o.getRecords  GET /k/v1/records.json
   * @param {string} o.condition  kintone.app.getQueryCondition() の値（空文字列＝絞り込みなし）
   * @param {Array<{code:string, method:string}>} o.items
   * @param {number} [o.max]
   * @param {(fetched:number,total:number)=>void} [o.onProgress]
   * @returns {Promise<{total:number, fetched:number, overLimit:boolean, acc:Object<string,object>}>}
   */
  async function fetchSummary(o) {
    // 条件を取得できないまま集計すると絞り込みの無い全件を集計してしまうので、文字列以外は受け付けない
    if (typeof o.condition !== 'string') throw new Error('絞り込み条件を取得できないため、集計できません。');
    const max = o.max || SUMMARY_MAX_RECORDS;
    const size = o.pageSize || SUMMARY_PAGE_SIZE;
    const codes = Array.from(new Set((o.items || []).map((i) => i.code).filter(Boolean)));
    const where = o.condition.trim();
    const acc = {};
    codes.forEach((c) => { acc[c] = createAccumulator(); });

    const first = await o.getRecords({
      query: `${where ? `(${where}) ` : ''}order by $id asc limit ${codes.length ? size : 1}`,
      fields: ['$id', ...codes],
      totalCount: true
    });
    const total = Number(first && first.totalCount);
    if (!Number.isFinite(total)) throw new Error('件数を取得できませんでした。');
    if (codes.length === 0) return { total, fetched: 0, overLimit: false, acc };
    if (total > max) return { total, fetched: 0, overLimit: true, acc };

    let fetched = 0;
    let records = (first && first.records) || [];
    for (;;) {
      if (records.length === 0) break;
      records.forEach((r) => codes.forEach((c) => accumulate(acc[c], r[c] ? r[c].value : '')));
      fetched += records.length;
      if (o.onProgress) o.onProgress(fetched, total);
      if (records.length < size || fetched >= total) break;
      if (fetched > max) break; // 途中で件数が増えた場合の安全弁
      const lastId = records[records.length - 1].$id.value;
      const res = await o.getRecords({
        query: `${where ? `(${where}) and ` : ''}$id > ${Number(lastId)} order by $id asc limit ${size}`,
        fields: ['$id', ...codes]
      });
      records = (res && res.records) || [];
    }
    return { total, fetched, overLimit: false, acc };
  }

  // =========================
  // 設定（v1 からの移行と保存形式）
  // =========================
  const DEFAULT_MAX_TOKENS = 5;

  function parseJsonArray(str) {
    try {
      const v = str ? JSON.parse(str) : [];
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  const str = (v, max = 200) => String(v ?? '').slice(0, max);
  let idSeq = 0;
  function newId(prefix) {
    idSeq += 1;
    return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`;
  }

  function sanitizeCond(c) {
    if (!c || typeof c !== 'object' || !c.code || !c.op) return null;
    const out = { code: str(c.code), op: str(c.op, 20) };
    const v = c.value;
    if (Array.isArray(v)) out.value = v.map((x) => str(x)).slice(0, 50);
    else if (v && typeof v === 'object') {
      out.value = {};
      if (v.kind) out.value.kind = str(v.kind, 20);
      if (v.offset !== undefined) out.value.offset = Math.trunc(Number(v.offset)) || 0;
      if (v.date) out.value.date = str(v.date, 10);
      if (v.period) out.value.period = str(v.period, 20);
    } else if (v !== undefined && v !== null) out.value = str(v);
    return out;
  }

  function sanitizeFieldRef(item) {
    if (!item || !item.code) return null;
    const out = { code: str(item.code), label: str(item.label || item.code), type: str(item.type || '', 40) };
    if (Array.isArray(item.options)) out.options = item.options.map((x) => str(x)).slice(0, 500);
    ['unit', 'unitPosition', 'displayScale', 'format'].forEach((k) => {
      if (item[k] !== undefined && item[k] !== null) out[k] = str(item[k], 40);
    });
    return out;
  }

  /**
   * 保存値（getConfig の戻り値）を、画面で使う形に正規化する。
   * lsConfig が無い＝横断検索 v1 の設定なので、横断検索だけを有効にして引き継ぐ。
   */
  function normalizeConfig(raw, edition) {
    const cfg = raw || {};
    const lim = LIMITS[edition || EDITION];
    const maxTokens = Number(cfg.maxTokens);
    const targets = parseJsonArray(cfg.targetsJson).filter((t) => t && t.code);
    const search = {
      enabled: true,
      spaceJoin: cfg.spaceJoin === 'or' ? 'or' : 'and',
      maxTokens: (Number.isFinite(maxTokens) && maxTokens >= 1 && maxTokens <= 10) ? maxTokens : DEFAULT_MAX_TOKENS,
      targets,
      fieldSnapshot: parseJsonArray(cfg.fieldSnapshotJson)
    };

    const hasLegacy = ['spaceJoin', 'maxTokens', 'targetsJson', 'fieldSnapshotJson'].some((k) => cfg[k] !== undefined);
    let ls = null;
    if (cfg.lsConfig) {
      try { ls = JSON.parse(cfg.lsConfig); } catch (e) { ls = null; }
    }

    const out = {
      version: 2,
      edition: edition || EDITION,
      migratedFrom: null,
      search,
      quickFilter: { enabled: false, items: [] },
      quickButtons: { enabled: false, items: [] },
      summary: { enabled: false, items: [] },
      highlight: { enabled: false, rules: [] }
    };

    if (!ls || typeof ls !== 'object') {
      // v1（横断検索のみ）: 設定済みなら横断検索を有効のまま引き継ぐ
      out.search.enabled = hasLegacy ? targets.length > 0 : true;
      out.migratedFrom = hasLegacy ? 'v1' : null;
      return out;
    }

    out.search.enabled = !(ls.search && ls.search.enabled === false);

    const qf = ls.quickFilter || {};
    out.quickFilter.enabled = Boolean(qf.enabled);
    out.quickFilter.items = (Array.isArray(qf.items) ? qf.items : []).map(sanitizeFieldRef).filter(Boolean).slice(0, lim.quickFilter);

    const qb = ls.quickButtons || {};
    out.quickButtons.enabled = Boolean(qb.enabled);
    out.quickButtons.items = (Array.isArray(qb.items) ? qb.items : []).map((b) => {
      if (!b) return null;
      const conds = (Array.isArray(b.conds) ? b.conds : []).map(sanitizeCond).filter(Boolean).slice(0, lim.buttonConds);
      const metas = (Array.isArray(b.metas) ? b.metas : []).map(sanitizeFieldRef).filter(Boolean);
      return { id: str(b.id || newId('b'), 40), label: str(b.label, 40), conds, metas };
    }).filter(Boolean).slice(0, lim.quickButtons);

    const sm = ls.summary || {};
    out.summary.enabled = Boolean(sm.enabled);
    out.summary.items = (Array.isArray(sm.items) ? sm.items : []).map((i) => {
      const f = sanitizeFieldRef(i);
      if (!f) return null;
      f.method = i.method === 'avg' ? 'avg' : 'sum';
      return f;
    }).filter(Boolean).slice(0, lim.summary);

    const hl = ls.highlight || {};
    out.highlight.enabled = Boolean(hl.enabled);
    out.highlight.rules = (Array.isArray(hl.rules) ? hl.rules : []).map((r) => {
      const c = sanitizeCond(r);
      if (!c) return null;
      c.id = str(r.id || newId('h'), 40);
      c.target = r.target === 'cell' ? 'cell' : 'row';
      c.style = STYLE_PRESETS[r.style] ? r.style : 'warning';
      c.type = str(r.type || '', 40);
      return c;
    }).filter(Boolean).slice(0, lim.highlight);

    return out;
  }

  /**
   * 画面の設定を保存形式にする。横断検索 v1 と同じキーはそのまま残し（旧版へ戻しても動く）、
   * 一覧サポートの設定は lsConfig に JSON で追加する。
   */
  function toSavedConfig(cfg) {
    const s = cfg.search;
    const ls = {
      version: 2,
      search: { enabled: Boolean(s.enabled) },
      quickFilter: { enabled: Boolean(cfg.quickFilter.enabled), items: cfg.quickFilter.items },
      quickButtons: { enabled: Boolean(cfg.quickButtons.enabled), items: cfg.quickButtons.items },
      summary: { enabled: Boolean(cfg.summary.enabled), items: cfg.summary.items },
      highlight: { enabled: Boolean(cfg.highlight.enabled), rules: cfg.highlight.rules }
    };
    return {
      spaceJoin: s.spaceJoin === 'or' ? 'or' : 'and',
      maxTokens: String(Number(s.maxTokens) || DEFAULT_MAX_TOKENS),
      targetsJson: JSON.stringify(s.targets || []),
      fieldSnapshotJson: JSON.stringify(s.fieldSnapshot || []),
      lsConfig: JSON.stringify(ls)
    };
  }

  /** クイックボタン・装飾の条件が参照するフィールドの型情報（設定時のスナップショット）を code→meta にする */
  function metaMapFrom(list) {
    const map = {};
    (list || []).forEach((m) => { if (m && m.code) map[m.code] = m; });
    return map;
  }

  return {
    EDITION, LIMITS, SUMMARY_MAX_RECORDS, SUMMARY_PAGE_SIZE, DEFAULT_MAX_TOKENS,
    PARAMS, PERIODS, STYLE_PRESETS, METHOD_LABELS, OP_LABELS,
    typeGroup, isNumericField, operatorsFor,
    localDateString, parseDateString, addDays, localStartIso, resolveDateValue,
    escapeQueryValue, composeQuery, buildCondClause, buildButtonQuery, buildQuickFilterQuery,
    cleanQuickFilterValues, normalizeNumberInput,
    hashQuery, normalizeForSig, readUrlState, buildNavUrl, buildResetUrl, readCondition,
    evaluateCond, evaluateHighlights,
    parseDecimal, createAccumulator, accumulate, sumString, averageString, displayDecimals, formatNumberDisplay,
    fetchSummary,
    normalizeConfig, toSavedConfig, metaMapFrom
  };
});
