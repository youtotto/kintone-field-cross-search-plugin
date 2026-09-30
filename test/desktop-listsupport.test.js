'use strict';

// 一覧サポート: 検索条件の合成 / クイックフィルター / クイックボタン / 集計 / 条件付き装飾

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../source/js/ls-core.js');
const { loadDesktop, makeConfig, defaultFields, opts } = require('./helpers/load-desktop');

function lsFields() {
  return {
    ...defaultFields(),
    状態: { type: 'DROP_DOWN', code: '状態', label: '状態', options: opts(['未対応', '対応中', '完了']) },
    金額: { type: 'NUMBER', code: '金額', label: '金額', unit: '円', unitPosition: 'AFTER' },
    期限: { type: 'DATE', code: '期限', label: '期限' },
    担当者: { type: 'USER_SELECT', code: '担当者', label: '担当者' }
  };
}

/** 横断検索（顧客名）＋一覧サポートの設定 */
function lsConfig(parts = {}, searchCodes = ['顧客名']) {
  const base = makeConfig(searchCodes, { fields: lsFields() });
  const ls = {
    version: 2,
    search: { enabled: parts.search !== false },
    quickFilter: parts.quickFilter || { enabled: false, items: [] },
    quickButtons: parts.quickButtons || { enabled: false, items: [] },
    summary: parts.summary || { enabled: false, items: [] },
    highlight: parts.highlight || { enabled: false, rules: [] }
  };
  return { ...base, lsConfig: JSON.stringify(ls) };
}

const QF = {
  enabled: true,
  items: [
    { code: '顧客名', label: '顧客名', type: 'SINGLE_LINE_TEXT' },
    { code: '状態', label: '状態', type: 'DROP_DOWN', options: ['未対応', '対応中', '完了'] },
    { code: '金額', label: '金額', type: 'NUMBER' },
    { code: '期限', label: '期限', type: 'DATE' },
    { code: '担当者', label: '担当者', type: 'USER_SELECT' }
  ]
};

const QB = {
  enabled: true,
  items: [
    { id: 'b1', label: '未対応', conds: [{ code: '状態', op: 'in', value: ['未対応'] }], metas: [{ code: '状態', label: '状態', type: 'DROP_DOWN', options: ['未対応', '対応中', '完了'] }] },
    { id: 'b2', label: '期限超過', conds: [
      { code: '期限', op: 'lt', value: { kind: 'today', offset: 0 } },
      { code: '状態', op: 'not_in', value: ['完了'] }
    ], metas: [{ code: '期限', label: '期限', type: 'DATE' }, { code: '状態', label: '状態', type: 'DROP_DOWN', options: ['未対応', '対応中', '完了'] }] }
  ]
};

const SUM = { enabled: true, items: [{ code: '金額', label: '金額', type: 'NUMBER', method: 'sum' }, { code: '金額', label: '金額', type: 'NUMBER', method: 'avg' }] };

// 一覧の条件を取得できないときの案内（理由によらず同じ文面。原因は断定しない）
const CONDITION_MSG = '一覧の絞り込み条件を取得できませんでした。画面を再読み込みしてから、もう一度お試しください。解消しない場合は、標準の絞り込み条件を確認するか、アプリ管理者にお問い合わせください。';
const SUMMARY_MSG = '現在の絞り込み条件を読み取れないため、集計できません。画面を再読み込みしてから、もう一度お試しください。解消しない場合は、標準の絞り込み条件を確認するか、アプリ管理者にお問い合わせください。';

const q = (s) => '?' + new URLSearchParams(s).toString();
const rec = (id, o = {}) => {
  const r = { $id: { type: '__ID__', value: String(id) } };
  Object.entries(o).forEach(([k, v]) => { r[k] = { type: 'X', value: v }; });
  return r;
};

describe('検索条件の合成（標準の絞り込み＋横断検索）', () => {
  test('標準の絞り込みがある一覧で横断検索 → 絞り込みを残したまま AND で足す', async () => {
    const app = loadDesktop({ config: lsConfig(), currentFields: lsFields(), search: q({ view: '5', query: '状態 in ("未対応")' }) });
    await app.show();
    app.type('東京');
    app.searchBtn().click();
    const nav = app.lastNav();
    assert.equal(nav.query, '(状態 in ("未対応")) and (((顧客名 like "東京")))');
    assert.equal(nav.nrc_base, '状態 in ("未対応")');
    assert.ok(nav.nrc_sig);
    assert.equal(nav.params.get('view'), '5');
  });

  test('検索後の一覧: 検索語が入り、クリアすると標準の絞り込みだけに戻る', async () => {
    const first = loadDesktop({ config: lsConfig(), currentFields: lsFields(), search: q({ query: '状態 in ("未対応")' }) });
    await first.show();
    first.type('東京');
    first.searchBtn().click();

    const app = loadDesktop({ config: lsConfig(), currentFields: lsFields(), search: first.lastNav().url.search });
    await app.show();
    assert.equal(app.input().value, '東京');
    assert.equal(app.clearBtn().hidden, false);
    app.clearBtn().click();
    const nav = app.lastNav();
    assert.equal(nav.query, '状態 in ("未対応")');
    assert.equal(nav.nrc_q, null);
    assert.equal(nav.nrc_base, null);
    assert.equal(nav.nrc_sig, null);
  });

  test('検索後に標準の絞り込みで条件を変えた → その条件を新しい基準にし、検索語は適用中にしない', async () => {
    const first = loadDesktop({ config: lsConfig(), currentFields: lsFields() });
    await first.show();
    first.type('東京');
    first.searchBtn().click();
    const u = new URL(first.lastNav().url);
    u.searchParams.set('query', '((顧客名 like "東京")) and 状態 in ("完了")'); // 標準の絞り込みで編集

    const app = loadDesktop({ config: lsConfig(), currentFields: lsFields(), search: u.search });
    await app.show();
    assert.equal(app.input().value, '', '適用中の検索語として扱わない');
    assert.equal(app.clearBtn().hidden, true);
    app.type('営業');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '(((顧客名 like "東京")) and 状態 in ("完了")) and (((顧客名 like "営業")))');
  });
});

describe('標準の絞り込み（URL の q）がある一覧（2.0.0 MVP の実機 FAIL の再現）', () => {
  // kintone の標準の絞り込みは q に内部のフィールド ID で入る。query があると q は使われない（実機テストの結果から推定）ので、
  // kintone が実際に適用している条件（getQueryCondition）を base として query に含める必要がある
  const Q = 'f6000123 in ("未対応")';
  const STD = '状態 in ("未対応")';
  // q が URL にある間は、kintone はそれを適用している（query があれば query を適用）
  const applied = (u) => u.searchParams.get('query') || (u.searchParams.get('q') ? STD : '');

  test('標準の絞り込み＋横断検索: 標準の条件を残したまま AND で足す（期待 20 件 → 30 件になった不具合）', async () => {
    const app = loadDesktop({ config: lsConfig(), currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await app.show([rec(1)], { viewType: 'list' });
    app.type('東京');
    app.searchBtn().click();
    const nav = app.lastNav();
    assert.equal(nav.query, `(${STD}) and (((顧客名 like "東京")))`);
    assert.equal(nav.params.get('q'), Q, '標準の絞り込み（q）は残す');
    assert.equal(nav.nrc_base, STD);
    assert.equal(nav.params.get('nrc_orig'), null);
  });

  test('4 条件の組み合わせ（標準の絞り込み・横断検索・クイックフィルター・ボタン）でも標準の条件が残る（期待 5 件 → 7 件になった不具合）', async () => {
    const cfg = lsConfig({ quickFilter: QF, quickButtons: QB });
    const a1 = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await a1.show([rec(1)], { viewType: 'list' });
    a1.type('東京');
    a1.searchBtn().click();

    const a2 = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: a1.lastNav().url.search });
    await a2.show([rec(1)], { viewType: 'list' });
    a2.document.querySelector('#nrc-ls-qf [data-code="金額"] [data-part="from"]').value = '100000';
    a2.document.querySelector('#nrc-ls-qf [data-act="qf-apply"]').click();

    const a3 = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: a2.lastNav().url.search });
    await a3.show([rec(1)], { viewType: 'list' });
    a3.document.querySelector('#nrc-ls-qb button[data-id="b2"]').click();
    const nav = a3.lastNav();
    assert.equal(nav.query, `(${STD}) and (((顧客名 like "東京"))) and (金額 >= 100000) and ((期限 < TODAY()) and (状態 not in ("完了")))`);
    assert.equal((nav.query.match(/状態 in \("未対応"\)/g) || []).length, 1, '標準の条件は 1 回だけ（二重にしない）');
    assert.equal(nav.params.get('q'), Q);
  });

  test('プラグインの条件をすべて解除すると query を消し、標準の絞り込み（q）だけに戻る', async () => {
    const first = loadDesktop({ config: lsConfig(), currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await first.show([rec(1)], { viewType: 'list' });
    first.type('東京');
    first.searchBtn().click();

    const app = loadDesktop({ config: lsConfig(), currentFields: lsFields(), ls: { queryCondition: applied }, search: first.lastNav().url.search });
    await app.show([rec(1)], { viewType: 'list' });
    assert.equal(app.input().value, '東京');
    app.clearBtn().click();
    const nav = app.lastNav();
    assert.equal(nav.query, null);
    assert.equal(nav.params.get('q'), Q);
    assert.equal(nav.nrc_base, null);
  });

  test('一覧自体の絞り込み条件（view の条件）も残す', async () => {
    const app = loadDesktop({ config: lsConfig(), currentFields: lsFields(), ls: { queryCondition: '状態 not in ("完了")' }, search: q({ view: '7' }) });
    await app.show([rec(1)], { viewType: 'list' });
    app.type('東京');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '(状態 not in ("完了")) and (((顧客名 like "東京")))');
  });

  test('プラグインの条件の後に標準の絞り込みを変えた → プラグインの条件を外して開き直し、その旨を表示する', async () => {
    const first = loadDesktop({ config: lsConfig(), currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await first.show([rec(1)], { viewType: 'list' });
    first.type('東京');
    first.searchBtn().click();
    const changed = new URL(first.lastNav().url);
    changed.searchParams.set('q', 'f6000123 in ("完了")'); // 標準の絞り込みを変更（kintone は query を残したまま）

    const app = loadDesktop({ config: lsConfig(), currentFields: lsFields(), ls: { queryCondition: applied }, search: changed.search });
    await app.show([rec(1)], { viewType: 'list' });
    assert.equal(app.replaced.length, 1, 'location.replace で開き直す');
    const re = new URL(app.replaced[0]);
    assert.equal(re.searchParams.get('query'), null);
    assert.equal(re.searchParams.get('q'), 'f6000123 in ("完了")');
    assert.equal(re.searchParams.get('nrc_q'), null);
    assert.equal(re.searchParams.get('nrc_reset'), '1');
    assert.equal(app.roots(), 0, '開き直す前は画面を作らない');

    const after = loadDesktop({ config: lsConfig(), currentFields: lsFields(), ls: { queryCondition: applied }, search: re.search });
    await after.show([rec(1)], { viewType: 'list' });
    assert.equal(after.input().value, '');
    assert.match(after.statusText(), /標準の絞り込み（または一覧）が変わったため、一覧サポートの条件を解除して表示し直しました/);
    assert.equal(after.replaced.length, 0, '開き直しは 1 回だけ');
  });

  test('横断検索がオフでも、開き直しの案内はヘッダー領域に出す', async () => {
    const cfg = lsConfig({ search: false, quickButtons: QB });
    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: {}, search: q({ view: '5', q: Q, nrc_reset: '1' }) });
    await app.show([rec(1)], { viewType: 'list' });
    assert.match(app.document.getElementById('nrc-ls-notice').textContent, /一覧サポートの条件を解除して表示し直しました/);
  });

  test('条件を足した後の 2 回目の操作は、最初の base を使う（getQueryCondition にはプラグインの条件が含まれるため）', async () => {
    const cfg = lsConfig({ quickFilter: QF });
    const first = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await first.show([rec(1)], { viewType: 'list' });
    first.type('東京');
    first.searchBtn().click();

    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: first.lastNav().url.search });
    await app.show([rec(1)], { viewType: 'list' });
    app.document.querySelector('#nrc-ls-qf [data-code="状態"] [data-part="value"]').value = '対応中';
    app.document.querySelector('#nrc-ls-qf [data-act="qf-apply"]').click();
    assert.equal(app.lastNav().query, `(${STD}) and (((顧客名 like "東京"))) and (状態 in ("対応中"))`);
  });

  test('クイックフィルター・ボタンから始めても、標準の条件を残したまま AND で足す', async () => {
    const cfg = lsConfig({ quickFilter: QF, quickButtons: QB });
    const a = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await a.show([rec(1)], { viewType: 'list' });
    a.document.querySelector('#nrc-ls-qf [data-code="金額"] [data-part="from"]').value = '100000';
    a.document.querySelector('#nrc-ls-qf [data-act="qf-apply"]').click();
    assert.equal(a.lastNav().query, `(${STD}) and (金額 >= 100000)`);

    const b = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await b.show([rec(1)], { viewType: 'list' });
    b.document.querySelector('#nrc-ls-qb button[data-id="b1"]').click();
    assert.equal(b.lastNav().query, `(${STD}) and (状態 in ("未対応"))`);
    assert.equal(b.lastNav().params.get('q'), Q);
  });
});

describe('一覧の条件（getQueryCondition）を取得できないとき', () => {
  // 2.0.1 までは URL の query を基準に続けていたため、標準の絞り込み（q）を落とした query で開き直すことがあった。
  // 条件を新しく足す操作は、取得できなければ URL を変えずに中止する。記録した base で済む操作（解除など）は続ける
  const Q = 'f6000123 in ("未対応")';
  const STD = '状態 in ("未対応")';
  const applied = (u) => u.searchParams.get('query') || (u.searchParams.get('q') ? STD : '');
  const cfg = lsConfig({ quickFilter: QF, quickButtons: QB });

  /** 標準の絞り込みを付けた一覧で横断検索した後の URL（プラグインの条件が有効） */
  async function searchedUrl() {
    const first = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: applied }, search: q({ view: '5', q: Q }) });
    await first.show([rec(1)], { viewType: 'list' });
    first.type('東京');
    first.searchBtn().click();
    return first.lastNav().url;
  }

  test('標準の絞り込み（q）がある一覧で横断検索: URL を変えず、条件を欠落させた検索もしない。案内を出し、検索中にはしない', async () => {
    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: new Error('x') }, search: q({ view: '5', q: Q }) });
    await app.show([rec(1)], { viewType: 'list' });
    app.type('東京');
    app.searchBtn().click();
    app.key('Enter');
    assert.equal(app.navigations.length, 0, '開き直さない（location.href も replace も使わない）');
    assert.equal(app.statusText(), CONDITION_MSG);
    assert.doesNotMatch(app.statusText(), /検索中/);
    assert.equal(app.clearBtn().hidden, true, '適用済みの表示（クリア）を出さない');
  });

  test('クイックフィルター・クイックボタンでも同じ（URL を変えず、「解除」・押した状態にしない）', async () => {
    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: new Error('x') }, search: q({ view: '5', q: Q }) });
    await app.show([rec(1)], { viewType: 'list' });
    const qf = app.document.getElementById('nrc-ls-qf');
    qf.querySelector('[data-code="金額"] [data-part="from"]').value = '100000';
    qf.querySelector('[data-act="qf-apply"]').click();
    assert.equal(app.navigations.length, 0);
    assert.equal(qf.querySelector('[data-part="qf-note"]').textContent, CONDITION_MSG);
    assert.equal(qf.querySelector('[data-act="qf-clear"]').hidden, true);

    const b1 = app.document.querySelector('#nrc-ls-qb button[data-id="b1"]');
    b1.click();
    assert.equal(app.navigations.length, 0);
    assert.equal(b1.getAttribute('aria-pressed'), 'false');
    assert.equal(app.document.querySelector('#nrc-ls-qb [data-part="qb-note"]').textContent, CONDITION_MSG);
  });

  test('null（一覧画面以外で返る値）や API が無いときも「取得できない」として中止する', async () => {
    for (const ls of [{ queryCondition: null }, { queryConditionApi: false }]) {
      const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls, search: q({ view: '5', q: Q }) });
      await app.show([rec(1)], { viewType: 'list' });
      app.type('東京');
      app.searchBtn().click();
      assert.equal(app.navigations.length, 0);
      assert.equal(app.statusText(), CONDITION_MSG, '例外のときと同じ文面');
    }
  });

  test('案内の文面は理由（例外・null・API なし）によらず同じで、原因を断定しない（検索・クイックフィルター・ボタン・集計）', async () => {
    const withSum = lsConfig({ quickFilter: QF, quickButtons: QB, summary: SUM });
    for (const ls of [{ queryCondition: new Error('x') }, { queryCondition: null }, { queryConditionApi: false }]) {
      const app = loadDesktop({ config: withSum, currentFields: lsFields(), ls: { ...ls, records: [] }, search: q({ view: '5', q: Q }) });
      await app.show([rec(1)], { viewType: 'list' });
      await app.idle();
      app.type('東京');
      app.searchBtn().click();
      app.document.querySelector('#nrc-ls-qf [data-code="金額"] [data-part="from"]').value = '100000';
      app.document.querySelector('#nrc-ls-qf [data-act="qf-apply"]').click();
      app.document.querySelector('#nrc-ls-qb button[data-id="b1"]').click();
      const notes = [
        app.statusText(),
        app.document.querySelector('#nrc-ls-qf [data-part="qf-note"]').textContent,
        app.document.querySelector('#nrc-ls-qb [data-part="qb-note"]').textContent
      ];
      notes.forEach((t) => assert.equal(t, CONDITION_MSG));
      assert.equal(app.summaryText(), SUMMARY_MSG);
      [...notes, app.summaryText()].forEach((t) => assert.doesNotMatch(t, /削除/, '原因を断定しない'));
      assert.equal(app.navigations.length, 0);
      assert.equal(app.apiCalls.length, 0);
    }
  });

  test('query が外から変わった URL（プラグインの条件として扱わない）でも、取得できなければ中止する', async () => {
    const u = await searchedUrl();
    u.searchParams.set('query', '金額 > 0'); // 署名と合わない
    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: new Error('x') }, search: u.search });
    await app.show([rec(1)], { viewType: 'list' });
    app.type('大阪');
    app.searchBtn().click();
    assert.equal(app.navigations.length, 0);
    assert.equal(app.statusText(), CONDITION_MSG);
  });

  test('空文字列は「絞り込みなし」として取得できた扱い: 検索語だけで検索する', async () => {
    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: '' }, search: q({ view: '5' }) });
    await app.show([rec(1)], { viewType: 'list' });
    app.type('東京');
    app.searchBtn().click();
    const nav = app.lastNav();
    assert.equal(nav.query, '((顧客名 like "東京"))');
    assert.equal(nav.nrc_base, null);
    assert.ok(nav.nrc_sig);
  });

  test('プラグインの条件が有効なら記録した base を使うので、取得できなくても追加・解除・AND/OR の切り替えができる（標準の条件は残る）', async () => {
    const u = await searchedUrl();
    const load = async (search) => {
      const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: new Error('x') }, search });
      await app.show([rec(1)], { viewType: 'list' });
      return app;
    };

    const add = await load(u.search);
    add.document.querySelector('#nrc-ls-qf [data-code="金額"] [data-part="from"]').value = '100000';
    add.document.querySelector('#nrc-ls-qf [data-act="qf-apply"]').click();
    assert.equal(add.lastNav().query, `(${STD}) and (((顧客名 like "東京"))) and (金額 >= 100000)`);
    assert.equal(add.queryConditionCalls(), 0, '取り直さない');

    const qfClear = await load(add.lastNav().url.search);
    qfClear.document.querySelector('#nrc-ls-qf [data-act="qf-clear"]').click();
    assert.equal(qfClear.lastNav().query, `(${STD}) and (((顧客名 like "東京")))`);

    const mode = await load(u.search);
    mode.modeBtn('or').click();
    assert.equal(mode.lastNav().nrc_mode, 'or');
    assert.equal(mode.lastNav().query, `(${STD}) and (((顧客名 like "東京")))`);

    const clear = await load(u.search);
    clear.clearBtn().click();
    assert.equal(clear.lastNav().query, null, 'query を消して標準の絞り込み（q）に戻す');
    assert.equal(clear.lastNav().params.get('q'), Q);
    assert.equal(clear.queryConditionCalls(), 0);
  });

  test('一覧の切り替え・標準の絞り込みの変更による開き直しは、取得できなくても動く', async () => {
    const changed = await searchedUrl();
    changed.searchParams.set('view', '6'); // 一覧を切り替えた（kintone が query などを残した場合）
    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: { queryCondition: new Error('x') }, search: changed.search });
    await app.show([rec(1)], { viewType: 'list' });
    assert.equal(app.replaced.length, 1);
    const re = new URL(app.replaced[0]);
    assert.equal(re.searchParams.get('query'), null);
    assert.equal(re.searchParams.get('view'), '6');
    assert.equal(re.searchParams.get('nrc_reset'), '1');
  });
});

describe('クイックフィルター', () => {
  const config = lsConfig({ quickFilter: QF });

  test('ヘッダー領域に型ごとの入力欄が並ぶ', async () => {
    const app = loadDesktop({ config, currentFields: lsFields(), ls: {} });
    await app.show([rec(1)], { viewType: 'list' });
    const row = app.document.getElementById('nrc-ls-qf');
    assert.ok(row);
    const groups = Array.from(row.querySelectorAll('.nrc-ls__item')).map((w) => `${w.dataset.code}:${w.dataset.group}`);
    assert.deepEqual(groups, ['顧客名:text', '状態:select', '金額:number', '期限:date', '担当者:user']);
    const opts2 = Array.from(row.querySelectorAll('[data-code="状態"] option')).map((o) => o.value);
    assert.deepEqual(opts2, ['', '未対応', '対応中', '完了'], '選択肢は kintone の並び順');
  });

  test('入力して「絞り込む」→ 条件を AND で足して一覧を開き直す。開き直した後も入力が残る', async () => {
    const app = loadDesktop({ config, currentFields: lsFields(), ls: {}, search: q({ query: 'レコード番号 > 10' }) });
    await app.show([rec(1)], { viewType: 'list' });
    const row = app.document.getElementById('nrc-ls-qf');
    row.querySelector('[data-code="顧客名"] [data-part="value"]').value = '東京';
    row.querySelector('[data-code="状態"] [data-part="value"]').value = '未対応';
    row.querySelector('[data-code="金額"] [data-part="from"]').value = '1000';
    row.querySelector('[data-code="担当者"] [data-part="value"]').value = 'me';
    row.querySelector('[data-act="qf-apply"]').click();
    const nav = app.lastNav();
    assert.equal(nav.query, '(レコード番号 > 10) and (顧客名 like "東京" and 状態 in ("未対応") and 金額 >= 1000 and 担当者 in (LOGINUSER()))');
    assert.deepEqual(JSON.parse(nav.nrc_qf), { 顧客名: '東京', 状態: '未対応', 金額: { from: '1000' }, 担当者: 'me' });

    const again = loadDesktop({ config, currentFields: lsFields(), ls: {}, search: nav.url.search });
    await again.show([rec(1)], { viewType: 'list' });
    const row2 = again.document.getElementById('nrc-ls-qf');
    assert.equal(row2.querySelector('[data-code="顧客名"] [data-part="value"]').value, '東京');
    assert.equal(row2.querySelector('[data-code="金額"] [data-part="from"]').value, '1000');
    assert.equal(row2.querySelector('[data-act="qf-clear"]').hidden, false);
    row2.querySelector('[data-act="qf-clear"]').click();
    assert.equal(again.lastNav().query, 'レコード番号 > 10', '解除すると標準の絞り込みだけ');
    assert.equal(again.lastNav().nrc_qf, null);
  });

  test('Enter でも絞り込める（変換確定の Enter では絞り込まない）', async () => {
    const app = loadDesktop({ config, currentFields: lsFields(), ls: {} });
    await app.show([rec(1)], { viewType: 'list' });
    const input = app.document.querySelector('#nrc-ls-qf [data-code="顧客名"] [data-part="value"]');
    input.value = '大阪';
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    assert.equal(app.navigations.length, 0);
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(app.navigations.length, 1);
    assert.equal(app.lastNav().query, '顧客名 like "大阪"');
  });

  test('数値でない値は一覧を開き直さず、入力の確認を促す', async () => {
    const app = loadDesktop({ config, currentFields: lsFields(), ls: {} });
    await app.show([rec(1)], { viewType: 'list' });
    const row = app.document.getElementById('nrc-ls-qf');
    // number 型の input は数値以外を受け付けないため、type を変えて不正値を再現する
    const from = row.querySelector('[data-code="金額"] [data-part="from"]');
    from.type = 'text';
    from.value = 'abc';
    row.querySelector('[data-act="qf-apply"]').click();
    assert.equal(app.navigations.length, 0);
    assert.match(row.querySelector('[data-part="qf-note"]').textContent, /金額/);
  });

  test('横断検索とクイックフィルターを同時に使える（どちらを解除してももう一方は残る）', async () => {
    const app = loadDesktop({ config, currentFields: lsFields(), ls: {}, search: q({ query: '((顧客名 like "東京"))', nrc_q: '東京', nrc_mode: 'and' }) });
    await app.show([rec(1)], { viewType: 'list' });
    app.document.querySelector('#nrc-ls-qf [data-code="状態"] [data-part="value"]').value = '完了';
    app.document.querySelector('#nrc-ls-qf [data-act="qf-apply"]').click();
    const nav = app.lastNav();
    assert.equal(nav.query, '(((顧客名 like "東京"))) and (状態 in ("完了"))');

    const next = loadDesktop({ config, currentFields: lsFields(), ls: {}, search: nav.url.search });
    await next.show([rec(1)], { viewType: 'list' });
    next.clearBtn().click(); // 横断検索だけ解除
    assert.equal(next.lastNav().query, '状態 in ("完了")');
    assert.equal(next.lastNav().nrc_q, null);
  });
});

describe('クイックボタン', () => {
  const config = lsConfig({ quickButtons: QB });

  test('押すとその条件で絞り込み、もう一度押すと解除', async () => {
    const app = loadDesktop({ config, currentFields: lsFields(), ls: {} });
    await app.show([rec(1)], { viewType: 'list' });
    const btns = Array.from(app.document.querySelectorAll('#nrc-ls-qb button'));
    assert.deepEqual(btns.map((b) => b.textContent), ['未対応', '期限超過']);
    btns[1].click();
    const nav = app.lastNav();
    assert.equal(nav.nrc_btn, 'b2');
    assert.equal(nav.query, '(期限 < TODAY()) and (状態 not in ("完了"))');

    const again = loadDesktop({ config, currentFields: lsFields(), ls: {}, search: nav.url.search });
    await again.show([rec(1)], { viewType: 'list' });
    const pressed = again.document.querySelector('#nrc-ls-qb button[data-id="b2"]');
    assert.equal(pressed.getAttribute('aria-pressed'), 'true');
    pressed.click();
    assert.equal(again.lastNav().nrc_btn, null);
    assert.equal(again.lastNav().query, null);
  });

  test('別のボタンを押すと切り替わる（同時に 1 つ）', async () => {
    const app = loadDesktop({ config, currentFields: lsFields(), ls: {} });
    await app.show([rec(1)], { viewType: 'list' });
    app.document.querySelector('#nrc-ls-qb button[data-id="b1"]').click();
    const next = loadDesktop({ config, currentFields: lsFields(), ls: {}, search: app.lastNav().url.search });
    await next.show([rec(1)], { viewType: 'list' });
    next.document.querySelector('#nrc-ls-qb button[data-id="b2"]').click();
    assert.equal(next.lastNav().nrc_btn, 'b2');
    assert.equal(next.lastNav().query, '(期限 < TODAY()) and (状態 not in ("完了"))');
  });

  test('条件のフィールドが消えたボタンは押せない', async () => {
    const fields = lsFields();
    delete fields['期限'];
    const app = loadDesktop({ config, currentFields: fields, ls: {} });
    await app.show([rec(1)], { viewType: 'list' });
    assert.equal(app.document.querySelector('#nrc-ls-qb button[data-id="b1"]').disabled, false);
    assert.equal(app.document.querySelector('#nrc-ls-qb button[data-id="b2"]').disabled, true);
  });

  test('標準の絞り込み＋横断検索＋クイックフィルター＋ボタンを 1 つの条件にまとめる', async () => {
    const cfg = lsConfig({ quickFilter: QF, quickButtons: QB });
    const app = loadDesktop({ config: cfg, currentFields: lsFields(), ls: {}, search: q({ query: 'レコード番号 > 10' }) });
    await app.show([rec(1)], { viewType: 'list' });
    app.type('東京');
    app.searchBtn().click();
    let u = app.lastNav().url.search;

    const a2 = loadDesktop({ config: cfg, currentFields: lsFields(), ls: {}, search: u });
    await a2.show([rec(1)], { viewType: 'list' });
    a2.document.querySelector('#nrc-ls-qf [data-code="金額"] [data-part="to"]').value = '500';
    a2.document.querySelector('#nrc-ls-qf [data-act="qf-apply"]').click();
    u = a2.lastNav().url.search;

    const a3 = loadDesktop({ config: cfg, currentFields: lsFields(), ls: {}, search: u });
    await a3.show([rec(1)], { viewType: 'list' });
    a3.document.querySelector('#nrc-ls-qb button[data-id="b1"]').click();
    assert.equal(a3.lastNav().query, '(レコード番号 > 10) and (((顧客名 like "東京"))) and (金額 <= 500) and (状態 in ("未対応"))');
    assert.equal(a3.lastNav().nrc_base, 'レコード番号 > 10');
  });
});

describe('集計', () => {
  const records = [rec(1, { 金額: '100' }), rec(2, { 金額: '200' }), rec(3, { 金額: '' }), rec(4, { 金額: '300' })];

  test('現在の条件（getQueryCondition）で全件を取り、件数・合計・平均を表示する', async () => {
    const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: lsFields(), ls: { queryCondition: '状態 in ("未対応")', records } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    // 画面では区切り（｜）の前後に余白が付く（CSS の gap）。textContent では詰まる
    assert.equal(app.summaryText(), '4件｜金額 合計 600円｜金額 平均 200円（空欄1件を除く）');
    assert.equal(app.apiCalls[0].params.query, '(状態 in ("未対応")) order by $id asc limit 500');
    assert.deepEqual(app.apiCalls[0].params.fields, ['$id', '金額']);
    assert.equal(app.apiCalls[0].params.app, 123);
  });

  test('ページ送り・並べ替え（同じ条件での再発火）では取り直さない', async () => {
    const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: lsFields(), ls: { queryCondition: '', records } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    const calls = app.apiCalls.length;
    await app.show([rec(2)], { viewType: 'list' });
    await app.idle();
    assert.equal(app.apiCalls.length, calls);
    assert.match(app.summaryText(), /^4件/);
  });

  test('上限（10,000件）を超えると合計・平均を出さず、そのことを表示する', async () => {
    const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: lsFields(), ls: { queryCondition: '', records, totalCount: 12000 } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    assert.equal(app.summaryText(), '12,000件（10,000件を超えるため、合計・平均は表示しません。条件を絞り込んでください）');
  });

  test('API のエラーは黙って 0 にせず、理由を表示する', async () => {
    const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: lsFields(), ls: { queryCondition: '', records, apiError: { code: 'CB_NO02', message: '権限がありません。' } } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    assert.equal(app.summaryText(), '集計できませんでした（権限がありません。）。');
  });

  test('条件を読み取れない（例外）ときは集計せず、集計できない旨と対処を表示する（0 件や全件の集計を出さない）', async () => {
    const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: lsFields(), ls: { queryCondition: new Error('x'), records } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    assert.equal(app.summaryText(), SUMMARY_MSG);
    assert.equal(app.apiCalls.length, 0, 'レコードを取りに行かない');
  });

  test('null（一覧画面以外で返る値）や API が無いときも集計しない。欄は隠さず理由を出す', async () => {
    for (const ls of [{ queryCondition: null, records }, { queryConditionApi: false, records }]) {
      const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: lsFields(), ls });
      await app.show([rec(1)], { viewType: 'list' });
      await app.idle();
      assert.equal(app.document.getElementById('nrc-ls-summary').hidden, false);
      assert.equal(app.summaryText(), SUMMARY_MSG);
      assert.equal(app.apiCalls.length, 0);
    }
  });

  test('集計項目が無ければ件数だけ。数値でなくなったフィールドは集計しないと明示', async () => {
    const fields = lsFields();
    fields['金額'] = { type: 'SINGLE_LINE_TEXT', code: '金額', label: '金額' };
    const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: fields, ls: { queryCondition: '', records } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    assert.equal(app.summaryText(), '4件（集計できないフィールド：金額、金額）');
  });

  test('カレンダー表示では集計しない', async () => {
    const app = loadDesktop({ config: lsConfig({ summary: SUM }), currentFields: lsFields(), ls: { queryCondition: '', records } });
    await app.show([rec(1)], { viewType: 'calendar' });
    await app.idle();
    assert.equal(app.apiCalls.length, 0);
  });
});

describe('条件付き装飾', () => {
  const today = C.localDateString(new Date());
  const yesterday = C.addDays(today, -1);
  const HL = {
    enabled: true,
    rules: [
      { id: 'h1', code: '期限', op: 'lt', value: { kind: 'today', offset: 0 }, target: 'row', style: 'danger', type: 'DATE' },
      { id: 'h2', code: '金額', op: 'gte', value: '1000000', target: 'cell', style: 'redText', type: 'NUMBER' }
    ]
  };
  const records = [
    rec(11, { 期限: yesterday, 金額: '2000000', 顧客名: 'A' }),
    rec(12, { 期限: today, 金額: '10', 顧客名: 'B' }),
    rec(13, { 期限: today, 金額: '1000000', 顧客名: 'C' })
  ];

  test('公式 API（setRecordListStyle）で行・セルを装飾する', async () => {
    const app = loadDesktop({ config: lsConfig({ highlight: HL }), currentFields: lsFields(), ls: { viewFields: ['顧客名', '期限', '金額'] } });
    await app.show(records, { viewType: 'list' });
    await app.idle();
    assert.equal(app.listStyleCalls.length, 1);
    const body = app.listStyleCalls[0].body;
    assert.deepEqual(body.map((b) => b.recordId), ['11', '13']);
    const r11 = Object.fromEntries(body[0].style.map((s) => [`${s.columnType}:${s.column}`, s]));
    assert.deepEqual(r11['FIELD:顧客名'].background, { backgroundColor: '#FDE2E1' });
    assert.deepEqual(r11['FIELD:金額'].content, { color: '#B91C1C', fontWeight: 'bold' }, 'セルのルールが行より優先');
    assert.equal(r11['FIELD:金額'].background, undefined);
    assert.deepEqual(r11['ACTION:OPEN_DETAIL'].background, { backgroundColor: '#FDE2E1' });
    const r13 = body[1].style;
    assert.deepEqual(r13.map((s) => s.column), ['金額'], '一致したセルだけ');
  });

  test('どのレコードも一致しなければ装飾を消す（DEFAULT）', async () => {
    const app = loadDesktop({ config: lsConfig({ highlight: HL }), currentFields: lsFields(), ls: { viewFields: ['顧客名'] } });
    await app.show([rec(12, { 期限: today, 金額: '1' })], { viewType: 'list' });
    await app.idle();
    assert.deepEqual(app.listStyleCalls[0], { body: 'DEFAULT' });
  });

  test('公式 API が無い環境では一覧のセル要素で装飾する', async () => {
    const app = loadDesktop({ config: lsConfig({ highlight: HL }), currentFields: lsFields(), ls: { viewFields: ['顧客名', '金額'], listStyle: false, fieldElements: true } });
    const tbody = app.document.createElement('tbody');
    records.forEach((r) => {
      const tr = app.document.createElement('tr');
      ['顧客名', '金額'].forEach((code) => { const td = app.document.createElement('td'); td.dataset.code = code; tr.append(td); });
      tbody.append(tr);
    });
    app.document.body.append(tbody);
    await app.show(records, { viewType: 'list' });
    await app.idle();
    const cells = Array.from(tbody.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((td) => td.style.backgroundColor || td.style.color || ''));
    assert.equal(cells[0][0], 'rgb(253, 226, 225)', '1 行目は行全体が赤');
    assert.equal(cells[0][1], 'rgb(185, 28, 28)', '金額セルは赤字');
    assert.equal(cells[1][0], '');
  });
});

describe('既存の横断検索だけの設定（v1）', () => {
  test('一覧サポートの領域は作らない（見た目は v1 のまま）', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']), ls: { queryCondition: '', records: [] } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    assert.equal(app.document.getElementById('nrc-ls-root'), null);
    assert.equal(app.roots(), 1, '横断検索は表示');
    assert.equal(app.apiCalls.length, 0);
    assert.equal(app.listStyleCalls.length, 0);
  });

  test('横断検索をオフにした設定では検索バーを出さない', async () => {
    const app = loadDesktop({ config: lsConfig({ search: false, summary: SUM }), currentFields: lsFields(), ls: { queryCondition: '', records: [] } });
    await app.show([rec(1)], { viewType: 'list' });
    await app.idle();
    assert.equal(app.roots(), 0);
    assert.ok(app.document.getElementById('nrc-ls-summary'));
  });
});
