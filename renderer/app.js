'use strict';

const state = {
  skills: [],
  counts: {},
  dirs: {},
  category: '全部',
  search: '',
  showDisabled: true,
  onlyBroken: false,
  selected: null,
  updates: new Set(),
  checking: false,
  lang: 'zh',
  settings: null,
  scope: 'global', // 'global' 或项目绝对路径
  noNode: false,
  reconcileCount: 0,
  reconcileFindings: [],
  lastCheckAt: null,
};

const $ = (id) => document.getElementById(id);

function L(zh, en) { return state.lang === 'en' ? en : zh; }

const CAT_EN = {
  '视频生成': 'Video', '图像生成': 'Image', '视频渲染': 'Render',
  '分镜运镜': 'Camera', '短剧': 'Drama', 'UI 设计': 'UI',
  '工程工具': 'Tools', '其他': 'Other',
};
function catLabel(c) { return state.lang === 'en' ? (CAT_EN[c] || c) : c; }

function isZhText(s) {
  return /[一-龥]/.test(s || '');
}

function descOf(s) {
  const src = s.description || '';
  const wantZh = state.lang !== 'en';
  // 原文就是当前语言 → 永远用原文（编辑后立刻反映）
  if (src && isZhText(src) === wantZh) return src;
  const tr = (wantZh ? s.descZh : s.descEn) || '';
  return tr || src || '（无描述）';
}

function isTranslationStale(s) {
  if (!s || !s.transStale) return false;
  const src = s.description || '';
  const wantZh = state.lang !== 'en';
  return src && isZhText(src) !== wantZh;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 日志条 ---------------- */

let logTimer = null;
function log(msg) {
  const el = $('log');
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + msg;
  el.classList.add('show');
  el.scrollTop = el.scrollHeight;
  clearTimeout(logTimer);
  logTimer = setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 12000);
}

function banner(msg, kind) {
  const el = $('banner');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.className = 'banner ' + (kind || '');
}

function bannerHtml(html, kind) {
  const el = $('banner');
  el.innerHTML = html;
  el.className = 'banner ' + (kind || '');
}

/* ---------------- 弹窗 ---------------- */

let modalStack = [];

function openModal(opts) {
  $('modalTitle').textContent = opts.title || '';
  $('modalBody').innerHTML = opts.body || '';
  $('modalFoot').innerHTML = opts.foot || '';
  document.querySelector('.modal').classList.toggle('wide', !!opts.wide);
  $('overlay').classList.remove('hidden');
  modalStack.push(opts.id || 'modal');
  if (typeof opts.onMount === 'function') opts.onMount();
}

function closeModal() {
  $('overlay').classList.add('hidden');
  $('modalBody').innerHTML = '';
  $('modalFoot').innerHTML = '';
  modalStack = [];
}

$('modalClose').addEventListener('click', closeModal);
$('overlay').addEventListener('click', (e) => {
  if (e.target === $('overlay')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('overlay').classList.contains('hidden')) closeModal();
});

function loading(text) { return `<div class="loading">${esc(text || '处理中…')}</div>`; }

/* ---------------- 数据 ---------------- */

async function load(force) {
  try {
    if ($('brandSub')) $('brandSub').textContent = '加载中…';
    const data = state.scope === 'global'
      ? await window.api.list(!!force)
      : await window.api.projectList(state.scope);
    state.skills = data.skills;
    state.counts = data.counts;
    state.dirs = data.dirs;
    state.projectMode = data.mode || null;
    state.skillsDirExists = data.skillsDirExists !== false;
    render();
    if (state.scope !== 'global' && data.skillsDirExists === false) {
      banner(`这个目录下没有找到技能。已查找：${(data.dirs && data.dirs.skills) || state.scope}`, 'warn');
    }
  } catch (e) {
    banner('加载失败：' + e.message, 'err');
  }
}

async function loadSettings() {
  try { state.settings = await window.api.settingsGet(); } catch (e) { state.settings = null; }
  return state.settings;
}

/* ---------------- 渲染 ---------------- */

function statusOf(s) {
  if (s.disabled) return { cls: 'dot-off', text: t('detail.off') };
  if (s.health === 'ok') return { cls: 'dot-ok', text: t('detail.ok') };
  if (s.health === 'yaml-error' || s.health === 'missing-skill-md' || s.health === 'duplicate-name') {
    return { cls: 'dot-err', text: t('detail.abnormal') };
  }
  return { cls: 'dot-warn', text: t('detail.warn') };
}

function visibleSkills() {
  const q = state.search.trim().toLowerCase();
  return state.skills.filter((s) => {
    if (!state.showDisabled && s.disabled) return false;
    if (state.onlyBroken && s.health === 'ok') return false;
    if (state.category !== '全部' && s.category !== state.category) return false;
    if (q) {
      const hay = (s.name + ' ' + (s.descZh || '') + ' ' + (s.descEn || '') + ' ' + (s.source || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const c = state.counts || {};

  // 作用域列表
  const projects = (state.settings && state.settings.projects) || [];
  const sl = $('scopeList');
  sl.innerHTML = '';
  const mkScope = (label, value, title) => {
    const li = document.createElement('li');
    li.className = 'cat-item' + (state.scope === value ? ' active' : '');
    li.title = title || '';
    const span = document.createElement('span');
    span.textContent = label;
    li.appendChild(span);
    if (value !== 'global') {
      const del = document.createElement('span');
      del.className = 'scope-del';
      del.textContent = '×';
      del.title = '从列表移除（不会删除任何文件）';
      del.onclick = async (ev) => {
        ev.stopPropagation();
        await window.api.projectRemove(value);
        state.settings = await window.api.settingsGet();
        if (state.scope === value) { state.scope = 'global'; await load(true); }
        else render();
      };
      li.appendChild(del);
    }
    li.onclick = async () => {
      if (state.scope === value) return;
      state.scope = value;
      state.category = '全部';
      state.selected = null;
      state.updates.clear();
      $('btnUpdateAll').disabled = true;
      $('detailBody').classList.add('hidden');
      $('detailEmpty').classList.remove('hidden');
      await load(false);
    };
    return li;
  };
  sl.appendChild(mkScope(t('side.global'), 'global', (state.dirs && state.dirs.skills) || ''));
  projects.forEach((p) => sl.appendChild(
    mkScope(p.split(/[\\/]/).filter(Boolean).pop() || p, p, p)));

  const isProject = state.scope !== 'global';
  const distBtn = $('btnDistribute');
  if (distBtn) {
    distBtn.disabled = isProject;
    distBtn.title = isProject
      ? '分发只对全局技能生效；项目技能请先移到全局再分发'
      : '把技能共享给其他 AI 工具';
  }
  $('btnCheck').disabled = false;
  $('btnPresets').disabled = false;
  $('btnUpdateAll').disabled = state.updates.size === 0;

  const rcBtn = $('btnReconcile');
  if (rcBtn) {
    rcBtn.textContent = state.reconcileCount
      ? t('btn.reconcile') + ' (' + state.reconcileCount + ')'
      : t('btn.reconcile');
  }

  if (state.noNode) {
    ['btnCheck', 'btnUpdateAll', 'btnMarket'].forEach((id) => {
      const b = $(id);
      if (b) { b.disabled = true; b.title = '需要 Node.js 22.20 或更高版本'; }
    });
  }

  const scopeTag = isProject
    ? L(' · 项目：', ' · project: ') + (state.scope.split(/[\\/]/).filter(Boolean).pop() || '')
    : '';
  $('brandSub').textContent = L(
    `${c.total || 0} 个技能 · ${c.enabled || 0} 启用 · ${c.untracked || 0} 本地` +
      (c.broken ? ` · ${c.broken} 异常` : '') + scopeTag,
    `${c.total || 0} skills · ${c.enabled || 0} on · ${c.untracked || 0} local` +
      (c.broken ? ` · ${c.broken} issues` : '') + scopeTag
  );

  const cats = new Map();
  for (const s of state.skills) {
    if (!state.showDisabled && s.disabled) continue;
    cats.set(s.category, (cats.get(s.category) || 0) + 1);
  }
  const total = [...cats.values()].reduce((a, b) => a + b, 0);
  const list = $('catList');
  list.innerHTML = '';
  const mk = (label, value, n) => {
    const li = document.createElement('li');
    li.className = 'cat-item' + (state.category === value ? ' active' : '');
    li.innerHTML = '<span></span><span class="cat-count">' + n + '</span>';
    li.firstChild.textContent = label;
    li.onclick = () => { state.category = value; render(); };
    return li;
  };
  list.appendChild(mk(t('side.all'), '全部', total));
  [...cats.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([n, v]) => list.appendChild(mk(catLabel(n), n, v)));

  $('sideFooter').innerHTML = L(
    `可用 ${c.enabled || 0} · 禁用 ${c.disabled || 0}<br>` +
      `可追踪 ${c.tracked || 0} · 本地 ${c.untracked || 0}` +
      (c.broken ? `<br><span style="color:var(--warning)">${c.broken} 个需要修复</span>` : ''),
    `enabled ${c.enabled || 0} · disabled ${c.disabled || 0}<br>` +
      `tracked ${c.tracked || 0} · local ${c.untracked || 0}` +
      (c.broken ? `<br><span style="color:var(--warning)">${c.broken} need fixing</span>` : '')
  );

  const items = visibleSkills();
  const grid = $('grid');
  grid.innerHTML = '';
  $('empty').classList.toggle('hidden', items.length > 0);

  for (const s of items) {
    const st = statusOf(s);
    const card = document.createElement('div');
    card.className = 'card' + (s.disabled ? ' is-disabled' : '') +
      (state.selected === s.name ? ' active' : '') +
      (state.updates.has(s.name) ? ' has-update' : '');
    card.innerHTML =
      '<div class="card-top"><div class="card-name"></div><div class="card-cat"></div></div>' +
      '<div class="card-desc"></div>' +
      '<div class="card-foot"><span class="status-dot ' + st.cls + '"></span>' +
      '<span class="st-text"></span><span class="cli-warn"></span><span class="card-track"></span></div>';
    card.querySelector('.card-name').textContent = s.name;
    card.querySelector('.card-cat').textContent = catLabel(s.category || '其他');
    card.querySelector('.card-desc').textContent = descOf(s);
    card.querySelector('.st-text').textContent = st.text;
    card.querySelector('.card-track').textContent =
      state.updates.has(s.name) ? L('↑ 有更新', '↑ update') : (s.tracked ? (s.source || '') : t('side.local'));
    const cw = card.querySelector('.cli-warn');
    if (s.cliMissing && s.cliMissing.length) {
      cw.textContent = L('缺 ', 'needs ') + s.cliMissing.join('/');
      cw.classList.add('show');
      cw.title = L(`这个技能需要 ${s.cliMissing.join('、')}，本机未安装`,
        `This skill needs ${s.cliMissing.join(', ')} — not installed`);
    }
    card.onclick = () => select(s.name);
    grid.appendChild(card);
  }
}

/* ---------------- 详情 ---------------- */

function select(name) {
  state.selected = name;
  const s = state.skills.find((x) => x.name === name);
  if (!s) return;
  render();

  $('detailEmpty').classList.add('hidden');
  $('detailBody').classList.remove('hidden');

  $('dName').textContent = s.name;
  const b = $('dBadge');
  b.textContent = s.disabled ? t('detail.disabledTag') : t('detail.enabled');
  b.className = 'badge ' + (s.disabled ? 'off' : 'on');

  $('dDesc').textContent = descOf(s);
  $('dStale').classList.toggle('hidden', !isTranslationStale(s));
  $('dCat').textContent = catLabel(s.category || '其他');
  $('dSource').textContent = s.tracked
    ? (s.source || '—')
    : (state.scope === 'global' ? t('detail.localSkill') : t('detail.projectSkill'));

  const cliRow = $('dCliRow');
  $('dUpdateLabel').textContent = L('更新状态', 'Update');
  const du = $('dUpdate');
  if (!s.tracked) {
    du.innerHTML = `<span style="color:var(--dim)">${L('无上游来源', 'no upstream')}</span>`;
  } else if (state.updates.has(s.name)) {
    du.innerHTML = `<span style="color:var(--accent)">${L('有更新可用', 'update available')}</span>`;
  } else if (state.lastCheckAt) {
    const t2 = new Date(state.lastCheckAt);
    const hh = String(t2.getHours()).padStart(2, '0');
    const mm = String(t2.getMinutes()).padStart(2, '0');
    du.innerHTML = `<span style="color:var(--ok-text)">${L('已是最新', 'up to date')}</span>` +
      `<span style="color:var(--dim);font-size:10.5px"> · ${L('检查于', 'checked')} ${hh}:${mm}</span>`;
  } else {
    du.innerHTML = `<span style="color:var(--dim)">${L('未检查（点右上角「检查更新」）', 'not checked — press “Check updates”')}</span>`;
  }

  const needs = s.cliNeeds || [];
  if (needs.length) {
    cliRow.classList.remove('hidden');
    const missing = s.cliMissing || [];
    if (!missing.length) {
      $('dCli').innerHTML = `<span style="color:var(--ok-text)">${needs.map(esc).join('、')} ✓</span>`;
    } else {
      $('dCli').innerHTML = `<span style="color:var(--warn-text)">${needs.map((c) =>
        missing.includes(c) ? `<b style="color:var(--err-text)">${esc(c)}</b>` : esc(c)).join('、')} · ${t('detail.cliMissing')}</span>`;
    }
  } else {
    cliRow.classList.add('hidden');
  }
  $('dStatus').textContent = statusOf(s).text;
  $('dSize').textContent = s.sizeKb != null ? s.sizeKb + ' KB' : t('detail.computing');
  if (s.sizeKb == null) {
    window.api.size(s.path).then((kb) => {
      if (state.selected === s.name && kb != null) $('dSize').textContent = kb + ' KB';
    }).catch(() => {});
  }
  $('dPath').textContent = s.path;

  const alert = $('dAlert');
  if (s.health !== 'ok') {
    alert.classList.remove('hidden');
    alert.className = 'detail-alert' + (s.health !== 'no-description' && s.health !== 'name-mismatch' ? ' err' : '');
    alert.textContent = '⚠ ' + (s.healthDetail || s.health);
  } else {
    alert.classList.add('hidden');
  }

  const tb = $('btnToggle');
  tb.textContent = s.disabled ? t('detail.enable') : t('detail.disable');
  tb.disabled = false;
  tb.onclick = async () => {
    tb.disabled = true;
    try {
      if (state.scope === 'global') await window.api.toggle(s.name, s.disabled);
      else await window.api.projectToggle(state.scope, s.name, s.disabled);
      log(`${s.disabled ? '启用' : '禁用'}：${s.name}`);
      await load(true);
      select(s.name);
    } catch (e) {
      banner('操作失败：' + e.message, 'err');
      tb.disabled = false;
    }
  };

  const fb = $('btnFix');
  fb.classList.toggle('hidden', s.health === 'ok' || s.health === 'missing-skill-md');
  fb.onclick = () => runFix(s.name);

  const pb = $('btnPreview');
  pb.classList.remove('hidden');
  if (s.tracked) {
    pb.disabled = false;
    pb.title = L('对比远端最新版本', 'Compare with the latest upstream version');
    pb.onclick = () => showPreview(s.name);
  } else {
    pb.disabled = true;
    pb.title = state.scope === 'global'
      ? L('本地技能，没有上游来源，无法预览更新', 'Local skill — no upstream, nothing to preview')
      : L('这个项目里没有 skills-lock.json，不知道它从哪装的，无法预览更新',
        'No skills-lock.json in this project — install source unknown, cannot preview');
    pb.onclick = null;
  }

  const upBtn = $('btnUpdateOne');
  if (state.updates.has(s.name)) {
    upBtn.classList.remove('hidden');
    upBtn.disabled = false;
    upBtn.textContent = L('更新', 'Update');
    upBtn.onclick = () => doUpdateOne(s.name);
  } else {
    upBtn.classList.add('hidden');
    upBtn.onclick = null;
  }

  $('btnEdit').onclick = () => showEditor(s.name);
  $('btnOpen').onclick = () => window.api.openPath(s.path);
  $('btnUninstall').onclick = () => showUninstall(s.name);
}

/* ---------------- 局部刷新 ---------------- */

function currentProject() {
  return state.scope === 'global' ? null : state.scope;
}

function recomputeCounts(skills) {
  return {
    total: skills.length,
    enabled: skills.filter((s) => !s.disabled).length,
    disabled: skills.filter((s) => s.disabled).length,
    tracked: skills.filter((s) => s.tracked && !s.disabled).length,
    untracked: skills.filter((s) => !s.tracked && !s.disabled).length,
    broken: skills.filter((s) => s.health !== 'ok').length,
  };
}

async function refreshOne(name) {
  try {
    const one = await window.api.getSkill(name, currentProject());
    if (!one) { await load(false); return; }
    const i = state.skills.findIndex((s) => s.name === name);
    if (i >= 0) state.skills[i] = one;
    else state.skills.unshift(one);
    state.counts = recomputeCounts(state.skills);
    render();
    if (state.selected === name) select(name);
  } catch (e) {
    await load(false);
  }
}

/* ---------------- 修复 ---------------- */

async function runFix(name) {
  try {
    const r = await window.api.fix(name, currentProject());
    if (r.ok) {
      const done = (r.actions && r.actions.length) ? r.actions.join('、') : '无需改动';
      banner(`✓ ${name} 已修复：${done}`, 'ok');
      log(`修复 ${name}: ${done}`);
    } else {
      banner(`修复未完全成功：${r.error || r.stillBroken || '未知原因'}`, 'warn');
    }
    if (r.changed === false && r.ok) banner(`✓ ${name} 检查完毕，格式本来就正确`, 'ok');
    await refreshOne(name);
  } catch (e) {
    banner('修复失败：' + e.message, 'err');
  }
}

/* ---------------- 更新 ---------------- */

async function doCheck() {
  if (state.checking) return;
  state.checking = true;
  const btn = $('btnCheck');
  btn.disabled = true; btn.textContent = '检查中…';
  banner('正在向各来源查询最新版本，首次可能较慢…', '');
  try {
    const r = await window.api.check(currentProject());
    if (r.unsupported) {
      banner(r.reason, 'warn');
      return;
    }
    applyCheckResult(r);
  } catch (e) {
    banner('检查失败：' + e.message, 'err');
  } finally {
    state.checking = false;
    btn.disabled = false; btn.textContent = '检查更新';
  }
}

function applyCheckResult(r) {
  state.lastCheckAt = r.at || Date.now();
  if (r.upToDate) {
    state.updates.clear();
    banner('✓ 全部技能已是最新', 'ok');
  } else {
    state.updates = new Set(r.updates || []);
    const names = r.updates || [];
    if (names.length) {
      bannerHtml(
        `<span>${L(`发现 ${names.length} 个可更新：`, `${names.length} update(s) available: `)}</span>` +
        names.map((n) => `<button class="upd-chip" data-upd="${esc(n)}">${esc(n)}</button>`).join('') +
        `<span style="color:var(--dim);margin-left:8px;font-size:11px">${L('点名字可单独更新', 'click a name to update just that one')}</span>`,
        'warn'
      );
      $('banner').querySelectorAll('button[data-upd]').forEach((b) => {
        b.onclick = () => doUpdateOne(b.dataset.upd);
      });
    } else {
      banner(L('检查完成，详见日志', 'Check finished, see logs'), 'warn');
    }
    if (r.raw) log(r.raw);
  }
  $('btnUpdateAll').disabled = state.updates.size === 0;
  render();
  if (state.selected) select(state.selected);
}

async function doUpdateOne(name) {
  const btn = $('btnUpdateOne');
  if (btn) { btn.disabled = true; btn.textContent = L('更新中…', 'Updating…'); }
  banner(L(`正在更新 ${name}…`, `Updating ${name}…`), '');
  try {
    const r = await window.api.update([name], currentProject());
    if (r.ok) {
      state.updates.delete(name);
      banner(L(`✓ 已更新 ${name}`, `✓ ${name} updated`), 'ok');
      await refreshOne(name);
      render();
    } else {
      banner(L('更新失败，详见日志：', 'Update failed, see logs: ') + (r.raw || '').slice(0, 160), 'err');
      log(r.raw || '');
      await refreshOne(name);
    }
  } catch (e) {
    banner(L('更新失败：', 'Update failed: ') + e.message, 'err');
  }
}

async function doUpdateAll() {
  const names = [...state.updates];
  if (!names.length) return;
  const btn = $('btnUpdateAll');
  btn.disabled = true; btn.textContent = '更新中…';
  banner(`正在更新 ${names.length} 个技能（已自动备份）…`, '');
  try {
    const r = await window.api.update(names, currentProject());
    if (r.raw) log(r.raw);
    banner(r.ok ? `✓ 已更新 ${names.length} 个技能${r.backup ? '，更新前已备份' : ''}`
      : '更新过程中有错误，详见日志', r.ok ? 'ok' : 'err');
    state.updates.clear();
    await load(true);
  } catch (e) {
    banner('更新失败：' + e.message, 'err');
  } finally {
    $('btnUpdateAll').disabled = true;
    btn.textContent = '更新全部';
  }
}

/* ---------------- 差异预览 ---------------- */

async function showPreview(name) {
  openModal({
    title: t('title.preview', name),
    body: loading('正在对比远端最新版本…'),
    wide: true,
  });
  try {
    const r = await window.api.updatePreview(name, currentProject());
    if (!r.ok) {
      $('modalBody').innerHTML = `<div class="detail-alert">${esc(r.reason || '无法预览')}</div>`;
      return;
    }
    if (r.same) {
      $('modalBody').innerHTML = `<div class="banner ok">与远端完全一致，无需更新</div>
        <div class="kv"><span>来源</span><b class="mono">${esc(r.source)}</b></div>
        <div class="kv"><span>文件</span><b class="mono">${esc(r.remotePath)}</b></div>`;
      return;
    }
    const lines = (r.lines || []).map((l) =>
      `<div class="${l.t === '+' ? 'add' : 'del'}">${esc(l.t + ' ' + l.s)}</div>`).join('');
    $('modalBody').innerHTML =
      `<div class="diff-sum">新增 <b style="color:var(--ok-text)">${r.added}</b> 行，
        删除 <b style="color:var(--err-text)">${r.removed}</b> 行
        ${r.lines && r.lines.length >= 400 ? '（仅显示前 400 行）' : ''}</div>
       <div class="diff">${lines || '<div>（无内容差异）</div>'}</div>`;
    $('modalFoot').innerHTML =
      '<button class="btn btn-secondary" onclick="closeModal()">' + t('common.close') + '</button>' +
      `<button class="btn btn-primary" id="mUpdate">更新这一个</button>`;
    $('mUpdate').onclick = async () => {
      closeModal();
      state.updates = new Set([name]);
      await doUpdateAll();
    };
  } catch (e) {
    $('modalBody').innerHTML = `<div class="detail-alert err">${esc(e.message)}</div>`;
  }
}

/* ---------------- 依赖体检 ---------------- */

async function showDeps() {
  openModal({ title: t('title.deps'), body: loading('正在检测本机环境…'), wide: true });
  try {
    const items = await window.api.deps();
    const rows = items.map((d) => {
      let status;
      if (d.ok) status = '<span class="pill ok">' + t('dp.normal') + '</span>';
      else if (d.affected && d.affected.length) status = '<span class="pill warn">' + t('dp.notInstalled') + '</span>';
      else status = '<span class="pill bad">' + t('dp.missing') + '</span>';

      let impact;
      if (d.affected) {
        impact = d.affected.length
          ? `<span class="mono" style="font-size:10.5px;${d.ok ? 'color:var(--dim)' : 'color:var(--warn-text)'}">${d.affected.map(esc).join('、')}</span>`
          : '<span style="color:var(--dim)">—</span>';
      } else {
        impact = '<span style="color:var(--dim)">' + t('dp.allSkills') + '</span>';
      }

      return `<tr>
        <td>${esc(d.name)}</td>
        <td class="mono">${esc(d.found)}</td>
        <td>${status}</td>
        <td style="color:var(--muted)">${esc(d.hint)}</td>
        <td>${impact}</td>
      </tr>`;
    }).join('');

    const optional = items.filter((d) => !d.ok && d.install && d.affected && d.affected.length);

    $('modalBody').innerHTML =
      `<p style="color:var(--dim);font-size:11.5px;margin:0 0 12px;line-height:1.7">${t('dp.intro')}</p>
       <table class="tbl"><thead><tr><th>${t('dp.component')}</th><th>${t('dp.version')}</th><th>${t('dp.state')}</th><th>${t('dp.usage')}</th><th>${t('dp.affected')}</th></tr></thead>
       <tbody>${rows}</tbody></table>` +
      (optional.length ? `<div class="detail-alert" style="margin-top:14px">
        <b>${t('dp.optional')}</b> ${t('dp.optionalHint')}<br>` +
        optional.map((m) => `<div style="display:flex;align-items:center;gap:10px;margin-top:8px">
          <code style="flex:1;word-break:break-all">${esc(m.install)}</code>
          <button class="btn btn-secondary" data-install="${esc(m.key)}" style="flex:none">${t('dp.oneClick')}</button>
        </div>`).join('') +
        `</div>` : '');

    $('modalBody').querySelectorAll('button[data-install]').forEach((b) => {
      b.onclick = async () => {
        const key = b.dataset.install;
        const it = items.find((x) => x.key === key);
        const ok = confirm(t('dp.installConfirm', it ? it.install : key));
        if (!ok) return;
        b.disabled = true;
        b.textContent = t('dp.installing');
        try {
          const r = await window.api.depsInstall(key);
          if (r.ok) {
            banner(t('dp.installedOk', key), 'ok');
            showDeps();
          } else {
            b.disabled = false;
            b.textContent = t('common.retry');
            banner(t('dp.installFail', key), 'err');
            log(r.raw || '');
          }
        } catch (e) {
          b.disabled = false;
          b.textContent = '重试';
          banner(L('安装失败：', 'Install failed: ') + e.message, 'err');
        }
      };
    });
  } catch (e) {
    $('modalBody').innerHTML = `<div class="detail-alert err">${esc(e.message)}</div>`;
  }
}

/* ---------------- 套装 ---------------- */

async function showPresets() {
  openModal({ title: t('title.presets'), body: loading('加载中…'), wide: true });
  const s = await loadSettings();
  const presets = (s && s.presets) || [];
  const totalOn = state.skills.filter((s) => !s.disabled).length;

  const body = presets.map((p) => {
    const present = p.skills.map((n) => state.skills.find((s) => s.name === n)).filter(Boolean);
    const offCount = present.filter((s) => s.disabled).length;
    const missingCount = p.skills.length - present.length;
    const onCount = present.length - offCount;

    const alreadyOn = missingCount === 0 && offCount === 0;
    const onlyThis = alreadyOn && totalOn === present.length;

    let stat;
    if (missingCount === 0 && offCount === 0) {
      stat = `<span class="pill ok">全部已启用</span>`;
    } else if (onCount === 0) {
      stat = `<span class="pill bad">全部未启用</span>`;
    } else {
      stat = `<span class="pill warn">部分启用 ${onCount}/${p.skills.length}</span>`;
      if (missingCount) stat += `<span class="pill bad" style="margin-left:6px">${missingCount} 个未安装</span>`;
    }

    const chips = p.skills.map((n) => {
      const s = state.skills.find((x) => x.name === n);
      const cls = s ? (s.disabled ? 'chip off' : 'chip') : 'chip missing';
      return `<span class="${cls}">${esc(n)}</span>`;
    }).join('');

    return `<div class="preset">
      <div class="preset-head">
        <div>
          <div class="preset-name">${esc(p.name)} ${stat}</div>
          <div class="preset-hint">启用这套：只把这 ${p.skills.length} 个打开，其他不动　·　只留这套：关闭其余 ${Math.max(0, totalOn - onCount)} 个</div>
        </div>
        <div style="flex:none">
          <button class="btn btn-secondary" data-preset="${esc(p.id)}" data-mode="add"
            ${alreadyOn ? 'disabled title="这套装的技能已经全部启用，无需重复操作"' : ''}>${alreadyOn ? '已启用' : '启用该套装'}</button>
          <button class="btn btn-ghost" data-preset="${esc(p.id)}" data-mode="only"
            ${onlyThis ? 'disabled title="当前就只启用了这套"' : ''}>${onlyThis ? '已只留这套' : '只留该套装'}</button>
        </div>
      </div>
      <div class="preset-skills">${chips}</div>
    </div>`;
  }).join('');

  $('modalBody').innerHTML = `
    <div class="preset-intro">
      <b>套装不是新东西，它只是一组「哪几个技能开着」的预设。</b><br>
      点「启用该套装」＝把这几个技能打开，其他保持原样；点「只留该套装」＝打开这几个、同时关闭其余全部。<br>
      被关闭的技能只是移到 <span class="mono">~/.claude/skills-disabled/</span>，Claude Code 和已连接的工具就读不到它们了——文件不会丢，随时能启用回来。
      <div class="preset-count">当前共 ${state.skills.length} 个技能，其中 ${totalOn} 个处于启用状态${state.scope !== 'global'
        ? `　·　作用域：项目 <b class="mono">${esc(state.scope)}</b>（只影响这个项目）`
        : '　·　作用域：全局'}</div>
    </div>
    <div class="preset-list">${body}</div>`;

  $('modalBody').querySelectorAll('button[data-preset]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.preset;
      const mode = b.dataset.mode;
      if (mode === 'only' && !confirm('这会禁用套装之外的所有技能，确定？')) return;
      b.disabled = true;
      const r = await window.api.applyPreset(id, mode, currentProject());
      closeModal();
      await load(true);

      const acts = r.actions || [];
      const on = acts.filter((a) => a.result === '已启用').length;
      const off = acts.filter((a) => a.result === '已禁用').length;
      const missing = acts.filter((a) => a.result === '未安装').length;

      if (on === 0 && off === 0) {
        banner(`「${r.preset}」里的 ${acts.length} 个技能本来就都处于启用状态，没有需要变更的。` +
          (missing ? `另有 ${missing} 个没安装。` : '') +
          ' 如果你想让其他技能暂时让位，用「只留该套装」。', 'warn');
      } else {
        const parts = [];
        if (on) parts.push(`启用 ${on} 个`);
        if (off) parts.push(`禁用 ${off} 个`);
        if (missing) parts.push(`${missing} 个未安装已跳过`);
        banner(`✓ 套装「${r.preset}」已应用：${parts.join('，')}`, missing ? 'warn' : 'ok');
      }
    };
  });
}

/* ---------------- 备份 ---------------- */

async function showNewBackup() {
  const st = await window.api.settingsGet().catch(() => null);
  let bkDir = (st && st.backupDir) || ((st && st.dataDir) ? st.dataDir + '\\backups' : '');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defLabel = L(
    `手动备份 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    `Manual backup ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  );

  openModal({
    title: L('新建备份', 'New backup'),
    body: `
      <div class="set-label" style="margin-bottom:6px">${L('备份名称', 'Backup name')}</div>
      <div class="set-hint" style="margin-bottom:8px">${L('写清楚这份备份是干什么用的，以后一眼能认出来', 'Describe what this backup is for so you can recognise it later')}</div>
      <input id="mBkLabel" class="search" style="width:100%;height:34px" maxlength="60" value="${esc(defLabel)}" />

      <div class="set-row" style="margin-top:16px">
        <div class="set-text">
          <div class="set-label">${L('备份到', 'Save to')}</div>
          <div class="set-hint mono" id="mBkPath">${esc(bkDir)}</div>
        </div>
        <button class="btn btn-ghost" id="mBkPick" style="flex:none">${L('更改', 'Change')}</button>
      </div>`,
    foot: '<button class="btn btn-secondary" onclick="closeModal()">' + t('common.cancel') + '</button>' +
      '<button class="btn btn-primary" id="mBkGo">' + L('开始备份', 'Start') + '</button>',
  });

  $('mBkPick').onclick = async () => {
    const p = await window.api.pickFolder();
    if (!p) return;
    await window.api.settingsSet({ backupDir: p });
    bkDir = p;
    $('mBkPath').textContent = p;
    banner(L('备份目录已改为：', 'Backup folder changed to: ') + p, 'ok');
  };

  $('mBkGo').onclick = async () => {
    const btn = $('mBkGo');
    const label = ($('mBkLabel').value || '').trim() || defLabel;
    btn.disabled = true;
    btn.textContent = L('备份中…', 'Backing up…');
    try {
      const r = await window.api.backupCreate(label);
      closeModal();
      banner(t('bk.done', r.count) + ' · ' + label, 'ok');
      showBackups();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = L('开始备份', 'Start');
      banner(L('备份失败：', 'Backup failed: ') + e.message, 'err');
    }
  };
}

async function showBackups() {
  openModal({ title: t('title.backups'), body: loading('加载中…'), wide: true });
  const list = await window.api.backupsList();
  const s0 = await window.api.settingsGet();
  const dirLabel = (s0 && s0.backupDir) ? s0.backupDir : ((s0 && s0.dataDir) || '') + '\\backups';
  const rows = list.map((b) => `
    <tr>
      <td class="mono">${esc(fmtBackupTs(b.ts))}</td>
      <td>${esc(b.label || '—')}</td>
      <td>${b.count} 个</td>
      <td>${b.sizeKb} KB</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-ghost" data-restore="${esc(b.ts)}">${t('common.restore')}</button>
        <button class="btn btn-danger" data-del="${esc(b.ts)}">${t('common.delete')}</button>
      </td>
    </tr>`).join('');
  $('modalBody').innerHTML =
    `<div class="set-hint mono" style="margin-bottom:12px">备份目录：${esc(dirLabel)}</div>` +
    (list.length
      ? `<table class="tbl"><thead><tr><th>时间</th><th>备注</th><th>技能数</th><th>大小</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="loading">还没有备份</div>');
  $('modalFoot').innerHTML = '<button class="btn btn-ghost" id="mBkDir">更改目录</button>' +
    '<button class="btn btn-primary" id="mBackupNew">' + t('bk.create') + '</button>';

  $('mBkDir').onclick = async () => {
    try {
      const p = await window.api.pickFolder();
      if (!p) return;
      await window.api.settingsSet({ backupDir: p });
      banner('备份目录已改为：' + p + '（已有备份不会自动迁移）', 'ok');
      showBackups();
    } catch (e) { banner('更改失败：' + e.message, 'err'); }
  };

  $('mBackupNew').onclick = () => showNewBackup();

  $('modalBody').querySelectorAll('button[data-restore]').forEach((b) => {
    b.onclick = async () => {
      const ts = b.dataset.restore;
      if (!confirm(`还原到 ${ts}？\n当前状态会先自动备份一份。`)) return;
      b.disabled = true;
      await window.api.backupRestore(ts);
      closeModal();
      banner('✓ 已还原，当前状态已另存为备份', 'ok');
      await load(true);
    };
  });
  $('modalBody').querySelectorAll('button[data-del]').forEach((b) => {
    b.onclick = async () => {
      const ts = b.dataset.del;
      if (!confirm(`删除这份备份？\n\n${ts}\n\n删除后无法还原。`)) return;
      b.disabled = true;
      try {
        const r = await window.api.backupDelete(ts);
        banner(`✓ 已删除备份，释放 ${r.sizeKb} KB`, 'ok');
        showBackups();
      } catch (e) {
        banner('删除失败：' + e.message, 'err');
        b.disabled = false;
      }
    };
  });
}

/* ---------------- 市场 ---------------- */

async function showMarket(q) {
  openModal({
    title: t('title.market'),
    body: hubTabs('market') + `<p style="color:var(--dim);font-size:11.5px;line-height:1.75;margin:0 0 10px">
        ${t('mk.intro')}
      </p>
      <p style="font-size:11.5px;margin:0 0 12px;color:var(--text)">
        ${t('mk.target')}<b>${state.scope === 'global'
          ? t('mk.globalTarget')
          : t('mk.projectTarget', esc(state.scope))}</b>
      </p>
      <div class="market-bar">
        <input id="mQuery" placeholder="输入关键词，例如 image-to-ui / hyperframes / video" value="${esc(q || '')}" />
        <button class="btn btn-primary" id="mSearch">${t('common.search')}</button>
      </div><div id="mResults">${loading('输入关键词后搜索')}</div>`,
    wide: true,
  });
  wireHubTabs();
  $('mSearch').onclick = () => runMarketSearch();
  $('mQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') runMarketSearch(); });
  if (q) runMarketSearch();
}

let lastMarketQuery = '';

function marketTag(spec) {
  const repo = (spec.split('@')[0] || '').toLowerCase();
  if (repo.endsWith('/superpowers')) return { text: 'superpowers 衍生', cls: 'warn' };
  if (repo.includes('runcomfy') || repo.includes('gencraft')) return { text: 'RunComfy 系', cls: 'ok' };
  if (repo.includes('reflex')) return { text: 'reflex 系', cls: '' };
  return null;
}

async function runMarketSearch() {
  const q = $('mQuery').value.trim();
  if (!q) return;
  lastMarketQuery = q;
  $('mResults').innerHTML = loading('搜索中…');
  try {
    const r = await window.api.marketSearch(q);
    if (!r.results.length) {
      $('mResults').innerHTML = '<div class="loading">没有找到结果</div>';
      return;
    }
    $('mResults').innerHTML = r.results.map((x) => {
      const tag = marketTag(x.spec);
      return `<div class="market-row">
        <div style="min-width:0">
          <div class="market-spec">${esc(x.spec)}${tag
            ? `<span class="pill ${tag.cls}" style="margin-left:8px;font-size:10px">${tag.text}</span>` : ''}</div>
          <div class="market-installs">${esc(x.installs)} 安装</div>
        </div>
        <div style="flex:none;white-space:nowrap">
          <button class="btn btn-ghost" data-detail="${esc(x.spec)}">${t('common.detail')}</button>
          <button class="btn btn-secondary" data-spec="${esc(x.spec)}">安装</button>
        </div>
      </div>`;
    }).join('');

    $('mResults').querySelectorAll('button[data-detail]').forEach((b) => {
      b.onclick = () => showMarketDetail(b.dataset.detail);
    });
    $('mResults').querySelectorAll('button[data-spec]').forEach((b) => {
      b.onclick = () => doMarketInstall(b);
    });
  } catch (e) {
    $('mResults').innerHTML = `<div class="detail-alert err">${esc(e.message)}</div>`;
  }
}

async function doMarketInstall(btn) {
  const spec = btn.dataset.spec;
  const target = state.scope === 'global'
    ? { scope: 'global' }
    : { scope: 'project', path: state.scope };
  btn.disabled = true;
  btn.textContent = '安装中…';
  const res = await window.api.marketInstall(spec, target);
  if (res.ok) {
    btn.textContent = '已安装';
    banner(`✓ 已安装 ${spec} → ${res.scopeLabel}`, res.fellBackToGlobal ? 'warn' : 'ok');
    await load(true);
  } else {
    btn.disabled = false;
    btn.textContent = '重试';
    const box = $('mResults');
    if (box) box.insertAdjacentHTML('afterbegin',
      `<div class="detail-alert err">安装失败：${esc((res.raw || '').slice(0, 400))}</div>`);
    else banner('安装失败，详见日志', 'err');
  }
}

async function showMarketDetail(spec) {
  openModal({ title: t('title.sourceDetail', spec), body: loading('正在读取仓库与文件内容…'), wide: true });
  try {
    const d = await window.api.marketDetail(spec);

    let verdict;
    if (d.error) {
      verdict = `<div class="detail-alert err">读取失败：${esc(d.error)}</div>`;
    } else if (d.sameAsInstalled) {
      verdict = `<div class="banner ok">与本机已装的 <b>${esc(d.skill)}</b> 内容<b>完全一致</b> —— 装它只是把同一份东西再覆盖一遍</div>`;
    } else if (d.installedHash) {
      verdict = `<div class="banner warn">本机已装了同名技能，但<b>内容不一样</b> —— 装它会覆盖成本仓库的版本</div>`;
    } else {
      verdict = `<div class="banner">本机还没装这个技能，可以直接安装</div>`;
    }

    $('modalBody').innerHTML = verdict + `
      <div class="kv"><span>仓库</span><b class="mono">${esc(d.repo)}</b></div>
      <div class="kv"><span>文件路径</span><b class="mono break">${esc(d.pathInRepo || '—')}</b></div>
      <div class="kv"><span>Stars</span><b>${d.stars}</b></div>
      <div class="kv"><span>最近更新</span><b>${d.updated ? esc(d.updated.slice(0, 10)) : '—'}</b></div>
      <div class="kv"><span>是否 fork</span><b>${d.fork ? '是（从别的仓库分出来的）' : '否（原创仓库）'}</b></div>
      <div class="kv"><span>文件大小</span><b>${(d.bytes / 1024).toFixed(1)} KB</b></div>
      <div class="kv"><span>需要 CLI</span><b class="mono">${esc(d.allowed || '未声明')}</b></div>
      <div class="kv"><span>内容指纹</span><b class="mono">${esc(d.remoteHash || '—')}${d.installedHash ? ' / 已装 ' + esc(d.installedHash) : ''}</b></div>
      <p class="detail-desc" style="margin-top:16px">${esc((d.desc || d.repoDesc || '（无描述）').slice(0, 800))}</p>`;

    $('modalFoot').innerHTML =
      `<button class="btn btn-secondary" id="mBack">返回列表</button>` +
      `<button class="btn btn-primary" id="mDetInstall">${d.sameAsInstalled ? '重新安装' : '安装这个'}</button>`;
    $('mBack').onclick = () => { showMarket(lastMarketQuery); };
    $('mDetInstall').onclick = async () => {
      const b = $('mDetInstall');
      const target = state.scope === 'global'
        ? { scope: 'global' }
        : { scope: 'project', path: state.scope };
      b.disabled = true;
      b.textContent = '安装中…';
      const res = await window.api.marketInstall(spec, target);
      if (res.ok) {
        b.textContent = '已安装';
        banner(`✓ 已安装 ${spec} → ${res.scopeLabel}`, res.fellBackToGlobal ? 'warn' : 'ok');
        await load(true);
      } else {
        b.disabled = false;
        b.textContent = '重试';
        banner('安装失败：' + (res.raw || '').slice(0, 200), 'err');
      }
    };
  } catch (e) {
    $('modalBody').innerHTML = `<div class="detail-alert err">${esc(e.message)}</div>`;
  }
}

/* ---------------- 日志 ---------------- */

async function showLogs() {
  openModal({ title: t('title.logs'), body: loading('加载中…'), wide: true });
  const lines = await window.api.logsRead(400);
  $('modalBody').innerHTML = lines.length
    ? lines.map((l) => {
      const m = l.match(/^\[(.+?)\]\s+(\S+)\s*(.*)$/);
      if (!m) return `<div class="log-line"><span class="t"></span><span class="a"></span><span>${esc(l)}</span></div>`;
      const t = fmtLocal(new Date(m[1]));
      return `<div class="log-line"><span class="t">${esc(t)}</span><span class="a">${esc(m[2])}</span><span>${esc(m[3])}</span></div>`;
    }).join('')
    : '<div class="loading">还没有操作记录</div>';
  $('modalFoot').innerHTML = '<button class="btn btn-ghost" id="mClearLog">清空日志</button>';
  $('mClearLog').onclick = async () => {
    if (!confirm('清空全部操作日志？')) return;
    await window.api.logsClear();
    showLogs();
  };
}

/* ---------------- 编辑器 ---------------- */

async function showEditor(name) {
  const r = await window.api.readMd(name, currentProject());
  if (!r.ok) { banner(r.error, 'err'); return; }
  openModal({
    title: t('title.editor') + ' · ' + name,
    body: `<textarea class="editor-area" id="mEditor" spellcheck="false"></textarea>
           <div class="editor-status" id="mEditorStatus"></div>`,
    foot: '<button class="btn btn-secondary" onclick="closeModal()">' + t('common.cancel') + '</button>' +
      '<button class="btn btn-primary" id="mSave">' + t('common.save') + '</button>',
    wide: true,
  });
  const ta = $('mEditor');
  ta.value = r.content;
  $('mEditorStatus').textContent = r.path;

  $('mSave').onclick = async () => {
    const res = await window.api.writeMd(name, ta.value, currentProject());
    if (!res.ok) {
      $('mEditorStatus').innerHTML = `<span style="color:var(--err-text)">${esc(res.error)}</span>`;
      return;
    }
    closeModal();
    await refreshOne(name);
    if (res.valid) {
      banner(`✓ 已保存 ${name}，列表已更新`, 'ok');
    } else {
      banner(`已保存 ${name}，但 YAML 仍有错：${res.error}`, 'warn');
    }
  };
}

/* ---------------- 设置 ---------------- */

async function showSettings() {
  openModal({ title: t('title.settings'), body: loading('加载中…') });
  const s = (await window.api.settingsGet()) || {};
  const hide = s.hideToTray !== false;
  const hours = s.autoCheckHours === undefined ? 24 : s.autoCheckHours;

  $('modalBody').innerHTML = `
    <div class="set-row">
      <div class="set-text">
        <div class="set-label">关闭窗口时</div>
        <div class="set-hint">收进托盘时程序继续后台运行，定时检查更新照常工作；直接退出则完全关闭。</div>
      </div>
      <div class="seg">
        <button class="seg-btn ${hide ? 'on' : ''}" data-hide="1">收进托盘</button>
        <button class="seg-btn ${!hide ? 'on' : ''}" data-hide="0">直接退出</button>
      </div>
    </div>

    <div class="set-row">
      <div class="set-text">
        <div class="set-label">开机自启</div>
        <div class="set-hint">${s.packaged
          ? '开机后自动在后台启动，只留托盘图标，不弹窗口'
          : '开发模式下不写入系统，打包安装后才生效'}</div>
      </div>
      <div class="seg">
        <button class="seg-btn ${s.openAtLogin ? 'on' : ''}" data-login="1" ${s.packaged ? '' : 'disabled'}>${t('set.on')}</button>
        <button class="seg-btn ${!s.openAtLogin ? 'on' : ''}" data-login="0" ${s.packaged ? '' : 'disabled'}>关闭</button>
      </div>
    </div>

    <div class="set-row">
      <div class="set-text">
        <div class="set-label">自动检查更新</div>
        <div class="set-hint">每隔多少小时后台查一次；设为 0 关闭自动检查。</div>
      </div>
      <div class="set-inline">
        <input id="mHours" type="number" min="0" max="168" step="1" value="${hours}" class="num-input" />
        <span class="set-hint">小时</span>
      </div>
    </div>

    <div class="set-row">
      <div class="set-text">
        <div class="set-label">备份目录</div>
        <div class="set-hint mono">${esc(s.backupDir || (s.dataDir || '') + '\\backups')}</div>
      </div>
      <div style="flex:none;display:flex;gap:6px">
        <button class="btn btn-ghost" id="mChangeBackup">更改</button>
        ${s.backupDir ? '<button class="btn btn-ghost" id="mResetBackup">默认</button>' : ''}
      </div>
    </div>

    <div class="set-row">
      <div class="set-text">
        <div class="set-label">数据目录</div>
        <div class="set-hint mono">${esc(s.dataDir || '')}</div>
      </div>
      <button class="btn btn-ghost" id="mOpenData">${t('common.open')}</button>
    </div>

    <div class="set-row">
      <div class="set-text">
        <div class="set-label">技能目录</div>
        <div class="set-hint">Claude Code 全局技能所在位置</div>
      </div>
      <button class="btn btn-ghost" id="mOpenSkills">${t('common.open')}</button>
    </div>`;

  $('modalBody').querySelectorAll('button[data-hide]').forEach((b) => {
    b.onclick = async () => {
      const val = b.dataset.hide === '1';
      await window.api.settingsSet({ hideToTray: val });
      state.settings = await window.api.settingsGet();
      $('modalBody').querySelectorAll('button[data-hide]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      log(val ? '设置：关闭窗口收进托盘' : '设置：关闭窗口直接退出');
    };
  });

  $('modalBody').querySelectorAll('button[data-login]').forEach((b) => {
    b.onclick = async () => {
      if (b.disabled) return;
      const val = b.dataset.login === '1';
      await window.api.settingsSet({ openAtLogin: val });
      $('modalBody').querySelectorAll('button[data-login]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      log(val ? '设置：开机自启已开启' : '设置：开机自启已关闭');
    };
  });

  const mi = $('mHours');
  mi.addEventListener('change', async () => {
    let v = parseInt(mi.value, 10);
    if (isNaN(v) || v < 0) v = 0;
    if (v > 168) v = 168;
    mi.value = v;
    await window.api.settingsSet({ autoCheckHours: v });
    state.settings = await window.api.settingsGet();
    log(v === 0 ? '设置：已关闭自动检查更新' : `设置：每 ${v} 小时自动检查更新`);
  });

  $('mOpenData').onclick = () => window.api.openPath(s.dataDir || '');
  $('mOpenSkills').onclick = () => window.api.openPath((state.dirs && state.dirs.skills) || '');

  const cb = $('mChangeBackup');
  if (cb) {
    cb.onclick = async () => {
      try {
        const p = await window.api.pickFolder();
        if (!p) return;
        await window.api.settingsSet({ backupDir: p });
        banner('备份目录已改为：' + p + '（已有备份不会自动迁移）', 'ok');
        showSettings();
      } catch (e) { banner('更改失败：' + e.message, 'err'); }
    };
  }
  const rb = $('mResetBackup');
  if (rb) {
    rb.onclick = async () => {
      await window.api.settingsSet({ backupDir: '' });
      banner('备份目录已恢复默认', 'ok');
      showSettings();
    };
  }
}

/* ---------------- 分发 ---------------- */

const distState = { scope: 'filtered', mode: 'link', tools: [] };

async function showDistribute() {
  openModal({ title: t('title.distribute'), body: loading('正在探测本机 AI 工具…'), wide: true });
  distState.tools = await window.api.toolsList();
  renderDistribute();
}

function renderDistribute() {
  const all = state.skills.filter((s) => !s.disabled);
  const filtered = visibleSkills().filter((s) => !s.disabled);
  const scopeList = distState.scope === 'all' ? all : filtered;
  const scopeNames = scopeList.map((s) => s.name);

  const rows = distState.tools.map((t) => {
    let status, actions;

    if (!t.supportsSkills) {
      status = '<span class="pill warn">不支持技能目录</span>';
      actions = '<button class="btn btn-ghost" data-export="1">导出技能包</button>';
    } else if (!t.installed) {
      status = '<span class="pill">未检测到</span>';
      actions = '<button class="btn btn-ghost" disabled>连接</button>';
    } else {
      const n = t.linked.length;
      status = n
        ? `<span class="pill ok">已连接 ${n}</span>`
        : '<span class="pill">已安装 · 未连接</span>';
      actions =
        `<button class="btn btn-secondary" data-connect="${esc(t.id)}">连接</button>` +
        (n ? `<button class="btn btn-ghost" data-disconnect="${esc(t.id)}">断开</button>` : '');
    }

    return `<tr>
      <td>${esc(t.name)}</td>
      <td class="mono" style="color:var(--dim)">${esc(t.dir || '—')}</td>
      <td>${status}</td>
      <td style="text-align:right;white-space:nowrap">${actions}</td>
    </tr>`;
  }).join('');

  $('modalBody').innerHTML = `
    <div class="set-row">
      <div class="set-text">
        <div class="set-label">分发范围</div>
        <div class="set-hint">「当前筛选」跟随左侧分类和搜索框，推荐用它只推需要的技能，避免稀释对方注意力。</div>
      </div>
      <div class="seg">
        <button class="seg-btn ${distState.scope === 'filtered' ? 'on' : ''}" data-scope="filtered">当前筛选（${filtered.length}）</button>
        <button class="seg-btn ${distState.scope === 'all' ? 'on' : ''}" data-scope="all">全部（${all.length}）</button>
      </div>
    </div>

    <div class="set-row">
      <div class="set-text">
        <div class="set-label">同步方式</div>
        <div class="set-hint">链接 = 目录联接，不占空间、改一处就生效；复制 = 独立副本，需要重新分发才同步。</div>
      </div>
      <div class="seg">
        <button class="seg-btn ${distState.mode === 'link' ? 'on' : ''}" data-mode="link">链接</button>
        <button class="seg-btn ${distState.mode === 'copy' ? 'on' : ''}" data-mode="copy">复制</button>
      </div>
    </div>

    <table class="tbl" style="margin-top:6px">
      <thead><tr><th>工具</th><th>技能目录</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="color:var(--dim);font-size:11.5px;margin-top:14px;line-height:1.7">
      连接后需要<b>重启对应的工具</b>才能发现新技能。<br>
      豆包没有技能目录机制，只能用「导出技能包」把内容粘贴到智能体设定里。
    </p>`;

  $('modalBody').querySelectorAll('button[data-scope]').forEach((b) => {
    b.onclick = () => { distState.scope = b.dataset.scope; renderDistribute(); };
  });
  $('modalBody').querySelectorAll('button[data-mode]').forEach((b) => {
    b.onclick = () => { distState.mode = b.dataset.mode; renderDistribute(); };
  });
  $('modalBody').querySelectorAll('button[data-connect]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.connect;
      b.disabled = true; b.textContent = '连接中…';
      try {
        const r = await window.api.distribute(id, scopeNames, distState.mode);
        const fail = (r.results || []).filter((x) => x.result.indexOf('失败') === 0 || x.result.indexOf('跳过') >= 0);
        banner(`✓ ${r.tool} 已${distState.mode === 'copy' ? '复制' : '连接'} ${r.success}/${r.total} 个技能` +
          (fail.length ? `，${fail.length} 个未处理（详见日志）` : '') +
          '，重启该工具后生效', fail.length ? 'warn' : 'ok');
        if (fail.length) log(fail.map((f) => `${f.name}: ${f.result}`).join('\n'));
        distState.tools = await window.api.toolsList();
        renderDistribute();
      } catch (e) {
        banner('连接失败：' + e.message, 'err');
        b.disabled = false; b.textContent = '连接';
      }
    };
  });
  $('modalBody').querySelectorAll('button[data-disconnect]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.disconnect;
      const t = distState.tools.find((x) => x.id === id);
      if (!confirm(`断开 ${t.name}？\n只会移除本程序创建的链接，不删除源技能。`)) return;
      const r = await window.api.disconnectTool(id);
      banner(`已断开 ${t.name}，移除 ${r.removed} 个链接` + (r.kept ? `，保留 ${r.kept} 个非本程序创建的条目` : ''), 'ok');
      distState.tools = await window.api.toolsList();
      renderDistribute();
    };
  });
  $('modalBody').querySelectorAll('button[data-export]').forEach((b) => {
    b.onclick = () => showExport(scopeNames);
  });

  $('modalFoot').innerHTML = '<button class="btn btn-ghost" id="mExport">导出技能包</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">' + t('common.close') + '</button>';
  $('mExport').onclick = () => showExport(scopeNames);
}

/* ---------------- 导出技能包 ---------------- */

function showExport(names) {
  openModal({
    title: t('title.export', names.length),
    body: `
      <div class="set-row">
        <div class="set-text">
          <div class="set-label">格式</div>
          <div class="set-hint">精简版只保留名字和描述，篇幅约为完整版的两成，适合上下文有限的聊天工具。</div>
        </div>
        <div class="seg">
          <button class="seg-btn on" data-fmt="compact">精简版</button>
          <button class="seg-btn" data-fmt="full">完整版</button>
        </div>
      </div>
      <div id="mExportInfo" class="set-hint" style="margin-top:14px"></div>`,
    foot: '<button class="btn btn-secondary" onclick="showDistribute()">返回</button>' +
      '<button class="btn btn-ghost" id="mCopy">复制到剪贴板</button>' +
      '<button class="btn btn-primary" id="mSave">另存为…</button>',
  });

  let fmt = 'compact';
  $('modalBody').querySelectorAll('button[data-fmt]').forEach((b) => {
    b.onclick = () => {
      $('modalBody').querySelectorAll('button[data-fmt]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      fmt = b.dataset.fmt;
    };
  });

  $('mCopy').onclick = async () => {
    const r = await window.api.exportPack(names, fmt, 'clipboard');
    if (r.ok) $('mExportInfo').innerHTML =
      `<span style="color:var(--ok-text)">✓ 已复制 ${names.length} 个技能，约 ${(r.bytes / 1024).toFixed(0)} KB</span>`;
    else $('mExportInfo').textContent = r.error || '失败';
  };

  $('mSave').onclick = async () => {
    const r = await window.api.exportPack(names, fmt, 'save');
    if (r.ok) $('mExportInfo').innerHTML =
      `<span style="color:var(--ok-text)">✓ 已保存到 ${esc(r.path)}</span>`;
    else if (!r.canceled) $('mExportInfo').textContent = r.error || '失败';
  };
}

/* ---------------- 卸载（两步确认）---------------- */

async function showUninstall(name) {
  const s = state.skills.find((x) => x.name === name);
  if (!s) return;
  const st = await window.api.settingsGet().catch(() => null);
  const bkDir = (st && st.backupDir) || ((st && st.dataDir) ? st.dataDir + '\\backups' : '默认备份目录');
  const bk = await window.api.backupHas(name).catch(() => ({ has: false }));

  openModal({
    title: t('title.uninstall1', name),
    body: `<div class="detail-alert err">
        <b>这是永久删除，不是禁用。</b><br>
        技能目录会被整个删掉。如果它已经分发到其他工具，那些链接会一并断开。
      </div>
      <div class="kv"><span>位置</span><b class="mono break">${esc(s.path)}</b></div>
      <div class="kv"><span>大小</span><b>${s.sizeKb != null ? s.sizeKb + ' KB' : '—'}</b></div>
      <div class="kv"><span>来源</span><b>${esc(s.tracked ? (s.source || '—') : '本地技能')}</b></div>
      <div class="kv"><span>备份目录</span><b class="mono break">${esc(bkDir)}</b></div>
      <div style="margin-top:14px" id="mBkState">${bk.has
        ? `<div class="banner ok">这个技能已有备份（${esc(bk.ts)}），删错了可以还原</div>`
        : `<div class="banner warn">还没有备份。需要的话可以先备一份，不要也能直接删。</div>
           <button class="btn btn-secondary" id="mDoBackup" style="margin-top:10px">先备份这个技能</button>`}</div>`,
    foot: '<button class="btn btn-secondary" onclick="closeModal()">' + t('common.cancel') + '</button>' +
      '<button class="btn btn-danger" id="mStep2">' + t('common.continue') + '</button>',
  });

  const b = $('mDoBackup');
  if (b) {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '备份中…';
      try {
        await window.api.backupOne(name, currentProject());
        $('mBkState').innerHTML = '<div class="banner ok">✓ 已备份，删错了可以在这里还原</div>';
        banner(`✓ 已备份 ${name}`, 'ok');
      } catch (e) {
        b.disabled = false;
        b.textContent = '先备份这个技能';
        banner('备份失败：' + e.message, 'err');
      }
    };
  }

  $('mStep2').onclick = () => showUninstallConfirm(name);
}

function showUninstallConfirm(name) {
  openModal({
    title: t('title.uninstall2', name),
    body: `<p style="font-size:12.5px;color:var(--muted);line-height:1.9;margin-top:0">
        请输入技能名称 <b class="mono" style="color:var(--err-text)">${esc(name)}</b> 以确认永久删除：</p>
      <input id="mConfirmInput" class="search" style="width:100%;height:34px" autocomplete="off" spellcheck="false" placeholder="${esc(name)}" />
      <div class="editor-status" id="mConfirmHint" style="color:var(--dim)">名称必须完全一致</div>`,
    foot: '<button class="btn btn-secondary" onclick="closeModal()">' + t('common.cancel') + '</button>' +
      '<button class="btn btn-danger" id="mConfirmBtn" disabled>永久删除</button>',
  });

  const inp = $('mConfirmInput');
  const btn = $('mConfirmBtn');
  const hint = $('mConfirmHint');
  setTimeout(() => inp.focus(), 50);

  inp.addEventListener('input', () => {
    const match = inp.value.trim() === name;
    btn.disabled = !match;
    hint.innerHTML = match
      ? '<span style="color:var(--ok-text)">✓ 名称一致，可以删除</span>'
      : '<span style="color:var(--dim)">名称必须完全一致</span>';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !btn.disabled) btn.click();
  });

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '删除中…';
    try {
      const r = await window.api.uninstall(name, currentProject());
      closeModal();
      state.selected = null;
      $('detailBody').classList.add('hidden');
      $('detailEmpty').classList.remove('hidden');
      banner(`✓ 已卸载 ${r.name}，释放 ${r.sizeKb} KB` +
        (r.unlinked ? `，断开 ${r.unlinked} 个分发链接` : '') +
        '（备份保留在备份目录，可随时还原）', 'ok');
      await load(false);
    } catch (e) {
      banner('卸载失败：' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '永久删除';
    }
  };
}

/* ---------------- 自动归位（只报告）---------------- */

function showReconcile() {
  openModal({ title: t('title.reconcile'), body: loading('正在扫描…'), wide: true });
  runReconcile();
}

async function runReconcile() {
  $('modalBody').innerHTML = loading('正在扫描各工具的技能目录…');
  try {
    const r = await window.api.reconcileScan([]);
    state.reconcileFindings = r.findings;
    state.reconcileCount = r.findings.length;
    render();

    const dirRows = r.scanned.map((s) => `
      <tr>
        <td>${esc(s.label)}</td>
        <td class="mono" style="color:var(--dim)">${esc(s.dir)}</td>
        <td>${s.exists ? '<span class="pill ok">存在</span>' : '<span class="pill">未创建</span>'}</td>
        <td>${s.count}</td>
        <td style="color:var(--dim)">${s.skipped.length}</td>
      </tr>`).join('');

    let findBlock;
    if (!r.findings.length) {
      findBlock = '<div class="banner ok">没有发现散落在别处的技能 —— 都在唯一目录里</div>';
    } else {
      const rows = r.findings.map((f, i) => {
        const cls = f.status === 'new' ? 'warn' : f.status === 'same' ? '' : 'bad';
        const text = f.status === 'new' ? '新增'
          : f.status === 'same' ? '重复（内容相同）' : '冲突（内容不同）';

        let actions = '';
        if (f.status === 'new') {
          actions = `<button class="btn btn-secondary" data-act="link" data-i="${i}">移动并指向</button>
                     <button class="btn btn-ghost" data-act="move" data-i="${i}">只移动</button>`;
        } else if (f.status === 'same') {
          actions = `<button class="btn btn-secondary" data-act="link" data-i="${i}">合并并指向</button>`;
        } else {
          actions = `<button class="btn btn-secondary" data-act="detail" data-i="${i}">查看差异</button>`;
        }

        return `<tr>
          <td class="mono">${esc(f.name)}</td>
          <td>${esc(f.fromLabel)}</td>
          <td><span class="pill ${cls}">${text}</span></td>
          <td style="color:var(--muted)">${esc(f.detail)}</td>
          <td style="text-align:right;white-space:nowrap">${actions}</td>
        </tr>`;
      }).join('');
      findBlock = `<table class="tbl"><thead><tr><th>技能</th><th>所在工具</th><th>状态</th><th>说明</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    $('modalBody').innerHTML = `
      <div class="preset-intro">
        <b>这里只做检测和分析。真正移动文件需要你点每一行的按钮，一次只处理一个。</b><br>
        「移动并指向」把技能搬进唯一目录、再在原位置留一个联接，装它的 AI 还能照常用；
        「只移动」只搬走，原位置不再保留入口。
      </div>
      <div class="side-title" style="padding-left:0">扫描范围</div>
      <table class="tbl"><thead><tr><th>工具</th><th>目录</th><th>状态</th><th>技能数</th><th>已排除</th></tr></thead>
      <tbody>${dirRows}</tbody></table>
      <div class="side-title" style="padding-left:0;margin-top:18px">发现（${r.findings.length}）</div>
      ${findBlock}`;

    $('modalFoot').innerHTML = '<button class="btn btn-ghost" id="mRescan">重新扫描</button>' +
      '<button class="btn btn-secondary" onclick="closeModal()">' + t('common.close') + '</button>';
    $('mRescan').onclick = runReconcile;

    $('modalBody').querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => {
        const f = state.reconcileFindings[Number(b.dataset.i)];
        if (!f) return;
        if (b.dataset.act === 'detail') showReconcileDetail(f);
        else doReconcileApply(f, b.dataset.act, b);
      };
    });
  } catch (e) {
    $('modalBody').innerHTML = `<div class="detail-alert err">${esc(e.message)}</div>`;
  }
}

async function showReconcileDetail(f) {
  openModal({ title: t('title.diff', f.name), body: loading('正在读取两份 SKILL.md…'), wide: true });
  try {
    const d = await window.api.reconcileDetail(f);
    if (!d.hasBoth) {
      $('modalBody').innerHTML = '<div class="banner">两边只有一份存在，无法对比</div>';
      return;
    }
    if (d.same) {
      $('modalBody').innerHTML = '<div class="banner ok">两份内容完全一致</div>';
      return;
    }
    const lines = (d.lines || []).map((l) =>
      `<div class="${l.t === '+' ? 'add' : 'del'}">${esc(l.t + ' ' + l.s)}</div>`).join('');
    $('modalBody').innerHTML =
      `<div class="diff-sum">
        基准：唯一目录里的版本（<span style="color:var(--err-text)">红=它有</span>），
        对比：${esc(f.fromLabel)} 里的版本（<span style="color:var(--ok-text)">绿=它有</span>）<br>
        差异：新增 <b style="color:var(--ok-text)">${d.added}</b> 行，缺少 <b style="color:var(--err-text)">${d.removed}</b> 行
      </div>
      <div class="diff" style="margin-top:10px">${lines || '<div>（无内容差异）</div>'}</div>`;
    $('modalFoot').innerHTML = '<button class="btn btn-secondary" onclick="showReconcile()">返回</button>';
  } catch (e) {
    $('modalBody').innerHTML = `<div class="detail-alert err">${esc(e.message)}</div>`;
  }
}

async function doReconcileApply(f, mode, btn) {
  const label = mode === 'link' ? '移动并指向' : '只移动';
  if (!confirm(`对 ${f.name} 执行「${label}」？\n源：${f.from}\n${mode === 'link' ? '搬进唯一目录后，在原位置留一个联接。' : '只搬进唯一目录，原位置不再保留。'}`))
    return;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const r = await window.api.reconcileApply(f, mode);
    const parts = [];
    if (r.moved) parts.push('已移动');
    if (r.replaced) parts.push('已合并（内容相同，删除了散落副本）');
    if (r.linked) parts.push('原位置已建立联接');
    banner(`✓ ${r.name}：${parts.join('，')}`, 'ok');
    await load(true);
    runReconcile();
  } catch (e) {
    banner('处理失败：' + e.message, 'err');
    btn.disabled = false;
    btn.textContent = label;
  }
}

function hubTabs(active) {
  const mk = (id, label) =>
    `<button class="seg-btn ${active === id ? 'on' : ''}" data-hub="${id}">${label}</button>`;
  return `<div class="seg" style="margin-bottom:14px">${mk('market', L('市场', 'Market'))}${mk('repos', L('仓库', 'Repos'))}</div>`;
}

function wireHubTabs() {
  document.querySelectorAll('button[data-hub]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.hub === 'market') showMarket(lastMarketQuery);
      else showRepos(false);
    };
  });
}

/* ---------------- 仓库（只统计）---------------- */

function fmtSize(kb) {
  if (!kb && kb !== 0) return '—';
  if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(2) + ' GB';
  if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
  return kb + ' KB';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtLocal(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* 备份目录名是 UTC：2026-11-15T08-09-33-000Z */
function fmtBackupTs(ts) {
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return ts;
  return fmtLocal(new Date(Date.UTC(
    +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]
  )));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const s = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (days <= 0) return s + '（今天）';
  if (days === 1) return s + '（昨天）';
  return s + `（${days} 天前）`;
}

let repoList = [];
const repoStates = {};
const repoUpdates = {};
let repoTimer = null;

function startRepoTimer() {
  if (repoTimer) return;
  repoTimer = setInterval(() => {
    const anyRunning = Object.values(repoStates).some((x) => x && x.status === 'running');
    if (!anyRunning) { clearInterval(repoTimer); repoTimer = null; return; }
    paintRepos();
  }, 1000);
}

async function showRepos(force) {
  openModal({ title: t('title.repos'), body: loading(L('正在统计…', 'Scanning…')), wide: true });
  try {
    repoList = await window.api.reposList(!!force);
    if (!repoList.length) {
      $('modalBody').innerHTML = `<p style="color:var(--dim);font-size:12px;line-height:1.8;margin:0 0 14px">
        ${t('rp.intro')}
      </p><div class="loading">${t('rp.none')}</div>`;
      $('modalFoot').innerHTML = '<button class="btn btn-primary" id="mRepoAdd">' + t('common.addFolder') + '</button>';
      $('mRepoAdd').onclick = addRepoFlow;
      return;
    }
    paintRepos();
  } catch (e) {
    $('modalBody').innerHTML = `<div class="detail-alert err">${esc(e.message)}</div>`;
  }
}

function paintRepos() {
  const rows = repoList.map((r, i) => {
    const st = repoStates[r.path];
    const busy = !!(st && st.status === 'running');

    let status = '';
    if (busy) {
      const sec = Math.max(0, Math.floor((Date.now() - st.startedAt) / 1000));
      const pct = st.percent != null ? st.percent : 0;
      status = `<div style="margin-top:6px;display:flex;align-items:center;gap:6px" data-pb="${esc(r.path)}">
        <span class="spinner"></span>
        <span class="pbar"><i style="width:${pct}%"></i></span>
        <span class="pb-text" style="color:var(--accent);font-size:11px;white-space:nowrap">${st.percent != null ? st.percent + '% · ' : ''}${esc(st.phase || L('更新中', 'Pulling'))} · ${sec}s</span>
      </div>`;
    } else if (st && st.status === 'ok') {
      status = `<div style="margin-top:5px"><span class="pill ok">${L('✓ 已更新', '✓ Updated')}</span></div>`;
    } else if (st && st.status === 'fail') {
      status = `<div style="margin-top:5px"><span class="pill bad">${L('✗ 失败', '✗ Failed')}</span></div>`;
    }

    const gitCell = r.isGit
      ? `<span class="pill ok">${esc(r.branch || 'git')}</span>` +
        (r.dirty === true ? `<span class="pill warn" style="margin-left:6px">${t('rp.dirty')}</span>`
          : r.dirty === false ? `<span class="pill" style="margin-left:6px">${t('rp.clean')}</span>` : '')
      : `<span class="pill">${t('rp.notGit')}</span>`;

    const upd = repoUpdates[r.path];
    let version = '';
    if (upd && upd.checking) {
      version = `<div style="margin-top:5px"><span class="spinner"></span><span class="set-hint">${L('检查中…', 'Checking…')}</span></div>`;
    } else if (upd && upd.ok) {
      const hash = `<span class="mono" style="font-size:10px;color:var(--dim);margin-left:6px">${esc(upd.localHead || '')} → ${esc(upd.remoteHead || '')}</span>`;
      if (upd.behind > 0) {
        version = `<div style="margin-top:5px"><span class="pill warn">${L(`落后 ${upd.behind} 个提交`, `behind ${upd.behind}`)}</span>${hash}</div>`;
      } else if (upd.ahead > 0) {
        version = `<div style="margin-top:5px"><span class="pill">${L(`领先 ${upd.ahead} 个提交`, `ahead ${upd.ahead}`)}</span>${hash}</div>`;
      } else {
        version = `<div style="margin-top:5px"><span class="pill ok">${L('已是最新', 'Up to date')}</span>${hash}</div>`;
      }
    } else if (upd && !upd.ok) {
      const map = {
        'not-git': L('不是 git 仓库', 'Not a git repo'),
        'no-upstream': L('没有配置远端分支', 'No upstream branch'),
        'fetch-failed': L('拉取失败（网络或权限）', 'Fetch failed (network/permission)'),
      };
      version = `<div style="margin-top:5px"><span class="pill bad">${map[upd.reason] || esc(upd.reason)}</span></div>`;
    }

    return `<tr>
      <td><b>${esc(r.name)}</b>${status}${version}
        <div class="mono" style="font-size:10px;color:var(--dim);margin-top:4px;word-break:break-all">${esc(r.path)}</div>
      </td>
      <td style="white-space:nowrap">${r.exists ? fmtSize(r.sizeKb) : `<span style="color:var(--err-text)">${t('rp.notExist')}</span>`}</td>
      <td style="white-space:nowrap">${r.exists ? r.fileCount + ' ' + L('个', 'files') : '—'}</td>
      <td style="white-space:nowrap">${gitCell}</td>
      <td style="white-space:nowrap;color:var(--muted)">${esc(fmtTime(r.lastCommit || r.lastModified))}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-ghost" data-open="${i}" ${!r.exists || busy ? 'disabled' : ''}>${L('打开', 'Open')}</button>
        <button class="btn btn-ghost" data-check="${i}" ${!r.exists || !r.isGit || busy ? 'disabled' : ''}>${L('检查', 'Check')}</button>
        <button class="btn btn-ghost" data-pull="${i}" ${!r.exists || !r.isGit || busy ? 'disabled' : ''}>${busy ? L('更新中…', 'Pulling…') : L('更新', 'Pull')}</button>
        <button class="btn btn-danger" data-rm="${i}" ${busy ? 'disabled' : ''}>${L('移除', 'Remove')}</button>
      </td>
    </tr>`;
  }).join('');

  const totalKb = repoList.reduce((n, r) => n + (r.sizeKb || 0), 0);
  const totalFiles = repoList.reduce((n, r) => n + (r.fileCount || 0), 0);

  $('modalBody').innerHTML = hubTabs('repos') + `
    <p style="color:var(--dim);font-size:11.5px;line-height:1.75;margin:0 0 12px">${t('rp.intro')}</p>
    <table class="tbl">
      <thead><tr><th>${t('rp.name')}</th><th>${t('rp.size')}</th><th>${t('rp.files')}</th><th>${t('rp.git')}</th><th>${t('rp.lastCommit')}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="set-hint" style="margin-top:12px">${t('rp.total', repoList.length, fmtSize(totalKb), totalFiles)}</div>`;
  wireHubTabs();

  $('modalFoot').innerHTML =
    '<button class="btn btn-ghost" id="mRepoCheckAll">' + L('检查全部', 'Check all') + '</button>' +
    '<button class="btn btn-ghost" id="mRepoRefresh">' + t('common.refresh') + '</button>' +
    '<button class="btn btn-primary" id="mRepoAdd">' + t('common.addFolder') + '</button>';
  $('mRepoRefresh').onclick = () => showRepos(true);
  $('mRepoAdd').onclick = addRepoFlow;
  $('mRepoCheckAll').onclick = () => {
    repoList.forEach((r, i) => { if (r.exists && r.isGit) doRepoCheck(i); });
  };

  $('modalBody').querySelectorAll('button[data-check]').forEach((b) => {
    b.onclick = () => doRepoCheck(Number(b.dataset.check));
  });

  $('modalBody').querySelectorAll('button[data-open]').forEach((b) => {
    b.onclick = () => {
      const r = repoList[Number(b.dataset.open)];
      if (r) window.api.openPath(r.path);
    };
  });
  $('modalBody').querySelectorAll('button[data-pull]').forEach((b) => {
    b.onclick = () => doRepoPull(Number(b.dataset.pull));
  });
  $('modalBody').querySelectorAll('button[data-rm]').forEach((b) => {
    b.onclick = async () => {
      const r = repoList[Number(b.dataset.rm)];
      if (!r) return;
      if (!confirm(t('rp.removeConfirm', r.name))) return;
      try {
        await window.api.repoRemove(r.path);
        delete repoStates[r.path];
        banner(t('rp.removed', r.name), 'ok');
        showRepos(true);
      } catch (e) { banner(L('移除失败：', 'Remove failed: ') + e.message, 'err'); }
    };
  });
}

async function doRepoCheck(idx) {
  const r = repoList[idx];
  if (!r) return;
  repoUpdates[r.path] = { checking: true };
  paintRepos();
  try {
    const res = await window.api.repoCheck(r.path);
    repoUpdates[r.path] = res;
  } catch (e) {
    repoUpdates[r.path] = { ok: false, reason: e.message };
  }
  paintRepos();
}

async function doRepoPull(idx) {
  const r = repoList[idx];
  if (!r) return;
  if (!confirm(L(
    `对「${r.name}」执行 git pull？

${r.path}

只做快进合并，遇到需要手动合并的情况会中止。`,
    `Run git pull on “${r.name}”?

${r.path}

Fast-forward only; it aborts if a manual merge is needed.`
  ))) return;

  repoStates[r.path] = { status: 'running', startedAt: Date.now(), percent: null, phase: '' };
  paintRepos();
  startRepoTimer();

  try {
    const res = await window.api.repoPull(r.path);
    if (res.ok) {
      repoStates[r.path] = { status: 'ok', at: Date.now(), msg: res.raw };
      delete repoUpdates[r.path];
      banner(L(`✓ ${r.name} 已更新`, `✓ ${r.name} updated`), 'ok');
      const one = await window.api.repoOne(r.path).catch(() => null);
      if (one) {
        const i = repoList.findIndex((x) => x.path === r.path);
        if (i >= 0) repoList[i] = one;
      }
    } else {
      repoStates[r.path] = { status: 'fail', at: Date.now(), msg: res.raw };
      banner(L(`${r.name} 更新失败（可能需要手动合并），详见日志`,
        `${r.name} pull failed (manual merge may be needed), see logs`), 'err');
      log(res.raw || '');
    }
  } catch (e) {
    repoStates[r.path] = { status: 'fail', msg: e.message };
    banner(L('更新失败：', 'Pull failed: ') + e.message, 'err');
  }
  paintRepos();
}

async function addRepoFlow() {
  try {
    const p = await window.api.pickFolder();
    if (!p) return;
    await window.api.repoAdd(p);
    banner('已添加仓库：' + p, 'ok');
    showRepos(true);
  } catch (e) {
    banner('添加失败：' + e.message, 'err');
  }
}

if (window.api.onRepoPullProgress) {
  window.api.onRepoPullProgress((d) => {
    const st = repoStates[d.path];
    if (!st || st.status !== 'running') return;
    if (d.percent != null) st.percent = d.percent;
    if (d.phase) st.phase = d.phase;
    const el = Array.from(document.querySelectorAll('[data-pb]')).find((x) => x.dataset.pb === d.path);
    if (!el) return;
    const bar = el.querySelector('.pbar i');
    const txt = el.querySelector('.pb-text');
    const pct = st.percent != null ? st.percent : 0;
    if (bar) bar.style.width = pct + '%';
    if (txt) {
      const sec = Math.max(0, Math.floor((Date.now() - st.startedAt) / 1000));
      txt.textContent = (st.percent != null ? st.percent + '% · ' : '') + (st.phase || L('更新中', 'Pulling')) + ' · ' + sec + 's';
    }
  });
}

/* ---------------- 主题 / 语言 ---------------- */

function paintLangBtn() {
  const b = $('btnLang');
  if (!b) return;
  b.textContent = state.lang === 'en' ? 'EN' : '中';
  b.title = state.lang === 'en' ? '切换到中文介绍' : 'Switch to English';
}

function applyLang(l) {
  state.lang = l === 'en' ? 'en' : 'zh';
  try { localStorage.setItem('lang', state.lang); } catch (e) {}
  setUiLang(state.lang);
  paintLangBtn();
  render();
  if (state.selected) select(state.selected);
}

function initLang() {
  let l = 'zh';
  try { l = localStorage.getItem('lang') || 'zh'; } catch (e) {}
  state.lang = l === 'en' ? 'en' : 'zh';
  setUiLang(state.lang);
  paintLangBtn();
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const b = $('btnTheme');
  b.textContent = t === 'light' ? '☀' : '☾';
  b.title = t === 'light' ? '切换到深色' : '切换到浅色';
  try { localStorage.setItem('theme', t); } catch (e) {}
}

function initTheme() {
  let t = document.documentElement.getAttribute('data-theme');
  if (t !== 'light' && t !== 'dark') t = 'dark';
  applyTheme(t);
}

/* ---------------- 事件 ---------------- */

$('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('showDisabled').addEventListener('change', (e) => { state.showDisabled = e.target.checked; render(); });
$('onlyBroken').addEventListener('change', (e) => { state.onlyBroken = e.target.checked; render(); });
$('btnCheck').addEventListener('click', doCheck);
$('btnUpdateAll').addEventListener('click', doUpdateAll);
$('btnDeps').addEventListener('click', showDeps);
$('btnPresets').addEventListener('click', showPresets);
$('btnBackups').addEventListener('click', showBackups);
$('btnMarket').addEventListener('click', () => showMarket(''));
$('btnLogs').addEventListener('click', showLogs);
$('btnSettings').addEventListener('click', showSettings);
$('btnDistribute').addEventListener('click', showDistribute);
$('btnReconcile').addEventListener('click', showReconcile);

$('btnAddProject').addEventListener('click', async () => {
  try {
    const p = await window.api.pickFolder();
    if (!p) return;
    await window.api.projectAdd(p);
    state.settings = await window.api.settingsGet();
    state.scope = p;
    state.category = '全部';
    state.selected = null;
    await load(true);
    banner('已添加项目：' + p, 'ok');
  } catch (e) {
    banner('添加失败：' + e.message, 'err');
  }
});
$('btnTheme').addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
});
$('btnLang').addEventListener('click', () => applyLang(state.lang === 'zh' ? 'en' : 'zh'));
$('btnRefresh').addEventListener('click', async () => {
  banner('重新扫描中…', '');
  await load(true);
  banner('');
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('search').focus(); }
});

// 外部安装 / 删除技能时自动刷新
if (window.api.onSkillsChanged) {
  window.api.onSkillsChanged(async () => {
    await load(true);
    banner('检测到技能目录变化，已自动刷新', 'ok');
    setTimeout(() => banner(''), 3000);
  });
}
if (window.api.onUpdates) {
  window.api.onUpdates((r) => applyCheckResult(r));
}

/* ---------------- 启动 ---------------- */

$('showDisabled').checked = true;
initTheme();
initLang();
(async () => {
  await loadSettings();
  try {
    const env = await window.api.envInfo();
    if (!env.nodeOk) {
      state.noNode = true;
      banner(env.hasNode
        ? `Node.js 版本过低（${env.nodeVersion}），需要 22.20 或更高。检查更新、市场、安装功能暂不可用。`
        : '未检测到 Node.js。检查更新、市场、安装功能需要 Node.js 22.20+，请先安装。', 'warn');
    }
  } catch (e) { /* 忽略 */ }
  await load(false);

  // 后台刷新 CLI 元数据（磁盘缓存先顶上，界面不等它）
  setTimeout(() => { if (state.scope === 'global') load(true); }, 900);

  // 启动时检查是否有散落在其他工具目录的技能
  try {
    const rc = await window.api.reconcileScan([]);
    if (rc && rc.findings.length) {
      state.reconcileCount = rc.findings.length;
      state.reconcileFindings = rc.findings;
      render();
      banner(`检测到 ${rc.findings.length} 个技能散落在其他 AI 工具的目录里，点右上角「归位 (${rc.findings.length})」查看并处理`, 'warn');
    }
  } catch (e) { /* 忽略 */ }
})();
