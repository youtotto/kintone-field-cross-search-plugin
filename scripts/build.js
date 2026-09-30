#!/usr/bin/env node
/* scripts/build.js
 * 一覧サポートのプラグイン ZIP を作る（実機確認用）。
 * 1. manifest.json を公式の @kintone/plugin-manifest-validator で検証し、参照ファイルの存在を確かめる
 * 2. 横断検索と同じ ppk（= 同じプラグイン ID）で署名し、build/ に出力する（アップデートで移行できるように）
 * 3. 出力の プラグイン ID・サイズ・SHA-256 を表示する
 * ppk の中身は表示しない。ppk が無いときは新しく作らずに止める（プラグイン ID が変わるため）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'source');
const EXPECTED_ID = 'iaeigihohpbbjelmflbcbeimcjobagbg'; // 横断検索プラグイン（公開済み）と同じ
const ppk = path.join(root, `${EXPECTED_ID}.ppk`);

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// ---------- 1. manifest の検証 ----------
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const mod = require('@kintone/plugin-manifest-validator');
const validate = typeof mod === 'function' ? mod : mod.default;
const exists = (p) => fs.existsSync(path.join(src, p));
const result = validate(manifest, {
  relativePath: exists,
  maxFileSize: (max, p) => (fs.statSync(path.join(src, p)).size <= max ? true : { valid: false, message: `${p} が ${max} bytes を超えています` }),
  fileExists: (p) => (exists(p) ? true : { valid: false, message: `${p} がありません` })
});
if (!result.valid) {
  (result.errors || []).forEach((e) => console.error(`  ${e.instancePath || ''} ${e.message}`));
  fail('manifest.json の検証に失敗しました。');
}
(result.warnings || []).forEach((w) => console.warn(`  ⚠ ${w.message}`));

const referenced = [
  manifest.icon,
  ...(manifest.desktop && manifest.desktop.js || []),
  ...(manifest.desktop && manifest.desktop.css || []),
  manifest.config && manifest.config.html,
  ...(manifest.config && manifest.config.js || []),
  ...(manifest.config && manifest.config.css || [])
].filter((p) => p && !/^https?:\/\//.test(p));
referenced.forEach((p) => { if (!exists(p)) fail(`manifest が参照するファイルがありません: ${p}`); });

// source/ に秘密鍵やテスト用ファイルが紛れていないこと
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
walk(src).forEach((f) => {
  if (/\.(ppk|pem|key)$/i.test(f)) fail(`source/ に秘密鍵があります: ${path.relative(root, f)}`);
});
if (!/js\/ls-core\.js/.test(JSON.stringify(manifest.desktop)) || manifest.desktop.js[0] !== 'js/ls-core.js') {
  fail('desktop.js より先に js/ls-core.js を読み込む必要があります。');
}
console.log(`✔ manifest OK（${manifest.name.ja} ${manifest.version}、参照ファイル ${referenced.length} 件）`);

// ---------- 2. 署名して ZIP を作る ----------
if (!fs.existsSync(ppk)) fail(`ppk がありません: ${path.basename(ppk)}（プラグイン ID が変わるため新しくは作りません）`);
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `list-support-${manifest.version}-mvp.zip`);
const cli = path.join(root, 'node_modules', '@kintone', 'plugin-packer', 'bin', 'cli.js');
if (!fs.existsSync(cli)) fail('@kintone/plugin-packer が見つかりません。npm install を実行してください。');

const r = spawnSync(process.execPath, [cli, src, '--ppk', ppk, '--out', out], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(r.stderr || '');
  fail('plugin-packer に失敗しました。');
}
// ---------- 3. 出力の確認 ----------
// プラグイン ID = 公開鍵（PUBKEY）の SHA-256 の先頭 32 桁を a〜p に写したもの（plugin-packer と同じ手順）
const { readZipEntries } = require('./zip-read');
const buf = fs.readFileSync(out);
const outer = readZipEntries(buf);
const names = outer.map((e) => e.name).sort().join(',');
if (names !== 'PUBKEY,SIGNATURE,contents.zip') fail(`ZIP の構成が想定と違います: ${names}`);
const pubkey = outer.find((e) => e.name === 'PUBKEY').data;
const hex = crypto.createHash('sha256').update(pubkey).digest('hex').slice(0, 32);
const id = hex.split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
if (id !== EXPECTED_ID) fail(`プラグイン ID が期待と違います: ${id}（期待: ${EXPECTED_ID}）`);

const inner = readZipEntries(outer.find((e) => e.name === 'contents.zip').data);
const innerNames = inner.map((e) => e.name);
['manifest.json', ...referenced].forEach((p) => { if (!innerNames.includes(p)) fail(`ZIP に ${p} が入っていません`); });
const packedManifest = JSON.parse(inner.find((e) => e.name === 'manifest.json').data.toString('utf8'));
if (packedManifest.version !== manifest.version) fail('ZIP 内の manifest の version が source と違います');

const sha = crypto.createHash('sha256').update(buf).digest('hex');
console.log(`✔ packed ${path.relative(root, out)}`);
console.log(`  プラグイン ID: ${id}（横断検索と同じ。上書きでアップデートできる）`);
console.log(`  中身: ${innerNames.join(', ')}`);
console.log(`  サイズ: ${buf.length} bytes`);
console.log(`  SHA-256: ${sha}`);
