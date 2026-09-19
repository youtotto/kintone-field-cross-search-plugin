(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  // 検索語の上限の既定値。desktop.js / config.html と同じ値にすること
  const DEFAULT_MAX_TOKENS = 5;

  // ===== config.html の要素 =====
  const el = {
    spaceJoin: document.getElementById('spaceJoin'),       // and / or（一覧画面を開いたときの初期値。利用者は一覧画面で切り替えられる）
    maxTokens: document.getElementById('maxTokens'),

    fieldFilter: document.getElementById('fieldFilter'),
    btnSelectAll: document.getElementById('btnSelectAll'),
    btnUnselectAll: document.getElementById('btnUnselectAll'),
    fieldTbody: document.getElementById('fieldTbody'),

    btnSave: document.getElementById('btnSave'),
    btnCancel: document.getElementById('btnCancel'),

    errBasic: document.getElementById('errBasic'),
    errFields: document.getElementById('errFields'),
    warnMissing: document.getElementById('warnMissing')
  };

  // 描画用フィールド行
  // { code, label, type, typeLabel, op, isSubtable, parentCode, parentLabel, options }
  let fieldRows = [];

  // ===== フィールドタイプ表示 =====
  const TYPE_LABEL_MAP = {
    SINGLE_LINE_TEXT: '文字列（1行）',
    MULTI_LINE_TEXT: '文字列（複数行）',
    RICH_TEXT: 'リッチエディター',
    LINK: 'リンク',
    DROP_DOWN: 'ドロップダウン',
    RADIO_BUTTON: 'ラジオボタン',
    CHECK_BOX: 'チェックボックス',
    MULTI_SELECT: '複数選択',
    FILE: '添付ファイル'
  };

  // 部分一致（like）で検索する型
  const LIKE_TYPES = new Set([
    'SINGLE_LINE_TEXT',
    'MULTI_LINE_TEXT',
    'RICH_TEXT',
    'LINK',
    'FILE'
  ]);

  // 選択肢の完全一致（in）で検索する型
  const IN_TYPES = new Set([
    'DROP_DOWN',
    'RADIO_BUTTON',
    'CHECK_BOX',
    'MULTI_SELECT'
  ]);

  function resolveOperatorByType(type) {
    if (LIKE_TYPES.has(type)) return 'like';
    if (IN_TYPES.has(type)) return 'in';
    return null; // 対象外
  }

  // ===== util =====
  function showMessage(targetEl, message) {
    if (!targetEl) return;
    targetEl.textContent = message || '';
    targetEl.classList.toggle('is-show', Boolean(message));
  }

  function escapeHtml(s) {
    return (s ?? '')
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseJsonArray(str) {
    try {
      const v = str ? JSON.parse(str) : [];
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  function readConfig() {
    const cfg = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
    const maxTokens = Number(cfg.maxTokens);

    return {
      spaceJoin: cfg.spaceJoin === 'or' ? 'or' : 'and',
      maxTokens: (Number.isFinite(maxTokens) && maxTokens >= 1 && maxTokens <= 10) ? maxTokens : DEFAULT_MAX_TOKENS,
      selectedTargets: parseJsonArray(cfg.targetsJson),     // [{code, op}]
      fieldSnapshot: parseJsonArray(cfg.fieldSnapshotJson)
    };
  }

  function writeConfig(configObj) {
    kintone.plugin.app.setConfig(configObj, () => {
      location.href = `/k/admin/app/${kintone.app.getId()}/plugin/?message=CONFIG_SAVED#/`;
    });
  }

  // desktop.js が検索・整合性チェックに使うスナップショット
  function buildFieldSnapshotFromSelected(selectedCodes) {
    const snap = selectedCodes.map((code) => {
      const row = fieldRows.find(r => r.code === code);
      return {
        code,
        label: row ? row.label : '',
        type: row ? row.type : 'UNKNOWN',
        op: row ? row.op : 'like',
        isSubtable: row ? Boolean(row.isSubtable) : false,
        parentCode: row ? (row.parentCode || '') : '',
        parentLabel: row ? (row.parentLabel || '') : '',
        // 選択肢系のみ
        options: (row && IN_TYPES.has(row.type) && Array.isArray(row.options)) ? row.options : []
      };
    });

    // 保存内容を安定させるため code 順で固定
    snap.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'ja'));
    return snap;
  }

  // ===== フィールド取得（サブテーブル展開） =====
  async function fetchFormFields() {
    const props = await kintone.app.getFormFields();
    const rows = [];

    const extractOptions = (field) => {
      // options は { "選択肢": { label, index } } 形式
      const opt = field && field.options ? field.options : null;
      if (!opt || typeof opt !== 'object') return [];
      return Object.keys(opt).filter(k => k !== '__proto__').sort((a, b) => a.localeCompare(b, 'ja'));
    };

    const pushRow = (f, fallbackCode, parent) => {
      if (!f) return;
      const op = resolveOperatorByType(f.type);
      if (!op) return;

      rows.push({
        code: f.code || fallbackCode,
        label: f.label || fallbackCode,
        type: f.type,
        typeLabel: TYPE_LABEL_MAP[f.type] || f.type,
        op,
        options: IN_TYPES.has(f.type) ? extractOptions(f) : [],
        isSubtable: Boolean(parent),
        parentCode: parent ? parent.code : '',
        parentLabel: parent ? parent.label : ''
      });
    };

    Object.keys(props || {}).forEach((code) => {
      const f = props[code];
      if (!f) return;

      if (f.type === 'SUBTABLE') {
        const sub = f.fields || {};
        const parent = { code: f.code || code, label: f.label || code };
        Object.keys(sub).forEach((subCode) => pushRow(sub[subCode], subCode, parent));
        return;
      }
      pushRow(f, code, null);
    });

    // 並び：通常フィールド（ラベル順）→ サブテーブル（親ラベル → 子ラベル）
    rows.sort((a, b) => {
      const aKey = `${a.isSubtable ? '1' : '0'}|${a.parentLabel || ''}|${a.label || ''}|${a.code || ''}`;
      const bKey = `${b.isSubtable ? '1' : '0'}|${b.parentLabel || ''}|${b.label || ''}|${b.code || ''}`;
      return aKey.localeCompare(bKey, 'ja');
    });

    return rows;
  }

  // ===== 描画 =====
  function renderFieldTable(selectedSet) {
    const html = fieldRows.map((r) => {
      const checked = selectedSet.has(r.code) ? 'checked' : '';
      const badge = r.op === 'in'
        ? '<span class="nrc-badge">選択肢と完全一致</span>'
        : '<span class="nrc-badge">部分一致</span>';

      const name = r.isSubtable
        ? `${escapeHtml(r.parentLabel)} / ${escapeHtml(r.label)}`
        : escapeHtml(r.label);

      return `
        <tr data-code="${escapeHtml(r.code)}" data-label="${name}">
          <td><input type="checkbox" class="js-target" data-code="${escapeHtml(r.code)}" aria-label="${name} を検索対象にする" ${checked}></td>
          <td>${name}</td>
          <td><code>${escapeHtml(r.code)}</code></td>
          <td>${escapeHtml(r.typeLabel)}</td>
          <td>${badge}</td>
        </tr>
      `;
    }).join('');

    if (el.fieldTbody) el.fieldTbody.innerHTML = html;
  }

  // 保存済みの検索対象のうち、現在のフォームに無い／対応外の型になったものを知らせる
  function renderMissingNotice(selectedTargets, snapshot) {
    const available = new Set(fieldRows.map(r => r.code));
    const snapMap = {};
    (snapshot || []).forEach((s) => { if (s && s.code) snapMap[s.code] = s; });

    const missing = (selectedTargets || [])
      .map(t => t && t.code)
      .filter(code => code && !available.has(code))
      .map((code) => {
        const s = snapMap[code];
        const label = s ? (s.isSubtable ? `${s.parentLabel} / ${s.label}` : s.label) : '';
        return label ? `${label}（${code}）` : code;
      });

    showMessage(
      el.warnMissing,
      missing.length
        ? `保存済みの検索対象のうち、次のフィールドは現在のフォームに無いか、検索に対応していない種類に変更されています。\nこのまま保存すると検索対象から外れます。\n・${missing.join('\n・')}`
        : ''
    );
  }

  function applyTableFilter() {
    const keyword = (el.fieldFilter && el.fieldFilter.value ? el.fieldFilter.value : '').trim().toLowerCase();
    if (!el.fieldTbody) return;

    Array.from(el.fieldTbody.querySelectorAll('tr')).forEach((tr) => {
      const code = (tr.dataset.code || '').toLowerCase();
      const label = (tr.dataset.label || '').toLowerCase();
      const hit = !keyword || code.includes(keyword) || label.includes(keyword);
      tr.style.display = hit ? '' : 'none';
    });
  }

  function getSelectedCodes() {
    return Array.from(document.querySelectorAll('.js-target'))
      .filter(c => c.checked)
      .map(c => c.dataset.code)
      .filter(Boolean);
  }

  function setVisibleCheckboxes(checked) {
    if (!el.fieldTbody) return;
    Array.from(el.fieldTbody.querySelectorAll('tr')).forEach((tr) => {
      if (tr.style.display === 'none') return;
      const cb = tr.querySelector('.js-target');
      if (cb) cb.checked = checked;
    });
  }

  // ===== 保存 =====
  function validateBeforeSave() {
    showMessage(el.errBasic, '');
    showMessage(el.errFields, '');

    const maxTokens = Number(el.maxTokens && el.maxTokens.value);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 10) {
      showMessage(el.errBasic, '「検索語の上限」は 1〜10 の整数で指定してください。');
      return false;
    }

    if (getSelectedCodes().length === 0) {
      showMessage(el.errFields, '検索対象フィールドが未選択です。少なくとも1つ選択してください。');
      return false;
    }
    return true;
  }

  function buildTargetsFromSelected(selectedCodes) {
    return selectedCodes.map((code) => {
      const row = fieldRows.find(r => r.code === code);
      return { code, op: row ? row.op : 'like' };
    });
  }

  function onSave() {
    if (!validateBeforeSave()) return;

    const selectedCodes = getSelectedCodes();

    writeConfig({
      spaceJoin: el.spaceJoin && el.spaceJoin.value === 'or' ? 'or' : 'and',
      maxTokens: String(Number(el.maxTokens && el.maxTokens.value) || DEFAULT_MAX_TOKENS),
      // 検索対象（クエリ生成用：最小）
      targetsJson: JSON.stringify(buildTargetsFromSelected(selectedCodes)),
      // desktop.js 用スナップショット（type / options など）
      fieldSnapshotJson: JSON.stringify(buildFieldSnapshotFromSelected(selectedCodes))
    });
  }

  function onCancel() {
    history.back();
  }

  // ===== init =====
  async function init() {
    try {
      const cfg = readConfig();

      if (el.spaceJoin) el.spaceJoin.value = cfg.spaceJoin;
      if (el.maxTokens) el.maxTokens.value = String(cfg.maxTokens);

      fieldRows = await fetchFormFields();

      const selectedSet = new Set((cfg.selectedTargets || []).map(x => x && x.code).filter(Boolean));
      renderFieldTable(selectedSet);
      renderMissingNotice(cfg.selectedTargets, cfg.fieldSnapshot);

      if (el.fieldFilter) el.fieldFilter.addEventListener('input', applyTableFilter);

      // 全選択/解除（表示中のみ）
      if (el.btnSelectAll) el.btnSelectAll.addEventListener('click', () => setVisibleCheckboxes(true));
      if (el.btnUnselectAll) el.btnUnselectAll.addEventListener('click', () => setVisibleCheckboxes(false));

      if (el.btnSave) el.btnSave.addEventListener('click', onSave);
      if (el.btnCancel) el.btnCancel.addEventListener('click', onCancel);

      applyTableFilter();
    } catch (e) {
      showMessage(el.errBasic, `初期化に失敗しました。\n${e.message || e}`);
      if (el.btnSave) el.btnSave.disabled = true;
    }
  }

  init();
})();
