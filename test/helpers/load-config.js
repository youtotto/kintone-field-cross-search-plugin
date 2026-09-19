'use strict';

/** source/config.html + source/js/config.js を jsdom 上で読み込むヘルパー */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { defaultFields } = require('./load-desktop');

const CONFIG_HTML = path.resolve(__dirname, '../../source/config.html');
const CONFIG_JS = path.resolve(__dirname, '../../source/js/config.js');

function configFields() {
  return {
    ...defaultFields(),
    金額: { type: 'NUMBER', code: '金額', label: '金額' },
    契約開始日: { type: 'DATE', code: '契約開始日', label: '契約開始日' },
    担当者: { type: 'USER_SELECT', code: '担当者', label: '担当者' },
    担当組織: { type: 'ORGANIZATION_SELECT', code: '担当組織', label: '担当組織' },
    リンク: { type: 'LINK', code: 'リンク', label: 'リンク' },
    作成者: { type: 'CREATOR', code: '作成者', label: '作成者' }
  };
}

async function loadConfigScreen({ config = {}, fields = configFields(), failFields = false } = {}) {
  const html = fs.readFileSync(CONFIG_HTML, 'utf8');
  const js = fs.readFileSync(CONFIG_JS, 'utf8');

  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    url: 'https://example.cybozu.com/k/admin/app/1/plugin/config',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  const logs = [];
  window.console.log = (...a) => logs.push(a);

  let saved = null;
  window.kintone = {
    $PLUGIN_ID: 'mock-plugin',
    app: {
      getId: () => 1,
      getFormFields: async () => {
        if (failFields) throw new Error('権限がありません');
        return JSON.parse(JSON.stringify(fields));
      }
    },
    plugin: { app: {
      getConfig: () => JSON.parse(JSON.stringify(config)),
      setConfig: (conf) => { saved = conf; } // 保存後の画面遷移（コールバック）は呼ばない
    } }
  };

  window.eval(js);
  await new Promise((r) => setTimeout(r, 30));

  const doc = window.document;
  return {
    window, document: doc, logs,
    rows: () => Array.from(doc.querySelectorAll('#fieldTbody tr')),
    codes: () => Array.from(doc.querySelectorAll('#fieldTbody tr')).map(tr => tr.dataset.code),
    checkbox: (code) => Array.from(doc.querySelectorAll('.js-target')).find(c => c.dataset.code === code),
    checkedCodes: () => Array.from(doc.querySelectorAll('.js-target')).filter(c => c.checked).map(c => c.dataset.code),
    text: (id) => doc.getElementById(id).textContent,
    shown: (id) => doc.getElementById(id).classList.contains('is-show'),
    save() {
      doc.getElementById('btnSave').click();
      return saved ? {
        raw: saved,
        targets: JSON.parse(saved.targetsJson),
        snapshot: JSON.parse(saved.fieldSnapshotJson)
      } : null;
    }
  };
}

module.exports = { loadConfigScreen, configFields };
