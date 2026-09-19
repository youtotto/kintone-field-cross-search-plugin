'use strict';

// H. 設定画面

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfigScreen } = require('./helpers/load-config');
const { makeConfig } = require('./helpers/load-desktop');

describe('H. 対象フィールドの候補', () => {
  test('対応型だけが候補に出る（数値・日付・ユーザー選択・組織選択・作成者は出ない）', async () => {
    const ui = await loadConfigScreen();
    const codes = ui.codes();
    ['顧客名', '備考', '説明', 'リンク', '契約区分', '優先度', '対応エリア', 'タグ', '契約書', '品名'].forEach((c) => {
      assert.ok(codes.includes(c), `${c} が候補にある`);
    });
    ['金額', '契約開始日', '担当者', '担当組織', '作成者', '明細'].forEach((c) => {
      assert.ok(!codes.includes(c), `${c} は候補に無い`);
    });
  });

  test('一致方法の表示: 文字列は部分一致、選択肢系は完全一致', async () => {
    const ui = await loadConfigScreen();
    const row = (code) => ui.rows().find(tr => tr.dataset.code === code).textContent;
    assert.match(row('顧客名'), /部分一致/);
    assert.match(row('説明'), /部分一致/);
    ['契約区分', '優先度', '対応エリア', 'タグ'].forEach((c) => assert.match(row(c), /選択肢と完全一致/));
  });

  test('サブテーブル内フィールドは「テーブル名 / フィールド名」で表示', async () => {
    const ui = await loadConfigScreen();
    assert.match(ui.rows().find(tr => tr.dataset.code === '品名').textContent, /明細 \/ 品名/);
  });

  test('初期値: AND・上限 5・未選択', async () => {
    const ui = await loadConfigScreen();
    assert.equal(ui.document.getElementById('spaceJoin').value, 'and');
    assert.equal(ui.document.getElementById('maxTokens').value, '5');
    assert.deepEqual(ui.checkedCodes(), []);
  });

  test('console.log が残っていない', async () => {
    const ui = await loadConfigScreen();
    assert.equal(ui.logs.length, 0);
  });
});

describe('H. 保存', () => {
  test('選択して保存: targets（op 付き）とスナップショット（選択肢系は options 付き）', async () => {
    const ui = await loadConfigScreen();
    ['顧客名', '説明', '優先度', '対応エリア', 'タグ', '契約区分'].forEach((c) => { ui.checkbox(c).checked = true; });
    const s = ui.save();
    assert.ok(s);
    const op = Object.fromEntries(s.targets.map(t => [t.code, t.op]));
    assert.deepEqual(op, { 顧客名: 'like', 説明: 'like', 優先度: 'in', 対応エリア: 'in', タグ: 'in', 契約区分: 'in' });

    const snap = Object.fromEntries(s.snapshot.map(x => [x.code, x]));
    assert.equal(snap['優先度'].type, 'RADIO_BUTTON');
    assert.deepEqual(snap['優先度'].options.slice().sort(), ['中', '低', '高'].sort());
    assert.deepEqual(snap['対応エリア'].options.slice().sort(), ['東京都', '神奈川県'].sort());
    assert.deepEqual(snap['タグ'].options.slice().sort(), ['保留', '重要'].sort());
    assert.deepEqual(snap['顧客名'].options, []);
    assert.equal(s.raw.maxTokens, '5');
    assert.equal(s.raw.spaceJoin, 'and');
    assert.equal('pos' in s.raw, false, '未使用の pos は保存しない');
  });

  test('未選択で保存 → エラー表示、保存されない', async () => {
    const ui = await loadConfigScreen();
    assert.equal(ui.save(), null);
    assert.ok(ui.shown('errFields'));
    assert.match(ui.text('errFields'), /少なくとも1つ選択/);
  });

  test('上限が範囲外 → エラー表示、保存されない', async () => {
    const ui = await loadConfigScreen();
    ui.checkbox('顧客名').checked = true;
    ui.document.getElementById('maxTokens').value = '11';
    assert.equal(ui.save(), null);
    assert.match(ui.text('errBasic'), /1〜10/);
  });

  test('フィールド情報の取得失敗 → エラー表示、保存ボタン無効', async () => {
    const ui = await loadConfigScreen({ failFields: true });
    assert.match(ui.text('errBasic'), /初期化に失敗しました/);
    assert.equal(ui.document.getElementById('btnSave').disabled, true);
  });
});

describe('H. 既存設定の保持', () => {
  const saved = makeConfig(['顧客名', '備考', '契約区分'], { spaceJoin: 'or', maxTokens: 3 });

  test('読み込み: チェック状態・OR・上限 3 が復元される', async () => {
    const ui = await loadConfigScreen({ config: saved });
    assert.deepEqual(ui.checkedCodes().sort(), ['備考', '契約区分', '顧客名'].sort());
    assert.equal(ui.document.getElementById('spaceJoin').value, 'or');
    assert.equal(ui.document.getElementById('maxTokens').value, '3');
    assert.equal(ui.shown('warnMissing'), false);
  });

  test('何も変更せず保存 → targets / spaceJoin / maxTokens が不変', async () => {
    const ui = await loadConfigScreen({ config: saved });
    const s = ui.save();
    const before = JSON.parse(saved.targetsJson).sort((a, b) => a.code.localeCompare(b.code));
    const after = s.targets.slice().sort((a, b) => a.code.localeCompare(b.code));
    assert.deepEqual(after, before);
    assert.equal(s.raw.spaceJoin, 'or');
    assert.equal(s.raw.maxTokens, '3');
  });

  test('保存済みフィールドがフォームから消えている場合は、保存前に警告で知らせる', async () => {
    const withDeleted = makeConfig(['顧客名', '備考']);
    const fields = require('./helpers/load-config').configFields();
    delete fields['備考'];
    const ui = await loadConfigScreen({ config: withDeleted, fields });
    assert.ok(ui.shown('warnMissing'));
    assert.match(ui.text('warnMissing'), /備考（備考）/);
    assert.match(ui.text('warnMissing'), /このまま保存すると検索対象から外れます/);
    assert.deepEqual(ui.checkedCodes(), ['顧客名']);
  });
});

describe('config.html の整理', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../source/config.html'), 'utf8');

  test('script タグ（外部 kintone.js / 相対 config.js）が無い', () => {
    assert.doesNotMatch(html, /<script/i);
  });
  test('body 内要素のみ（html / head / body タグが無い）', () => {
    assert.doesNotMatch(html, /<html|<head|<body|<!DOCTYPE/i);
  });
  test('outline:none が無く、実装と矛盾する注記（query自動生成 / like・in 表記）が無い', () => {
    assert.doesNotMatch(html, /outline:\s*none/);
    assert.doesNotMatch(html, /query自動生成/);
  });
  test('未使用 CSS（タブ・カード表示）が残っていない', () => {
    assert.doesNotMatch(html, /\.nrc-tab\b|\.nrc-field-card|\.nrc-pill|\.nrc-grid--3/);
  });
});

describe('AND / OR は初期値の設定（利用者が一覧画面で切り替え可能）', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../source/config.html'), 'utf8');

  test('説明文: 初期値であること、一覧画面で切り替えられることを明記', () => {
    assert.match(html, /AND \/ OR の初期値/);
    assert.match(html, /検索画面を開いたときの AND \/ OR の初期値を設定します。利用者は一覧画面上で切り替えられます。/);
  });

  test('設定 JSON の構造は変更なし（spaceJoin / maxTokens / targetsJson / fieldSnapshotJson のみ）', async () => {
    const ui = await loadConfigScreen();
    ui.checkbox('顧客名').checked = true;
    ui.document.getElementById('spaceJoin').value = 'or';
    const s = ui.save();
    assert.deepEqual(Object.keys(s.raw).sort(), ['fieldSnapshotJson', 'maxTokens', 'spaceJoin', 'targetsJson']);
    assert.equal(s.raw.spaceJoin, 'or');
  });
});
