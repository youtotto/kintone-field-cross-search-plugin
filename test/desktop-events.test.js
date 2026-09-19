'use strict';

// A. index.show 再発火 / B. IME / I. query・URL・クリア

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadDesktop, makeConfig } = require('./helpers/load-desktop');

const config = makeConfig(['顧客名', '備考']);

describe('A. index.show の再発火', () => {
  [1, 2, 3].forEach((times) => {
    test(`index.show を ${times} 回発火 → 検索ボタンが1回だけ動く`, async () => {
      const app = loadDesktop({ config });
      for (let i = 0; i < times; i++) await app.show();
      assert.equal(app.roots(), 1, '検索 UI は 1 つだけ');
      app.type('東京');
      app.searchBtn().click();
      assert.equal(app.navigations.length, 1, '検索が 1 回だけ実行される（二重登録なし）');
      assert.equal(app.lastNav().nrc_q, '東京');
    });

    test(`index.show を ${times} 回発火 → Enter が1回だけ動く`, async () => {
      const app = loadDesktop({ config });
      for (let i = 0; i < times; i++) await app.show();
      app.type('東京');
      const ev = app.key('Enter');
      assert.equal(app.navigations.length, 1);
      assert.equal(ev.defaultPrevented, true);
    });

    test(`index.show を ${times} 回発火 → クリアが1回だけ動く`, async () => {
      const app = loadDesktop({ config, search: '?query=x&nrc_q=東京' });
      for (let i = 0; i < times; i++) await app.show();
      assert.equal(app.clearBtn().hidden, false);
      app.clearBtn().click();
      assert.equal(app.navigations.length, 1);
      assert.equal(app.lastNav().query, null);
      assert.equal(app.lastNav().nrc_q, null);
    });
  });

  test('kintone がヘッダー領域を作り直した後の再発火でも UI が再生成され、操作できる', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.recreateHeaderSpace();
    assert.equal(app.roots(), 0, 'ヘッダー再生成で UI が消えた状態');
    await app.show();
    assert.equal(app.roots(), 1);
    app.type('東京');
    app.searchBtn().click();
    assert.equal(app.navigations.length, 1);
    app.key('Enter');
    assert.equal(app.navigations.length, 2);
  });

  test('再発火しても対象フィールドパネルの開閉が1クリック1回で動く', async () => {
    const app = loadDesktop({ config });
    await app.show(); await app.show(); await app.show();
    app.toggle().click();
    assert.equal(app.panel().hidden, false);
    assert.equal(app.toggle().getAttribute('aria-expanded'), 'true');
    app.toggle().click();
    assert.equal(app.panel().hidden, true);
  });

  test('パネルは外側クリック・閉じるボタン・Esc で閉じる', async () => {
    const app = loadDesktop({ config });
    await app.show(); await app.show();
    app.toggle().click();
    app.document.body.click();
    assert.equal(app.panel().hidden, true);
    app.toggle().click();
    app.document.getElementById('nrc-xsearch-close').click();
    assert.equal(app.panel().hidden, true);
    app.toggle().click();
    app.key('Escape');
    assert.equal(app.panel().hidden, true);
  });

  test('フィールド定義の取得（照合）はページ内で1回だけ', async () => {
    const app = loadDesktop({ config });
    await app.show(); await app.show(); await app.show();
    assert.equal(app.getFormFieldsCalls(), 1);
  });

  test('再発火時に入力途中の内容を上書きしない', async () => {
    const app = loadDesktop({ config, search: '?query=x&nrc_q=東京' });
    await app.show();
    assert.equal(app.input().value, '東京');
    app.type('入力途中');
    await app.show();
    assert.equal(app.input().value, '入力途中');
  });

  test('検索対象が未設定なら UI を出さない', async () => {
    const app = loadDesktop({ config: {} });
    await app.show();
    assert.equal(app.roots(), 0);
  });
});

describe('B. IME', () => {
  test('isComposing=true の Enter では検索しない', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.type('とうきょう');
    app.key('Enter', { isComposing: true });
    assert.equal(app.navigations.length, 0);
  });

  test('keyCode=229 の Enter では検索しない', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.type('とうきょう');
    app.key('Enter', { keyCode: 229 });
    assert.equal(app.navigations.length, 0);
  });

  test('変換確定後の通常 Enter で 1 回だけ検索する', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.type('東京');
    app.key('Enter', { isComposing: true });
    app.key('Enter');
    assert.equal(app.navigations.length, 1);
  });

  test('Enter 以外のキーでは検索しない', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.type('東京');
    app.key('a');
    assert.equal(app.navigations.length, 0);
  });
});

describe('I. query / URL', () => {
  test('AND: 語ごとの OR 句を and で結合', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.type('東京 営業');
    app.searchBtn().click();
    assert.equal(app.lastNav().query,
      '((顧客名 like "東京") or (備考 like "東京")) and ((顧客名 like "営業") or (備考 like "営業"))');
    assert.equal(app.lastNav().nrc_q, '東京 営業');
  });

  test('OR: or で結合', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名'], { spaceJoin: 'or' }) });
    await app.show();
    app.type('東京 営業');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((顧客名 like "東京")) or ((顧客名 like "営業"))');
  });

  test('全角スペース・連続スペースも区切りとして扱う', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']) });
    await app.show();
    app.type('  東京　　営業  ');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((顧客名 like "東京")) and ((顧客名 like "営業"))');
  });

  test('特殊文字: ダブルクォートとバックスラッシュをエスケープ', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']) });
    await app.show();
    app.type('a"b c\\d');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((顧客名 like "a\\"b")) and ((顧客名 like "c\\\\d"))');
  });

  test('既存の URL パラメータ（view）は保持し、offset は消す', async () => {
    const app = loadDesktop({ config, search: '?view=20&offset=100' });
    await app.show();
    app.type('東京');
    app.searchBtn().click();
    assert.equal(app.lastNav().params.get('view'), '20');
    assert.equal(app.lastNav().params.get('offset'), null);
  });

  test('URL の nrc_q が入力欄に復元される', async () => {
    const app = loadDesktop({ config, search: '?query=x&nrc_q=東京 営業' });
    await app.show();
    assert.equal(app.input().value, '東京 営業');
  });

  test('空欄で検索: 未適用なら何もしない / 適用中なら解除', async () => {
    const a = loadDesktop({ config });
    await a.show();
    a.searchBtn().click();
    assert.equal(a.navigations.length, 0);

    const b = loadDesktop({ config, search: '?view=20&query=x&nrc_q=東京' });
    await b.show();
    b.type('');
    b.searchBtn().click();
    assert.equal(b.navigations.length, 1);
    assert.equal(b.lastNav().query, null);
    assert.equal(b.lastNav().nrc_q, null);
    assert.equal(b.lastNav().params.get('view'), '20');
  });

  test('サブテーブル内フィールド・添付ファイルは like で検索', async () => {
    const app = loadDesktop({ config: makeConfig(['品名', '契約書']) });
    await app.show();
    app.type('見積');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((品名 like "見積") or (契約書 like "見積"))');
  });
});
