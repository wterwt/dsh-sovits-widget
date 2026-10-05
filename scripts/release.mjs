/**
 * 自动创建 GitHub Release 并上传附件（无需 gh CLI）。
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxxxxxxx
 *   node scripts/release.mjs [附件路径]
 *
 * 行为：
 * - 读取 package.json 的 version，tag 形如 v0.1.0
 * - 若该 tag 的 Release 已存在，则改写它；否则新建
 * - 上传附件（已存在同名则先删除再上传）
 * - 仓库通过 git remote origin 自动识别
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `v${pkg.version}`;

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error('缺少令牌。请先设置环境变量：');
  console.error('  set GITHUB_TOKEN=你的令牌');
  console.error('令牌需要 repo 权限（Fine-grained 令牌勾选 Contents: Read and write）。');
  process.exit(1);
}

// ---- 识别仓库 ----
function remoteUrl() {
  const out = execSync('git remote get-url origin', { cwd: root, encoding: 'utf8' }).trim();
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(out);
  if (!m) throw new Error(`无法从 remote 识别 GitHub 仓库: ${out}`);
  return { owner: m[1], repo: m[2] };
}

const { owner, repo } = remoteUrl();
const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-sovits-widget-release',
};

async function gh(path, init = {}) {
  const res = await fetch(`${api}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}\n${text.slice(0, 500)}`);
  }
  return body;
}

// ---- 附件路径 ----
const defaultAsset = join(root, '..', `${pkg.name}-${pkg.version}-dist.zip`);
const assetPath = process.argv[2] ?? defaultAsset;
if (!existsSync(assetPath)) {
  console.error(`找不到附件: ${assetPath}`);
  console.error('请先运行: node scripts/package.mjs');
  process.exit(1);
}
const assetName = basename(assetPath);
const assetSize = statSync(assetPath).size;

console.log(`仓库: ${owner}/${repo}`);
console.log(`标签: ${tag}`);
console.log(`附件: ${assetName} (${(assetSize / 1024).toFixed(1)} KB)`);
console.log('');

// ---- 查找或创建 Release ----
let release = null;
try {
  release = await gh(`/releases/tags/${tag}`);
  console.log(`已存在 Release: ${release.html_url}`);
} catch {
  console.log('Release 不存在，将新建。');
}

const notes = `## GPT-SoVITS 语音播报插件 · ${tag}

给 DeepSeek Harness 的助手回复加上语音播报，用自己的声音读出来。

### 安装

1. 下载下方 \`${assetName}\`
2. 解压到固定目录（如 \`D:\\dsh-sovits-widget\`）
3. 双击 \`scripts\\install.bat\`
4. 重启 DeepSeek Harness
5. 点右下角 🔊 按钮配置音色

**不需要安装 Node.js，不需要命令行操作。** 详见包内 \`新手安装指南.md\`。

### 前置要求

- DeepSeek Harness 桌面版（已安装并启动过）
- GPT-SoVITS 服务（端口 9880），需自行下载：https://github.com/RVC-Boss/GPT-SoVITS

### 主要功能

- 角色提示词注入，音色与角色卡强绑定
- 同时兼容新版 \`api_v2.py\` 与旧版 \`api.py\`（自动探测）
- 情感映射、音色混合、文本清洗分段
- Web Audio 流式播放、打断淡出、消息级播放按钮
- 连续失败自动降级浏览器语音
- 配置自动备份与一键回滚
`;

if (release) {
  release = await gh(`/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${tag} 首个版本`, body: notes, draft: false, prerelease: false }),
  });
  console.log('已更新 Release 信息。');
} else {
  release = await gh('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `${tag} 首个版本`,
      body: notes,
      draft: false,
      prerelease: false,
    }),
  });
  console.log(`已创建 Release: ${release.html_url}`);
}

// ---- 上传附件（同名先删）----
const existing = (release.assets ?? []).find((a) => a.name === assetName);
if (existing) {
  console.log(`删除同名旧附件: ${assetName}`);
  await gh(`/releases/assets/${existing.id}`, { method: 'DELETE' });
}

const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`;
console.log(`上传中…`);

const uploadRes = await fetch(uploadUrl, {
  method: 'POST',
  headers: {
    ...headers,
    'Content-Type': 'application/zip',
    'Content-Length': String(assetSize),
  },
  body: createReadStream(assetPath),
  duplex: 'half',
});

if (!uploadRes.ok) {
  const text = await uploadRes.text();
  console.error(`上传失败 ${uploadRes.status}: ${text.slice(0, 500)}`);
  process.exit(1);
}

const uploaded = await uploadRes.json();
console.log('');
console.log('上传成功！');
console.log(`  附件: ${uploaded.name} (${(uploaded.size / 1024).toFixed(1)} KB)`);
console.log(`  下载: ${uploaded.browser_download_url}`);
console.log(`  页面: ${release.html_url}`);
