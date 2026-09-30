'use strict';

// 一覧サポートの共通ロジック（ls-core.js）の単体テスト

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../source/js/ls-core.js');

const BASE = 'https://example.cybozu.com/k/123/';

describe('検索条件の合成（composeQuery）', () => {
  test('1 つだけならそのまま（横断検索だけの従来の query と同じ）', () => {
    assert.equal(C.composeQuery(['((顧客名 like "東京"))']), '((顧客名 like "東京"))');
    assert.equal(C.composeQuery(['', null, 'a = 1', '  ']), 'a = 1');
  });
  test('2 つ以上は括弧で包んで AND（or を含む条件の優先順位が崩れない）', () => {
    assert.equal(C.composeQuery(['状態 in ("未対応")', '(a) or (b)']), '(状態 in ("未対応")) and ((a) or (b))');
  });
  test('何も無ければ空文字', () => {
    assert.equal(C.composeQuery([]), '');
    assert.equal(C.composeQuery(['', '']), '');
  });
});

describe('URL の状態（readUrlState / buildNavUrl）', () => {
  test('プラグインの条件が無い URL: query は標準の絞り込み（base）', () => {
    const s = C.readUrlState('?view=5&query=' + encodeURIComponent('状態 in ("未対応")'));
    assert.equal(s.base, '状態 in ("未対応")');
    assert.deepEqual(s.active, { kw: '', qf: {}, btn: '' });
    assert.equal(s.owned, false);
  });

  test('v1.0.1 の URL（nrc_q だけ）: base は空、検索語は適用中', () => {
    const s = C.readUrlState('?query=x&nrc_q=東京');
    assert.equal(s.base, '');
    assert.equal(s.active.kw, '東京');
    assert.equal(s.legacy, true);
  });

  test('nrc_mode だけ残った URL（解除後に標準の絞り込み）: query を base とみなす', () => {
    const s = C.readUrlState('?query=' + encodeURIComponent('a = 1') + '&nrc_mode=or');
    assert.equal(s.base, 'a = 1');
    assert.equal(s.mode, 'or');
    assert.equal(s.owned, false);
  });

  test('プラグインが作った URL を読み戻せる（base・検索語・フィルター・ボタン）', () => {
    const final = C.composeQuery(['a = 1', 'k like "x"', 'n >= 10', 'z in ("y")']);
    const url = C.buildNavUrl(BASE + '?view=5&offset=40&query=a', {
      base: 'a = 1', final, kw: 'x', mode: 'or', qf: { 金額: { from: '10' } }, btn: 'b1'
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get('view'), '5', 'view は保持');
    assert.equal(u.searchParams.get('offset'), null, 'offset は消す');
    const s = C.readUrlState(u.search);
    assert.equal(s.owned, true);
    assert.equal(s.base, 'a = 1');
    assert.equal(s.query, final);
    assert.deepEqual(s.active, { kw: 'x', qf: { 金額: { from: '10' } }, btn: 'b1' });
    assert.equal(s.mode, 'or');
  });

  test('利用者が標準の絞り込みで条件を変えた（署名が一致しない）: その条件を新しい base にし、プラグインの条件は外す', () => {
    const url = C.buildNavUrl(BASE, { base: '', final: 'k like "x"', kw: 'x', mode: 'and', qf: {}, btn: '' });
    const u = new URL(url);
    u.searchParams.set('query', 'k like "x" and 状態 in ("完了")'); // 標準の絞り込みで編集された
    const s = C.readUrlState(u.search);
    assert.equal(s.stale, true);
    assert.equal(s.base, 'k like "x" and 状態 in ("完了")');
    assert.deepEqual(s.active, { kw: '', qf: {}, btn: '' });
  });

  test('プラグインの条件をすべて外すと、元の URL の query（外部リンクなど）に戻し、nrc_* を消す', () => {
    const url = C.buildNavUrl(BASE + '?nrc_base=a&nrc_sig=zz&nrc_orig=a', { base: 'a = 1', orig: 'a = 1', final: 'a = 1', kw: '', mode: 'and', qf: {}, btn: '' });
    const u = new URL(url);
    assert.equal(u.searchParams.get('query'), 'a = 1');
    ['nrc_base', 'nrc_orig', 'nrc_sig', 'nrc_qsig', 'nrc_view'].forEach((k) => assert.equal(u.searchParams.get(k), null, k));
    const s = C.readUrlState(u.search);
    assert.equal(s.base, 'a = 1');
  });

  test('標準の絞り込み（q）だけだった一覧: 条件をすべて外すと query を消し、q はそのまま残す', () => {
    const url = C.buildNavUrl(BASE + '?view=5&q=' + encodeURIComponent('f1 in ("x")') + '&query=zz&nrc_sig=zz', { base: '状態 in ("x")', orig: '', final: '', kw: '', mode: 'and', qf: {}, btn: '' });
    const u = new URL(url);
    assert.equal(u.searchParams.get('query'), null);
    assert.equal(u.searchParams.get('q'), 'f1 in ("x")');
    assert.equal(u.searchParams.get('view'), '5');
  });

  test('base も条件も無ければ query を消す', () => {
    const url = C.buildNavUrl(BASE + '?query=x&nrc_q=y', { base: '', final: '', kw: '', mode: 'and', qf: {}, btn: '' });
    assert.equal(new URL(url).searchParams.get('query'), null);
  });

  describe('標準の絞り込み（q）と一覧（view）の変更を見分ける', () => {
    const Q = 'f123 in ("未対応")';
    const navUrl = () => C.buildNavUrl(BASE + '?view=5&q=' + encodeURIComponent(Q), {
      base: '状態 in ("未対応")', orig: '', final: '(状態 in ("未対応")) and (k like "x")', kw: 'x', mode: 'and', qf: {}, btn: ''
    });

    test('プラグインの条件を足しても q はそのまま残し、q と一覧の印を付ける', () => {
      const u = new URL(navUrl());
      assert.equal(u.searchParams.get('q'), Q);
      assert.equal(u.searchParams.get('nrc_view'), '5');
      assert.equal(u.searchParams.get('nrc_qsig'), C.hashQuery(Q));
      const s = C.readUrlState(u.search);
      assert.equal(s.owned, true);
      assert.equal(s.base, '状態 in ("未対応")');
      assert.equal(s.orig, '');
    });

    test('その後に標準の絞り込み（q）を変えた → reset（プラグインの条件を外して開き直す）', () => {
      const u = new URL(navUrl());
      u.searchParams.set('q', 'f123 in ("完了")');
      const s = C.readUrlState(u.search);
      assert.equal(s.reset, true);
      assert.equal(s.owned, false);
      assert.deepEqual(s.active, { kw: '', qf: {}, btn: '' });
    });

    test('標準の絞り込みを解除した（q が無くなった）→ reset', () => {
      const u = new URL(navUrl());
      u.searchParams.delete('q');
      assert.equal(C.readUrlState(u.search).reset, true);
    });

    test('別の一覧に切り替えた → reset。kintone が後から view を付けただけなら reset しない', () => {
      const u = new URL(navUrl());
      u.searchParams.set('view', '9');
      assert.equal(C.readUrlState(u.search).reset, true);

      const noView = new URL(C.buildNavUrl(BASE, { base: '', orig: '', final: 'k like "x"', kw: 'x', mode: 'and', qf: {}, btn: '' }));
      noView.searchParams.set('view', '9');
      assert.equal(C.readUrlState(noView.search).owned, true);
    });

    test('q の空白の違い（再エンコード）は同じとみなす', () => {
      const u = new URL(navUrl());
      u.searchParams.set('q', 'f123  in  ("未対応") ');
      assert.equal(C.readUrlState(u.search).owned, true);
    });

    test('2.0.0 MVP の URL（nrc_qsig・nrc_view なし）はこれまでどおり読める', () => {
      const u = new URL(navUrl());
      u.searchParams.delete('nrc_qsig');
      u.searchParams.delete('nrc_view');
      u.searchParams.set('q', 'f999 = "x"');
      assert.equal(C.readUrlState(u.search).owned, true);
    });

    test('開き直す URL: query とプラグインの条件を外し、q・view・AND/OR は残して印を付ける', () => {
      const u = new URL(C.buildResetUrl(navUrl() + '&offset=40'));
      assert.equal(u.searchParams.get('query'), null);
      ['nrc_q', 'nrc_qf', 'nrc_btn', 'nrc_base', 'nrc_orig', 'nrc_sig', 'nrc_qsig', 'nrc_view', 'offset'].forEach((k) => assert.equal(u.searchParams.get(k), null, k));
      assert.equal(u.searchParams.get('q'), Q);
      assert.equal(u.searchParams.get('view'), '5');
      assert.equal(u.searchParams.get('nrc_mode'), 'and');
      const s = C.readUrlState(u.search);
      assert.equal(s.resetNotice, true);
      assert.equal(s.reset, false);
      assert.equal(s.owned, false);
    });

    test('次にプラグインの条件を足すと、開き直しの印は消える', () => {
      const u = new URL(C.buildNavUrl(C.buildResetUrl(navUrl()), { base: '', orig: '', final: 'k like "y"', kw: 'y', mode: 'and', qf: {}, btn: '' }));
      assert.equal(u.searchParams.get('nrc_reset'), null);
    });
  });

  test('壊れた nrc_qf は無視する', () => {
    const s = C.readUrlState('?nrc_qf=%7Bbroken&nrc_q=a');
    assert.deepEqual(s.active.qf, {});
  });
});

describe('クイックボタンの条件（buildCondClause / buildButtonQuery）', () => {
  const meta = {
    状態: { type: 'DROP_DOWN', options: ['未対応', '対応中', '完了'] },
    担当者: { type: 'USER_SELECT' },
    期限: { type: 'DATE' },
    作成日時: { type: 'CREATED_TIME' },
    金額: { type: 'NUMBER' },
    件名: { type: 'SINGLE_LINE_TEXT' },
    本文: { type: 'MULTI_LINE_TEXT' },
    タグ: { type: 'CHECK_BOX', options: ['重要', '保留'] }
  };
  const clause = (code, op, value) => C.buildCondClause({ code, op, value }, meta[code]);

  test('選択肢: in / not in（存在しない選択肢は捨てる）', () => {
    assert.equal(clause('状態', 'in', ['未対応', '対応中']), '状態 in ("未対応", "対応中")');
    assert.equal(clause('状態', 'not_in', ['完了']), '状態 not in ("完了")');
    assert.equal(clause('状態', 'in', ['消えた選択肢']), null);
    assert.equal(clause('タグ', 'in', ['重要']), 'タグ in ("重要")');
  });
  test('ユーザー: 自分 / 自分ではない', () => {
    assert.equal(clause('担当者', 'me'), '担当者 in (LOGINUSER())');
    assert.equal(clause('担当者', 'not_me'), '担当者 not in (LOGINUSER())');
  });
  test('日付: 今日・今日から N 日・日付指定・期間', () => {
    assert.equal(clause('期限', 'lt', { kind: 'today', offset: 0 }), '期限 < TODAY()');
    assert.equal(clause('期限', 'lte', { kind: 'today', offset: 3 }), '期限 <= FROM_TODAY(3, DAYS)');
    assert.equal(clause('期限', 'gte', { kind: 'today', offset: -7 }), '期限 >= FROM_TODAY(-7, DAYS)');
    assert.equal(clause('期限', 'eq', { kind: 'fixed', date: '2026-09-30' }), '期限 = "2026-09-30"');
    assert.equal(clause('期限', 'eq', { kind: 'period', period: 'THIS_MONTH' }), '期限 = THIS_MONTH()');
    assert.equal(clause('作成日時', 'eq', { kind: 'period', period: 'THIS_WEEK' }), '作成日時 = THIS_WEEK()');
    assert.equal(clause('期限', 'lt', { kind: 'period', period: 'THIS_MONTH' }), null, '期間は「が（期間内）」だけ');
    assert.equal(clause('期限', 'eq', { kind: 'fixed', date: '2026-02-30' }), null, '存在しない日付');
  });
  test('数値: 比較演算子。数値でない値は作らない', () => {
    assert.equal(clause('金額', 'gte', '1000000'), '金額 >= 1000000');
    assert.equal(clause('金額', 'lt', '１，０００'), '金額 < 1000', '全角・桁区切りを直す');
    assert.equal(clause('金額', 'eq', 'abc'), null);
  });
  test('文字列: 含む・含まない・等しい（複数行は = を使えない）・空', () => {
    assert.equal(clause('件名', 'contains', '見積'), '件名 like "見積"');
    assert.equal(clause('件名', 'eq', 'a"b'), '件名 = "a\\"b"');
    assert.equal(clause('本文', 'eq', 'x'), null);
    assert.equal(clause('本文', 'not_contains', 'x'), '本文 not like "x"');
    assert.equal(clause('件名', 'empty'), '件名 is empty');
    assert.equal(clause('件名', 'contains', '  '), null);
  });
  test('ボタン: 条件は AND で結ぶ。作れない条件は数える', () => {
    const r = C.buildButtonQuery({ conds: [
      { code: '期限', op: 'lt', value: { kind: 'today', offset: 0 } },
      { code: '状態', op: 'not_in', value: ['完了'] },
      { code: '無いフィールド', op: 'in', value: ['a'] }
    ] }, meta);
    assert.equal(r.query, '(期限 < TODAY()) and (状態 not in ("完了"))');
    assert.equal(r.invalid, 1);
  });
});

describe('クイックフィルター（buildQuickFilterQuery）', () => {
  const items = [
    { code: '顧客名', type: 'SINGLE_LINE_TEXT' },
    { code: '状態', type: 'DROP_DOWN', options: ['未対応', '完了'] },
    { code: '金額', type: 'NUMBER' },
    { code: '期限', type: 'DATE' },
    { code: '更新日時', type: 'UPDATED_TIME' },
    { code: '担当者', type: 'USER_SELECT' }
  ];
  const meta = C.metaMapFrom(items);

  test('型ごとの条件を AND で結ぶ', () => {
    const r = C.buildQuickFilterQuery(items, {
      顧客名: '東京', 状態: '未対応', 金額: { from: '100', to: '500' }, 期限: { from: '2026-09-01', to: '2026-09-30' }, 担当者: 'me'
    }, meta);
    assert.equal(r.query, '顧客名 like "東京" and 状態 in ("未対応") and 金額 >= 100 and 金額 <= 500 and 期限 >= "2026-09-01" and 期限 <= "2026-09-30" and 担当者 in (LOGINUSER())');
    assert.deepEqual(r.problems, []);
  });

  test('日時は端末の日付の 0:00 から翌日 0:00 未満（UTC 表記）', () => {
    const r = C.buildQuickFilterQuery(items, { 更新日時: { from: '2026-09-01', to: '2026-09-30' } }, meta);
    const from = new Date(2026, 8, 1).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const to = new Date(2026, 9, 1).toISOString().replace(/\.\d{3}Z$/, 'Z');
    assert.equal(r.query, `更新日時 >= "${from}" and 更新日時 < "${to}"`);
  });

  test('数値でない値・選択肢に無い値は problems に出し、条件にしない', () => {
    const r = C.buildQuickFilterQuery(items, { 金額: { from: 'abc' }, 状態: '存在しない' }, meta);
    assert.equal(r.query, '');
    assert.deepEqual(r.problems.sort(), ['状態', '金額'].sort());
  });

  test('空の値は無視する', () => {
    const r = C.buildQuickFilterQuery(items, C.cleanQuickFilterValues({ 顧客名: '  ', 金額: { from: '', to: '' } }), meta);
    assert.equal(r.query, '');
  });
});

describe('条件付き装飾の判定（evaluateCond / evaluateHighlights）', () => {
  const now = new Date(2026, 8, 29, 10, 0, 0); // 2026-09-29 10:00（端末時刻）
  const meta = {
    期限: { type: 'DATE' }, 更新日時: { type: 'UPDATED_TIME' }, 金額: { type: 'NUMBER' }, 状態: { type: 'DROP_DOWN' },
    タグ: { type: 'CHECK_BOX' }, 担当者: { type: 'USER_SELECT' }, 件名: { type: 'SINGLE_LINE_TEXT' }, 説明: { type: 'RICH_TEXT' }
  };
  const rec = (o) => {
    const r = { $id: { type: '__ID__', value: String(o.id || 1) } };
    Object.keys(o).forEach((k) => { if (k !== 'id') r[k] = { type: meta[k] ? meta[k].type : 'X', value: o[k] }; });
    return r;
  };
  const ev = (cond, r) => C.evaluateCond(cond, r, meta[cond.code], { now, loginUserCode: 'sato' });

  test('期限 < 今日（空欄は一致しない）', () => {
    const c = { code: '期限', op: 'lt', value: { kind: 'today', offset: 0 } };
    assert.equal(ev(c, rec({ 期限: '2026-09-28' })), true);
    assert.equal(ev(c, rec({ 期限: '2026-09-29' })), false);
    assert.equal(ev(c, rec({ 期限: '' })), false);
  });
  test('期限 <= 今日から 3 日', () => {
    const c = { code: '期限', op: 'lte', value: { kind: 'today', offset: 3 } };
    assert.equal(ev(c, rec({ 期限: '2026-10-02' })), true);
    assert.equal(ev(c, rec({ 期限: '2026-10-03' })), false);
  });
  test('日時は端末の日付で比較する', () => {
    const today = { code: '更新日時', op: 'eq', value: { kind: 'today', offset: 0 } };
    const before = { code: '更新日時', op: 'lt', value: { kind: 'today', offset: -7 } };
    assert.equal(ev(today, rec({ 更新日時: new Date(2026, 8, 29, 0, 30).toISOString() })), true);
    assert.equal(ev(today, rec({ 更新日時: new Date(2026, 8, 28, 23, 59).toISOString() })), false);
    assert.equal(ev(before, rec({ 更新日時: new Date(2026, 8, 21, 23, 0).toISOString() })), true);
    assert.equal(ev(before, rec({ 更新日時: new Date(2026, 8, 22, 0, 0).toISOString() })), false);
  });
  test('数値・選択肢・複数選択・ユーザー・文字列', () => {
    assert.equal(ev({ code: '金額', op: 'gte', value: '1000000' }, rec({ 金額: '1000000' })), true);
    assert.equal(ev({ code: '金額', op: 'gte', value: '1000000' }, rec({ 金額: '999999.9' })), false);
    assert.equal(ev({ code: '状態', op: 'in', value: ['未対応'] }, rec({ 状態: '未対応' })), true);
    assert.equal(ev({ code: '状態', op: 'not_in', value: ['完了'] }, rec({ 状態: '完了' })), false);
    assert.equal(ev({ code: 'タグ', op: 'in', value: ['重要'] }, rec({ タグ: ['保留', '重要'] })), true);
    assert.equal(ev({ code: 'タグ', op: 'empty' }, rec({ タグ: [] })), true);
    assert.equal(ev({ code: '担当者', op: 'me' }, rec({ 担当者: [{ code: 'sato', name: '佐藤' }] })), true);
    assert.equal(ev({ code: '担当者', op: 'not_me' }, rec({ 担当者: [{ code: 'suzuki' }] })), true);
    assert.equal(ev({ code: '件名', op: 'contains', value: 'ABC' }, rec({ 件名: '見積abc' })), true, '大文字小文字を区別しない');
    assert.equal(ev({ code: '説明', op: 'contains', value: 'b' }, rec({ 説明: '<b>太字</b>' })), false, 'リッチエディターはタグを除いて比較');
  });
  test('フィールドが無いレコードは一致しない', () => {
    assert.equal(ev({ code: '金額', op: 'gte', value: '1' }, rec({})), false);
  });
  test('行は最初に一致したルール、セルは列ごとに最初に一致したルール', () => {
    const rules = [
      { code: '期限', op: 'lt', value: { kind: 'today', offset: 0 }, target: 'row', style: 'danger' },
      { code: '状態', op: 'in', value: ['未対応'], target: 'row', style: 'warning' },
      { code: '金額', op: 'gte', value: '1000000', target: 'cell', style: 'redText' }
    ];
    const out = C.evaluateHighlights(rules, [
      rec({ id: 1, 期限: '2026-09-01', 状態: '未対応', 金額: '2000000' }),
      rec({ id: 2, 期限: '2026-12-01', 状態: '未対応', 金額: '10' }),
      rec({ id: 3, 期限: '2026-12-01', 状態: '完了', 金額: '10' })
    ], meta, { now, loginUserCode: 'sato' });
    assert.deepEqual(out, [
      { recordId: '1', row: 'danger', cells: { 金額: 'redText' } },
      { recordId: '2', row: 'warning', cells: {} }
    ]);
  });
});

describe('集計（桁落ちしない合計・平均と書式）', () => {
  const accOf = (vals) => vals.reduce((a, v) => C.accumulate(a, v), C.createAccumulator());

  test('小数を含む合計が浮動小数点で崩れない（0.1 + 0.2 = 0.3）', () => {
    assert.equal(C.sumString(accOf(['0.1', '0.2'])), '0.3');
    assert.equal(C.sumString(accOf(['100', '200.5', '0.25'])), '300.75');
  });
  test('空欄と数値でない値は除き、件数を数える', () => {
    const a = accOf(['10', '', '#N/A!', '20']);
    assert.equal(a.count, 2);
    assert.equal(a.empty, 1);
    assert.equal(a.invalid, 1);
    assert.equal(C.averageString(a, 0), '15');
  });
  test('平均は四捨五入（負の数も）', () => {
    assert.equal(C.averageString(accOf(['1', '2']), 0), '2');
    assert.equal(C.averageString(accOf(['1', '1', '2']), 2), '1.33');
    assert.equal(C.averageString(accOf(['-1', '-2']), 0), '-2');
    assert.equal(C.averageString(C.createAccumulator(), 0), null, '0 件なら null');
  });
  test('大きな金額の合計（Number の精度を超えても正確）', () => {
    assert.equal(C.sumString(accOf(['9007199254740993', '1'])), '9007199254740994');
  });
  test('表示桁数: 小数点以下の表示桁数があればそれ、無ければデータの桁数', () => {
    assert.equal(C.displayDecimals({ displayScale: '2' }, accOf(['1'])), 2);
    assert.equal(C.displayDecimals({ displayScale: '' }, accOf(['1.5'])), 1);
    assert.equal(C.displayDecimals({}, accOf(['262083'])), 0);
  });
  test('桁区切りと単位（前・後）', () => {
    assert.equal(C.formatNumberDisplay('12580000', { unit: '円' }), '12,580,000円');
    assert.equal(C.formatNumberDisplay('-1234.5', { unit: '$', unitPosition: 'BEFORE' }), '$-1,234.5');
    assert.equal(C.formatNumberDisplay('48', {}), '48');
    assert.equal(C.formatNumberDisplay(null, {}), '―');
  });
});

describe('全件取得（fetchSummary）', () => {
  function makeApi(n, { totalCount } = {}) {
    const records = Array.from({ length: n }, (_, i) => ({ $id: { value: String(i + 1) }, 金額: { value: String((i + 1) * 10) } }));
    const calls = [];
    const getRecords = async (params) => {
      calls.push(params);
      const m = /\$id > (\d+)/.exec(params.query);
      const after = m ? Number(m[1]) : 0;
      const lim = Number(/limit (\d+)/.exec(params.query)[1]);
      const res = { records: records.filter((r) => Number(r.$id.value) > after).slice(0, lim) };
      if (params.totalCount) res.totalCount = String(totalCount !== undefined ? totalCount : n);
      return res;
    };
    return { getRecords, calls };
  }

  test('$id 順に送って全件を集計する（1,234 件 = 3 回）', async () => {
    const api = makeApi(1234);
    const r = await C.fetchSummary({ getRecords: api.getRecords, condition: '状態 in ("未対応") or 金額 > 0', items: [{ code: '金額', method: 'sum' }] });
    assert.equal(r.total, 1234);
    assert.equal(r.fetched, 1234);
    assert.equal(C.sumString(r.acc['金額']), String(10 * 1234 * 1235 / 2));
    assert.equal(api.calls.length, 3);
    assert.equal(api.calls[0].query, '(状態 in ("未対応") or 金額 > 0) order by $id asc limit 500');
    assert.equal(api.calls[1].query, '(状態 in ("未対応") or 金額 > 0) and $id > 500 order by $id asc limit 500');
    assert.deepEqual(api.calls[0].fields, ['$id', '金額']);
    assert.equal(api.calls[0].totalCount, true);
  });

  test('条件が空でも動く', async () => {
    const api = makeApi(3);
    const r = await C.fetchSummary({ getRecords: api.getRecords, condition: '', items: [{ code: '金額', method: 'avg' }] });
    assert.equal(api.calls[0].query, 'order by $id asc limit 500');
    assert.equal(C.averageString(r.acc['金額'], 0), '20');
  });

  test('集計項目が無ければ件数だけ（1 件だけ取得）', async () => {
    const api = makeApi(48);
    const r = await C.fetchSummary({ getRecords: api.getRecords, condition: '', items: [] });
    assert.equal(r.total, 48);
    assert.equal(api.calls.length, 1);
    assert.match(api.calls[0].query, /limit 1$/);
  });

  test('上限を超える件数では合計を計算しない（overLimit）', async () => {
    const api = makeApi(10, { totalCount: 10001 });
    const r = await C.fetchSummary({ getRecords: api.getRecords, condition: '', items: [{ code: '金額', method: 'sum' }] });
    assert.equal(r.overLimit, true);
    assert.equal(r.total, 10001);
    assert.equal(api.calls.length, 1);
  });

  test('API のエラーはそのまま呼び出し側へ返す（黙って 0 にしない）', async () => {
    await assert.rejects(C.fetchSummary({
      getRecords: async () => { throw { code: 'GAIA_IL23', message: 'クエリが不正です' }; },
      condition: 'x', items: [{ code: '金額', method: 'sum' }]
    }), (e) => e.code === 'GAIA_IL23');
  });

  test('条件が文字列でない（取得できなかった）ときは、全件を集計せずにエラーにする', async () => {
    for (const condition of [undefined, null]) {
      const api = makeApi(3);
      await assert.rejects(C.fetchSummary({ getRecords: api.getRecords, condition, items: [{ code: '金額', method: 'sum' }] }), /絞り込み条件を取得できない/);
      assert.equal(api.calls.length, 0);
    }
  });
});

describe('一覧の条件の読み取り（readCondition）', () => {
  test('文字列は取得できた扱い（空文字列＝絞り込みなし も含む）', () => {
    assert.deepEqual(C.readCondition(() => '状態 in ("未対応")'), { ok: true, condition: '状態 in ("未対応")' });
    assert.deepEqual(C.readCondition(() => ''), { ok: true, condition: '' });
  });

  test('例外・文字列以外・API なしは「取得できない」として理由を分ける', () => {
    const err = new Error('deleted user');
    assert.deepEqual(C.readCondition(() => { throw err; }), { ok: false, reason: 'error', error: err });
    assert.deepEqual(C.readCondition(() => null), { ok: false, reason: 'invalid' });
    assert.deepEqual(C.readCondition(() => undefined), { ok: false, reason: 'invalid' });
    assert.deepEqual(C.readCondition(null), { ok: false, reason: 'unavailable' });
  });
});

describe('設定の移行と保存（normalizeConfig / toSavedConfig）', () => {
  const v1 = {
    spaceJoin: 'or', maxTokens: '3',
    targetsJson: JSON.stringify([{ code: '顧客名', op: 'like' }]),
    fieldSnapshotJson: JSON.stringify([{ code: '顧客名', type: 'SINGLE_LINE_TEXT', op: 'like' }])
  };

  test('v1（横断検索）の設定: 横断検索だけを有効のまま引き継ぐ', () => {
    const c = C.normalizeConfig(v1);
    assert.equal(c.migratedFrom, 'v1');
    assert.equal(c.search.enabled, true);
    assert.equal(c.search.spaceJoin, 'or');
    assert.equal(c.search.maxTokens, 3);
    assert.deepEqual(c.search.targets, [{ code: '顧客名', op: 'like' }]);
    assert.equal(c.quickFilter.enabled, false);
    assert.equal(c.summary.enabled, false);
    assert.equal(c.highlight.enabled, false);
  });

  test('新規（設定なし）: 横断検索はオン、移行扱いにしない', () => {
    const c = C.normalizeConfig({});
    assert.equal(c.migratedFrom, null);
    assert.equal(c.search.enabled, true);
    assert.equal(c.search.maxTokens, 5);
  });

  test('保存形式: v1 のキーはそのまま、lsConfig を追加。読み戻すと同じ内容', () => {
    const c = C.normalizeConfig(v1);
    c.summary.enabled = true;
    c.summary.items = [{ code: '金額', label: '金額', type: 'NUMBER', unit: '円', method: 'sum' }];
    c.highlight.enabled = true;
    c.highlight.rules = [{ id: 'h1', code: '期限', op: 'lt', value: { kind: 'today', offset: 0 }, target: 'row', style: 'danger', type: 'DATE' }];
    const saved = C.toSavedConfig(c);
    assert.equal(saved.spaceJoin, 'or');
    assert.equal(saved.maxTokens, '3');
    assert.equal(saved.targetsJson, v1.targetsJson);
    const back = C.normalizeConfig(saved);
    assert.equal(back.migratedFrom, null);
    assert.equal(back.summary.enabled, true);
    assert.deepEqual(back.summary.items, [{ code: '金額', label: '金額', type: 'NUMBER', unit: '円', method: 'sum' }]);
    assert.deepEqual(back.highlight.rules[0].value, { kind: 'today', offset: 0 });
    assert.equal(back.highlight.rules[0].style, 'danger');
  });

  test('横断検索をオフにして保存しても、検索対象の設定は残る（再びオンにすると戻る）', () => {
    const c = C.normalizeConfig(v1);
    c.search.enabled = false;
    const back = C.normalizeConfig(C.toSavedConfig(c));
    assert.equal(back.search.enabled, false);
    assert.deepEqual(back.search.targets, [{ code: '顧客名', op: 'like' }]);
  });

  test('無料版の上限を超える項目は読み込み時に切り詰める', () => {
    const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const saved = {
      lsConfig: JSON.stringify({
        version: 2,
        quickFilter: { enabled: true, items: many(9, (i) => ({ code: `f${i}`, type: 'SINGLE_LINE_TEXT' })) },
        quickButtons: { enabled: true, items: many(9, (i) => ({ id: `b${i}`, label: `B${i}`, conds: many(5, () => ({ code: 'x', op: 'contains', value: 'a' })) })) },
        summary: { enabled: true, items: many(5, (i) => ({ code: `n${i}`, type: 'NUMBER', method: 'sum' })) },
        highlight: { enabled: true, rules: many(9, (i) => ({ code: `h${i}`, op: 'empty', style: 'danger' })) }
      })
    };
    const c = C.normalizeConfig(saved);
    assert.equal(c.quickFilter.items.length, C.LIMITS.free.quickFilter);
    assert.equal(c.quickButtons.items.length, C.LIMITS.free.quickButtons);
    assert.equal(c.quickButtons.items[0].conds.length, C.LIMITS.free.buttonConds);
    assert.equal(c.summary.items.length, C.LIMITS.free.summary);
    assert.equal(c.highlight.rules.length, C.LIMITS.free.highlight);
  });

  test('壊れた lsConfig は v1 として扱う（一覧画面を壊さない）', () => {
    const c = C.normalizeConfig({ ...v1, lsConfig: '{broken' });
    assert.equal(c.search.enabled, true);
    assert.equal(c.migratedFrom, 'v1');
  });

  test('未知の装飾名は「黄（注意）」に戻す', () => {
    const c = C.normalizeConfig({ lsConfig: JSON.stringify({ highlight: { enabled: true, rules: [{ code: 'a', op: 'empty', style: 'neon' }] } }) });
    assert.equal(c.highlight.rules[0].style, 'warning');
  });
});
