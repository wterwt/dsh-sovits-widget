/**
 * 冒烟测试：用 duck-typed Cordis 上下文加载构建产物 lib/index.js，
 * 验证插件 apply 不抛错、路由注册齐全、systemPrompt 注入与事件监听挂载成功。
 * 不依赖 @deepseek-ai 任何包，模拟 whale-widget 所需的宿主契约面。
 */

import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');
const mod = plugin.default ?? plugin;

const routes = [];
const tapIndexFns = [];
const sections = [];
const eventListeners = [];
const injectedRows = [];
const disposers = [];

const webServer = {
  register: (route) => {
    routes.push(`${route.kind}:${route.path}`);
    return () => {};
  },
  tapIndex: (fn) => {
    tapIndexFns.push(fn);
    return () => {};
  },
};

const systemPrompt = {
  section: (s) => {
    sections.push(`${s.name}@${s.order}`);
    return () => {};
  },
};

const ctx = { webServer, systemPrompt, get: () => undefined };

const root = {
  on: (event, cb) => {
    eventListeners.push(event);
    return () => {};
  },
  inject: (names, cb) => {
    if (names.includes('webServer') || names.includes('systemPrompt')) cb(ctx);
  },
  effect: (fn) => {
    const dispose = fn();
    disposers.push(dispose);
    return () => {};
  },
};

// 隔离 dataDir，避免污染真实 ~/.dsh
const dataDir = mkdtempSync(join(tmpdir(), 'sovits-smoke-'));
process.env.DSH_HOME = dataDir;

let failure = null;
try {
  mod.apply(root);
} catch (err) {
  failure = err;
}

const checks = {
  'apply 不抛错': failure === null,
  '注册了客户端脚本路由': routes.includes('exact:/dsh-sovits/client.js'),
  '注册了配置路由': routes.includes('exact:/dsh-sovits/config.json'),
  '注册了合成路由': routes.includes('exact:/dsh-sovits/speak.json'),
  '注册了状态轮询路由': routes.includes('exact:/dsh-sovits/status.json'),
  '注册了音频取件路由': routes.includes('exact:/dsh-sovits/audio.bin'),
  '注册了健康路由': routes.includes('exact:/dsh-sovits/health.json'),
  'systemPrompt 注入段': sections.includes('tts:sovits-style@131'),
  'session/event 监听': eventListeners.includes('session/event'),
  '桌面壳注入行监听': eventListeners.includes('webserver/index-inject'),
  'tapIndex 已挂载': tapIndexFns.length === 1,
  '路由总数 >= 15': routes.length >= 15,
};

let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}
if (failure) {
  console.error('apply 异常:', failure);
  ok = false;
}
console.log(`\n路由清单（${routes.length} 条）:`);
for (const route of routes.sort()) console.log('  ' + route);
process.exit(ok ? 0 : 1);
