#!/usr/bin/env node
/* scripts/make-harness.js
 * 見た目の確認用に、kintone を模擬した 2 つのページを build/harness/ に作る（配布物には入らない）。
 *   config.html … 設定画面（全機能をオンにしたサンプル設定）
 *   list.html   … 一覧画面（横断検索・クイックフィルター・ボタン・集計・装飾）
 * ブラウザで開いて確認する。kintone の画面そのものではないので、実機の確認の代わりにはならない。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = path.join(root, 'build', 'harness');
fs.mkdirSync(out, { recursive: true });

const opt = (arr) => Object.fromEntries(arr.map((l, i) => [l, { label: l, index: String(i) }]));
const fields = {
  レコード番号: { type: 'RECORD_NUMBER', code: 'レコード番号', label: 'レコード番号' },
  案件名: { type: 'SINGLE_LINE_TEXT', code: '案件名', label: '案件名' },
  顧客名: { type: 'SINGLE_LINE_TEXT', code: '顧客名', label: '顧客名' },
  状態: { type: 'DROP_DOWN', code: '状態', label: '状態', options: opt(['未対応', '対応中', '完了']) },
  担当者: { type: 'USER_SELECT', code: '担当者', label: '担当者' },
  金額: { type: 'NUMBER', code: '金額', label: '金額', unit: '円', unitPosition: 'AFTER' },
  期限: { type: 'DATE', code: '期限', label: '期限' },
  更新日時: { type: 'UPDATED_TIME', code: '更新日時', label: '更新日時' }
};

const today = new Date();
const d = (n) => { const x = new Date(today); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const rows = [
  [1, 'サイト改修', '東京商事', '未対応', 'sato', '1200000', d(-3)],
  [2, '保守契約', '大阪物産', '対応中', 'suzuki', '240000', d(5)],
  [3, '新規導入', '東京商事', '完了', 'sato', '3500000', d(-10)],
  [4, '研修', '名古屋工業', '未対応', 'tanaka', '180000', d(1)],
  [5, 'データ移行', '札幌運輸', '対応中', 'sato', '860000', d(-1)],
  [6, 'アプリ追加', '福岡食品', '未対応', 'suzuki', '', d(14)]
];
const records = rows.map(([id, name, cust, st, user, amt, due]) => ({
  $id: { type: '__ID__', value: String(id) },
  案件名: { type: 'SINGLE_LINE_TEXT', value: name },
  顧客名: { type: 'SINGLE_LINE_TEXT', value: cust },
  状態: { type: 'DROP_DOWN', value: st },
  担当者: { type: 'USER_SELECT', value: [{ code: user, name: user }] },
  金額: { type: 'NUMBER', value: amt },
  期限: { type: 'DATE', value: due }
}));

const snapshot = [
  { code: '案件名', label: '案件名', type: 'SINGLE_LINE_TEXT', op: 'like', isSubtable: false, parentCode: '', parentLabel: '', options: [] },
  { code: '顧客名', label: '顧客名', type: 'SINGLE_LINE_TEXT', op: 'like', isSubtable: false, parentCode: '', parentLabel: '', options: [] },
  { code: '状態', label: '状態', type: 'DROP_DOWN', op: 'in', isSubtable: false, parentCode: '', parentLabel: '', options: ['未対応', '対応中', '完了'] }
];
const stateMeta = { code: '状態', label: '状態', type: 'DROP_DOWN', options: ['未対応', '対応中', '完了'] };
const ls = {
  version: 2,
  search: { enabled: true },
  quickFilter: { enabled: true, items: [stateMeta, { code: '担当者', label: '担当者', type: 'USER_SELECT' }, { code: '金額', label: '金額', type: 'NUMBER' }, { code: '期限', label: '期限', type: 'DATE' }] },
  quickButtons: {
    enabled: true,
    items: [
      { id: 'b1', label: '自分の担当', conds: [{ code: '担当者', op: 'me' }], metas: [{ code: '担当者', label: '担当者', type: 'USER_SELECT' }] },
      { id: 'b2', label: '未対応', conds: [{ code: '状態', op: 'in', value: ['未対応'] }], metas: [stateMeta] },
      { id: 'b3', label: '今月期限', conds: [{ code: '期限', op: 'eq', value: { kind: 'period', period: 'THIS_MONTH' } }], metas: [{ code: '期限', label: '期限', type: 'DATE' }] },
      { id: 'b4', label: '期限超過', conds: [{ code: '期限', op: 'lt', value: { kind: 'today', offset: 0 } }, { code: '状態', op: 'not_in', value: ['完了'] }], metas: [{ code: '期限', label: '期限', type: 'DATE' }, stateMeta] }
    ]
  },
  summary: { enabled: true, items: [{ code: '金額', label: '売上', type: 'NUMBER', unit: '円', method: 'sum' }, { code: '金額', label: '売上', type: 'NUMBER', unit: '円', method: 'avg' }] },
  highlight: {
    enabled: true,
    rules: [
      { id: 'h1', code: '期限', op: 'lt', value: { kind: 'today', offset: 0 }, target: 'row', style: 'danger', type: 'DATE' },
      { id: 'h2', code: '状態', op: 'in', value: ['未対応'], target: 'cell', style: 'warning', type: 'DROP_DOWN' },
      { id: 'h3', code: '金額', op: 'gte', value: '1000000', target: 'cell', style: 'redText', type: 'NUMBER' }
    ]
  }
};
const config = {
  spaceJoin: 'and', maxTokens: '5',
  targetsJson: JSON.stringify([{ code: '案件名', op: 'like' }, { code: '顧客名', op: 'like' }, { code: '状態', op: 'in' }]),
  fieldSnapshotJson: JSON.stringify(snapshot),
  lsConfig: JSON.stringify(ls)
};

const mock = (extra) => `
<script>
window.__fields = ${JSON.stringify(fields)};
window.__records = ${JSON.stringify(records)};
window.__config = ${JSON.stringify(config)};
window.kintone = {
  $PLUGIN_ID: 'harness',
  events: { on: (ev, fn) => { window.__handler = fn; } },
  getLoginUser: () => ({ code: 'sato' }),
  plugin: { app: { getConfig: () => JSON.parse(JSON.stringify(window.__config)), setConfig: (c) => { window.__saved = c; } } },
  app: {
    getId: () => 1,
    getFormFields: async () => JSON.parse(JSON.stringify(window.__fields)),
    getHeaderMenuSpaceElement: () => document.getElementById('menu-space'),
    getHeaderSpaceElement: () => document.getElementById('header-space'),
    getQueryCondition: () => new URLSearchParams(location.search).get('query') || '',
    getView: async () => ({ type: 'LIST', fields: ['案件名', '顧客名', '状態', '担当者', '金額', '期限'] }),
    setRecordListStyle: async (conf) => {
      document.querySelectorAll('#list td').forEach((td) => { td.style.cssText = ''; });
      if (conf.body === 'DEFAULT') return;
      conf.body.forEach((b) => b.style.forEach((s) => {
        const td = document.querySelector('#list tr[data-id="' + b.recordId + '"] td[data-col="' + (s.columnType === 'ACTION' ? s.column : s.column) + '"]');
        if (!td) return;
        if (s.background) td.style.backgroundColor = s.background.backgroundColor;
        if (s.content && s.content.color) td.style.color = s.content.color;
        if (s.content && s.content.fontWeight) td.style.fontWeight = s.content.fontWeight;
      }));
    }
  },
  api: Object.assign(async (url, method, params) => {
    if (/status/.test(url)) return { enable: false };
    const m = /\\$id > (\\d+)/.exec(params.query || '');
    const after = m ? Number(m[1]) : 0;
    const rows = window.__records.filter((r) => Number(r.$id.value) > after);
    const res = { records: rows };
    if (params.totalCount) res.totalCount = String(window.__records.length);
    return res;
  }, { url: (p) => p })
};
</script>
${extra || ''}`;

// ---------- 設定画面 ----------
const configPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一覧サポート 設定（ハーネス）</title>
<style>body{margin:0;background:#f5f5f5;} .k-head{background:#fff;border-bottom:1px solid #e3e3e3;padding:10px 16px;font:14px sans-serif;color:#333}</style>
</head><body><div class="k-head">kintone（模擬） › アプリの設定 › プラグイン › 一覧サポート for kintone</div>
${read('source/config.html')}
${mock()}
<script>${read('source/js/ls-core.js')}</script>
<script>${read('source/js/config.js')}</script>
</body></html>`;
fs.writeFileSync(path.join(out, 'config.html'), configPage);

// ---------- 一覧画面 ----------
const cols = ['案件名', '顧客名', '状態', '担当者', '金額', '期限'];
const cell = (r, c) => {
  const v = r[c].value;
  if (c === '担当者') return v.map((u) => u.name).join(', ');
  if (c === '金額') return v ? `${Number(v).toLocaleString('ja-JP')}円` : '';
  return v;
};
const table = `<table id="list"><thead><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
  records.map((r) => `<tr data-id="${r.$id.value}"><td data-col="OPEN_DETAIL">▸</td>${cols.map((c) => `<td data-col="${c}">${cell(r, c)}</td>`).join('')}</tr>`).join('')
}</tbody></table>`;
const listPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一覧サポート 一覧画面（ハーネス）</title>
<style>
  body{margin:0;background:#f5f5f5;font:14px -apple-system,"Segoe UI","Noto Sans JP",Meiryo,sans-serif;color:#333}
  .k-top{background:#fff;border-bottom:1px solid #e3e3e3;padding:8px 16px;display:flex;align-items:center;gap:12px}
  .k-view{border:1px solid #ccc;border-radius:4px;padding:6px 10px;background:#fff}
  .k-body{padding:8px 16px}
  #list{border-collapse:collapse;background:#fff;width:100%}
  #list th,#list td{border:1px solid #e3e3e3;padding:8px 10px;text-align:left}
  #list th{background:#f8f8f8;font-weight:normal;color:#666}
</style></head><body>
<div class="k-top"><span class="k-view">（すべて）▾</span><span>🔍</span><div id="menu-space"></div></div>
<div class="k-body"><div id="header-space"></div>${table}</div>
${mock()}
<script>${read('source/js/ls-core.js')}</script>
<script>${read('source/js/desktop.js')}</script>
<script>window.__handler({ type: 'app.record.index.show', viewType: 'list', records: window.__records });</script>
</body></html>`;
fs.writeFileSync(path.join(out, 'list.html'), listPage);

console.log(`harness: ${path.relative(root, path.join(out, 'config.html'))}, ${path.relative(root, path.join(out, 'list.html'))}`);
