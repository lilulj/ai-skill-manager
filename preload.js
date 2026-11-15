'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 技能
  list: (force) => ipcRenderer.invoke('skills:list', force),
  toggle: (name, enable) => ipcRenderer.invoke('skills:toggle', name, enable),
  size: (p) => ipcRenderer.invoke('skills:size', p),
  check: (projectPath) => ipcRenderer.invoke('skills:check', projectPath),
  update: (names, projectPath) => ipcRenderer.invoke('skills:update', names, projectPath),
  fix: (name, projectPath) => ipcRenderer.invoke('skills:fix', name, projectPath),
  getSkill: (name, projectPath) => ipcRenderer.invoke('skills:one', name, projectPath),
  fixAll: () => ipcRenderer.invoke('skills:fixAll'),
  readMd: (name, projectPath) => ipcRenderer.invoke('skills:read', name, projectPath),
  writeMd: (name, content, projectPath) => ipcRenderer.invoke('skills:write', name, content, projectPath),
  uninstall: (name, projectPath) => ipcRenderer.invoke('skills:uninstall', name, projectPath),

  // 依赖
  deps: () => ipcRenderer.invoke('deps:check'),
  depsInstall: (key) => ipcRenderer.invoke('deps:install', key),

  // 套装
  applyPreset: (id, mode, projectPath) => ipcRenderer.invoke('presets:apply', id, mode, projectPath),

  // 备份
  backupsList: () => ipcRenderer.invoke('backups:list'),
  backupCreate: (label) => ipcRenderer.invoke('backups:create', label),
  backupOne: (name, projectPath) => ipcRenderer.invoke('backups:one', name, projectPath),
  backupHas: (name) => ipcRenderer.invoke('backups:has', name),
  backupRestore: (ts) => ipcRenderer.invoke('backups:restore', ts),
  backupDelete: (ts) => ipcRenderer.invoke('backups:delete', ts),

  // 市场
  marketSearch: (q) => ipcRenderer.invoke('market:search', q),
  marketInstall: (spec, target) => ipcRenderer.invoke('market:install', spec, target),
  marketDetail: (spec) => ipcRenderer.invoke('market:detail', spec),

  // 归位扫描
  reconcileScan: (extraDirs) => ipcRenderer.invoke('reconcile:scan', extraDirs),
  reconcileDetail: (item) => ipcRenderer.invoke('reconcile:detail', item),
  reconcileApply: (item, mode) => ipcRenderer.invoke('reconcile:apply', item, mode),

  // 项目级
  projectList: (p) => ipcRenderer.invoke('project:list', p),
  projectToggle: (p, name, enable) => ipcRenderer.invoke('project:toggle', p, name, enable),
  projectAdd: (p) => ipcRenderer.invoke('project:add', p),
  projectRemove: (p) => ipcRenderer.invoke('project:remove', p),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  envInfo: () => ipcRenderer.invoke('env:info'),

  // 更新预览
  updatePreview: (name, projectPath) => ipcRenderer.invoke('update:preview', name, projectPath),

  // 日志
  logsRead: (limit) => ipcRenderer.invoke('logs:read', limit),
  logsClear: () => ipcRenderer.invoke('logs:clear'),

  // 设置
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 分发
  toolsList: () => ipcRenderer.invoke('tools:list'),
  distribute: (toolId, names, mode) => ipcRenderer.invoke('tools:distribute', toolId, names, mode),
  disconnectTool: (toolId) => ipcRenderer.invoke('tools:disconnect', toolId),
  exportPack: (names, format, action) => ipcRenderer.invoke('pack:export', names, format, action),

  // 仓库
  reposList: (force) => ipcRenderer.invoke('repos:list', force),
  repoAdd: (p) => ipcRenderer.invoke('repos:add', p),
  repoRemove: (p) => ipcRenderer.invoke('repos:remove', p),
  repoPull: (p) => ipcRenderer.invoke('repos:pull', p),
  repoOne: (p) => ipcRenderer.invoke('repos:one', p),
  repoCheck: (p) => ipcRenderer.invoke('repos:check', p),
  onRepoPullProgress: (cb) => ipcRenderer.on('repo:pull-progress', (_e, d) => cb(d)),

  // 系统
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('app:showItem', p),

  // 事件
  onUpdates: (cb) => ipcRenderer.on('updates:result', (_e, r) => cb(r)),
  onSkillsChanged: (cb) => ipcRenderer.on('skills:changed', () => cb()),
});
