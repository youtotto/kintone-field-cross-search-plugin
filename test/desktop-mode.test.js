'use strict';

// AND / OR を一覧画面で利用者が切り替える（初期値: URL > プラグイン設定 > AND）

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadDesktop, makeConfig } = require('./helpers/load-desktop');

const cfgAnd = makeConfig(['顧客名'], { spaceJoin: 'and' });
const cfgOr = makeConfig(['顧客名'], { spaceJoin: 'or' });
const cfgNone = (() => { const c = makeConfig(['顧客名']); delete c.spaceJoin; return c; })();

const Q_AND = '((顧客名 like "東京")) and ((顧客名 like "営業"))';
const Q_OR = '((顧客名 like "東京")) or ((顧客名 like "営業"))';

describe('初期値', () => {
  test('設定 AND → 初期 AND', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['and']);
  });
  test('設定 OR → 初期 OR', async () => {
    const app = loadDesktop({ config: cfgOr });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['or']);
  });
  test('設定なし → AND', async () => {
    const app = loadDesktop({ config: cfgNone });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['and']);
  });
});

describe('URL からの復元（URL > プラグイン設定 > AND）', () => {
  test('nrc_mode=or → OR（設定が AND でも URL を優先）', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?nrc_mode=or' });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['or']);
  });
  test('nrc_mode=and → AND（設定が OR でも URL を優先）', async () => {
    const app = loadDesktop({ config: cfgOr, search: '?nrc_mode=and' });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['and']);
  });
  test('nrc_mode=xxx（不正）→ プラグイン設定へフォールバック', async () => {
    const a = loadDesktop({ config: cfgOr, search: '?nrc_mode=xxx' });
    await a.show();
    assert.deepEqual(a.pressedModes(), ['or']);
    const b = loadDesktop({ config: cfgAnd, search: '?nrc_mode=xxx' });
    await b.show();
    assert.deepEqual(b.pressedModes(), ['and']);
  });
  test('nrc_mode=OR（大文字）は不正扱い → 設定値', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?nrc_mode=OR' });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['and']);
  });
  test('不正な URL 値・設定なし → AND', async () => {
    const app = loadDesktop({ config: cfgNone, search: '?nrc_mode=xxx' });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['and']);
  });
});

describe('ユーザー切替と検索実行', () => {
  test('AND のまま「東京 営業」→ 条件1 and 条件2、URL に nrc_mode=and', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    app.type('東京 営業');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, Q_AND);
    assert.equal(app.lastNav().nrc_mode, 'and');
    assert.equal(app.lastNav().nrc_q, '東京 営業');
  });

  test('AND → OR に切り替えて検索 → 条件1 or 条件2、URL に nrc_mode=or', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    app.modeBtn('or').click();
    assert.deepEqual(app.pressedModes(), ['or']);
    assert.equal(app.navigations.length, 0, '未検索時の切替では再読込しない');
    app.type('東京 営業');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, Q_OR);
    assert.equal(app.lastNav().nrc_mode, 'or');
  });

  test('OR → AND に切り替えて検索 → and で結合', async () => {
    const app = loadDesktop({ config: cfgOr });
    await app.show();
    app.modeBtn('and').click();
    assert.deepEqual(app.pressedModes(), ['and']);
    app.type('東京 営業');
    app.key('Enter');
    assert.equal(app.lastNav().query, Q_AND);
    assert.equal(app.lastNav().nrc_mode, 'and');
  });

  test('同じモードを押し直しても何も起きない', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?query=x&nrc_q=東京 営業&nrc_mode=and' });
    await app.show();
    app.modeBtn('and').click();
    assert.equal(app.navigations.length, 0);
  });

  test('設定値（プラグイン設定）は切替で変更されない = 別ページを新規に開けば設定値に戻る', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    app.modeBtn('or').click();
    const fresh = loadDesktop({ config: cfgAnd });
    await fresh.show();
    assert.deepEqual(fresh.pressedModes(), ['and']);
  });
});

describe('検索中の切替: トグルと適用中表示を常に一致させる', () => {
  test('検索中（AND）に OR を押す → 適用中の語のまま OR で検索し直す', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?view=20&query=x&nrc_q=東京 営業&nrc_mode=and' });
    await app.show();
    assert.match(app.statusText(), /検索中: 東京 営業 \/ AND（すべて含む）/);
    app.type('入力途中の別の語'); // 入力欄ではなく、適用中の検索語で再検索する
    app.modeBtn('or').click();
    assert.equal(app.navigations.length, 1);
    assert.equal(app.lastNav().query, Q_OR);
    assert.equal(app.lastNav().nrc_q, '東京 営業');
    assert.equal(app.lastNav().nrc_mode, 'or');
    assert.equal(app.lastNav().params.get('view'), '20');
  });

  test('再読込後: トグル OR と「検索中: … / OR（いずれかを含む）」が一致', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?query=x&nrc_q=東京 営業&nrc_mode=or' });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['or']);
    assert.match(app.statusText(), /検索中: 東京 営業 \/ OR（いずれかを含む）/);
  });

  test('nrc_mode の無い旧 URL（v1.0.0 で検索した URL）: 設定値のモードで表示', async () => {
    const app = loadDesktop({ config: cfgOr, search: '?query=x&nrc_q=東京 営業' });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['or']);
    assert.match(app.statusText(), /\/ OR/);
  });
});

describe('再発火', () => {
  test('index.show を 3 回発火してもモード維持・トグル可能・二重登録なし', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    app.modeBtn('or').click();
    await app.show();
    await app.show();
    assert.deepEqual(app.pressedModes(), ['or'], '利用者の選択が初期値に戻らない');

    app.modeBtn('and').click();
    assert.deepEqual(app.pressedModes(), ['and']);
    app.modeBtn('or').click();
    assert.deepEqual(app.pressedModes(), ['or']);

    app.type('東京 営業');
    app.searchBtn().click();
    assert.equal(app.navigations.length, 1, '検索は 1 回だけ');
    assert.equal(app.lastNav().query, Q_OR);
  });

  test('ヘッダー領域が作り直された後も、選択中のモードで UI が復元される', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    app.modeBtn('or').click();
    app.recreateHeaderSpace();
    await app.show();
    assert.deepEqual(app.pressedModes(), ['or']);
    app.modeBtn('and').click();
    assert.deepEqual(app.pressedModes(), ['and']);
  });

  test('検索中の再発火（ページング・ソート相当）: URL のモードと表示が維持される', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?query=x&nrc_q=東京 営業&nrc_mode=or&offset=20' });
    await app.show(); await app.show();
    assert.deepEqual(app.pressedModes(), ['or']);
    assert.match(app.statusText(), /\/ OR/);
  });
});

describe('クリア', () => {
  test('クリア: query と nrc_q を解除し、現在のモードは URL に残す', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?view=20&query=x&nrc_q=東京&nrc_mode=or' });
    await app.show();
    app.clearBtn().click();
    assert.equal(app.lastNav().query, null);
    assert.equal(app.lastNav().nrc_q, null);
    assert.equal(app.lastNav().nrc_mode, 'or');
    assert.equal(app.lastNav().params.get('view'), '20');
  });

  test('クリア後の画面: 選択状態は OR のまま、適用中表示なし、クリア非表示', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?view=20&nrc_mode=or' });
    await app.show();
    assert.deepEqual(app.pressedModes(), ['or']);
    assert.equal(app.statusText(), '');
    assert.equal(app.clearBtn().hidden, true);
  });

  test('空欄検索による解除でもモードを保持', async () => {
    const app = loadDesktop({ config: cfgAnd, search: '?query=x&nrc_q=東京&nrc_mode=or' });
    await app.show();
    app.type('');
    app.searchBtn().click();
    assert.equal(app.lastNav().nrc_q, null);
    assert.equal(app.lastNav().nrc_mode, 'or');
  });
});

describe('IME・アクセシビリティ', () => {
  test('モード切替後も IME 確定 Enter では検索しない / 通常 Enter は 1 回', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    app.modeBtn('or').click();
    app.type('とうきょう');
    app.key('Enter', { isComposing: true });
    app.key('Enter', { keyCode: 229 });
    assert.equal(app.navigations.length, 0);
    app.key('Enter');
    assert.equal(app.navigations.length, 1);
    assert.equal(app.lastNav().nrc_mode, 'or');
  });

  test('切替は button 要素・aria-pressed・role=group＋aria-label・title で意味が分かる', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    const and = app.modeBtn('and');
    const or = app.modeBtn('or');
    assert.equal(and.tagName, 'BUTTON');
    assert.equal(or.tagName, 'BUTTON');
    assert.equal(and.getAttribute('type'), 'button');
    assert.equal(and.getAttribute('aria-pressed'), 'true');
    assert.equal(or.getAttribute('aria-pressed'), 'false');
    const group = and.parentElement;
    assert.equal(group.getAttribute('role'), 'group');
    assert.ok(group.getAttribute('aria-label'));
    assert.match(and.getAttribute('title'), /すべての検索語を含む/);
    assert.match(or.getAttribute('title'), /いずれかの検索語を含む/);
  });

  test('配置: 入力欄 → AND|OR → 検索 → クリア の順', async () => {
    const app = loadDesktop({ config: cfgAnd });
    await app.show();
    const bar = app.input().parentElement;
    const order = Array.from(bar.children).map(c => c.id || c.className);
    assert.deepEqual(order.slice(0, 4), ['nrc-xsearch-input', 'nrc-xsearch__mode', 'nrc-xsearch-btn', 'nrc-xsearch-clear']);
  });
});
