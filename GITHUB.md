# GitHub 发布指引

本文档说明如何把本项目推送到 GitHub，并发布可供别人下载安装的版本。所有命令在项目根目录执行。

---

## 一、推送前检查

```bat
pnpm install
pnpm test          :: 62 个用例应全部通过
pnpm typecheck     :: 应无错误
pnpm build         :: 生成 lib/ 与 assets/
node scripts/smoke.mjs
```

确认 `git status` 里**没有** `lib/`、`assets/sovits-widget.js`、`node_modules/`（本仓库不提交构建产物，已在 `.gitignore` 排除）。

---

## 二、配置 Git 身份（只需一次）

```bat
git config --global user.name "你的名字"
git config --global user.email "你的邮箱@example.com"
```

建议用 GitHub 账号里绑定的邮箱，提交才能正确归属到你。

---

## 三、创建本地仓库并首次提交

项目根目录已执行过 `git init`，如未初始化先执行：

```bat
cd /d D:\ds\gpt-sovits-tts-plugin
git init
git branch -M main
git add -A
git status                 :: 核对文件清单，确认没有误加构建产物
git commit -m "feat: 首个版本，GPT-SoVITS 语音播报插件 0.1.0"
```

---

## 四、在 GitHub 创建仓库

1. 打开 https://github.com/new
2. **Repository name**：`dsh-sovits-widget`
3. **Description**：建议填
   `GPT-SoVITS 语音播报插件 for DeepSeek Harness — 角色音色、情感映射、流式播放与打断`
4. 可见性按需选择（Public 便于他人使用）
5. **不要**勾选 "Add a README file"、".gitignore"、"license"（本地已有，避免冲突）
6. 点 **Create repository**

---

## 五、推送

创建后 GitHub 会显示仓库地址。把下面命令里的 `<你的用户名>` 换成实际用户名：

```bat
git remote add origin https://github.com/<你的用户名>/dsh-sovits-widget.git
git push -u origin main
```

首次推送会弹出登录窗口，用浏览器授权即可。若之前用过其他 remote：

```bat
git remote set-url origin https://github.com/<你的用户名>/dsh-sovits-widget.git
```

---

## 六、发布可下载版本（关键步骤）

因为仓库不含构建产物，**必须通过 Release 提供打包文件**，别人才能免构建安装。

1. 本地构建并打包：

```bat
pnpm build
node scripts/package.mjs D:\ds
```

得到 `D:\ds\dsh-sovits-widget-0.1.0-dist.zip`（含 `lib/`、`assets/` 与全部文档）。

2. 打 tag 并推送：

```bat
git tag v0.1.0
git push origin v0.1.0
```

3. 在 GitHub 仓库页 → **Releases** → **Draft a new release**
4. **Choose a tag**：选 `v0.1.0`
5. **Release title**：`v0.1.0 — 首个版本`
6. **Describe this release**：可从 [CHANGELOG.md](CHANGELOG.md) 复制要点
7. 把 `dsh-sovits-widget-0.1.0-dist.zip` 拖到 **Attach binaries** 区域上传
8. 点 **Publish release**

完成后，README 里的下载链接可以指向 Release 页面。

---

## 七、仓库建议设置

| 位置 | 建议 |
| --- | --- |
| About → Description | 填上插件简介 |
| About → Topics | 添加 `dsh`、`dsh-plugin`、`deepseek-harness`、`gpt-sovits`、`tts` |
| Settings → Features → Issues | 开启，便于收集反馈 |
| Settings → Actions | 保持默认开启，CI 会自动跑测试与构建 |

CI 工作流（`.github/workflows/ci.yml`）会在每次 push 与 PR 时执行类型检查、单测、构建与冒烟测试，并把构建产物作为 artifact 上传。

---

## 八、后续更新版本

```bat
:: 1. 改 package.json 的 version，更新 CHANGELOG.md
:: 2. 验证
pnpm test && pnpm typecheck && pnpm build

:: 3. 提交
git add -A
git commit -m "release: 0.1.1"
git tag v0.1.1
git push origin main --tags

:: 4. 打包并在 GitHub 新建 Release 上传
node scripts/package.mjs D:\ds
```

---

## 九、可选：发布到 npm

让别人可以直接 `dsh plugin add dsh-sovits-widget`：

```bat
npm login
npm publish --access public
```

注意事项：

- `files` 字段已配置，只会发布 `lib/`、`assets/`、`cordis.patch.yml` 与文档；
- 但 `lib/` 不入库，`npm publish` 前**必须**先 `pnpm build`（`prepublishOnly` 钩子可自动化，本项目未配置，需手动执行）；
- pnpm 10+ 的 `minimumReleaseAge` 供应链保护会拒绝安装刚发布的新包，用户侧需要在 profile 的 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude` 豁免，或等待保护期结束。

---

## 十、检查清单

推送前：

- [ ] `pnpm test` 通过（62 用例）
- [ ] `pnpm typecheck` 无错误
- [ ] `pnpm build` 成功
- [ ] `git status` 未包含 `lib/`、`assets/sovits-widget.js`、`node_modules/`
- [ ] README / INSTALL 里的路径与命令与实际一致

发布后：

- [ ] Release 已上传 `*-dist.zip`
- [ ] 从 Release 下载 zip，在另一台（或干净目录）按 INSTALL.md 走通安装
- [ ] About 的 Description 与 Topics 已填写
