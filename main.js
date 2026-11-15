'use strict';

const {
  app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, nativeImage,
  dialog, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const yaml = require('js-yaml');

const HOME = os.homedir();
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const DISABLED_DIR = path.join(HOME, '.claude', 'skills-disabled');
const I18N_PATH = path.join(__dirname, 'i18n', 'descriptions.json');

let I18N = {};
try { I18N = JSON.parse(fs.readFileSync(I18N_PATH, 'utf8')); } catch (_) { I18N = {}; }

let mainWindow = null;
let tray = null;
let schedulerTimer = null;
let userData = null;

// 固定数据目录名，避免改名后设置/备份丢失；Windows 通知也需要 AppUserModelID
app.setName('skills-manager');
if (process.platform === 'win32') app.setAppUserModelId('cn.llmood.skillsmanager');

/* 单实例：只允许开一个，再次启动时唤起已有窗口 */
const IS_TEST_MODE = ['--shot', '--selftest', '--test-dist', '--test-preset', '--test-uninstall', '--test-market', '--test-reconcile', '--test-project', '--test-apply', '--test-projpath', '--test-speed', '--test-fix', '--test-scope', '--test-backup-del']
  .some((a) => process.argv.includes(a));
const gotTheLock = IS_TEST_MODE ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); });
}

/* ================================================================== */
/* 基础工具                                                            */
/* ================================================================== */

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(cmd, args, {
      shell: isWin,
      cwd: opts.cwd || HOME,
      env: { ...process.env, DISABLE_TELEMETRY: '1', ...(opts.env || {}) },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, opts.timeout || 180000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }); });
  });
}

const NPX = () => (process.platform === 'win32' ? 'npx.cmd' : 'npx');
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else { try { total += fs.statSync(fp).size; } catch (_) {} }
    }
  };
  walk(dir);
  return total;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

const OP_LOG = () => path.join(userData, 'operations.log');

function opLog(action, detail) {
  try {
    const line = `[${new Date().toISOString()}] ${action} ${detail || ''}\n`;
    fs.appendFileSync(OP_LOG(), line, 'utf8');
  } catch (_) {}
}

/* ================================================================== */
/* 设置                                                               */
/* ================================================================== */

const DEFAULT_PRESETS = [
  { id: 'drama', name: '短剧生产包', skills: ['short-drama', 'seedance-20', 'minimax-video-prompt', 'character-asset-build', '运镜与机位', '表情语气对话提示词', 'h3-jineng'] },
  { id: 'image', name: '图像出图包', skills: ['krea2-zimage-prompt', 'gpt-image-prompt', 'mj-prompt', 'ai-image-generation', 'character-design-prompt', 'film-styles'] },
  { id: 'render', name: '视频渲染包', skills: ['hyperframes', 'hyperframes-cli', 'hyperframes-registry', 'remotion-render', 'ai-video-generation'] },
  { id: 'ui', name: '前端设计包', skills: ['anti-ui-slop', 'uizze-ui', 'image-to-ui', 'break-ui', 'mobile-native', 'animation-performance'] },
];

function settingsPath() { return path.join(userData, 'settings.json'); }

function getSettings() {
  const s = readJson(settingsPath(), {});
  return {
    hideToTray: s.hideToTray !== undefined ? s.hideToTray : true,
    autoCheckHours: s.autoCheckHours !== undefined ? s.autoCheckHours : 24,
    presets: s.presets || DEFAULT_PRESETS,
    projects: s.projects || [],
    repos: s.repos || [],
    backupDir: s.backupDir || '',
    openAtLogin: app.isPackaged ? loginItemEnabled() : !!s.openAtLogin,
    packaged: app.isPackaged,
    dataDir: userData,
  };
}

function applyLoginItem(enabled) {
  if (!app.isPackaged) return { ok: false, dev: true, message: '开发模式下不写入开机自启（打包后生效）' };
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: true,
      path: process.execPath,
      args: enabled ? ['--hidden'] : [],
    });
    return { ok: true, openAtLogin: app.getLoginItemSettings().openAtLogin };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function loginItemEnabled() {
  if (!app.isPackaged) return false;
  try { return !!app.getLoginItemSettings().openAtLogin; } catch (_) { return false; }
}

function setSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch };
  writeJson(settingsPath(), next);
  scheduleAutoCheck(next.autoCheckHours);
  if (Object.prototype.hasOwnProperty.call(patch, 'openAtLogin')) {
    applyLoginItem(patch.openAtLogin);
  }
  return next;
}

/* ================================================================== */
/* 分类                                                               */
/* ================================================================== */

const CATEGORY_RULES = [
  { cat: '视频生成', keys: ['ai-video-generation', 'seedance', 'h3-', 'minimax-video', 'minimax-lipsync', 'minimax-fashion-video', 'minimax-jewelry-video'] },
  { cat: '图像生成', keys: ['ai-image-generation', 'krea2', 'gpt-image', 'mj-prompt', 'ai-visual-prompt', 'character-design', 'character-asset'] },
  { cat: '视频渲染', keys: ['hyperframes', 'remotion'] },
  { cat: '分镜运镜', keys: ['运镜', 'cinematic-terms', 'film-styles'] },
  { cat: '短剧', keys: ['short-drama', '表情语气', '豆包音频', 'prop-text-composite'] },
  { cat: 'UI 设计', keys: ['uizze', 'anti-ui-slop', 'image-to-ui', 'break-ui', 'mobile-native', 'ui-', 'animation-performance'] },
  { cat: '工程工具', keys: ['find-skills', 'chief-of-staff', 'neon-', 'security-audit', 'ultracave', 'douyin-download'] },
];

function categorize(name, description) {
  const n = (name || '').toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keys.some((k) => n.includes(k.toLowerCase()))) return rule.cat;
  }
  const d = (description || '').toLowerCase();
  if (/视频|video/.test(d)) return '视频生成';
  if (/图像|image|图片/.test(d)) return '图像生成';
  if (/ui|界面/.test(d)) return 'UI 设计';
  return '其他';
}

/* ================================================================== */
/* 解析 SKILL.md                                                      */
/* ================================================================== */

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return { head: text.slice(3, end), body: text.slice(end + 4), endIdx: end };
}

function parseFrontmatter(text) {
  const fm = splitFrontmatter(text);
  if (!fm) return { ok: false, reason: 'no-frontmatter' };
  try {
    return { ok: true, data: yaml.load(fm.head) || {} };
  } catch (e) {
    return { ok: false, reason: 'yaml-error', detail: e.message };
  }
}

/** 修复双引号字符串里未转义的反斜杠 */
function repairYamlEscapes(text) {
  const fm = splitFrontmatter(text);
  if (!fm) return text;
  const valid = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', ' ', 'N', '_', 'L', 'P']);
  let out = '';
  let inDouble = false;
  for (let i = 0; i < fm.head.length; i++) {
    const ch = fm.head[i];
    if (!inDouble) {
      out += ch;
      if (ch === '"') inDouble = true;
      continue;
    }
    if (ch === '\\') {
      const nextCh = fm.head[i + 1];
      if (nextCh !== undefined && !valid.has(nextCh)) {
        out += '\\\\';
      } else {
        out += ch;
      }
      continue;
    }
    out += ch;
    if (ch === '"') inDouble = false;
  }
  return '---' + out + '\n---' + fm.body;
}

function scanDir(dir, disabled) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  const names = new Map();

  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const skillPath = path.join(dir, ent.name);
    const mdPath = path.join(skillPath, 'SKILL.md');
    const item = {
      name: ent.name, path: skillPath, mdPath,
      disabled,
      hasSkillMd: fs.existsSync(mdPath),
      sizeKb: null,
      health: 'ok', healthDetail: null, healthCode: null,
      description: '', displayName: ent.name,
    };

    if (!item.hasSkillMd) {
      item.health = 'missing-skill-md'; item.healthCode = 'missing-skill-md';
      item.healthDetail = '目录里没有 SKILL.md';
      out.push(item); continue;
    }

    let text = '';
    try { text = fs.readFileSync(mdPath, 'utf8'); }
    catch (e) {
      item.health = 'read-error'; item.healthCode = 'read-error';
      item.healthDetail = String(e.message);
      out.push(item); continue;
    }

    const fm = parseFrontmatter(text);
    if (!fm.ok) {
      item.health = fm.reason;
      item.healthCode = fm.reason;
      item.healthDetail = fm.detail || fm.reason;
    } else {
      const d = fm.data || {};
      item.description = typeof d.description === 'string' ? d.description : '';
      item.displayName = d.name || ent.name;

      // 从 allowed-tools 里提取需要的命令行工具
      const at = d['allowed-tools'];
      const toolStr = Array.isArray(at) ? at.join(' ') : (typeof at === 'string' ? at : '');
      const needs = [];
      const re = /Bash\(\s*([a-zA-Z0-9_.\-]+)/g;
      let m;
      while ((m = re.exec(toolStr)) !== null) needs.push(m[1]);
      item.cliNeeds = [...new Set(needs)];

      if (!d.description) {
        item.health = 'no-description'; item.healthCode = 'no-description';
        item.healthDetail = 'frontmatter 里缺少 description';
      } else if (d.name && d.name !== ent.name) {
        item.health = 'name-mismatch'; item.healthCode = 'name-mismatch';
        item.healthDetail = `frontmatter name (${d.name}) 与目录名不一致`;
      }
    }

    item.category = categorize(ent.name, item.description);
    const key = (item.displayName || ent.name).toLowerCase();
    if (names.has(key)) {
      names.get(key).push(ent.name);
    } else {
      names.set(key, [ent.name]);
    }
    out.push(item);
  }

  // 重名检测
  for (const [key, arr] of names) {
    if (arr.length > 1) {
      for (const nm of arr) {
        const it = out.find((x) => x.name === nm);
        if (it && it.health === 'ok') {
          it.health = 'duplicate-name';
          it.healthCode = 'duplicate-name';
          it.healthDetail = `与其他技能重名：${arr.join('、')}`;
        }
      }
    }
  }

  for (const it of out) {
    const tr = I18N[it.name] || {};
    it.descZh = tr.zh || it.description || '';
    it.descEn = tr.en || it.description || '';
    it.hasTranslation = !!(tr.zh && tr.en);
    it.transStale = !!(tr.srcHash && it.description && sha(it.description) !== tr.srcHash);
  }
  return out;
}

/* ================================================================== */
/* 列表                                                               */
/* ================================================================== */

let listCache = { at: 0, data: null };
let cliCache = { at: 0, map: {} };

function metaCachePath() { return path.join(userData, 'skills-meta-cache.json'); }

function loadMetaCacheFromDisk() {
  const d = readJson(metaCachePath(), null);
  if (!d) return;
  if (d.map && Object.keys(d.map).length) listCache = { at: d.at || 0, data: d.map };
  if (d.cli && Object.keys(d.cli).length) cliCache = { at: d.cliAt || 0, map: d.cli };
}

function saveMetaCache() {
  try {
    writeJson(metaCachePath(), {
      at: listCache.at, map: listCache.data || {},
      cliAt: cliCache.at, cli: cliCache.map || {},
    });
  } catch (_) {}
}

async function getCliMeta(force) {
  // 非强制时直接返回已有结果（内存或磁盘缓存），由调用方在后台刷新
  if (!force && listCache.data) return listCache.data;
  const res = await runCmd(NPX(), ['-y', 'skills', 'list', '-g', '--json'], { timeout: 120000 });
  let data = [];
  try { data = JSON.parse(res.stdout.slice(res.stdout.indexOf('['))); } catch (_) {}
  if (!data.length && listCache.data) return listCache.data;
  const map = {};
  for (const s of data) map[s.name] = s;
  listCache = { at: Date.now(), data: map };
  saveMetaCache();
  return map;
}

async function cliPresence(cmds) {
  const list = [...new Set(cmds)].filter(Boolean);
  if (!list.length) return {};
  const fresh = Date.now() - cliCache.at < 300000;
  const allKnown = list.every((c) => c in cliCache.map);
  if (fresh && allKnown) return cliCache.map;
  const map = { ...cliCache.map };
  for (const c of list) {
    if (fresh && c in map) continue;
    const r = await runCmd(process.platform === 'win32' ? 'where' : 'which', [c], { timeout: 15000 });
    map[c] = r.code === 0;
  }
  cliCache = { at: Date.now(), map };
  saveMetaCache();
  return map;
}

async function listSkills(force) {
  const meta = await getCliMeta(force);
  const enabled = scanDir(SKILLS_DIR, false);
  const disabled = scanDir(DISABLED_DIR, true);
  const all = [...enabled, ...disabled];

  for (const s of all) {
    const m = meta[s.name];
    s.source = m ? m.source : null;
    s.sourceUrl = m ? m.sourceUrl : null;
    s.tracked = !!(m && m.status === 'tracked');
    if (!s.category) s.category = categorize(s.name, s.description);
  }

  // 按技能实际声明的 CLI 依赖打标，只影响需要的那几个
  const allNeeds = all.flatMap((s) => s.cliNeeds || []);
  const present = await cliPresence(allNeeds);
  for (const s of all) {
    const needs = s.cliNeeds || [];
    s.cliOk = needs.every((c) => present[c] !== false);
    s.cliMissing = needs.filter((c) => present[c] === false);
  }

  return {
    skills: all,
    dirs: { skills: SKILLS_DIR, disabled: DISABLED_DIR },
    counts: {
      total: all.length,
      enabled: enabled.length,
      disabled: disabled.length,
      tracked: all.filter((s) => s.tracked && !s.disabled).length,
      untracked: all.filter((s) => !s.tracked && !s.disabled).length,
      broken: all.filter((s) => s.health !== 'ok').length,
    },
  };
}

/* ================================================================== */
/* 启用 / 禁用                                                         */
/* ================================================================== */

function moveDir(src, dst) {
  ensureDir(path.dirname(dst));
  if (fs.existsSync(dst)) throw new Error('目标已存在：' + dst);
  try { fs.renameSync(src, dst); }
  catch (e) {
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

async function toggleSkill(name, enable) {
  const src = path.join(enable ? DISABLED_DIR : SKILLS_DIR, name);
  const dst = path.join(enable ? SKILLS_DIR : DISABLED_DIR, name);
  if (!fs.existsSync(src)) throw new Error('找不到：' + src);
  if (fs.existsSync(dst)) throw new Error('目标已存在：' + dst);
  moveDir(src, dst);
  listCache.at = 0;
  opLog(enable ? 'ENABLE' : 'DISABLE', name);
  return { ok: true, name, enabled: enable };
}

/* ================================================================== */
/* 健康修复                                                            */
/* ================================================================== */

async function fixSkill(name, projectPath) {
  const dirs = projectPath
    ? projectDirs(projectPath)
    : { skills: SKILLS_DIR, disabled: DISABLED_DIR };

  const enabledPath = path.join(dirs.skills, name);
  const disabledPath = path.join(dirs.disabled, name);
  const dir = fs.existsSync(enabledPath) ? enabledPath : disabledPath;
  if (!fs.existsSync(dir)) return { ok: false, error: '找不到技能' };

  const mdPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) {
    return { ok: false, error: '缺少 SKILL.md，无法自动修复（需要手工创建）' };
  }

  const orig = fs.readFileSync(mdPath, 'utf8');
  let text = orig;
  const actions = [];

  // 1. YAML 转义修复（可能反复几次直到能解析）
  for (let i = 0; i < 3; i++) {
    const fm = parseFrontmatter(text);
    if (fm.ok) break;
    const fixed = repairYamlEscapes(text);
    if (fixed === text) break;
    text = fixed;
    actions.push('修复 YAML 转义');
  }

  // 2. 补 description
  let fm = parseFrontmatter(text);
  if (fm.ok) {
    const d = fm.data || {};
    const fmBlock = splitFrontmatter(text);
    if (!d.description) {
      const inject = `\ndescription: "${name}（自动补充的描述，请补充完整）"`;
      text = '---' + fmBlock.head + inject + '\n---' + fmBlock.body;
      actions.push('补写 description');
    }
    // 3. 修正 name
    fm = parseFrontmatter(text);
    if (fm.ok && fm.data && fm.data.name && fm.data.name !== name) {
      const blk = splitFrontmatter(text);
      const head = blk.head.replace(/^name:\s*.*$/m, `name: "${name}"`);
      text = '---' + head + '\n---' + blk.body;
      actions.push(`name 由 ${fm.data.name} 改为 ${name}`);
    }
  }

  if (text !== orig) {
    fs.writeFileSync(mdPath, text, 'utf8');
    opLog('FIX', `${name} (${actions.join(', ')})`);
  }

  const after = parseFrontmatter(text);
  return {
    ok: after.ok,
    actions,
    changed: text !== orig,
    stillBroken: !after.ok ? (after.detail || after.reason) : null,
  };
}

async function fixAllBroken() {
  const data = await listSkills(true);
  const broken = data.skills.filter((s) => s.health !== 'ok');
  const results = [];
  for (const s of broken) {
    try { results.push({ name: s.name, ...(await fixSkill(s.name)) }); }
    catch (e) { results.push({ name: s.name, ok: false, error: e.message }); }
  }
  listCache.at = 0;
  return { total: broken.length, results };
}

/* ================================================================== */
/* 依赖体检                                                            */
/* ================================================================== */

async function depsCheck() {
  const items = [];
  const skillData = await listSkills(false);

  const ver = async (cmd, args) => {
    const r = await runCmd(cmd, args, { timeout: 20000 });
    return r.code === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
  };

  const affectedBy = (key) =>
    skillData.skills
      .filter((s) =>
        (s.cliNeeds || []).includes(key) ||
        s.name.toLowerCase().startsWith(key.toLowerCase()))
      .map((s) => s.name);

  const nodeV = (await ver('node', ['-v'])) || ('v' + process.versions.node);
  items.push({
    key: 'node', name: 'Node.js', required: '≥ 22.20', found: nodeV,
    ok: !!nodeV && (() => {
      const m = nodeV.match(/v(\d+)\.(\d+)/);
      return !!(m && (parseInt(m[1], 10) > 22 || (parseInt(m[1], 10) === 22 && parseInt(m[2], 10) >= 20)));
    })(),
    hint: '用来运行 skills CLI 和 HyperFrames',
  });

  const npmV = await ver(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['-v']);
  items.push({ key: 'npm', name: 'npm', required: '任意', found: npmV, ok: !!npmV, hint: '安装依赖用' });

  const gitV = await ver('git', ['--version']);
  items.push({ key: 'git', name: 'git', required: '任意', found: gitV, ok: !!gitV, hint: '部分 skill 需要拉取仓库' });

  const which = async (cmd) => {
    const r = await runCmd(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 15000 });
    return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
  };

  for (const [key, name, hint] of [
    ['belt', 'inference.sh CLI (belt)', 'ai-video-generation / ai-image-generation 需要'],
    ['runcomfy', 'RunComfy CLI', 'RunComfy 系 skill 需要'],
    ['hyperframes', 'HyperFrames CLI', '做视频渲染需要'],
  ]) {
    let p = await which(key);
    if (!p) {
      // 可能在 node_modules 里，用 npx 兜底探测
      const r = await runCmd(NPX(), ['-y', key, '--version'], { timeout: 60000 });
      if (r.code === 0) p = (r.stdout || '').trim().split('\n')[0];
    }
    items.push({
      key, name, required: '已安装', found: p || '未检测到', ok: !!p, hint,
      affected: affectedBy(key),
      install: key === 'belt' ? 'npx skills add belt-sh/cli -g' :
        key === 'runcomfy' ? 'npm i -g @runcomfy/cli' : 'npm i -g hyperframes',
    });
  }

  return items;
}

/* ================================================================== */
/* 备份                                                               */
/* ================================================================== */

function backupRoot() {
  const custom = getSettings().backupDir;
  return (custom && custom.trim()) ? custom : path.join(userData, 'backups');
}

function createBackup(label) {
  ensureDir(backupRoot());
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupRoot(), ts);
  ensureDir(dir);
  let count = 0;
  if (fs.existsSync(SKILLS_DIR)) {
    fs.cpSync(SKILLS_DIR, path.join(dir, 'skills'), { recursive: true });
    count = fs.readdirSync(SKILLS_DIR).filter((n) => {
      try { return fs.statSync(path.join(SKILLS_DIR, n)).isDirectory(); } catch (_) { return false; }
    }).length;
  }
  if (fs.existsSync(DISABLED_DIR)) {
    fs.cpSync(DISABLED_DIR, path.join(dir, 'skills-disabled'), { recursive: true });
  }
  writeJson(path.join(dir, 'meta.json'), { ts, label: label || '', count });
  opLog('BACKUP', `${ts} (${count} 个技能)`);
  return { ok: true, ts, count, dir };
}

function backupOne(name, projectPath) {
  const dirs = scopeDirs(projectPath);
  let src = null;
  for (const d of [dirs.skills, dirs.disabled]) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) { src = p; break; }
  }
  if (!src) throw new Error('找不到要备份的技能');

  ensureDir(backupRoot());
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot(), `${ts}--${name}`);
  ensureDir(dest);
  fs.cpSync(src, path.join(dest, name), { recursive: true });
  writeJson(path.join(dest, 'meta.json'), {
    ts, label: `单技能备份：${name}`, skill: name,
    project: projectPath || null, count: 1,
  });
  opLog('BACKUP_ONE', `${name} → ${dest}`);
  return { ok: true, ts, dest, name };
}

function hasBackup(name) {
  const root = backupRoot();
  if (!fs.existsSync(root)) return { has: false };
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return { has: false }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const meta = readJson(path.join(dir, 'meta.json'), {});
    if (meta.skill === name) return { has: true, ts: e.name, single: true };
    if (fs.existsSync(path.join(dir, 'skills', name))) return { has: true, ts: e.name, single: false };
  }
  return { has: false };
}

function deleteBackup(ts) {
  const dir = path.join(backupRoot(), ts);
  if (!fs.existsSync(dir)) throw new Error('备份不存在');
  const sizeKb = Math.round(dirSize(dir) / 1024);
  fs.rmSync(dir, { recursive: true, force: true });
  opLog('DELETE_BACKUP', `${ts} (${sizeKb}KB)`);
  return { ok: true, ts, sizeKb };
}

function listBackups() {
  const root = backupRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name);
      const meta = readJson(path.join(dir, 'meta.json'), {});
      return { ts: e.name, label: meta.label || '', count: meta.count || 0, sizeKb: Math.round(dirSize(dir) / 1024) };
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

function restoreBackup(ts) {
  const dir = path.join(backupRoot(), ts);
  if (!fs.existsSync(dir)) throw new Error('备份不存在');
  const meta = readJson(path.join(dir, 'meta.json'), {});

  // 单技能备份
  if (meta.skill) {
    const src = path.join(dir, meta.skill);
    if (!fs.existsSync(src)) throw new Error('备份内容缺失');
    const target = meta.project || SKILLS_DIR;
    ensureDir(target);
    const dst = path.join(target, meta.skill);
    if (fs.existsSync(dst)) throw new Error('目标位置已有同名技能，请先处理');
    fs.cpSync(src, dst, { recursive: true });
    listCache.at = 0;
    opLog('RESTORE_ONE', `${meta.skill} → ${target}`);
    return { ok: true, ts, restored: meta.skill, target };
  }

  const src = path.join(dir, 'skills');
  if (!fs.existsSync(src)) throw new Error('备份内容缺失');
  // 先给当前状态再备一份，防止还原后想要回退
  createBackup('还原前自动备份');
  fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
  fs.cpSync(src, SKILLS_DIR, { recursive: true });
  const ds = path.join(dir, 'skills-disabled');
  if (fs.existsSync(ds)) {
    fs.rmSync(DISABLED_DIR, { recursive: true, force: true });
    fs.cpSync(ds, DISABLED_DIR, { recursive: true });
  }
  listCache.at = 0;
  opLog('RESTORE', ts);
  return { ok: true, ts };
}

/* ================================================================== */
/* 套装                                                               */
/* ================================================================== */

async function applyPreset(presetId, mode, projectPath) {
  const s = getSettings();
  const preset = s.presets.find((p) => p.id === presetId);
  if (!preset) throw new Error('套装不存在');

  if (projectPath) {
    const d = projectDirs(projectPath);
    if (d.mode !== 'nested') throw new Error('这个目录不是标准项目结构，无法应用套装');
  }

  const data = projectPath ? await listProjectSkills(projectPath) : await listSkills(false);
  const want = new Set(preset.skills);
  const actions = [];
  const doToggle = (name, enable) =>
    projectPath ? toggleProjectSkill(projectPath, name, enable) : toggleSkill(name, enable);

  for (const name of preset.skills) {
    const item = data.skills.find((x) => x.name === name);
    if (!item) { actions.push({ name, result: '未安装' }); continue; }
    if (item.disabled) {
      try { await doToggle(name, true); actions.push({ name, result: '已启用' }); }
      catch (e) { actions.push({ name, result: '失败：' + e.message }); }
    } else {
      actions.push({ name, result: '本来就是启用' });
    }
  }

  if (mode === 'only') {
    for (const item of data.skills) {
      if (!item.disabled && !want.has(item.name)) {
        try { await doToggle(item.name, false); actions.push({ name: item.name, result: '已禁用' }); }
        catch (e) { actions.push({ name: item.name, result: '失败：' + e.message }); }
      }
    }
  }

  listCache.at = 0;
  opLog('PRESET', `${preset.name} (${mode})${projectPath ? ' @ ' + projectPath : ''}`);
  return { ok: true, preset: preset.name, actions };
}

/* ================================================================== */
/* 市场                                                               */
/* ================================================================== */

async function marketSearch(q) {
  const r = await runCmd(NPX(), ['-y', 'skills', 'find', q], { timeout: 120000 });
  const text = (r.stdout || '') + (r.stderr || '');
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\S+)\s+([\d.,]+\s*[KkMm万]?)\s+installs?\s*$/);
    if (m) out.push({ spec: m[1], installs: m[2] });
  }
  return { ok: r.code === 0, query: q, results: out, raw: text.trim() };
}

async function marketInstall(spec, target) {
  const [repo, skill] = spec.split('@');
  let args;
  let cwd = HOME;
  let dest = SKILLS_DIR;
  let scopeLabel = '全局';
  let fellBackToGlobal = false;

  if (target && target.scope === 'project' && target.path) {
    const d = projectDirs(target.path);
    if (d.mode === 'nested') {
      args = ['-y', 'skills', 'add', repo, '-a', 'claude-code', '--copy', '-y'];
      cwd = target.path;
      dest = d.skills;
      scopeLabel = '项目 ' + target.path;
    } else {
      // 自定义技能目录（非标准项目结构），CLI 装不进去，退回全局
      args = ['-y', 'skills', 'add', repo, '-g', '-a', 'claude-code', '--copy', '-y'];
      fellBackToGlobal = true;
    }
  } else {
    args = ['-y', 'skills', 'add', repo, '-g', '-a', 'claude-code', '--copy', '-y'];
  }

  if (skill) args.push('-s', skill);
  const r = await runCmd(NPX(), args, { timeout: 600000, cwd });
  listCache.at = 0;
  opLog('INSTALL', `${spec} → ${fellBackToGlobal ? '全局(回退)' : scopeLabel}`);
  return {
    ok: r.code === 0,
    dest,
    scopeLabel: fellBackToGlobal ? '全局（该目录不是标准项目结构，已回退）' : scopeLabel,
    fellBackToGlobal,
    raw: ((r.stdout || '') + '\n' + (r.stderr || '')).trim(),
  };
}

const sha = (s) => crypto.createHash('sha256')
  .update(s.replace(/\r\n/g, '\n').trim())
  .digest('hex').slice(0, 12);

async function marketDetail(spec) {
  const [repo, skill] = spec.split('@');
  if (!repo) throw new Error('无效的 spec');

  let info = {};
  try { info = await ghJson(`https://api.github.com/repos/${repo}`); } catch (_) {}

  let pathInRepo = null;
  let content = null;
  let remoteHash = null;
  let desc = '';
  let allowed = '';
  let error = null;

  try {
    pathInRepo = await findRemoteSkillFile(repo, skill);
    if (pathInRepo) {
      content = await fetchRaw(repo, pathInRepo);
      remoteHash = sha(content);
      const fm = parseFrontmatter(content);
      if (fm.ok) {
        desc = fm.data.description || '';
        const at = fm.data['allowed-tools'];
        allowed = Array.isArray(at) ? at.join(' ') : (at || '');
      }
    } else {
      error = `仓库里没找到 ${skill || '目标技能'}/SKILL.md`;
    }
  } catch (e) {
    error = e.message;
  }

  const localPath = path.join(SKILLS_DIR, skill || '', 'SKILL.md');
  let installedHash = null;
  let sameAsInstalled = false;
  if (skill && fs.existsSync(localPath)) {
    installedHash = sha(fs.readFileSync(localPath, 'utf8'));
    sameAsInstalled = installedHash === remoteHash;
  }

  return {
    ok: true, spec, repo, skill,
    stars: info.stargazers_count || 0,
    updated: info.pushed_at || null,
    repoDesc: info.description || '',
    archived: !!info.archived,
    fork: !!info.fork,
    pathInRepo, bytes: content ? Buffer.byteLength(content, 'utf8') : 0,
    remoteHash, installedHash, sameAsInstalled,
    allowed, desc, error,
  };
}

/* ================================================================== */
/* 更新检查 / 更新 / 差异预览                                           */
/* ================================================================== */

function parseCheckOutput(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^Checking skills from source:/i.test(t)) continue;
    if (/up to date/i.test(t)) continue;
    if (/^Fetching \d+ sources/i.test(t)) continue;
    if (/^Checking for skill updates/i.test(t)) continue;
    const m = t.match(/^[•\-*⬆↑↗\s]*([a-z0-9][a-z0-9._-]{1,60})\b/i);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

async function checkUpdates(projectPath) {
  const args = ['-y', 'skills', 'check'];
  let cwd = HOME;

  if (projectPath) {
    const d = projectDirs(projectPath);
    if (d.mode !== 'nested') {
      return {
        ok: false, unsupported: true,
        reason: '这个目录不是标准项目结构（缺少 .claude/skills），无法检查更新',
        upToDate: false, updates: [], raw: '', at: Date.now(),
      };
    }
    args.push('-p');
    cwd = projectPath;
  } else {
    args.push('-g');
  }

  const r = await runCmd(NPX(), args, { timeout: 300000, cwd });
  const text = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  const upToDate = /up to date/i.test(text);
  opLog('CHECK', (projectPath ? `project ${projectPath}` : 'global') + (upToDate ? ' all up to date' : ' updates available'));
  return { ok: r.code === 0, upToDate, updates: upToDate ? [] : parseCheckOutput(text), raw: text, at: Date.now() };
}

async function updateSkills(names, projectPath) {
  const list = Array.isArray(names) ? names : [];
  let backup = null;
  let cwd = HOME;
  const args = ['-y', 'skills', 'update', ...list];

  if (projectPath) {
    const d = projectDirs(projectPath);
    if (d.mode !== 'nested') throw new Error('这个目录不是标准项目结构，无法更新');
    args.push('-p');
    cwd = projectPath;
  } else {
    args.push('-g');
    try { backup = createBackup('更新前自动备份'); } catch (_) {}
  }

  args.push('-y');
  const r = await runCmd(NPX(), args, { timeout: 900000, cwd });
  listCache.at = 0;
  opLog('UPDATE', `${list.join(', ') || 'all'}${projectPath ? ' @ ' + projectPath : ''}`);
  return {
    ok: r.code === 0, names: list, backup: backup ? backup.ts : null,
    raw: ((r.stdout || '') + '\n' + (r.stderr || '')).trim(),
  };
}

const treeCache = new Map();

async function ghJson(url) {
  // 优先走本机 gh CLI（已登录，避免匿名限流）
  const m = url.match(/^https:\/\/api\.github\.com\/(.+)$/);
  if (m) {
    const r = await runCmd('gh', ['api', m[1]], { timeout: 60000 });
    if (r.code === 0) {
      try { return JSON.parse(r.stdout); } catch (_) {}
    }
  }
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'skills-manager' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

async function findRemoteSkillFile(source, skillName) {
  if (treeCache.has(source)) {
    const t = treeCache.get(source);
    return t.find((p) => p.endsWith(`/${skillName}/SKILL.md`)) || null;
  }
  const tree = await ghJson(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`);
  const files = (tree.tree || []).filter((x) => x.type === 'blob').map((x) => x.path);
  treeCache.set(source, files);
  return files.find((p) => p === `${skillName}/SKILL.md` || p.endsWith(`/${skillName}/SKILL.md`))
    || files.find((p) => p === 'SKILL.md')
    || null;
}

async function fetchRaw(source, filePath) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${source}/HEAD/${filePath}`, {
      headers: { 'User-Agent': 'skills-manager' },
    });
    if (res.ok) return res.text();
  } catch (_) {}
  // 兜底：gh api 取原始内容
  const r = await runCmd('gh', ['api', `repos/${source}/contents/${filePath}`, '-H', 'Accept: application/vnd.github.raw'], { timeout: 60000 });
  if (r.code === 0 && r.stdout) return r.stdout;
  throw new Error('无法下载远端 SKILL.md');
}

function simpleDiff(a, b) {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  const n = la.length, m = lb.length;
  if (n * m > 4000000) return { tooBig: true, added: 0, removed: 0, lines: [] };
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ t: '-', s: la[i] }); removed++; i++; }
    else { lines.push({ t: '+', s: lb[j] }); added++; j++; }
  }
  while (i < n) { lines.push({ t: '-', s: la[i] }); removed++; i++; }
  while (j < m) { lines.push({ t: '+', s: lb[j] }); added++; j++; }
  return { added, removed, lines: lines.slice(0, 400) };
}

async function updatePreview(name, projectPath) {
  const data = projectPath ? await listProjectSkills(projectPath) : await listSkills(false);
  const item = data.skills.find((s) => s.name === name);
  if (!item) throw new Error('技能不存在');
  if (!item.tracked || !item.source) {
    return { ok: false, reason: '本地技能，没有上游来源，无法预览更新' };
  }
  if (!item.hasSkillMd) return { ok: false, reason: '本地缺少 SKILL.md' };

  const remotePath = await findRemoteSkillFile(item.source, name);
  if (!remotePath) return { ok: false, reason: `在 ${item.source} 里没找到 ${name}/SKILL.md` };

  const remote = await fetchRaw(item.source, remotePath);
  const local = fs.readFileSync(item.mdPath, 'utf8');
  const diff = simpleDiff(local, remote);
  return {
    ok: true, name, source: item.source, remotePath,
    same: local.trim() === remote.trim(), ...diff,
  };
}

/* ================================================================== */
/* 编辑器                                                             */
/* ================================================================== */

function scopeDirs(projectPath) {
  return projectPath
    ? projectDirs(projectPath)
    : { skills: SKILLS_DIR, disabled: DISABLED_DIR };
}

function readSkillMd(name, projectPath) {
  const dirs = scopeDirs(projectPath);
  for (const d of [dirs.skills, dirs.disabled]) {
    const p = path.join(d, name, 'SKILL.md');
    if (fs.existsSync(p)) return { ok: true, path: p, content: fs.readFileSync(p, 'utf8') };
  }
  return { ok: false, error: '找不到 SKILL.md' };
}

function writeSkillMd(name, content, projectPath) {
  const dirs = scopeDirs(projectPath);
  for (const d of [dirs.skills, dirs.disabled]) {
    const p = path.join(d, name, 'SKILL.md');
    if (fs.existsSync(p)) {
      fs.writeFileSync(p, content, 'utf8');
      listCache.at = 0;
      opLog('EDIT', `${name}${projectPath ? ' @ ' + projectPath : ''}`);
      const fm = parseFrontmatter(content);
      return { ok: true, valid: fm.ok, error: fm.ok ? null : (fm.detail || fm.reason) };
    }
  }
  return { ok: false, error: '找不到 SKILL.md' };
}

/* ================================================================== */
/* 日志                                                               */
/* ================================================================== */

function readLogs(limit) {
  try {
    if (!fs.existsSync(OP_LOG())) return [];
    const lines = fs.readFileSync(OP_LOG(), 'utf8').trim().split(/\r?\n/);
    return lines.slice(-(limit || 300)).reverse();
  } catch (_) { return []; }
}

function clearLogs() {
  try { fs.writeFileSync(OP_LOG(), '', 'utf8'); } catch (_) {}
  return { ok: true };
}

/* ================================================================== */
/* 目录监听：外部安装 / 删除技能时自动刷新                                  */
/* ================================================================== */

let watchTimer = null;

function notifyChanged() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    listCache.at = 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('skills:changed');
    }
  }, 800);
}

function watchSkillsDirs() {
  for (const dir of [SKILLS_DIR, DISABLED_DIR]) {
    try {
      if (fs.existsSync(dir)) {
        fs.watch(dir, { persistent: false }, () => notifyChanged());
      }
    } catch (_) {}
  }
}

/* ================================================================== */
/* 托盘 / 定时检查                                                      */
/* ================================================================== */

function trayIcon() {
  const ico = path.join(__dirname, 'icon.ico');
  if (fs.existsSync(ico)) {
    const img = nativeImage.createFromPath(ico);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('AI Skill Manager');
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      {
        label: '检查更新',
        click: async () => {
          const r = await checkUpdates();
          if (r.upToDate) new Notification({ title: 'AI Skill Manager', body: '全部技能已是最新' }).show();
          else new Notification({ title: 'AI Skill Manager', body: `发现 ${r.updates.length} 个可更新` }).show();
          if (mainWindow) mainWindow.webContents.send('updates:result', r);
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuiting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
  } catch (_) {}
}

function scheduleAutoCheck(hours) {
  if (schedulerTimer) clearInterval(schedulerTimer);
  const h = Number(hours);
  if (!h || h <= 0) return;
  const ms = Math.max(1, h) * 3600 * 1000;
  schedulerTimer = setInterval(async () => {
    try {
      const r = await checkUpdates();
      if (mainWindow) mainWindow.webContents.send('updates:result', r);
      if (!r.upToDate && Array.isArray(r.updates) && r.updates.length) {
        new Notification({ title: 'AI Skill Manager', body: `有 ${r.updates.length} 个技能可更新` }).show();
      }
    } catch (_) {}
  }, ms);
}

/* ================================================================== */
/* 窗口                                                               */
/* ================================================================== */

/* ================================================================== */
/* 技能分发：把技能共享给其他 AI 工具                                     */
/* ================================================================== */

const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

const AGENT_TOOLS = [
  {
    id: 'codex', name: 'Codex', supportsSkills: true,
    dir: path.join(HOME, '.agents', 'skills'),
    detect: [path.join(HOME, '.codex'), path.join(HOME, '.agents')],
    note: '读取 ~/.agents/skills/',
  },
  {
    id: 'cursor', name: 'Cursor', supportsSkills: true,
    dir: path.join(HOME, '.cursor', 'skills'),
    detect: [path.join(HOME, '.cursor'), path.join(LOCAL, 'Programs', 'cursor')],
    note: '读取 ~/.cursor/skills/',
  },
  {
    id: 'gemini', name: 'Gemini CLI', supportsSkills: true,
    dir: path.join(HOME, '.gemini', 'skills'),
    detect: [path.join(HOME, '.gemini')],
    note: '读取 ~/.gemini/skills/',
  },
  {
    id: 'copilot', name: 'GitHub Copilot', supportsSkills: true,
    dir: path.join(HOME, '.copilot', 'skills'),
    detect: [path.join(HOME, '.copilot')],
    note: '读取 ~/.copilot/skills/',
  },
  {
    id: 'opencode', name: 'OpenCode', supportsSkills: true,
    dir: path.join(HOME, '.config', 'opencode', 'skills'),
    detect: [path.join(HOME, '.config', 'opencode')],
    note: '读取 ~/.config/opencode/skills/',
  },
  {
    id: 'windsurf', name: 'Windsurf', supportsSkills: true,
    dir: path.join(HOME, '.codeium', 'windsurf', 'skills'),
    detect: [path.join(HOME, '.codeium')],
    note: '读取 ~/.codeium/windsurf/skills/',
  },
  {
    id: 'trae', name: 'Trae', supportsSkills: true,
    dir: path.join(HOME, '.trae', 'skills'),
    detect: [path.join(HOME, '.trae')],
    note: '读取 ~/.trae/skills/',
  },
  {
    id: 'qwen', name: 'Qwen Code', supportsSkills: true,
    dir: path.join(HOME, '.qwen', 'skills'),
    detect: [path.join(HOME, '.qwen')],
    note: '读取 ~/.qwen/skills/',
  },
  {
    id: 'doubao', name: '豆包', supportsSkills: false,
    dir: null,
    detect: [path.join(LOCAL, 'Doubao')],
    note: '聊天客户端，没有技能目录机制，只能用「导出技能包」粘贴到智能体设定里',
  },
];

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}

function readLink(p) {
  try { return fs.readlinkSync(p); } catch (_) { return null; }
}

function pointsToSkills(src) {
  const t = readLink(src);
  if (!t) return false;
  return path.resolve(t).toLowerCase().startsWith(path.resolve(SKILLS_DIR).toLowerCase());
}

function detectTools() {
  return AGENT_TOOLS.map((t) => {
    const installed = t.detect.some((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
    let linked = [];
    if (t.supportsSkills && t.dir && fs.existsSync(t.dir)) {
      try {
        linked = fs.readdirSync(t.dir).filter((n) => {
          const p = path.join(t.dir, n);
          return isLink(p) && pointsToSkills(p);
        });
      } catch (_) {}
    }
    return {
      id: t.id, name: t.name, dir: t.dir, note: t.note,
      supportsSkills: t.supportsSkills, installed, linked,
    };
  });
}

async function distribute(toolId, skillNames, mode) {
  const tool = AGENT_TOOLS.find((t) => t.id === toolId);
  if (!tool) throw new Error('未知工具');
  if (!tool.supportsSkills) throw new Error('该工具不支持技能目录，请改用导出技能包');
  if (!tool.dir) throw new Error('该工具没有可用的技能目录');

  ensureDir(tool.dir);
  const results = [];
  let ok = 0;

  for (const name of skillNames) {
    const src = path.join(SKILLS_DIR, name);
    if (!fs.existsSync(src)) { results.push({ name, result: '源技能不存在' }); continue; }
    const dst = path.join(tool.dir, name);

    if (fs.existsSync(dst) || isLink(dst)) {
      if (isLink(dst) && pointsToSkills(dst)) { results.push({ name, result: '早已连接' }); continue; }
      results.push({ name, result: '目标已存在（非本程序创建），跳过' });
      continue;
    }

    try {
      if (mode === 'copy') {
        fs.cpSync(src, dst, { recursive: true });
        results.push({ name, result: '已复制' });
      } else {
        fs.symlinkSync(path.resolve(src), dst, LINK_TYPE);
        results.push({ name, result: '已连接' });
      }
      ok++;
    } catch (e) {
      results.push({ name, result: '失败：' + e.message });
    }
  }

  opLog('DISTRIBUTE', `${tool.name} ${mode} ${ok}/${skillNames.length}`);
  return { ok: true, tool: tool.name, mode, total: skillNames.length, success: ok, results };
}

async function disconnectTool(toolId) {
  const tool = AGENT_TOOLS.find((t) => t.id === toolId);
  if (!tool || !tool.dir || !fs.existsSync(tool.dir)) return { ok: true, removed: 0, kept: 0 };

  let removed = 0;
  let kept = 0;
  for (const n of fs.readdirSync(tool.dir)) {
    const p = path.join(tool.dir, n);
    if (isLink(p) && pointsToSkills(p)) {
      try { fs.unlinkSync(p); removed++; } catch (_) {}
    } else {
      kept++;
    }
  }
  opLog('DISCONNECT', `${tool.name} 移除 ${removed}`);
  return { ok: true, removed, kept };
}

/* ---------------- 导出技能包 ---------------- */

function buildPack(names, format) {
  const parts = [];
  const stamp = new Date().toISOString().slice(0, 10);
  parts.push(`# AI 技能包\n\n导出日期：${stamp}\n包含技能：${names.length} 个\n\n---\n`);

  for (const name of names) {
    const mdPath = path.join(SKILLS_DIR, name, 'SKILL.md');
    if (!fs.existsSync(mdPath)) continue;
    const text = fs.readFileSync(mdPath, 'utf8');
    const fm = parseFrontmatter(text);
    const data = (fm.ok && fm.data) || {};
    const zh = (I18N[name] && I18N[name].zh) || data.description || '';

    if (format === 'compact') {
      parts.push(`## ${name}\n\n${zh}\n`);
    } else {
      const fmBlock = splitFrontmatter(text);
      const body = fmBlock ? fmBlock.body.replace(/^\s*---\s*/, '') : text;
      parts.push(`## ${name}\n\n${zh}\n\n${body.trim()}\n\n---\n`);
    }
  }
  return parts.join('\n');
}

async function exportPack(names, format, action) {
  const list = Array.isArray(names) ? names : [];
  if (!list.length) return { ok: false, error: '没有选择技能' };
  const content = buildPack(list, format);

  if (action === 'clipboard') {
    clipboard.writeText(content);
    return { ok: true, chars: content.length, bytes: Buffer.byteLength(content, 'utf8') };
  }

  const defName = `skill-pack-${format}-${new Date().toISOString().slice(0, 10)}.md`;
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '导出技能包',
    defaultPath: path.join(app.getPath('documents'), defName),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, content, 'utf8');
  opLog('EXPORT', `${format} ${list.length} 个 → ${r.filePath}`);
  return { ok: true, path: r.filePath, bytes: Buffer.byteLength(content, 'utf8') };
}

/* 单个技能的即时信息（用于局部刷新，不走 npx） */
async function getSkillInfo(name, projectPath) {
  const dirs = projectPath
    ? projectDirs(projectPath)
    : { skills: SKILLS_DIR, disabled: DISABLED_DIR };

  let base = null;
  let disabled = false;
  if (fs.existsSync(path.join(dirs.skills, name))) base = dirs.skills;
  else if (fs.existsSync(path.join(dirs.disabled, name))) { base = dirs.disabled; disabled = true; }
  if (!base) return null;

  const item = scanDir(base, disabled).find((x) => x.name === name);
  if (!item) return null;

  const present = await cliPresence(item.cliNeeds || []);
  const needs = item.cliNeeds || [];
  item.cliOk = needs.every((c) => present[c] !== false);
  item.cliMissing = needs.filter((c) => present[c] === false);

  if (!projectPath) {
    const meta = await getCliMeta(false);
    const m = meta[name];
    item.source = m ? m.source : null;
    item.tracked = !!(m && m.status === 'tracked');
  }
  return item;
}

/* ================================================================== */
/* 卸载（永久删除）                                                      */
/* ================================================================== */

async function uninstallSkill(name, projectPath) {
  const dirs = scopeDirs(projectPath);
  const candidates = [path.join(dirs.skills, name), path.join(dirs.disabled, name)];
  const found = candidates.filter((p) => fs.existsSync(p));
  if (!found.length) throw new Error('找不到该技能的目录');

  // 清掉指向它的分发链接
  const links = [];
  for (const t of AGENT_TOOLS) {
    if (!t.dir || !fs.existsSync(t.dir)) continue;
    const p = path.join(t.dir, name);
    if (!isLink(p)) continue;
    const target = readLink(p);
    if (target && found.some((f) =>
      path.resolve(target).toLowerCase().startsWith(path.resolve(f).toLowerCase()))) {
      try { fs.unlinkSync(p); links.push(p); } catch (_) {}
    }
  }

  const sizeKb = found.reduce((n, p) => n + Math.round(dirSize(p) / 1024), 0);
  for (const p of found) fs.rmSync(p, { recursive: true, force: true });

  listCache.at = 0;
  opLog('UNINSTALL', `${name}${projectPath ? ' @ ' + projectPath : ''} (${sizeKb}KB, 断开 ${links.length} 个链接)`);
  return { ok: true, name, removed: found.length, sizeKb, unlinked: links.length };
}

/* ================================================================== */
/* 自动归位：扫描散落在别处的技能（只报告，不动文件）                      */
/* ================================================================== */

const SCAN_WHITELIST = [
  { id: 'codex', label: 'Codex', dir: () => path.join(HOME, '.agents', 'skills') },
  { id: 'cursor', label: 'Cursor', dir: () => path.join(HOME, '.cursor', 'skills') },
  { id: 'gemini', label: 'Gemini CLI', dir: () => path.join(HOME, '.gemini', 'skills') },
  { id: 'copilot', label: 'GitHub Copilot', dir: () => path.join(HOME, '.copilot', 'skills') },
  { id: 'opencode', label: 'OpenCode', dir: () => path.join(HOME, '.config', 'opencode', 'skills') },
  { id: 'windsurf', label: 'Windsurf', dir: () => path.join(HOME, '.codeium', 'windsurf', 'skills') },
  { id: 'trae', label: 'Trae', dir: () => path.join(HOME, '.trae', 'skills') },
  { id: 'qwen', label: 'Qwen Code', dir: () => path.join(HOME, '.qwen', 'skills') },
];

function dirHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, base) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of sorted) {
      const p = path.join(d, e.name);
      const rel = path.relative(base, p).replace(/\\/g, '/');
      if (e.isDirectory()) walk(p, base);
      else if (e.isFile()) {
        h.update(rel);
        try { h.update(fs.readFileSync(p)); } catch (_) {}
      }
    }
  };
  walk(dir, dir);
  return h.digest('hex').slice(0, 12);
}

function isInsideGitRepo(dir) {
  let cur = dir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

async function reconcileScan(extraDirs) {
  const scanned = [];
  const findings = [];

  const globalNames = new Set(
    (fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR) : [])
      .filter((n) => { try { return fs.statSync(path.join(SKILLS_DIR, n)).isDirectory(); } catch (_) { return false; } })
  );

  const targets = SCAN_WHITELIST.map((w) => ({ label: w.label, dir: w.dir() }))
    .concat((extraDirs || []).map((d) => ({ label: path.basename(d) || d, dir: d })));

  for (const t of targets) {
    const info = { label: t.label, dir: t.dir, exists: fs.existsSync(t.dir), count: 0, skipped: [] };
    scanned.push(info);
    if (!info.exists) continue;

    let entries;
    try { entries = fs.readdirSync(t.dir, { withFileTypes: true }); } catch (_) { continue; }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const p = path.join(t.dir, ent.name);

      if (ent.name.startsWith('.')) { info.skipped.push({ name: ent.name, why: '系统目录' }); continue; }
      if (isLink(p)) { info.skipped.push({ name: ent.name, why: '已经是联接' }); continue; }
      if (isInsideGitRepo(p)) { info.skipped.push({ name: ent.name, why: '在 git 仓库里' }); continue; }
      if (!fs.existsSync(path.join(p, 'SKILL.md'))) { info.skipped.push({ name: ent.name, why: '没有 SKILL.md' }); continue; }

      info.count++;
      const localHash = dirHash(p);
      let status = 'new';
      let detail = '唯一目录里没有，可以搬过去';
      if (globalNames.has(ent.name)) {
        const gh = dirHash(path.join(SKILLS_DIR, ent.name));
        if (gh === localHash) {
          status = 'same';
          detail = '与唯一目录里的内容完全一致，只需在原地建联接';
        } else {
          status = 'diff';
          detail = '同名但内容不同，需要你决定保留哪份';
        }
      }
      findings.push({
        name: ent.name, from: t.dir, fromLabel: t.label,
        status, detail, hash: localHash,
      });
    }
  }

  return { scanned, findings, canonical: SKILLS_DIR, mode: 'report-only' };
}

/* ================================================================== */
/* 项目级技能                                                          */
/* ================================================================== */

function looksLikeSkillsDir(d) {
  try {
    const ents = fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    return ents.some((e) => fs.existsSync(path.join(d, e.name, 'SKILL.md')));
  } catch (_) { return false; }
}

function projectDirs(p) {
  const nested = path.join(p, '.claude', 'skills');
  const nestedDis = path.join(p, '.claude', 'skills-disabled');

  // 1) 标准项目结构：<项目>/.claude/skills
  if (fs.existsSync(nested)) {
    return { skills: nested, disabled: nestedDis, mode: 'nested' };
  }
  // 2) 用户直接选了技能目录本身：里面就有一堆 <name>/SKILL.md
  if (looksLikeSkillsDir(p)) {
    return {
      skills: p,
      disabled: path.join(path.dirname(p), path.basename(p) + '-disabled'),
      mode: 'direct',
    };
  }
  return { skills: nested, disabled: nestedDis, mode: 'nested' };
}

async function listProjectSkills(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) throw new Error('项目路径不存在');
  const d = projectDirs(projectPath);
  const enabled = scanDir(d.skills, false);
  const disabled = scanDir(d.disabled, true);
  const all = [...enabled, ...disabled];

  // 项目里若有 skills-lock.json，读出来标来源（兼容几种落点）
  let lock = {};
  const lockPaths = [
    path.join(projectPath, 'skills-lock.json'),
    path.join(d.skills, 'skills-lock.json'),
  ];
  if (d.mode === 'direct') {
    lockPaths.push(path.join(path.dirname(projectPath), 'skills-lock.json'));
  }
  for (const lp of lockPaths) {
    try {
      if (!fs.existsSync(lp)) continue;
      const parsed = readJson(lp, {}).skills || {};
      if (Object.keys(parsed).length) { lock = parsed; break; }
    } catch (_) {}
  }

  for (const s of all) {
    const m = lock[s.name];
    s.source = m ? m.source : null;
    s.tracked = !!m;
    if (!s.category) s.category = categorize(s.name, s.description);
    s.cliMissing = s.cliMissing || [];
  }

  return {
    skills: all,
    dirs: d,
    scope: 'project',
    project: projectPath,
    mode: d.mode,
    skillsDirExists: fs.existsSync(d.skills),
    counts: {
      total: all.length,
      enabled: enabled.length,
      disabled: disabled.length,
      tracked: all.filter((s) => s.tracked).length,
      untracked: all.filter((s) => !s.tracked).length,
      broken: all.filter((s) => s.health !== 'ok').length,
    },
  };
}

async function toggleProjectSkill(projectPath, name, enable) {
  const d = projectDirs(projectPath);
  const src = path.join(enable ? d.disabled : d.skills, name);
  const dst = path.join(enable ? d.skills : d.disabled, name);
  if (!fs.existsSync(src)) throw new Error('找不到：' + src);
  if (fs.existsSync(dst)) throw new Error('目标已存在：' + dst);
  moveDir(src, dst);
  opLog(enable ? 'ENABLE(project)' : 'DISABLE(project)', `${name} @ ${projectPath}`);
  return { ok: true, name, enabled: enable };
}

async function reconcileDetail(item) {
  const srcMd = path.join(item.from, item.name, 'SKILL.md');
  const dstMd = path.join(SKILLS_DIR, item.name, 'SKILL.md');
  const a = fs.existsSync(dstMd) ? fs.readFileSync(dstMd, 'utf8') : '';
  const b = fs.existsSync(srcMd) ? fs.readFileSync(srcMd, 'utf8') : '';
  const hasBoth = !!(a && b);
  return {
    ok: true,
    name: item.name,
    from: item.from,
    hasBoth,
    same: hasBoth ? sha(a) === sha(b) : false,
    ...(hasBoth ? simpleDiff(a, b) : { added: 0, removed: 0, lines: [] }),
  };
}

async function reconcileApply(item, mode) {
  const name = item.name;
  const from = item.from;
  const src = path.join(from, name);
  const dst = path.join(SKILLS_DIR, name);

  if (!fs.existsSync(src)) throw new Error('源目录不存在');
  if (isLink(src)) throw new Error('源目录已经是联接，无需处理');
  if (isInsideGitRepo(src)) throw new Error('源目录在 git 仓库里，拒绝移动');
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('源目录里没有 SKILL.md');

  const srcHash = dirHash(src);
  let replaced = false;
  let moved = false;

  if (fs.existsSync(dst)) {
    if (dirHash(dst) !== srcHash) {
      throw new Error('唯一目录里已有同名但内容不同的技能，请先手动处理');
    }
    fs.rmSync(src, { recursive: true, force: true });
    replaced = true;
  } else {
    ensureDir(SKILLS_DIR);
    moveDir(src, dst);
    moved = true;
  }

  let linked = false;
  if (mode === 'link' && !fs.existsSync(src)) {
    ensureDir(from);
    fs.symlinkSync(path.resolve(dst), src, LINK_TYPE);
    linked = true;
  }

  listCache.at = 0;
  opLog('RECONCILE', `${name} from=${from} mode=${mode} moved=${moved} replaced=${replaced} linked=${linked}`);
  return { ok: true, name, moved, replaced, linked };
}

const CLI_INSTALL = {
  belt: { cmd: 'npx', args: ['-y', 'skills', 'add', 'belt-sh/cli', '-g'] },
  runcomfy: { cmd: 'npm', args: ['i', '-g', '@runcomfy/cli'] },
  hyperframes: { cmd: 'npm', args: ['i', '-g', 'hyperframes'] },
};

async function installCli(key) {
  const spec = CLI_INSTALL[key];
  if (!spec) throw new Error('未知组件：' + key);
  const exe = spec.cmd === 'npm'
    ? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
    : NPX();
  const r = await runCmd(exe, spec.args, { timeout: 900000 });
  cliCache = { at: 0, map: {} };
  opLog('INSTALL_CLI', `${key} exit=${r.code}`);
  return {
    ok: r.code === 0,
    key,
    raw: ((r.stdout || '') + '\n' + (r.stderr || '')).trim().slice(-4000),
  };
}

/* ================================================================== */
/* 仓库：只统计，不当技能处理                                             */
/* ================================================================== */

let reposCache = { at: 0, data: null };

async function gitOut(dir, args) {
  const r = await runCmd('git', ['-C', dir, ...args], { timeout: 30000 });
  return r.code === 0 ? (r.stdout || '').trim() : null;
}

async function repoInfo(p) {
  const info = {
    path: p,
    name: path.basename(p) || p,
    exists: fs.existsSync(p),
    sizeKb: 0, fileCount: 0, lastModified: null,
    isGit: false, branch: null, dirty: null, lastCommit: null,
  };
  if (!info.exists) return info;

  let files = 0;
  let newest = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(fp);
        files++;
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (_) {}
    }
  };
  walk(p);

  info.fileCount = files;
  info.sizeKb = Math.round(bytes / 1024);
  info.lastModified = newest ? new Date(newest).toISOString() : null;
  info.isGit = fs.existsSync(path.join(p, '.git'));

  if (info.isGit) {
    const br = await gitOut(p, ['rev-parse', '--abbrev-ref', 'HEAD']);
    info.branch = br || null;
    const st = await gitOut(p, ['status', '--porcelain']);
    info.dirty = st === null ? null : st.length > 0;
    const lc = await gitOut(p, ['log', '-1', '--format=%cI']);
    info.lastCommit = lc || null;
  }
  return info;
}

async function listRepos(force) {
  if (!force && reposCache.data && Date.now() - reposCache.at < 60000) return reposCache.data;
  const s = getSettings();
  const out = [];
  for (const p of s.repos || []) {
    try { out.push(await repoInfo(p)); }
    catch (e) { out.push({ path: p, name: path.basename(p), exists: false, error: e.message }); }
  }
  reposCache = { at: Date.now(), data: out };
  return out;
}

async function checkRepoUpdate(p) {
  if (!p || !fs.existsSync(path.join(p, '.git'))) {
    return { ok: false, reason: 'not-git' };
  }
  const up = await gitOut(p, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up) return { ok: false, reason: 'no-upstream' };

  const f = await runCmd('git', ['-C', p, 'fetch', '--quiet'], { timeout: 300000 });
  if (f.code !== 0) {
    return { ok: false, reason: 'fetch-failed', raw: ((f.stdout || '') + (f.stderr || '')).trim().slice(-800) };
  }

  const behind = parseInt((await gitOut(p, ['rev-list', '--count', 'HEAD..@{u}'])) || '0', 10) || 0;
  const ahead = parseInt((await gitOut(p, ['rev-list', '--count', '@{u}..HEAD'])) || '0', 10) || 0;
  const localHead = await gitOut(p, ['rev-parse', '--short', 'HEAD']);
  const remoteHead = await gitOut(p, ['rev-parse', '--short', '@{u}']);
  const localDate = await gitOut(p, ['log', '-1', '--format=%cs']);
  const remoteDate = await gitOut(p, ['log', '-1', '--format=%cs', '@{u}']);

  reposCache.at = 0;
  opLog('REPO_CHECK', `${p} behind=${behind} ahead=${ahead}`);
  return { ok: true, behind, ahead, upstream: up, localHead, remoteHead, localDate, remoteDate };
}

function pullRepo(p, onProgress) {
  return new Promise((resolve) => {
    if (!p || !fs.existsSync(p)) return resolve({ ok: false, raw: '路径不存在' });
    if (!fs.existsSync(path.join(p, '.git'))) return resolve({ ok: false, raw: '不是 git 仓库' });

    const child = spawn('git', ['-C', p, 'pull', '--ff-only', '--progress'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env },
    });

    let out = '';
    let lastPhase = '';

    const handle = (buf) => {
      const text = buf.toString();
      out += text;
      if (!onProgress) return;
      // git 用 \r 覆盖同一行，按 \r 和 \n 都切
      for (const line of text.split(/[\r\n]+/)) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(/^([A-Za-z][A-Za-z ]{2,30}):\s+(\d{1,3})%/);
        if (m) {
          lastPhase = m[1].trim();
          onProgress({ phase: lastPhase, percent: parseInt(m[2], 10), line: t.slice(0, 160) });
        } else if (/^(remote:|From |Updating |Already up to date|Fast-forward|Merge made)/i.test(t)) {
          onProgress({ phase: t.slice(0, 60), percent: null, line: t.slice(0, 160) });
        }
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 600000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, raw: out.trim().slice(-3000) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, raw: String(err) });
    });
  });
}

function addRepo(p) {
  if (!p || !fs.existsSync(p)) throw new Error('路径不存在');
  let st;
  try { st = fs.statSync(p); } catch (_) { throw new Error('无法读取该路径'); }
  if (!st.isDirectory()) throw new Error('请选择一个文件夹');

  const s = getSettings();
  if ((s.repos || []).includes(p)) throw new Error('已经登记过了');
  if (p === SKILLS_DIR || p.startsWith(SKILLS_DIR + path.sep)) {
    throw new Error('这是技能目录，不能登记为仓库');
  }
  if ((s.projects || []).includes(p)) {
    throw new Error('这个路径已经在「项目作用域」里了，不能重复登记');
  }

  const fp = path.join(p, 'SKILL.md');
  if (fs.existsSync(fp)) {
    // 目录本身是技能，也允许，但提醒
  }

  const next = setSettings({ repos: [...(s.repos || []), p] });
  reposCache.at = 0;
  opLog('REPO_ADD', p);
  return { ok: true, repos: next.repos };
}

function removeRepo(p) {
  const s = getSettings();
  const next = setSettings({ repos: (s.repos || []).filter((x) => x !== p) });
  reposCache.at = 0;
  opLog('REPO_REMOVE', p);
  return { ok: true, repos: next.repos };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1000, minHeight: 640,
    backgroundColor: '#0B0B0D', title: 'AI Skill Manager', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    show: !process.argv.includes('--hidden'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('close', (e) => {
    const s = getSettings();
    if (!app.isQuiting && s.hideToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  if (process.argv.includes('--shot')) {
    const shotDir = app.isPackaged ? app.getPath('userData') : path.join(__dirname, 'shots');
    ensureDir(shotDir);
    mainWindow.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const descCheck = await mainWindow.webContents.executeJavaScript(`
          (() => {
            const s = state.skills.find((x) => x.name === 'minimax-jewelry-video');
            if (!s) return { found: false };
            return { found: true, desc: descOf(s).slice(0, 30), stale: isTranslationStale(s) };
          })()
        `);
        console.log('DESC_CHECK=' + JSON.stringify(descCheck));
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            state.updates = new Set(['ai-video-generation', 'hyperframes-cli']);
            state.lastCheckAt = Date.now();
            bannerHtml('<span>发现 2 个可更新：</span>' +
              [...state.updates].map((n) => '<button class="upd-chip" data-upd="' + n + '">' + n + '</button>').join('') +
              '<span style="color:var(--dim);margin-left:8px;font-size:11px">点名字可单独更新</span>', 'warn');
            document.getElementById('banner').querySelectorAll('button[data-upd]').forEach((b) => {
              b.onclick = () => doUpdateOne(b.dataset.upd);
            });
            state.selected = 'ai-video-generation';
            select('ai-video-generation');
          })()
        `);
        await new Promise((r) => setTimeout(r, 600));
        let img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-dark.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("applyTheme('light')");
        await new Promise((r) => setTimeout(r, 700));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-light.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("applyTheme('dark'); applyLang('en')");
        await new Promise((r) => setTimeout(r, 700));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-en.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("applyLang('zh')");
        await new Promise((r) => setTimeout(r, 400));

        await mainWindow.webContents.executeJavaScript("showDeps()");
        await new Promise((r) => setTimeout(r, 6000));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-deps.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showPresets()");
        await new Promise((r) => setTimeout(r, 2500));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-presets.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showSettings()");
        await new Promise((r) => setTimeout(r, 1500));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-settings.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showDistribute()");
        await new Promise((r) => setTimeout(r, 2500));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-distribute.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showUninstall('ultracave')");
        await new Promise((r) => setTimeout(r, 900));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-uninstall1.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("showUninstallConfirm('ultracave')");
        await new Promise((r) => setTimeout(r, 700));
        await mainWindow.webContents.executeJavaScript(
          "(()=>{const i=document.getElementById('mConfirmInput');i.value='ultracave';i.dispatchEvent(new Event('input'));})()");
        await new Promise((r) => setTimeout(r, 400));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-uninstall2.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showMarket('ai-video-generation')");
        await new Promise((r) => setTimeout(r, 12000));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-market.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript(
          "showMarketDetail('101-skills/superpowers@ai-video-generation')");
        await new Promise((r) => setTimeout(r, 7000));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-market-detail.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showReconcile()");
        await new Promise((r) => setTimeout(r, 4000));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-reconcile.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript(
          "(async()=>{const s=(state.settings&&state.settings.projects)||[];if(s[0]){state.scope=s[0];await load(false);}})()");
        await new Promise((r) => setTimeout(r, 1200));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-project.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showBackups()");
        await new Promise((r) => setTimeout(r, 1200));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-backups.png'), img.toPNG());

        // 编辑保存后局部刷新验证（临时项目，不碰真实技能）
        const tmpProj = path.join(os.tmpdir(), '__edit_ui_test__');
        fs.rmSync(tmpProj, { recursive: true, force: true });
        ensureDir(path.join(tmpProj, '.claude', 'skills', 'demo'));
        fs.writeFileSync(
          path.join(tmpProj, '.claude', 'skills', 'demo', 'SKILL.md'),
          '---\nname: demo\ndescription: "原始描述 ORIGINAL"\n---\n\n# demo\n', 'utf8');

        await mainWindow.webContents.executeJavaScript(`
          (async () => {
            state.settings = state.settings || {};
            state.settings.projects = [${JSON.stringify(tmpProj)}];
            state.scope = ${JSON.stringify(tmpProj)};
            await load(false);
            select('demo');
            await showEditor('demo');
            const ta = document.getElementById('mEditor');
            ta.value = ta.value.replace('原始描述 ORIGINAL', '修改后的描述 EDITED');
            document.getElementById('mSave').click();
          })()
        `);
        await new Promise((r) => setTimeout(r, 2000));

        const editCheck = await mainWindow.webContents.executeJavaScript(`
          ({
            modalOpen: !document.getElementById('overlay').classList.contains('hidden'),
            cardDesc: (document.querySelector('.card-desc') || {}).textContent || '',
            detailDesc: (document.getElementById('dDesc') || {}).textContent || '',
            banner: (document.getElementById('banner') || {}).textContent || ''
          })
        `);
        console.log('EDIT_CHECK=' + JSON.stringify(editCheck));

        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-edit.png'), img.toPNG());
        fs.rmSync(tmpProj, { recursive: true, force: true });

        await mainWindow.webContents.executeJavaScript("closeModal(); showRepos(true)");
        await new Promise((r) => setTimeout(r, 14000));
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            if (typeof repoList === 'undefined' || !repoList.length) return;
            repoStates[repoList[0].path] = { status: 'ok', at: Date.now() };
            repoUpdates[repoList[0].path] = { ok: true, behind: 0, ahead: 0, localHead: '65677a3', remoteHead: '65677a3' };
            if (repoList[1]) {
              repoStates[repoList[1].path] = { status: 'running', startedAt: Date.now() - 7000, percent: 42, phase: 'Receiving objects' };
            }
            paintRepos();
          })()
        `);
        await new Promise((r) => setTimeout(r, 800));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-repos.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal(); showNewBackup()");
        await new Promise((r) => setTimeout(r, 1200));
        img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, 'shot-backup-new.png'), img.toPNG());

        await mainWindow.webContents.executeJavaScript("closeModal()");
        console.log('SHOT_SAVED');
      } catch (e) { console.error('SHOT_FAIL', e.message); }
      app.isQuiting = true;
      app.quit();
    });
  }
}

/* ================================================================== */
/* 启动                                                               */
/* ================================================================== */

app.whenReady().then(async () => {
  if (!gotTheLock) return;

  userData = app.getPath('userData');
  ensureDir(userData);
  ensureDir(SKILLS_DIR);
  ensureDir(DISABLED_DIR);
  loadMetaCacheFromDisk();

  if (process.argv.includes('--test-backup-del')) {
    console.log('BKDEL start');
    const before = listBackups();
    console.log('before=' + before.length + ' totalSizeKb=' + before.reduce((n, b) => n + b.sizeKb, 0));
    let removed = 0;
    for (const b of before) {
      if (b.label === 'selftest') {
        try { await deleteBackup(b.ts); removed++; } catch (e) { console.log('fail ' + b.ts + ' ' + e.message); }
      }
    }
    const after = listBackups();
    console.log('removed=' + removed);
    console.log('after=' + after.length + ' totalSizeKb=' + after.reduce((n, b) => n + b.sizeKb, 0));
    console.log('BKDEL done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-scope')) {
    console.log('SCOPE start');
    const proj = path.join(os.tmpdir(), '__scope_test__');
    fs.rmSync(proj, { recursive: true, force: true });
    const sk = path.join(proj, 'demo');
    ensureDir(sk);
    fs.writeFileSync(path.join(sk, 'SKILL.md'),
      '---\nname: "demo"\ndescription: "路径 llmood\\skills\\，读取"\n---\n\n# demo\n', 'utf8');

    const info1 = await getSkillInfo('demo', proj);
    console.log('info health=' + (info1 ? info1.health : 'null'));

    const f = await fixSkill('demo', proj);
    console.log('fix ok=' + f.ok + ' actions=' + JSON.stringify(f.actions));

    const rd = readSkillMd('demo', proj);
    console.log('read ok=' + rd.ok + ' path=' + (rd.path || ''));

    const wr = writeSkillMd('demo', rd.content + '\n<!-- touched -->\n', proj);
    console.log('write ok=' + wr.ok + ' valid=' + wr.valid);

    const pv = await updatePreview('demo', proj);
    console.log('preview ok=' + pv.ok + ' reason=' + (pv.reason || '-'));

    const un = await uninstallSkill('demo', proj);
    console.log('uninstall removed=' + un.removed + ' exists=' + fs.existsSync(sk));

    fs.rmSync(proj, { recursive: true, force: true });
    console.log('SCOPE done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-fix')) {
    console.log('FIX start');
    const proj = path.join(os.tmpdir(), '__fix_test__');
    fs.rmSync(proj, { recursive: true, force: true });
    const sk = path.join(proj, 'broken');
    ensureDir(sk);
    const bad = '---\nname: "broken"\ndescription: "位于 llmood\\skills\\，读取"\n---\n\n# x\n';
    fs.writeFileSync(path.join(sk, 'SKILL.md'), bad, 'utf8');
    const before = parseFrontmatter(fs.readFileSync(path.join(sk, 'SKILL.md'), 'utf8'));
    console.log('before valid=' + before.ok + (before.ok ? '' : ' reason=' + before.reason));

    const r = await fixSkill('broken', proj);
    console.log('fix ok=' + r.ok + ' actions=' + JSON.stringify(r.actions));
    const after = parseFrontmatter(fs.readFileSync(path.join(sk, 'SKILL.md'), 'utf8'));
    console.log('after valid=' + after.ok);
    console.log('desc=' + JSON.stringify((after.data || {}).description));

    const info = await getSkillInfo('broken', proj);
    console.log('getSkillInfo health=' + (info ? info.health : 'null'));
    fs.rmSync(proj, { recursive: true, force: true });
    console.log('FIX done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-speed')) {
    let t = Date.now();
    const a = await listSkills(false);
    console.log(`first paint (disk cache): ${Date.now() - t}ms (${a.counts.total} skills)`);
    t = Date.now();
    const b = await listSkills(true);
    console.log(`forced refresh (npx): ${Date.now() - t}ms (${b.counts.total} skills)`);
    t = Date.now();
    const c = await listSkills(false);
    console.log(`subsequent (memory): ${Date.now() - t}ms (${c.counts.total} skills)`);
    const s = getSettings();
    const proj = (s.projects && s.projects[0]) || 'E:\\llmood\\skills';
    t = Date.now();
    const d = await listProjectSkills(proj);
    console.log(`project ${proj}: ${Date.now() - t}ms (${d.counts.total} skills, mode=${d.mode})`);
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-projpath')) {
    const idx = process.argv.indexOf('--test-projpath');
    const p = process.argv[idx + 1];
    try {
      const r = await listProjectSkills(p);
      console.log(`proj=${p}`);
      console.log(`mode=${r.mode} exists=${r.skillsDirExists} total=${r.counts.total} enabled=${r.counts.enabled}`);
      console.log('names=' + JSON.stringify(r.skills.slice(0, 6).map((s) => s.name)));
      console.log('dirs=' + JSON.stringify(r.dirs));
    } catch (e) {
      console.log('ERROR ' + e.message);
    }
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-apply')) {
    console.log('APPLY start');
    const from = path.join(HOME, '.agents', 'skills');
    const name = '__apply_test__';
    const src = path.join(from, name);
    const dst = path.join(SKILLS_DIR, name);
    ensureDir(src);
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: __apply_test__\ndescription: t\n---\n\n# t\n', 'utf8');

    const scan = await reconcileScan([]);
    const item = scan.findings.find((f) => f.name === name);
    console.log('detected=' + JSON.stringify(item ? { s: item.status } : null));

    const r = await reconcileApply(item, 'link');
    console.log(`apply moved=${r.moved} replaced=${r.replaced} linked=${r.linked}`);
    console.log('inCanonical=' + fs.existsSync(dst));
    console.log('srcIsLink=' + isLink(src));
    const probe = path.join(src, 'SKILL.md');
    console.log('readThrough=' + fs.existsSync(probe));

    // 清理：先删联接，再删唯一目录里的副本
    try { if (isLink(src)) fs.unlinkSync(src); } catch (_) {}
    try { if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true }); } catch (_) {}
    console.log('cleaned=' + (!fs.existsSync(src) && !fs.existsSync(dst)));
    console.log('APPLY done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-project')) {
    console.log('PROJECT start');
    const proj = path.join(os.tmpdir(), '__skills_proj_test__');
    fs.rmSync(proj, { recursive: true, force: true });
    const pd = path.join(proj, '.claude', 'skills');
    ensureDir(path.join(pd, 'demo-a'));
    fs.writeFileSync(path.join(pd, 'demo-a', 'SKILL.md'),
      '---\nname: demo-a\ndescription: demo\n---\n\n# demo\n', 'utf8');

    let r = await listProjectSkills(proj);
    console.log(`list total=${r.counts.total} enabled=${r.counts.enabled}`);

    await toggleProjectSkill(proj, 'demo-a', false);
    r = await listProjectSkills(proj);
    console.log(`after disable enabled=${r.counts.enabled} disabled=${r.counts.disabled}`);

    await toggleProjectSkill(proj, 'demo-a', true);
    r = await listProjectSkills(proj);
    console.log(`after enable enabled=${r.counts.enabled} disabled=${r.counts.disabled}`);

    fs.rmSync(proj, { recursive: true, force: true });
    console.log('PROJECT done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-reconcile')) {
    console.log('RECONCILE start');
    const probeDir = path.join(HOME, '.agents', 'skills');
    ensureDir(probeDir);
    const a = path.join(probeDir, '__scan_new__');
    ensureDir(a);
    fs.writeFileSync(path.join(a, 'SKILL.md'), '---\nname: __scan_new__\ndescription: scan test\n---\n\n# t\n', 'utf8');

    // 复制一个同名同内容的，验证 same 判定
    const src = path.join(SKILLS_DIR, 'ultracave');
    const b = path.join(probeDir, 'ultracave');
    if (fs.existsSync(src) && !fs.existsSync(b)) fs.cpSync(src, b, { recursive: true });

    const r = await reconcileScan([]);
    console.log('scanned=' + JSON.stringify(r.scanned.map((s) => ({ l: s.label, e: s.exists, c: s.count }))));
    console.log('findings=' + JSON.stringify(r.findings.map((f) => ({ n: f.name, s: f.status }))));

    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
    const after = await reconcileScan([]);
    console.log('afterCleanup findings=' + after.findings.length);
    console.log('RECONCILE done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-market')) {
    console.log('MARKET start');
    for (const spec of ['101-skills/superpowers@ai-video-generation', 'gencraft-labs/skills@ai-image-generation', 'uizze/uizze@image-to-ui']) {
      try {
        const d = await marketDetail(spec);
        console.log(`${spec} stars=${d.stars} fork=${d.fork} path=${d.pathInRepo} bytes=${d.bytes} same=${d.sameAsInstalled} hash=${d.remoteHash || '-'} installed=${d.installedHash || '-'}`);
      } catch (e) {
        console.log(`${spec} ERROR ${e.message}`);
      }
    }
    console.log('MARKET done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-uninstall')) {
    console.log('UNINSTALL start');
    const tmp = path.join(SKILLS_DIR, '__uninstall_test__');
    ensureDir(tmp);
    fs.writeFileSync(path.join(tmp, 'SKILL.md'), '---\nname: __uninstall_test__\ndescription: temp\ntest: true\n---\n\n# temp\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'big.txt'), 'x'.repeat(5000), 'utf8');
    console.log('created=' + fs.existsSync(tmp));

    const before = await listSkills(true);
    console.log('listed=' + before.skills.some((s) => s.name === '__uninstall_test__'));

    const r = await uninstallSkill('__uninstall_test__');
    console.log(`uninstall ok=${r.ok} removed=${r.removed} sizeKb=${r.sizeKb} unlinked=${r.unlinked}`);
    console.log('gone=' + !fs.existsSync(tmp));

    const after = await listSkills(true);
    console.log('stillListed=' + after.skills.some((s) => s.name === '__uninstall_test__'));
    console.log('total=' + after.counts.total);
    console.log('UNINSTALL done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-preset')) {
    console.log('PRESET start');
    const before = await listSkills(true);
    console.log('before enabled=' + before.counts.enabled + ' disabled=' + before.counts.disabled);

    // 先禁用两个套内技能，模拟用户期望被拉起的状态
    await toggleSkill('film-styles', false);
    await toggleSkill('mj-prompt', false);
    const mid = await listSkills(true);
    console.log('after disable enabled=' + mid.counts.enabled + ' disabled=' + mid.counts.disabled);

    const r1 = await applyPreset('image', 'add');
    console.log('apply(add) preset=' + r1.preset + ' actions=' + JSON.stringify(r1.actions));

    const after = await listSkills(true);
    console.log('after apply enabled=' + after.counts.enabled + ' disabled=' + after.counts.disabled);

    // 再测「只留该套装」
    const r2 = await applyPreset('image', 'only');
    const afterOnly = await listSkills(true);
    console.log('apply(only) changes=' + r2.actions.filter((a) => a.result.indexOf('已') === 0).length +
      ' enabled=' + afterOnly.counts.enabled + ' disabled=' + afterOnly.counts.disabled);
    const stillOn = afterOnly.skills.filter((s) => !s.disabled).map((s) => s.name);
    console.log('only-enabled=' + JSON.stringify(stillOn));

    // 恢复
    const all = await listSkills(true);
    for (const s of all.skills.filter((x) => x.disabled)) {
      try { await toggleSkill(s.name, true); } catch (_) {}
    }
    const restored = await listSkills(true);
    console.log('restored enabled=' + restored.counts.enabled + ' disabled=' + restored.counts.disabled);
    console.log('PRESET done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--test-dist')) {
    console.log('DIST start');
    const before = detectTools();
    console.log('tools=' + JSON.stringify(before.map((t) => ({ id: t.id, installed: t.installed, sup: t.supportsSkills, linked: t.linked.length }))));

    const r = await distribute('codex', ['hyperframes-cli', 'find-skills'], 'link');
    console.log(`distribute ok=${r.ok} success=${r.success}/${r.total}`);

    const probe = path.join(HOME, '.agents', 'skills', 'hyperframes-cli', 'SKILL.md');
    const readThrough = fs.existsSync(probe);
    console.log(`readthrough=${readThrough} size=${readThrough ? fs.statSync(probe).size : 0}`);

    const mid = detectTools().find((t) => t.id === 'codex');
    console.log('linkedNow=' + mid.linked.length);

    const d = await disconnectTool('codex');
    console.log(`disconnect removed=${d.removed} kept=${d.kept}`);
    const after = detectTools().find((t) => t.id === 'codex');
    console.log('afterDisconnect=' + after.linked.length);

    const pack = buildPack(['short-drama', 'find-skills'], 'compact');
    const full = buildPack(['short-drama', 'find-skills'], 'full');
    console.log(`pack compact=${pack.length} full=${full.length}`);
    console.log('DIST done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  if (process.argv.includes('--selftest')) {
    console.log('SELFTEST start');
    const l = await listSkills(true);
    console.log(`skills total=${l.skills.length} enabled=${l.counts.enabled} tracked=${l.counts.tracked} broken=${l.counts.broken}`);
    const withCli = l.skills.filter((s) => (s.cliNeeds || []).length);
    console.log('cli-needs=' + JSON.stringify(withCli.map((s) => ({ n: s.name, need: s.cliNeeds, missing: s.cliMissing }))));
    const c = await checkUpdates();
    console.log(`check ok=${c.ok} upToDate=${c.upToDate} updates=${JSON.stringify(c.updates)}`);
    const d = await depsCheck();
    console.log('deps=' + JSON.stringify(d.map((x) => `${x.key}:${x.ok}`)));
    try {
      const b = createBackup('selftest');
      const list = listBackups();
      console.log(`backup ok=${b.ok} count=${b.count} listed=${list.length}`);
    } catch (e) { console.log('backup ERROR ' + e.message); }
    try {
      const p = await updatePreview('hyperframes-cli');
      console.log(`preview ok=${p.ok} same=${p.same} added=${p.added} removed=${p.removed}${p.reason ? ' reason=' + p.reason : ''}`);
    } catch (e) { console.log('preview ERROR ' + e.message); }
    try {
      const m = await marketSearch('image-to-ui');
      console.log('market=' + JSON.stringify(m.results.slice(0, 2)));
    } catch (e) { console.log('market ERROR ' + e.message); }
    console.log('SELFTEST done');
    app.isQuiting = true;
    app.quit();
    return;
  }

  ipcMain.handle('skills:list', async (_e, force) => listSkills(force));
  ipcMain.handle('skills:size', async (_e, p) => {
    try { return Math.round(dirSize(p) / 1024); } catch (_) { return null; }
  });
  ipcMain.handle('skills:toggle', async (_e, name, enable) => toggleSkill(name, enable));
  ipcMain.handle('skills:check', async (_e, projectPath) => checkUpdates(projectPath));
  ipcMain.handle('skills:update', async (_e, names, projectPath) => updateSkills(names, projectPath));
  ipcMain.handle('skills:fix', async (_e, name, projectPath) => fixSkill(name, projectPath));
  ipcMain.handle('skills:one', async (_e, name, projectPath) => getSkillInfo(name, projectPath));
  ipcMain.handle('skills:fixAll', async () => fixAllBroken());
  ipcMain.handle('skills:read', async (_e, name, projectPath) => readSkillMd(name, projectPath));
  ipcMain.handle('skills:write', async (_e, name, content, projectPath) => writeSkillMd(name, content, projectPath));
  ipcMain.handle('skills:uninstall', async (_e, name, projectPath) => uninstallSkill(name, projectPath));
  ipcMain.handle('deps:check', async () => depsCheck());
  ipcMain.handle('deps:install', async (_e, key) => installCli(key));
  ipcMain.handle('presets:apply', async (_e, id, mode, projectPath) => applyPreset(id, mode, projectPath));
  ipcMain.handle('backups:list', async () => listBackups());
  ipcMain.handle('backups:create', async (_e, label) => createBackup(label));
  ipcMain.handle('backups:one', async (_e, name, projectPath) => backupOne(name, projectPath));
  ipcMain.handle('backups:has', async (_e, name) => hasBackup(name));
  ipcMain.handle('backups:restore', async (_e, ts) => restoreBackup(ts));
  ipcMain.handle('backups:delete', async (_e, ts) => deleteBackup(ts));
  ipcMain.handle('market:search', async (_e, q) => marketSearch(q));
  ipcMain.handle('market:install', async (_e, spec, target) => marketInstall(spec, target));
  ipcMain.handle('market:detail', async (_e, spec) => marketDetail(spec));
  ipcMain.handle('reconcile:scan', async (_e, extraDirs) => reconcileScan(extraDirs));
  ipcMain.handle('reconcile:detail', async (_e, item) => reconcileDetail(item));
  ipcMain.handle('reconcile:apply', async (_e, item, mode) => reconcileApply(item, mode));
  ipcMain.handle('project:list', async (_e, p) => listProjectSkills(p));
  ipcMain.handle('project:toggle', async (_e, p, name, enable) => toggleProjectSkill(p, name, enable));
  ipcMain.handle('project:add', async (_e, p) => {
    if (!fs.existsSync(p)) throw new Error('路径不存在');
    const s = getSettings();
    const list = s.projects.slice();
    if (!list.includes(p)) list.push(p);
    return setSettings({ projects: list });
  });
  ipcMain.handle('project:remove', async (_e, p) => {
    const s = getSettings();
    return setSettings({ projects: s.projects.filter((x) => x !== p) });
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('update:preview', async (_e, name, projectPath) => updatePreview(name, projectPath));
  ipcMain.handle('logs:read', async (_e, limit) => readLogs(limit));
  ipcMain.handle('logs:clear', async () => clearLogs());
  ipcMain.handle('settings:get', async () => getSettings());
  ipcMain.handle('settings:set', async (_e, patch) => setSettings(patch));
  ipcMain.handle('tools:list', async () => detectTools());
  ipcMain.handle('tools:distribute', async (_e, toolId, names, mode) => distribute(toolId, names, mode));
  ipcMain.handle('tools:disconnect', async (_e, toolId) => disconnectTool(toolId));
  ipcMain.handle('pack:export', async (_e, names, format, action) => exportPack(names, format, action));
  ipcMain.handle('env:info', async () => {
    const r = await runCmd('node', ['-v'], { timeout: 15000 });
    const raw = r.code === 0 ? (r.stdout || '').trim() : '';
    const m = raw.match(/v(\d+)\.(\d+)/);
    const ok = !!(m && (parseInt(m[1], 10) > 22 || (parseInt(m[1], 10) === 22 && parseInt(m[2], 10) >= 20)));
    return { hasNode: r.code === 0, nodeVersion: raw || null, nodeOk: ok, platform: process.platform };
  });
  ipcMain.handle('repos:list', async (_e, force) => listRepos(force));
  ipcMain.handle('repos:add', async (_e, p) => addRepo(p));
  ipcMain.handle('repos:remove', async (_e, p) => removeRepo(p));
  ipcMain.handle('repos:pull', async (e, p) => {
    const sender = e.sender;
    const r = await pullRepo(p, (prog) => {
      try {
        if (!sender.isDestroyed()) sender.send('repo:pull-progress', { path: p, ...prog });
      } catch (_) {}
    });
    reposCache.at = 0;
    opLog('REPO_PULL', `${p} exit=${r.ok ? 0 : 1}`);
    return r;
  });
  ipcMain.handle('repos:check', async (_e, p) => checkRepoUpdate(p));
  ipcMain.handle('repos:one', async (_e, p) => repoInfo(p));
  ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));
  ipcMain.handle('app:showItem', async (_e, p) => shell.showItemInFolder(p));

  buildTray();
  scheduleAutoCheck(getSettings().autoCheckHours);
  if (app.isPackaged && getSettings().openAtLogin) applyLoginItem(true);
  watchSkillsDirs();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
