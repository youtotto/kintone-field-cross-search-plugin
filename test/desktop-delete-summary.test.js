'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDesktop } = require('./helpers/load-desktop');
const SUCCESS = 'app.record.index.delete.submit.success';
const fields = { 金額: { code: '金額', label: '金額', type: 'NUMBER' } };
const config = { lsConfig: JSON.stringify({ version: 2, search: { enabled: false }, summary: {
  enabled: true, items: ['sum', 'avg'].map(method => ({ ...fields.金額, method }))
} }) };
const records = [100, 200, ''].map((v, i) => ({ $id: { value: String(i + 1) }, 金額: { value: String(v) } }));
const response = rows => ({ records: rows, totalCount: String(rows.length) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const ls = { records, queryCondition: '検証ID like "AGG-20261014"', getRecords: () => response(records) };
  return { ls, app: loadDesktop({ config, currentFields: fields, ls }) };
}
const before = '3件｜金額 合計 300｜金額 平均 150（空欄1件を除く）';
const after = '2件｜金額 合計 200｜金額 平均 200（空欄1件を除く）';

test('個別削除の成功だけで3→2→1→0件を再集計し、空欄の平均除外を維持する', async () => {
  const { app, ls } = setup();
  await app.show(records, { viewType: 'list' });
  await app.idle();
  assert.equal(app.summaryText(), before);
  const expected = [after, '1件｜金額 合計 0｜金額 平均 ―（空欄1件を除く）', '0件｜金額 合計 0｜金額 平均 ―'];
  for (let i = 1; i <= 3; i++) {
    ls.getRecords = () => response(records.slice(i));
    const event = app.emit(SUCCESS, { recordId: String(i) });
    assert.equal(event.type, SUCCESS);
    await app.idle();
    assert.equal(app.summaryText(), expected[i - 1]);
    const calls = app.apiCalls.length;
    await app.show(records.slice(i).reverse(), { viewType: 'list' });
    await app.idle();
    assert.equal(app.apiCalls.length, calls, '同条件の再表示は新しいキャッシュを再利用');
  }
  assert.equal(app.apiCalls.length, 4);
  assert.ok(app.apiCalls.every(call => call.method === 'GET' && call.params.query.startsWith('(検証ID like "AGG-20261014")')));
  assert.equal(app.navigations.length, 0);
});

test('取消・削除前イベントのみ（失敗を含む）では集計を無効化しない', async () => {
  const { app } = setup();
  await app.show(records);
  await app.idle();
  app.emit('app.record.index.delete.submit', { recordId: '1' });
  await app.show(records);
  await app.idle();
  assert.equal(app.summaryText(), before);
  assert.equal(app.apiCalls.length, 1);
});

for (const failOld of [false, true]) {
  test(`削除前の遅い${failOld ? 'エラー' : '成功結果'}で更新済み表示とキャッシュを上書きしない`, async () => {
    const { app, ls } = setup();
    let resolveOld, rejectOld;
    ls.getRecords = () => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    await app.show(records);
    assert.equal(app.apiCalls.length, 1);
    ls.getRecords = () => response(records.slice(1));
    app.emit(SUCCESS, { recordId: '1' });
    await tick();
    assert.equal(app.summaryText(), after);
    if (failOld) rejectOld(new Error('old request failed')); else resolveOld(response(records));
    await app.idle();
    assert.equal(app.summaryText(), after);
    await app.show(records.slice(1));
    await app.idle();
    assert.equal(app.summaryText(), after);
    assert.equal(app.apiCalls.length, 2);
  });
}

test('削除成功時に集計DOMがなくても古い通信を無効化し、再表示で取り直す', async () => {
  const { app, ls } = setup();
  let finish;
  ls.getRecords = () => new Promise(resolve => { finish = resolve; });
  await app.show(records);
  app.document.getElementById('nrc-ls-summary').parentElement.remove();
  app.emit(SUCCESS, { recordId: '1' });
  finish(response(records));
  await app.idle();
  ls.getRecords = () => response(records.slice(1));
  await app.show(records.slice(1));
  await app.idle();
  assert.equal(app.summaryText(), after);
  assert.equal(app.apiCalls.length, 2);
});

test('削除後の再取得失敗で旧値を残さず、次の再表示で再試行する', async () => {
  const { app, ls } = setup();
  await app.show(records);
  await app.idle();
  ls.apiError = new Error('通信失敗');
  app.emit(SUCCESS, { recordId: '1' });
  await app.idle();
  assert.match(app.summaryText(), /集計できませんでした（通信失敗）/);
  ls.apiError = null;
  ls.getRecords = () => response(records.slice(1));
  await app.show(records.slice(1));
  await app.idle();
  assert.equal(app.summaryText(), after);
});

test('削除後に条件が取得できないと全件取得せず、条件復帰時は取り直す', async () => {
  const { app, ls } = setup();
  await app.show(records);
  await app.idle();
  ls.queryCondition = null;
  app.emit(SUCCESS, { recordId: '1' });
  await app.idle();
  assert.match(app.summaryText(), /現在の絞り込み条件を読み取れない/);
  assert.equal(app.apiCalls.length, 1);
  ls.queryCondition = '検証ID like "AGG-20261014"';
  ls.getRecords = () => response(records.slice(1));
  await app.show(records.slice(1));
  await app.idle();
  assert.equal(app.summaryText(), after);
});

test('集計OFF・カレンダー・初回表示前は削除成功による取得をしない', async () => {
  const { app } = setup();
  app.emit(SUCCESS, { recordId: '1' });
  await app.show(records, { viewType: 'calendar' });
  app.emit(SUCCESS, { recordId: '1' });
  await app.idle();
  assert.equal(app.apiCalls.length, 0);
  const disabled = loadDesktop({ config: {}, currentFields: fields, ls: { records } });
  await disabled.show(records);
  disabled.emit(SUCCESS, { recordId: '1' });
  await disabled.idle();
  assert.equal(disabled.apiCalls.length, 0);
});
