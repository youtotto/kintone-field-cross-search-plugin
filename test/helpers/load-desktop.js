'use strict';

/**
 * source/js/desktop.js を jsdom 上で読み込むヘルパー。
 * - kintone API をスタブ
 * - desktop.js が参照する `location` を差し替え、location.href への代入（＝一覧の再読込）を記録する
 *   （jsdom はページ遷移を実装していないため）
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const DESKTOP_PATH = path.resolve(__dirname, '../../source/js/desktop.js');
const CORE_PATH = path.resolve(__dirname, '../../source/js/ls-core.js');
const BASE_URL = 'https://example.cybozu.com/k/123/';

const opts = (arr) => Object.fromEntries(arr.map((l, i) => [l, { label: l, index: String(i) }]));

function defaultFields() {
  return {
    顧客名: { type: 'SINGLE_LINE_TEXT', code: '顧客名', label: '顧客名' },
    備考: { type: 'MULTI_LINE_TEXT', code: '備考', label: '備考' },
    説明: { type: 'RICH_TEXT', code: '説明', label: '説明' },
    契約区分: { type: 'DROP_DOWN', code: '契約区分', label: '契約区分', options: opts(['新規', '更新', '解約']) },
    優先度: { type: 'RADIO_BUTTON', code: '優先度', label: '優先度', options: opts(['高', '中', '低']) },
    対応エリア: { type: 'CHECK_BOX', code: '対応エリア', label: '対応エリア', options: opts(['東京都', '神奈川県']) },
    タグ: { type: 'MULTI_SELECT', code: 'タグ', label: 'タグ', options: opts(['重要', '保留']) },
    契約書: { type: 'FILE', code: '契約書', label: '契約書添付' },
    明細: { type: 'SUBTABLE', code: '明細', label: '明細', fields: { 品名: { type: 'SINGLE_LINE_TEXT', code: '品名', label: '品名' } } }
  };
}

/** フィールド定義から、config.js が保存するのと同じ形の設定を作る */
function makeConfig(codes, { spaceJoin = 'and', maxTokens, fields = defaultFields() } = {}) {
  const flat = {};
  Object.values(fields).forEach((f) => {
    if (f.type === 'SUBTABLE') {
      Object.values(f.fields).forEach((sf) => { flat[sf.code] = { ...sf, isSubtable: true, parentCode: f.code, parentLabel: f.label }; });
    } else {
      flat[f.code] = f;
    }
  });
  const IN = new Set(['DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT']);
  const targets = codes.map((code) => ({ code, op: IN.has(flat[code].type) ? 'in' : 'like' }));
  const snapshot = codes.map((code) => {
    const f = flat[code];
    return {
      code, label: f.label, type: f.type, op: IN.has(f.type) ? 'in' : 'like',
      isSubtable: Boolean(f.isSubtable), parentCode: f.parentCode || '', parentLabel: f.parentLabel || '',
      options: IN.has(f.type) ? Object.keys(f.options) : []
    };
  });
  const conf = { spaceJoin, targetsJson: JSON.stringify(targets), fieldSnapshotJson: JSON.stringify(snapshot) };
  if (maxTokens !== undefined) conf.maxTokens = String(maxTokens);
  return conf;
}

/**
 * @param {object} o
 * @param {object} o.config        getConfig の戻り値
 * @param {string} o.search        一覧 URL のクエリ文字列（例 '?view=20&nrc_q=東京'）
 * @param {object} o.currentFields 現在のフォーム定義（getFormFields）。null なら取得失敗を再現
 */
/**
 * 一覧サポートの API（任意）:
 * @param {object} o.ls  { headerSpace?:boolean, queryCondition?:string|null|Error|((url:URL)=>any), queryConditionApi?:boolean,
 *                        records?:object[], totalCount?:number, apiError?:object, viewFields?:string[], listStyle?:boolean,
 *                        fieldElements?:boolean, loginUser?:string }
 *   queryCondition: getQueryCondition の結果（Error は例外として投げる。既定は URL の query）。ls を渡さなくても使える
 *   queryConditionApi: false にすると getQueryCondition 自体を用意しない
 */
function loadDesktop({ config = {}, search = '', currentFields = defaultFields(), ls = null } = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><html><body><div id="header"><div id="menu-space"></div></div><div id="header-space"></div></body></html>', {
    runScripts: 'outside-only', url: BASE_URL, virtualConsole
  });
  const { window } = dom;
  const document = window.document;

  const navigations = [];
  const replaced = [];
  const fakeLocation = {
    _href: BASE_URL + search,
    get href() { return this._href; },
    set href(v) { navigations.push(String(v)); this._href = String(v); },
    replace(v) { navigations.push(String(v)); replaced.push(String(v)); this._href = String(v); },
    get search() { return new URL(this._href).search; }
  };

  const handlers = {};
  let getFormFieldsCalls = 0;
  window.kintone = {
    $PLUGIN_ID: 'mock-plugin',
    plugin: { app: { getConfig: () => JSON.parse(JSON.stringify(config)) } },
    events: { on: (ev, fn) => { [].concat(ev).forEach((e) => { handlers[e] = fn; }); } },
    app: {
      getId: () => 123,
      getHeaderMenuSpaceElement: () => document.getElementById('menu-space'),
      getFormFields: async () => {
        getFormFieldsCalls++;
        if (currentFields === null) throw new Error('forbidden');
        return JSON.parse(JSON.stringify(currentFields));
      }
    }
  };

  // ---- 一覧の条件（getQueryCondition）: 横断検索も使うので ls が無くても用意する ----
  const qc = ls || {};
  let queryConditionCalls = 0;
  if (qc.queryConditionApi !== false) {
    window.kintone.app.getQueryCondition = () => {
      queryConditionCalls++;
      if (qc.queryCondition instanceof Error) throw qc.queryCondition;
      if (typeof qc.queryCondition === 'function') return qc.queryCondition(new URL(fakeLocation.href));
      // 既定: kintone が URL の query を適用した結果（一覧自体の条件・標準の絞り込みは無い）
      return qc.queryCondition === undefined ? (new URL(fakeLocation.href).searchParams.get('query') || '') : qc.queryCondition;
    };
  }

  // ---- 一覧サポート用の API（ls を渡したときだけ用意する）----
  const apiCalls = [];
  const listStyleCalls = [];
  if (ls) {
    const k = window.kintone;
    if (ls.headerSpace !== false) k.app.getHeaderSpaceElement = () => document.getElementById('header-space');
    k.getLoginUser = () => ({ code: ls.loginUser || 'sato' });
    if (ls.viewFields) k.app.getView = async () => ({ type: 'LIST', fields: ls.viewFields.slice() });
    if (ls.listStyle !== false) k.app.setRecordListStyle = async (conf) => { listStyleCalls.push(JSON.parse(JSON.stringify(conf))); };
    const all = (ls.records || []).slice().sort((a, b) => Number(a.$id.value) - Number(b.$id.value));
    k.api = async (url, method, params) => {
      apiCalls.push({ url, method, params: JSON.parse(JSON.stringify(params)) });
      if (ls.apiError) throw ls.apiError;
      if (ls.getRecords) return ls.getRecords(params);
      const m = /\$id > (\d+)/.exec(params.query || '');
      const after = m ? Number(m[1]) : 0;
      const lim = Number((/limit (\d+)/.exec(params.query || '') || [])[1] || 500);
      const rows = all.filter((r) => Number(r.$id.value) > after).slice(0, lim);
      const res = { records: JSON.parse(JSON.stringify(rows)) };
      if (params.totalCount) res.totalCount = String(ls.totalCount !== undefined ? ls.totalCount : all.length);
      return res;
    };
    k.api.url = (p) => p;
    k.app.getFieldElements = ls.fieldElements ? (code) => Array.from(document.querySelectorAll(`td[data-code="${code}"]`)) : undefined;
  }

  window.eval(fs.readFileSync(CORE_PATH, 'utf8'));
  const code = fs.readFileSync(DESKTOP_PATH, 'utf8');
  window.eval(`(function (location) {\n${code}\n})`)(fakeLocation);

  const $ = (id) => document.getElementById(id);

  return {
    window, document, navigations, replaced,
    emit(type, extra = {}) {
      const event = { type, appId: 123, ...extra };
      return handlers[type] ? handlers[type](event) : event;
    },
    getFormFieldsCalls: () => getFormFieldsCalls,
    /** index.show を発火（records: 一覧に表示中のレコード配列） */
    async show(records = [{}], extra = {}) {
      const fn = handlers['app.record.index.show'];
      if (!fn) throw new Error('handler not registered');
      return fn({ type: 'app.record.index.show', records, ...extra });
    },
    /** 集計・装飾などの非同期処理が終わるまで待つ */
    async idle() {
      for (let i = 0; i < 5; i++) {
        await window.NrcListSupportRuntime.idle();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    apiCalls,
    listStyleCalls,
    headerSpace: () => document.getElementById('header-space'),
    summaryText: () => { const s = document.getElementById('nrc-ls-summary'); return s ? s.textContent.replace(/\s+/g, ' ').trim() : null; },
    queryConditionCalls: () => queryConditionCalls,
    /** kintone 側がヘッダーのメニュー領域を作り直した状況を再現 */
    recreateHeaderSpace() {
      $('menu-space').remove();
      const s = document.createElement('div');
      s.id = 'menu-space';
      $('header').appendChild(s);
    },
    input: () => $('nrc-xsearch-input'),
    searchBtn: () => $('nrc-xsearch-btn'),
    clearBtn: () => $('nrc-xsearch-clear'),
    toggle: () => $('nrc-xsearch-toggle'),
    modeBtn: (mode) => $(`nrc-xsearch-mode-${mode}`),
    /** 現在押されている（aria-pressed=true）モード。どちらか一方だけのはず */
    pressedModes: () => ['and', 'or'].filter(m => $(`nrc-xsearch-mode-${m}`).getAttribute('aria-pressed') === 'true'),
    panel: () => $('nrc-xsearch-panel'),
    status: () => $('nrc-xsearch-status'),
    statusText: () => ($('nrc-xsearch-status').hidden ? '' : $('nrc-xsearch-status').textContent.replace(/\s+/g, ' ').trim()),
    count: () => $('nrc-xsearch-count').textContent,
    chips: () => Array.from(document.querySelectorAll('#nrc-xsearch-chips .nrc-xsearch__chip[data-code]')),
    roots: () => document.querySelectorAll('#nrc-xsearch-root').length,
    type(text) { $('nrc-xsearch-input').value = text; },
    key(key, init = {}) {
      const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      if (init.keyCode !== undefined && ev.keyCode !== init.keyCode) {
        Object.defineProperty(ev, 'keyCode', { get: () => init.keyCode });
      }
      $('nrc-xsearch-input').dispatchEvent(ev);
      return ev;
    },
    /** 直近の遷移先 URL を分解 */
    lastNav() {
      if (navigations.length === 0) return null;
      const u = new URL(navigations[navigations.length - 1]);
      return {
        url: u,
        query: u.searchParams.get('query'),
        nrc_q: u.searchParams.get('nrc_q'),
        nrc_mode: u.searchParams.get('nrc_mode'),
        nrc_qf: u.searchParams.get('nrc_qf'),
        nrc_btn: u.searchParams.get('nrc_btn'),
        nrc_base: u.searchParams.get('nrc_base'),
        nrc_sig: u.searchParams.get('nrc_sig'),
        params: u.searchParams
      };
    }
  };
}

module.exports = { loadDesktop, makeConfig, defaultFields, opts };
