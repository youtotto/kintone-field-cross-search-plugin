'use strict';

// C. 語数上限 / D. 条件生成不能 / E. 適用中表示 / F. 対応フィールド / G. snapshot 不一致 / 0件 / a11y

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDesktop, makeConfig, defaultFields, opts } = require('./helpers/load-desktop');

describe('C. 検索語の上限', () => {
  test('既定の上限は 5（maxTokens 未設定）: 5 語はすべて検索に使う', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']) });
    await app.show();
    app.type('1 2 3 4 5');
    app.searchBtn().click();
    assert.equal((app.lastNav().query.match(/like/g) || []).length, 5);
  });

  test('6 語: 検索は 5 語で実行、入力値は nrc_q にそのまま保持', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']) });
    await app.show();
    app.type('1 2 3 4 5 6');
    app.searchBtn().click();
    assert.equal((app.lastNav().query.match(/like/g) || []).length, 5);
    assert.doesNotMatch(app.lastNav().query, /"6"/);
    assert.equal(app.lastNav().nrc_q, '1 2 3 4 5 6');
  });

  test('6 語で検索後の画面: 6 語目が対象外であることを通知し、使われた語も分かる', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']), search: '?query=x&nrc_q=1 2 3 4 5 6' });
    await app.show();
    const s = app.statusText();
    assert.match(s, /検索中: 1 2 3 4 5 \/ AND/);
    assert.match(s, /検索語は最大5件までです。6件目以降は検索対象になりません：6/);
    assert.equal(app.input().value, '1 2 3 4 5 6', '入力値は保持');
  });

  test('保存済みの上限（3）はそのまま尊重する', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名'], { maxTokens: 3 }), search: '?query=x&nrc_q=a b c d' });
    await app.show();
    assert.match(app.statusText(), /検索語は最大3件までです。4件目以降は検索対象になりません：d/);
  });

  test('不正な maxTokens は 5 にフォールバック', async () => {
    const app = loadDesktop({ config: { ...makeConfig(['顧客名']), maxTokens: 'abc' }, search: '?query=x&nrc_q=1 2 3 4 5 6' });
    await app.show();
    assert.match(app.statusText(), /最大5件/);
  });

  test('ソース上の既定値が 5 に統一されている（desktop.js / config.js / config.html）', () => {
    const src = (p) => fs.readFileSync(path.resolve(__dirname, '../source', p), 'utf8');
    assert.match(src('js/desktop.js'), /DEFAULT_MAX_TOKENS = 5/);
    assert.match(src('js/config.js'), /DEFAULT_MAX_TOKENS = 5/);
    assert.match(src('config.html'), /id="maxTokens"[^>]*value="5"/);
    assert.doesNotMatch(src('js/desktop.js'), /: 3;|\|\| 3\b/);
  });
});

describe('D. 条件を作れない検索語', () => {
  const config = makeConfig(['契約区分', '優先度']); // 選択肢系のみ

  test('一部の語だけ条件生成不能 → 検索は実行し、実行後に対象外語を通知', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.type('新規 営業');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((契約区分 in ("新規")))');
    assert.equal(app.lastNav().nrc_q, '新規 営業');

    const after = loadDesktop({ config, search: '?query=x&nrc_q=新規 営業' });
    await after.show();
    assert.match(after.statusText(), /検索中: 新規 \/ AND/);
    assert.match(after.statusText(), /一部の検索語は対象フィールドで検索できませんでした：営業/);
  });

  test('すべての語が条件生成不能 → 再読込せず、その場で通知（「検索中」とは表示しない）', async () => {
    const app = loadDesktop({ config });
    await app.show();
    app.type('営業 東京');
    app.searchBtn().click();
    assert.equal(app.navigations.length, 0);
    assert.match(app.statusText(), /対象フィールドでは検索できませんでした/);
    assert.doesNotMatch(app.statusText(), /検索中/);
  });

  test('like 対象が 1 つでもあれば全語が使われる', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名', '契約区分']), search: '?query=x&nrc_q=新規 営業' });
    await app.show();
    assert.match(app.statusText(), /検索中: 新規 営業/);
    assert.doesNotMatch(app.statusText(), /検索できませんでした/);
  });
});

describe('E. 適用中表示', () => {
  const config = makeConfig(['顧客名', '備考']);

  test('検索中: 検索語と AND を表示、クリアが使える', async () => {
    const app = loadDesktop({ config, search: '?query=x&nrc_q=東京 営業' });
    await app.show();
    assert.match(app.statusText(), /検索中: 東京 営業 \/ AND（すべて含む）/);
    assert.equal(app.clearBtn().hidden, false);
    assert.equal(app.status().getAttribute('role'), 'status');
  });

  test('検索中（OR 設定）: OR を表示', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名'], { spaceJoin: 'or' }), search: '?query=x&nrc_q=東京 営業' });
    await app.show();
    assert.match(app.statusText(), /検索中: 東京 営業 \/ OR（いずれかを含む）/);
  });

  test('未検索: 適用中表示なし、クリアは非表示', async () => {
    const app = loadDesktop({ config });
    await app.show();
    assert.equal(app.status().hidden, true);
    assert.equal(app.statusText(), '');
    assert.equal(app.clearBtn().hidden, true);
  });

  test('検索語は HTML エスケープして表示', async () => {
    const app = loadDesktop({ config, search: '?query=x&nrc_q=' + encodeURIComponent('<img src=x onerror=1>') });
    await app.show();
    assert.equal(app.status().querySelector('img'), null);
    assert.match(app.status().textContent, /<img/);
  });

  test('0 件: 一致するレコードが無い旨を表示', async () => {
    const app = loadDesktop({ config, search: '?query=x&nrc_q=東京 営業' });
    await app.show([]);
    assert.match(app.statusText(), /「東京 営業」に一致するレコードはありません。/);
  });

  test('結果あり / 未検索の 0 件では 0 件メッセージを出さない', async () => {
    const a = loadDesktop({ config, search: '?query=x&nrc_q=東京' });
    await a.show([{}, {}]);
    assert.doesNotMatch(a.statusText(), /一致するレコードはありません/);
    const b = loadDesktop({ config });
    await b.show([]);
    assert.equal(b.statusText(), '');
  });
});

describe('F. 対応フィールドの query 生成', () => {
  const cases = [
    ['SINGLE_LINE_TEXT', '顧客名', '東京', '((顧客名 like "東京"))'],
    ['MULTI_LINE_TEXT', '備考', '東京', '((備考 like "東京"))'],
    ['RICH_TEXT', '説明', '東京', '((説明 like "東京"))'],
    ['DROP_DOWN', '契約区分', '新規', '((契約区分 in ("新規")))'],
    ['RADIO_BUTTON', '優先度', '高', '((優先度 in ("高")))'],
    ['CHECK_BOX', '対応エリア', '東京都', '((対応エリア in ("東京都")))'],
    ['MULTI_SELECT', 'タグ', '重要', '((タグ in ("重要")))']
  ];
  cases.forEach(([type, code, word, expected]) => {
    test(`${type}: ${expected}`, async () => {
      const app = loadDesktop({ config: makeConfig([code]) });
      await app.show();
      app.type(word);
      app.searchBtn().click();
      assert.equal(app.lastNav().query, expected);
    });
  });

  test('選択肢系は部分一致では条件を作らない（「東京」は「東京都」に一致しない）', async () => {
    const app = loadDesktop({ config: makeConfig(['対応エリア']) });
    await app.show();
    app.type('東京');
    app.searchBtn().click();
    assert.equal(app.navigations.length, 0);
  });

  test('混在: 語ごとに like と in を OR で結合', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名', '優先度', 'タグ']) });
    await app.show();
    app.type('重要');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((顧客名 like "重要") or (タグ in ("重要")))');
  });
});

describe('G. スナップショット不一致', () => {
  const config = makeConfig(['顧客名', '備考', '契約区分', '優先度']);

  function changedFields() {
    const f = defaultFields();
    delete f['備考'];                                             // 削除
    f['契約区分'].type = 'RADIO_BUTTON';                           // 型変更
    f['優先度'].options = opts(['高', '中']);                       // 保存時の選択肢「低」が消えた
    return f;
  }

  test('一致時: 警告なし、件数 = チップ数、除外なし', async () => {
    const app = loadDesktop({ config });
    await app.show();
    assert.equal(app.count(), '4');
    assert.equal(app.chips().length, 4);
    assert.equal(app.chips().filter(c => c.dataset.excluded === '1').length, 0);
    assert.equal(app.document.getElementById('nrc-xsearch-warn').hidden, true);
    assert.equal(app.document.getElementById('nrc-xsearch-panelAlert').hidden, true);
  });

  test('不一致時: 使用中 1 件 + 除外 3 件。件数表示とチップの内訳が一致し、除外が識別できる', async () => {
    const app = loadDesktop({ config, currentFields: changedFields() });
    await app.show();
    const chips = app.chips();
    const excluded = chips.filter(c => c.dataset.excluded === '1');
    const active = chips.filter(c => c.dataset.excluded === '0');

    assert.equal(app.count(), '1');
    assert.equal(active.length, 1);
    assert.equal(app.document.getElementById('nrc-xsearch-excluded').textContent, '（除外3件）');
    assert.equal(excluded.length, 3);
    assert.deepEqual(excluded.map(c => c.dataset.code).sort(), ['備考', '優先度', '契約区分'].sort());
    excluded.forEach((c) => {
      assert.ok(c.classList.contains('is-excluded'));
      assert.match(c.textContent, /除外/);
    });
    assert.doesNotMatch(active[0].textContent, /除外/);
  });

  test('不一致時: 利用者向けの警告文言', async () => {
    const app = loadDesktop({ config, currentFields: changedFields() });
    await app.show();
    assert.equal(app.document.getElementById('nrc-xsearch-warn').hidden, false);
    const alert = app.document.getElementById('nrc-xsearch-panelAlert');
    assert.equal(alert.hidden, false);
    assert.equal(alert.textContent, '設定後に変更されたフィールドがあるため、一部を検索対象から除外しています。');
    assert.doesNotMatch(alert.textContent, /再設定|query|スナップショット/);
  });

  test('不一致時: 除外フィールドは query に入らない', async () => {
    const app = loadDesktop({ config, currentFields: changedFields() });
    await app.show();
    app.type('高');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((顧客名 like "高"))');
  });

  test('選択肢の追加だけなら不一致にしない', async () => {
    const f = defaultFields();
    f['契約区分'].options = opts(['新規', '更新', '解約', '保留']);
    const app = loadDesktop({ config, currentFields: f });
    await app.show();
    assert.equal(app.count(), '4');
  });

  test('全フィールドが不一致 → 設定値でフォールバックして検索可能（警告は表示）', async () => {
    const app = loadDesktop({ config: makeConfig(['備考']), currentFields: changedFields() });
    await app.show();
    app.type('東京');
    app.searchBtn().click();
    assert.equal(app.lastNav().query, '((備考 like "東京"))');
    assert.equal(app.document.getElementById('nrc-xsearch-warn').hidden, false);
    assert.match(app.document.getElementById('nrc-xsearch-panelAlert').textContent, /管理者に/);
  });

  test('フィールド定義の取得に失敗しても検索できる（警告なし）', async () => {
    const app = loadDesktop({ config, currentFields: null });
    await app.show();
    app.type('東京');
    app.searchBtn().click();
    assert.equal(app.navigations.length, 1);
    assert.equal(app.document.getElementById('nrc-xsearch-warn').hidden, true);
  });

  test('再発火しても除外表示が維持される', async () => {
    const app = loadDesktop({ config, currentFields: changedFields() });
    await app.show(); await app.show();
    assert.equal(app.count(), '1');
    assert.equal(app.chips().filter(c => c.dataset.excluded === '1').length, 3);
  });
});

describe('アクセシビリティ・ヘッダー幅', () => {
  test('入力欄に aria-label、トグルは button（aria-expanded / aria-controls）', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']) });
    await app.show();
    assert.ok(app.input().getAttribute('aria-label'));
    assert.equal(app.toggle().tagName, 'BUTTON');
    assert.equal(app.toggle().getAttribute('aria-controls'), 'nrc-xsearch-panel');
    assert.equal(app.toggle().getAttribute('aria-expanded'), 'false');
  });

  test('CSS: outline:none が無く、:focus-visible があり、width:100% / margin-left:24px を使わない', async () => {
    const app = loadDesktop({ config: makeConfig(['顧客名']) });
    await app.show();
    const css = app.document.getElementById('nrc-xsearch-style').textContent;
    assert.doesNotMatch(css, /outline:\s*none/);
    assert.match(css, /:focus-visible/);
    assert.doesNotMatch(css, /#nrc-xsearch-root\s*\{[^}]*(?<!max-)width:\s*100%/);
    assert.doesNotMatch(css, /margin-left:\s*24px/);
  });
});
