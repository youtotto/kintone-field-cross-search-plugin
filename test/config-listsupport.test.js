'use strict';

// 一覧サポートの設定画面: 旧設定の引き継ぎ / 機能ごとのオン・オフ / 各設定欄の保存

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfigScreen, configFields } = require('./helpers/load-config');
const { makeConfig } = require('./helpers/load-desktop');

const v1 = makeConfig(['顧客名', '契約区分'], { spaceJoin: 'or', maxTokens: 3 });

async function open(opts = {}) {
  const ui = await loadConfigScreen(opts);
  const d = ui.document;
  return {
    ...ui,
    toggle: (id, on) => ui.change(d.getElementById(id), on),
    shownBody: (id) => !d.getElementById(id).hidden,
    click: (sel) => ui.$(sel).click(),
    err: (id) => (d.getElementById(id).classList.contains('is-show') ? d.getElementById(id).textContent : '')
  };
}

describe('旧設定（横断検索 v1）の引き継ぎ', () => {
  test('引き継ぎの案内を出し、横断検索だけオン・ほかはオフで開く', async () => {
    const ui = await open({ config: v1 });
    assert.equal(ui.document.getElementById('migrateNote').hidden, false);
    assert.equal(ui.$('#searchEnabled').checked, true);
    ['qfEnabled', 'qbEnabled', 'sumEnabled', 'hlEnabled'].forEach((id) => assert.equal(ui.$(`#${id}`).checked, false, id));
    assert.equal(ui.shownBody('qfBody'), false);
    assert.deepEqual(ui.checkedCodes().sort(), ['契約区分', '顧客名'].sort());
  });

  test('そのまま保存: v1 のキーは変わらず、lsConfig が加わる', async () => {
    const ui = await open({ config: v1 });
    const s = ui.save();
    const sortByCode = (arr) => arr.slice().sort((a, b) => a.code.localeCompare(b.code));
    // 並び順は画面の表示順（v1 と同じ）。内容は変わらない
    assert.deepEqual(sortByCode(s.targets), sortByCode(JSON.parse(v1.targetsJson)));
    assert.equal(s.raw.spaceJoin, 'or');
    assert.equal(s.raw.maxTokens, '3');
    assert.equal(s.ls.search.enabled, true);
    assert.equal(s.ls.summary.enabled, false);
  });

  test('新規（設定なし）では引き継ぎの案内を出さない', async () => {
    const ui = await open();
    assert.equal(ui.document.getElementById('migrateNote').hidden, true);
  });
});

describe('機能のオン・オフ', () => {
  test('横断検索をオフにすると、検索対象が未選択でも保存できる（集計だけ使う）', async () => {
    const ui = await open();
    ui.toggle('searchEnabled', false);
    assert.equal(ui.shownBody('searchBody'), false);
    ui.toggle('sumEnabled', true);
    const s = ui.save();
    assert.ok(s);
    assert.equal(s.ls.search.enabled, false);
    assert.equal(s.ls.summary.enabled, true);
    assert.deepEqual(s.targets, []);
  });

  test('すべてオフでは保存しない', async () => {
    const ui = await open();
    ui.toggle('searchEnabled', false);
    assert.equal(ui.save(), null);
    assert.match(ui.err('errAll'), /使う機能を 1 つ以上オンにしてください/);
  });
});

describe('集計', () => {
  test('数値フィールドだけが候補。追加して保存すると単位などの情報も残る', async () => {
    const fields = configFields();
    fields['金額'] = { ...fields['金額'], unit: '円', unitPosition: 'AFTER', displayScale: '0' };
    fields['粗利'] = { type: 'CALC', code: '粗利', label: '粗利', format: 'NUMBER_DIGIT' };
    fields['日数'] = { type: 'CALC', code: '日数', label: '日数', format: 'DAY_HOUR_MINUTE' };
    const ui = await open({ config: v1, fields });
    const candidates = ui.$$('#sumAddField option').map((o) => o.value).filter(Boolean);
    assert.deepEqual(candidates.sort(), ['粗利', '金額'].sort(), '時間形式の計算フィールドは出ない');

    ui.toggle('sumEnabled', true);
    ui.change(ui.$('#sumAddField'), '金額');
    ui.change(ui.$('#sumAddMethod'), 'sum');
    ui.click('#sumAdd');
    ui.change(ui.$('#sumAddField'), '粗利');
    ui.change(ui.$('#sumAddMethod'), 'avg');
    ui.click('#sumAdd');
    assert.equal(ui.$('#sumAdd').disabled, true, '無料版は 2 項目まで');
    assert.match(ui.$('#sumLimit').textContent, /2 \/ 2/);

    const s = ui.save();
    assert.deepEqual(s.ls.summary.items.map((i) => `${i.code}:${i.method}`), ['金額:sum', '粗利:avg']);
    assert.equal(s.ls.summary.items[0].unit, '円');
    assert.equal(s.ls.summary.items[0].displayScale, '0');
  });

  test('項目を削除できる', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('sumEnabled', true);
    ui.change(ui.$('#sumAddField'), '金額');
    ui.click('#sumAdd');
    ui.click('#sumList button[data-act="sum-remove"]');
    assert.equal(ui.$$('#sumList .ls-item').length, 0);
  });
});

describe('クイックフィルター', () => {
  test('追加・削除でき、追加済みのフィールドは候補から外れる。上限は 5', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('qfEnabled', true);
    const candidates = ui.$$('#qfAddField option').map((o) => o.value).filter(Boolean);
    ['顧客名', '契約区分', '金額', '契約開始日', '担当者', '作成者'].forEach((c) => assert.ok(candidates.includes(c), c));
    ['契約書', '担当組織', '品名'].forEach((c) => assert.ok(!candidates.includes(c), `${c} は対象外`));

    ['顧客名', '契約区分', '金額', '契約開始日', '担当者'].forEach((c) => {
      ui.change(ui.$('#qfAddField'), c);
      ui.click('#qfAdd');
    });
    assert.equal(ui.$('#qfAdd').disabled, true);
    assert.ok(!ui.$$('#qfAddField option').map((o) => o.value).includes('顧客名'));

    ui.click('#qfList button[data-act="qf-remove"][data-i="0"]');
    const s = ui.save();
    assert.deepEqual(s.ls.quickFilter.items.map((i) => i.code), ['契約区分', '金額', '契約開始日', '担当者']);
    assert.deepEqual(s.ls.quickFilter.items[0].options, ['新規', '更新', '解約'], '選択肢は kintone の並び順');
  });

  test('オンなのに 1 つも無ければ保存しない', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('qfEnabled', true);
    assert.equal(ui.save(), null);
    assert.match(ui.err('errQf'), /1 つ以上追加してください/);
  });
});

describe('クイックボタン', () => {
  function condRow(ui, bi, ci) {
    return ui.$(`#qbList .ls-item[data-bi="${bi}"][data-ci="${ci}"]`);
  }

  test('名前と条件（選択肢）を設定して保存。条件のフィールド情報も保存される', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('qbEnabled', true);
    ui.click('#qbAdd');
    ui.change(ui.$('#qbList input[data-role="label"]'), '新規だけ', 'input');
    ui.change(condRow(ui, 0, 0).querySelector('[data-role="field"]'), '契約区分');
    const ops = Array.from(condRow(ui, 0, 0).querySelectorAll('[data-role="op"] option')).map((o) => o.value);
    assert.deepEqual(ops, ['in', 'not_in']);
    ui.change(condRow(ui, 0, 0).querySelector('input[data-role="opt"][value="新規"]'), true);
    const s = ui.save();
    assert.ok(s, ui.err('errQb'));
    const b = s.ls.quickButtons.items[0];
    assert.equal(b.label, '新規だけ');
    assert.deepEqual(b.conds, [{ code: '契約区分', op: 'in', value: ['新規'] }]);
    assert.equal(b.metas[0].type, 'DROP_DOWN');
  });

  test('日付の条件: 今月（期間）・今日から N 日を選べる。条件は 3 つまで', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('qbEnabled', true);
    ui.click('#qbAdd');
    ui.change(ui.$('#qbList input[data-role="label"]'), '今月開始', 'input');
    ui.change(condRow(ui, 0, 0).querySelector('[data-role="field"]'), '契約開始日');
    assert.equal(condRow(ui, 0, 0).querySelector('[data-role="op"]').value, 'eq');
    ui.change(condRow(ui, 0, 0).querySelector('[data-role="dateKind"]'), 'period:THIS_MONTH');

    ui.click('#qbList button[data-act="qb-cond-add"]');
    ui.change(condRow(ui, 0, 1).querySelector('[data-role="field"]'), '担当者');
    assert.deepEqual(Array.from(condRow(ui, 0, 1).querySelectorAll('[data-role="op"] option')).map((o) => o.value), ['me', 'not_me']);

    ui.click('#qbList button[data-act="qb-cond-add"]');
    ui.change(condRow(ui, 0, 2).querySelector('[data-role="field"]'), '金額');
    ui.change(condRow(ui, 0, 2).querySelector('[data-role="op"]'), 'gte');
    ui.change(condRow(ui, 0, 2).querySelector('[data-role="value"]'), '1000000', 'input');
    assert.equal(ui.$('#qbList button[data-act="qb-cond-add"]').disabled, true);

    const s = ui.save();
    assert.ok(s, ui.err('errQb'));
    assert.deepEqual(s.ls.quickButtons.items[0].conds, [
      { code: '契約開始日', op: 'eq', value: { kind: 'period', period: 'THIS_MONTH' } },
      { code: '担当者', op: 'me' },
      { code: '金額', op: 'gte', value: '1000000' }
    ]);
  });

  test('名前が無い・値が無い条件は保存しない', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('qbEnabled', true);
    ui.click('#qbAdd');
    ui.change(condRow(ui, 0, 0).querySelector('[data-role="field"]'), '顧客名');
    assert.equal(ui.save(), null);
    const msg = ui.err('errQb');
    assert.match(msg, /1 番目のボタンに名前を入力してください/);
    assert.match(msg, /条件 1 を確認してください/);
  });

  test('ステータスの選択肢はプロセス管理の設定から取る', async () => {
    const fields = { ...configFields(), ステータス: { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true } };
    const ui = await open({ config: v1, fields, statusStates: { 未処理: { name: '未処理', index: '0' }, 完了: { name: '完了', index: '1' } } });
    ui.toggle('qbEnabled', true);
    ui.click('#qbAdd');
    ui.change(ui.$('#qbList input[data-role="label"]'), '未処理', 'input');
    ui.change(condRow(ui, 0, 0).querySelector('[data-role="field"]'), 'ステータス');
    const opts = Array.from(condRow(ui, 0, 0).querySelectorAll('input[data-role="opt"]')).map((c) => c.value);
    assert.deepEqual(opts, ['未処理', '完了']);
    ui.change(condRow(ui, 0, 0).querySelector('input[data-role="opt"][value="未処理"]'), true);
    const s = ui.save();
    assert.ok(s, ui.err('errQb'));
    assert.deepEqual(s.ls.quickButtons.items[0].metas[0].options, ['未処理', '完了']);
  });
});

describe('条件付き装飾', () => {
  test('ルールを設定して保存（数値 >= 、セル、赤字・太字）', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('hlEnabled', true);
    ui.click('#hlAdd');
    const row = () => ui.$('#hlList .ls-item[data-ri="0"]');
    ui.change(row().querySelector('[data-role="field"]'), '金額');
    ui.change(row().querySelector('[data-role="op"]'), 'gte');
    ui.change(row().querySelector('[data-role="value"]'), '1000000', 'input');
    ui.change(row().querySelector('[data-role="target"]'), 'cell');
    ui.change(row().querySelector('[data-role="style"]'), 'redText');
    const s = ui.save();
    assert.ok(s, ui.err('errHl'));
    const r = s.ls.highlight.rules[0];
    assert.deepEqual({ code: r.code, op: r.op, value: r.value, target: r.target, style: r.style, type: r.type },
      { code: '金額', op: 'gte', value: '1000000', target: 'cell', style: 'redText', type: 'NUMBER' });
  });

  test('日付の条件は「今日から」と「日付を指定」（期間は選べない）', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('hlEnabled', true);
    ui.click('#hlAdd');
    const row = () => ui.$('#hlList .ls-item[data-ri="0"]');
    ui.change(row().querySelector('[data-role="field"]'), '契約開始日');
    ui.change(row().querySelector('[data-role="op"]'), 'lt');
    const kinds = Array.from(row().querySelectorAll('[data-role="dateKind"] option')).map((o) => o.value);
    assert.deepEqual(kinds, ['today', 'fixed']);
    const s = ui.save();
    assert.deepEqual(s.ls.highlight.rules[0].value, { kind: 'today', offset: 0 });
  });

  test('上限は 3 ルール。フィールド未選択のルールは保存しない', async () => {
    const ui = await open({ config: v1 });
    ui.toggle('hlEnabled', true);
    ui.click('#hlAdd'); ui.click('#hlAdd'); ui.click('#hlAdd');
    assert.equal(ui.$('#hlAdd').disabled, true);
    assert.equal(ui.save(), null);
    assert.match(ui.err('errHl'), /ルール 1 を確認してください/);
  });
});
