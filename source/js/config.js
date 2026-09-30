/* config.js
 * 一覧サポートの設定画面。
 * - 横断検索: v1 と同じ設定（spaceJoin / maxTokens / targetsJson / fieldSnapshotJson）をそのまま使う
 * - クイックフィルター / クイックボタン / 集計 / 条件付き装飾: lsConfig（JSON）に保存する
 * 保存形式と v1 からの移行は ls-core.js（normalizeConfig / toSavedConfig）にまとめてある。
 */
(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const LS = window.NrcListSupport;
  const LIM = LS.LIMITS[LS.EDITION];

  // 検索語の上限の既定値。desktop.js / config.html と同じ値にすること
  const DEFAULT_MAX_TOKENS = 5;

  const $ = (id) => document.getElementById(id);

  // ===== config.html の要素 =====
  const el = {
    migrateNote: $('migrateNote'),

    searchEnabled: $('searchEnabled'),
    searchBody: $('searchBody'),
    spaceJoin: $('spaceJoin'),       // and / or（一覧画面を開いたときの初期値。利用者は一覧画面で切り替えられる）
    maxTokens: $('maxTokens'),

    fieldFilter: $('fieldFilter'),
    btnSelectAll: $('btnSelectAll'),
    btnUnselectAll: $('btnUnselectAll'),
    fieldTbody: $('fieldTbody'),

    qfEnabled: $('qfEnabled'), qfBody: $('qfBody'), qfList: $('qfList'), qfAddField: $('qfAddField'), qfAdd: $('qfAdd'), qfLimit: $('qfLimit'), errQf: $('errQf'),
    qbEnabled: $('qbEnabled'), qbBody: $('qbBody'), qbList: $('qbList'), qbAdd: $('qbAdd'), qbLimit: $('qbLimit'), errQb: $('errQb'),
    sumEnabled: $('sumEnabled'), sumBody: $('sumBody'), sumList: $('sumList'), sumAddField: $('sumAddField'), sumAddMethod: $('sumAddMethod'), sumAdd: $('sumAdd'), sumLimit: $('sumLimit'), errSum: $('errSum'),
    hlEnabled: $('hlEnabled'), hlBody: $('hlBody'), hlList: $('hlList'), hlAdd: $('hlAdd'), hlLimit: $('hlLimit'), errHl: $('errHl'),

    btnSave: $('btnSave'),
    btnCancel: $('btnCancel'),

    errBasic: $('errBasic'),
    errFields: $('errFields'),
    errAll: $('errAll'),
    warnMissing: $('warnMissing')
  };

  // 横断検索の候補行
  // { code, label, type, typeLabel, op, isSubtable, parentCode, parentLabel, options }
  let fieldRows = [];
  // 一覧サポートの候補（テーブル外のフィールド）
  let allFields = [];
  let fieldByCode = {};
  // 画面の設定（LS.normalizeConfig の形）
  let cfg = null;

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
    FILE: '添付ファイル',
    NUMBER: '数値',
    CALC: '計算',
    DATE: '日付',
    DATETIME: '日時',
    CREATED_TIME: '作成日時',
    UPDATED_TIME: '更新日時',
    USER_SELECT: 'ユーザー選択',
    CREATOR: '作成者',
    MODIFIER: '更新者',
    STATUS: 'ステータス',
    STATUS_ASSIGNEE: '作業者'
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

  /** 要素を作る（利用者の入力やフィールド名は textContent / value で入れる） */
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = Boolean(v);
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach((c) => { if (c !== null && c !== undefined) node.append(c); });
    return node;
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
    const all = [];

    const extractOptions = (field) => {
      // options は { "選択肢": { label, index } } 形式
      const opt = field && field.options ? field.options : null;
      if (!opt || typeof opt !== 'object') return [];
      return Object.keys(opt).filter(k => k !== '__proto__').sort((a, b) => a.localeCompare(b, 'ja'));
    };
    const optionsByIndex = (field) => {
      const opt = field && field.options ? field.options : null;
      if (!opt || typeof opt !== 'object') return [];
      return Object.keys(opt).filter(k => k !== '__proto__')
        .sort((a, b) => Number((opt[a] && opt[a].index) || 0) - Number((opt[b] && opt[b].index) || 0));
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

      if (LS.typeGroup(f.type)) {
        const item = {
          code: f.code || code,
          label: f.label || code,
          type: f.type,
          options: IN_TYPES.has(f.type) ? optionsByIndex(f) : []
        };
        ['unit', 'unitPosition', 'displayScale', 'format'].forEach((k) => {
          if (f[k] !== undefined && f[k] !== null && f[k] !== '') item[k] = String(f[k]);
        });
        all.push(item);
      }
    });

    // 並び：通常フィールド（ラベル順）→ サブテーブル（親ラベル → 子ラベル）
    rows.sort((a, b) => {
      const aKey = `${a.isSubtable ? '1' : '0'}|${a.parentLabel || ''}|${a.label || ''}|${a.code || ''}`;
      const bKey = `${b.isSubtable ? '1' : '0'}|${b.parentLabel || ''}|${b.label || ''}|${b.code || ''}`;
      return aKey.localeCompare(bKey, 'ja');
    });
    all.sort((a, b) => `${a.label}|${a.code}`.localeCompare(`${b.label}|${b.code}`, 'ja'));

    return { rows, all };
  }

  /** ステータスの選択肢（プロセス管理が有効なときだけ）。取得できなければ空 */
  async function fetchStatusOptions() {
    if (typeof kintone.api !== 'function' || !kintone.api.url) return [];
    try {
      const res = await kintone.api(kintone.api.url('/k/v1/app/status.json', true), 'GET', { app: kintone.app.getId() });
      if (!res || !res.enable || !res.states) return [];
      return Object.keys(res.states)
        .sort((a, b) => Number(res.states[a].index || 0) - Number(res.states[b].index || 0));
    } catch (e) {
      return [];
    }
  }

  // ===== 描画（横断検索の対象フィールド） =====
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

  // ===== 一覧サポート: 共通 =====
  const fieldName = (f) => `${f.label}（${f.code}）`;
  const typeLabel = (type) => TYPE_LABEL_MAP[type] || type;

  function fieldRef(code) {
    const f = fieldByCode[code];
    if (!f) return null;
    const ref = { code: f.code, label: f.label, type: f.type };
    if (Array.isArray(f.options) && f.options.length) ref.options = f.options.slice();
    ['unit', 'unitPosition', 'displayScale', 'format'].forEach((k) => { if (f[k] !== undefined) ref[k] = f[k]; });
    return ref;
  }

  /** 条件に使えるフィールド（クイックフィルター・ボタン・装飾で共通） */
  function conditionFields() {
    return allFields.filter((f) => {
      const g = LS.typeGroup(f.type);
      if (!g) return false;
      if ((g === 'select' || g === 'multi') && (!f.options || f.options.length === 0)) return false;
      return true;
    });
  }

  function numericFields() {
    return allFields.filter((f) => LS.isNumericField(f));
  }

  function fillSelect(select, fields, selectedCode, placeholder) {
    select.replaceChildren();
    if (placeholder) select.append(h('option', { value: '', text: placeholder }));
    fields.forEach((f) => select.append(h('option', { value: f.code, text: `${fieldName(f)} ・ ${typeLabel(f.type)}` })));
    select.value = selectedCode && fields.some((f) => f.code === selectedCode) ? selectedCode : (placeholder ? '' : (fields[0] ? fields[0].code : ''));
  }

  function bindToggle(input, body, section) {
    if (!input || !body) return;
    input.checked = Boolean(cfg[section].enabled);
    body.hidden = !input.checked;
    input.addEventListener('change', () => {
      cfg[section].enabled = input.checked;
      body.hidden = !input.checked;
    });
  }

  function setLimitLabel(target, count, max) {
    if (target) target.textContent = `（${count} / ${max}）`;
  }

  // ----- 条件の行（クイックボタン・条件付き装飾で共通） -----
  function defaultValueFor(kind) {
    if (kind === 'date') return { kind: 'today', offset: 0 };
    if (kind === 'options') return [];
    if (kind === 'none') return undefined;
    return '';
  }

  function opsFor(code) {
    return LS.operatorsFor(fieldByCode[code] || null);
  }

  function valueKind(code, op) {
    const o = opsFor(code).find((x) => x.op === op);
    return o ? o.value : 'none';
  }

  function resetCond(cond, code) {
    cond.code = code;
    const ops = opsFor(code);
    cond.op = ops[0] ? ops[0].op : '';
    cond.value = defaultValueFor(ops[0] ? ops[0].value : 'none');
  }

  /**
   * 条件 1 行分の入力欄。data-* で「どの条件のどの項目か」を持たせ、入力はイベント委譲で受ける。
   * purpose: 'query'（クイックボタン。今週・今月などの期間も選べる）| 'eval'（条件付き装飾）
   */
  function condEditor(cond, keyAttrs, purpose) {
    const frag = [];
    const fieldSel = h('select', { ...keyAttrs, 'data-role': 'field', 'aria-label': '条件のフィールド' });
    fillSelect(fieldSel, conditionFields(), cond.code, 'フィールドを選択');
    frag.push(fieldSel);
    if (!cond.code || !fieldByCode[cond.code]) return frag;

    const ops = opsFor(cond.code);
    const opSel = h('select', { ...keyAttrs, 'data-role': 'op', 'aria-label': '条件の種類' });
    ops.forEach((o) => opSel.append(h('option', { value: o.op, text: o.label })));
    opSel.value = cond.op;
    frag.push(opSel);

    const kind = valueKind(cond.code, cond.op);
    const f = fieldByCode[cond.code];
    if (kind === 'text') {
      frag.push(h('input', { ...keyAttrs, type: 'text', 'data-role': 'value', 'aria-label': '比較する文字', value: typeof cond.value === 'string' ? cond.value : '' }));
    } else if (kind === 'number') {
      frag.push(h('input', { ...keyAttrs, type: 'number', 'data-role': 'value', 'aria-label': '比較する数値', value: cond.value ?? '' }));
    } else if (kind === 'date') {
      const v = cond.value && typeof cond.value === 'object' ? cond.value : { kind: 'today', offset: 0 };
      const kindSel = h('select', { ...keyAttrs, 'data-role': 'dateKind', 'aria-label': '日付の指定方法' });
      kindSel.append(h('option', { value: 'today', text: '今日から' }), h('option', { value: 'fixed', text: '日付を指定' }));
      if (purpose === 'query' && cond.op === 'eq') {
        Object.entries(LS.PERIODS).forEach(([k, label]) => kindSel.append(h('option', { value: `period:${k}`, text: label })));
      }
      kindSel.value = v.kind === 'period' ? `period:${v.period}` : (v.kind === 'fixed' ? 'fixed' : 'today');
      frag.push(kindSel);
      if (v.kind === 'fixed') {
        frag.push(h('input', { ...keyAttrs, type: 'date', 'data-role': 'date', 'aria-label': '日付', value: v.date || '' }));
      } else if (v.kind !== 'period') {
        frag.push(h('input', { ...keyAttrs, type: 'number', 'data-role': 'offset', 'aria-label': '今日から何日後（前はマイナス）', value: String(v.offset || 0), style: 'width:70px' }));
        frag.push(h('span', { className: 'ls-typeTag', text: '日後（前はマイナス）' }));
      }
    } else if (kind === 'options') {
      const box = h('span', { className: 'ls-options', role: 'group', 'aria-label': '選択肢' });
      const selected = new Set(Array.isArray(cond.value) ? cond.value : []);
      (f.options || []).forEach((o) => {
        box.append(h('label', {}, [h('input', { ...keyAttrs, type: 'checkbox', 'data-role': 'opt', value: o, checked: selected.has(o) }), document.createTextNode(o)]));
      });
      frag.push(box);
    }
    return frag;
  }

  /** 条件の入力欄の変更を model（cond）へ反映する。構造が変わる場合は true（描き直しが必要） */
  function applyCondInput(cond, target, row) {
    const role = target.dataset.role;
    if (role === 'field') { resetCond(cond, target.value); return true; }
    if (role === 'op') {
      const beforeKind = valueKind(cond.code, cond.op);
      cond.op = target.value;
      const afterKind = valueKind(cond.code, cond.op);
      if (beforeKind !== afterKind) cond.value = defaultValueFor(afterKind);
      // 期間は「が（期間内）」のときだけ選べる
      if (cond.value && cond.value.kind === 'period' && cond.op !== 'eq') cond.value = { kind: 'today', offset: 0 };
      return true;
    }
    if (role === 'value') { cond.value = target.value; return false; }
    if (role === 'dateKind') {
      const v = target.value;
      if (v === 'fixed') cond.value = { kind: 'fixed', date: '' };
      else if (v.startsWith('period:')) cond.value = { kind: 'period', period: v.slice(7) };
      else cond.value = { kind: 'today', offset: 0 };
      return true;
    }
    if (role === 'offset') { cond.value = { kind: 'today', offset: Math.trunc(Number(target.value)) || 0 }; return false; }
    if (role === 'date') { cond.value = { kind: 'fixed', date: target.value }; return false; }
    if (role === 'opt') {
      const checked = Array.from(row.querySelectorAll('input[data-role="opt"]')).filter((c) => c.checked).map((c) => c.value);
      cond.value = checked;
      return false;
    }
    return false;
  }

  function condIsValid(cond) {
    const f = fieldByCode[cond && cond.code];
    if (!f) return false;
    return Boolean(LS.buildCondClause(cond, f));
  }

  // ----- クイックフィルター -----
  function renderQf() {
    const items = cfg.quickFilter.items;
    el.qfList.replaceChildren(...items.map((it, i) => {
      const f = fieldByCode[it.code];
      const name = f ? fieldName(f) : `${it.label || it.code}（${it.code}）`;
      return h('div', { className: 'ls-item' }, [
        h('span', { className: 'ls-grow', text: name }),
        h('span', { className: 'ls-typeTag', text: f ? typeLabel(f.type) : 'フィールドが見つかりません' }),
        h('button', { className: 'ls-remove', type: 'button', 'data-act': 'qf-remove', 'data-i': i, text: '削除' })
      ]);
    }));
    const used = new Set(items.map((i) => i.code));
    fillSelect(el.qfAddField, conditionFields().filter((f) => !used.has(f.code)), '', 'フィールドを選択');
    el.qfAdd.disabled = items.length >= LIM.quickFilter;
    setLimitLabel(el.qfLimit, items.length, LIM.quickFilter);
  }

  // ----- クイックボタン -----
  function renderQb() {
    const buttons = cfg.quickButtons.items;
    el.qbList.replaceChildren(...buttons.map((b, bi) => {
      const card = h('div', { className: 'ls-button', 'data-bi': bi });
      card.append(h('div', { className: 'ls-buttonHead' }, [
        h('input', { type: 'text', 'data-bi': bi, 'data-role': 'label', placeholder: 'ボタン名（例: 未対応）', 'aria-label': 'ボタン名', value: b.label || '', maxlength: '40' }),
        h('span', { className: 'ls-and', text: '次の条件をすべて満たすレコード' }),
        h('span', { className: 'ls-grow' }),
        h('button', { className: 'ls-remove', type: 'button', 'data-act': 'qb-remove', 'data-bi': bi, text: 'ボタンを削除' })
      ]));
      b.conds.forEach((c, ci) => {
        const row = h('div', { className: 'ls-item', 'data-bi': bi, 'data-ci': ci });
        row.append(...condEditor(c, { 'data-bi': bi, 'data-ci': ci }, 'query'));
        row.append(h('span', { className: 'ls-grow' }), h('button', { className: 'ls-remove', type: 'button', 'data-act': 'qb-cond-remove', 'data-bi': bi, 'data-ci': ci, text: '条件を削除' }));
        card.append(row);
      });
      card.append(h('div', {}, [h('button', {
        className: 'nrc-btn', type: 'button', 'data-act': 'qb-cond-add', 'data-bi': bi,
        text: `＋ 条件を追加（${b.conds.length} / ${LIM.buttonConds}）`, disabled: b.conds.length >= LIM.buttonConds
      })]));
      return card;
    }));
    el.qbAdd.disabled = buttons.length >= LIM.quickButtons;
    setLimitLabel(el.qbLimit, buttons.length, LIM.quickButtons);
  }

  // ----- 集計 -----
  function renderSum() {
    const items = cfg.summary.items;
    el.sumList.replaceChildren(...items.map((it, i) => {
      const f = fieldByCode[it.code];
      return h('div', { className: 'ls-item' }, [
        h('span', { className: 'ls-grow', text: `${f ? fieldName(f) : `${it.label || it.code}（${it.code}）`} の${LS.METHOD_LABELS[it.method]}` }),
        f ? null : h('span', { className: 'ls-typeTag', text: 'フィールドが見つかりません' }),
        h('button', { className: 'ls-remove', type: 'button', 'data-act': 'sum-remove', 'data-i': i, text: '削除' })
      ]);
    }));
    fillSelect(el.sumAddField, numericFields(), '', '数値フィールドを選択');
    el.sumAdd.disabled = items.length >= LIM.summary;
    setLimitLabel(el.sumLimit, items.length, LIM.summary);
  }

  // ----- 条件付き装飾 -----
  function swatch(styleName) {
    const p = LS.STYLE_PRESETS[styleName] || {};
    const css = [
      p.background ? `background:${p.background}` : '',
      p.color ? `color:${p.color}` : '',
      p.bold ? 'font-weight:700' : ''
    ].filter(Boolean).join(';');
    return h('span', { className: 'ls-swatch', style: css, text: '表示例' });
  }

  function renderHl() {
    const rules = cfg.highlight.rules;
    el.hlList.replaceChildren(...rules.map((r, ri) => {
      // 1 段目: 条件、2 段目: 装飾（範囲・色・表示例・削除）
      const row = h('div', { className: 'ls-item ls-item--rule', 'data-ri': ri });
      const when = h('div', { className: 'ls-line' }, [h('span', { className: 'ls-and', text: `ルール ${ri + 1}` })]);
      when.append(...condEditor(r, { 'data-ri': ri }, 'eval'));
      const target = h('select', { 'data-ri': ri, 'data-role': 'target', 'aria-label': '装飾する範囲' });
      target.append(h('option', { value: 'row', text: '行全体' }), h('option', { value: 'cell', text: 'このフィールドのセル' }));
      target.value = r.target === 'cell' ? 'cell' : 'row';
      const style = h('select', { 'data-ri': ri, 'data-role': 'style', 'aria-label': '装飾' });
      Object.entries(LS.STYLE_PRESETS).forEach(([k, p]) => style.append(h('option', { value: k, text: p.label })));
      style.value = LS.STYLE_PRESETS[r.style] ? r.style : 'warning';
      const then = h('div', { className: 'ls-line' }, [
        h('span', { className: 'ls-typeTag', text: 'のとき →' }), target, style, swatch(style.value),
        h('span', { className: 'ls-grow' }),
        h('button', { className: 'ls-remove', type: 'button', 'data-act': 'hl-remove', 'data-ri': ri, text: '削除' })
      ]);
      row.append(when, then);
      return row;
    }));
    el.hlAdd.disabled = rules.length >= LIM.highlight;
    setLimitLabel(el.hlLimit, rules.length, LIM.highlight);
  }

  function renderAll() {
    renderQf();
    renderQb();
    renderSum();
    renderHl();
  }

  // ----- 入力イベント（委譲） -----
  let idSeq = 0;
  const newId = (p) => `${p}${Date.now().toString(36)}${(idSeq += 1).toString(36)}`;

  function bindListSupportEvents() {
    el.qfAdd.addEventListener('click', () => {
      const code = el.qfAddField.value;
      if (!code || cfg.quickFilter.items.length >= LIM.quickFilter) return;
      cfg.quickFilter.items.push(fieldRef(code));
      renderQf();
    });
    el.qfList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="qf-remove"]');
      if (!btn) return;
      cfg.quickFilter.items.splice(Number(btn.dataset.i), 1);
      renderQf();
    });

    el.qbAdd.addEventListener('click', () => {
      if (cfg.quickButtons.items.length >= LIM.quickButtons) return;
      cfg.quickButtons.items.push({ id: newId('b'), label: '', conds: [{ code: '', op: '', value: '' }], metas: [] });
      renderQb();
    });
    el.qbList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const bi = Number(btn.dataset.bi);
      const b = cfg.quickButtons.items[bi];
      if (!b) return;
      if (btn.dataset.act === 'qb-remove') cfg.quickButtons.items.splice(bi, 1);
      else if (btn.dataset.act === 'qb-cond-add' && b.conds.length < LIM.buttonConds) b.conds.push({ code: '', op: '', value: '' });
      else if (btn.dataset.act === 'qb-cond-remove') b.conds.splice(Number(btn.dataset.ci), 1);
      else return;
      renderQb();
    });
    const onQbInput = (e) => {
      const t = e.target;
      const bi = Number(t.dataset.bi);
      const b = cfg.quickButtons.items[bi];
      if (!b || !t.dataset.role) return;
      if (t.dataset.role === 'label') { b.label = t.value; return; }
      const cond = b.conds[Number(t.dataset.ci)];
      if (!cond) return;
      if (applyCondInput(cond, t, t.closest('.ls-item')) && e.type === 'change') renderQb();
    };
    el.qbList.addEventListener('input', onQbInput);
    el.qbList.addEventListener('change', onQbInput);

    el.sumAdd.addEventListener('click', () => {
      const code = el.sumAddField.value;
      if (!code || cfg.summary.items.length >= LIM.summary) return;
      cfg.summary.items.push({ ...fieldRef(code), method: el.sumAddMethod.value === 'avg' ? 'avg' : 'sum' });
      renderSum();
    });
    el.sumList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="sum-remove"]');
      if (!btn) return;
      cfg.summary.items.splice(Number(btn.dataset.i), 1);
      renderSum();
    });

    el.hlAdd.addEventListener('click', () => {
      if (cfg.highlight.rules.length >= LIM.highlight) return;
      cfg.highlight.rules.push({ id: newId('h'), code: '', op: '', value: '', target: 'row', style: 'warning' });
      renderHl();
    });
    el.hlList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="hl-remove"]');
      if (!btn) return;
      cfg.highlight.rules.splice(Number(btn.dataset.ri), 1);
      renderHl();
    });
    const onHlInput = (e) => {
      const t = e.target;
      const r = cfg.highlight.rules[Number(t.dataset.ri)];
      if (!r || !t.dataset.role) return;
      if (t.dataset.role === 'target') { r.target = t.value === 'cell' ? 'cell' : 'row'; return; }
      if (t.dataset.role === 'style') { r.style = t.value; if (e.type === 'change') renderHl(); return; }
      if (applyCondInput(r, t, t.closest('.ls-item')) && e.type === 'change') renderHl();
    };
    el.hlList.addEventListener('input', onHlInput);
    el.hlList.addEventListener('change', onHlInput);
  }

  // ===== 保存 =====
  function validateBeforeSave() {
    [el.errBasic, el.errFields, el.errQf, el.errQb, el.errSum, el.errHl, el.errAll].forEach((x) => showMessage(x, ''));
    let ok = true;

    if (cfg.search.enabled) {
      const maxTokens = Number(el.maxTokens && el.maxTokens.value);
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 10) {
        showMessage(el.errBasic, '「検索語の上限」は 1〜10 の整数で指定してください。');
        return false;
      }
      if (getSelectedCodes().length === 0) {
        showMessage(el.errFields, '検索対象フィールドが未選択です。少なくとも1つ選択してください。');
        return false;
      }
    }

    if (cfg.quickFilter.enabled && cfg.quickFilter.items.length === 0) {
      showMessage(el.errQf, 'クイックフィルターに使うフィールドを 1 つ以上追加してください。');
      ok = false;
    }

    if (cfg.quickButtons.enabled) {
      const problems = [];
      if (cfg.quickButtons.items.length === 0) problems.push('ボタンを 1 つ以上追加してください。');
      cfg.quickButtons.items.forEach((b, i) => {
        const name = b.label && b.label.trim() ? `「${b.label.trim()}」` : `${i + 1} 番目`;
        if (!b.label || !b.label.trim()) problems.push(`${i + 1} 番目のボタンに名前を入力してください。`);
        if (b.conds.length === 0) problems.push(`ボタン${name}に条件を 1 つ以上追加してください。`);
        b.conds.forEach((c, ci) => { if (!condIsValid(c)) problems.push(`ボタン${name}の条件 ${ci + 1} を確認してください（フィールド・種類・値）。`); });
      });
      if (problems.length) { showMessage(el.errQb, problems.join('\n')); ok = false; }
    }

    if (cfg.highlight.enabled) {
      const problems = [];
      if (cfg.highlight.rules.length === 0) problems.push('ルールを 1 つ以上追加してください。');
      cfg.highlight.rules.forEach((r, i) => { if (!condIsValid(r)) problems.push(`ルール ${i + 1} を確認してください（フィールド・種類・値）。`); });
      if (problems.length) { showMessage(el.errHl, problems.join('\n')); ok = false; }
    }

    const anyOn = cfg.search.enabled || cfg.quickFilter.enabled || cfg.quickButtons.enabled || cfg.summary.enabled || cfg.highlight.enabled;
    if (!anyOn) {
      showMessage(el.errAll, '使う機能を 1 つ以上オンにしてください。');
      ok = false;
    }
    if (!ok && !el.errAll.classList.contains('is-show')) showMessage(el.errAll, '入力内容を確認してください。');
    return ok;
  }

  function buildTargetsFromSelected(selectedCodes) {
    return selectedCodes.map((code) => {
      const row = fieldRows.find(r => r.code === code);
      return { code, op: row ? row.op : 'like' };
    });
  }

  /** 保存直前に、参照しているフィールドの情報（型・選択肢・単位）を今の定義で取り直す */
  function refreshSnapshots() {
    cfg.quickFilter.items = cfg.quickFilter.items.map((i) => fieldRef(i.code) || i);
    cfg.quickButtons.items = cfg.quickButtons.items.map((b) => {
      const codes = Array.from(new Set(b.conds.map((c) => c.code).filter(Boolean)));
      return { id: b.id, label: (b.label || '').trim(), conds: b.conds.map((c) => ({ code: c.code, op: c.op, value: c.value })), metas: codes.map(fieldRef).filter(Boolean) };
    });
    cfg.summary.items = cfg.summary.items.map((i) => {
      const ref = fieldRef(i.code);
      return ref ? { ...ref, method: i.method } : i;
    });
    cfg.highlight.rules = cfg.highlight.rules.map((r) => {
      const f = fieldByCode[r.code];
      return { id: r.id, code: r.code, op: r.op, value: r.value, target: r.target, style: r.style, type: f ? f.type : (r.type || '') };
    });
  }

  function onSave() {
    if (!validateBeforeSave()) return;

    const selectedCodes = getSelectedCodes();
    cfg.search.spaceJoin = el.spaceJoin && el.spaceJoin.value === 'or' ? 'or' : 'and';
    cfg.search.maxTokens = Number(el.maxTokens && el.maxTokens.value) || DEFAULT_MAX_TOKENS;
    // 検索対象（クエリ生成用：最小）と desktop.js 用スナップショット（type / options など）
    cfg.search.targets = buildTargetsFromSelected(selectedCodes);
    cfg.search.fieldSnapshot = buildFieldSnapshotFromSelected(selectedCodes);
    refreshSnapshots();

    writeConfig(LS.toSavedConfig(cfg));
  }

  function onCancel() {
    history.back();
  }

  // ===== init =====
  async function init() {
    try {
      cfg = LS.normalizeConfig(kintone.plugin.app.getConfig(PLUGIN_ID) || {});

      if (el.spaceJoin) el.spaceJoin.value = cfg.search.spaceJoin;
      if (el.maxTokens) el.maxTokens.value = String(cfg.search.maxTokens);
      if (el.migrateNote) el.migrateNote.hidden = cfg.migratedFrom !== 'v1';

      const fetched = await fetchFormFields();
      fieldRows = fetched.rows;
      allFields = fetched.all;
      fieldByCode = {};
      allFields.forEach((f) => { fieldByCode[f.code] = f; });

      const statusField = allFields.find((f) => f.type === 'STATUS');
      if (statusField) {
        statusField.options = await fetchStatusOptions();
      }

      const selectedSet = new Set((cfg.search.targets || []).map(x => x && x.code).filter(Boolean));
      renderFieldTable(selectedSet);
      renderMissingNotice(cfg.search.targets, cfg.search.fieldSnapshot);

      if (el.fieldFilter) el.fieldFilter.addEventListener('input', applyTableFilter);

      // 全選択/解除（表示中のみ）
      if (el.btnSelectAll) el.btnSelectAll.addEventListener('click', () => setVisibleCheckboxes(true));
      if (el.btnUnselectAll) el.btnUnselectAll.addEventListener('click', () => setVisibleCheckboxes(false));

      bindToggle(el.searchEnabled, el.searchBody, 'search');
      bindToggle(el.qfEnabled, el.qfBody, 'quickFilter');
      bindToggle(el.qbEnabled, el.qbBody, 'quickButtons');
      bindToggle(el.sumEnabled, el.sumBody, 'summary');
      bindToggle(el.hlEnabled, el.hlBody, 'highlight');
      renderAll();
      bindListSupportEvents();

      if (el.btnSave) el.btnSave.addEventListener('click', onSave);
      if (el.btnCancel) el.btnCancel.addEventListener('click', onCancel);

      applyTableFilter();
    } catch (e) {
      showMessage(el.errBasic, `初期化に失敗しました。\n${e.message || e}`);
      if (!cfg || !cfg.search.enabled) showMessage(el.errAll, `初期化に失敗しました。\n${e.message || e}`);
      if (el.btnSave) el.btnSave.disabled = true;
    }
  }

  init();
})();
