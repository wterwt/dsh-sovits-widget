# PROVENANCE

本包（`dsh-sovits-widget`）的构建产物与依赖来源说明。

## 构建产物

| 文件 | 来源 |
| --- | --- |
| `lib/index.js` | 由本项目 `src/host/**/*.ts` 经 esbuild 打包（ESM，Node 平台；`zod`、`p-queue` 已内联，仅 Node 内置模块保持 external） |
| `assets/sovits-widget.js` | 由本项目 `src/client/**/*.ts` 经 esbuild 打包（IIFE，浏览器平台，依赖全内联） |

构建命令：`pnpm build`（`scripts/build.mjs`）。源码即本仓库，无第三方编译产物混入。

## 运行时依赖

发布包**不依赖任何 `node_modules`**：`zod` 与 `p-queue` 在构建时已内联进 `lib/index.js`，安装时无需 `pnpm install`。

`package.json` 仍列出 `zod`、`p-queue` 作为 `dependencies`，仅为源码开发（类型检查、单测）与 npm 发布场景声明来源：

| 包 | 版本 | 用途 | 来源 |
| --- | --- | --- | --- |
| `zod` | ^3.24.1 | 配置 Schema 校验 | npm registry |
| `p-queue` | ^8.1.0 | 合成任务并发队列 | npm registry |

## 开发依赖

`typescript`、`esbuild`、`vitest`、`@types/node` —— 仅构建/测试用，不随发布包分发。

## 设计参照

插件形态（bundle patch + 宿主 lib + assets 客户端脚本 + `tapIndex`/`webserver/index-inject` 双通道加载）参照 `dsh-whale-widget@0.3.17` 的公开实现模式；宿主扩展点契约（`ctx.webServer`、`ctx.systemPrompt`、`session/event` 事件流）来自 DeepSeek Harness 开源仓库（packages/host/webserver、packages/core/system-prompt、packages/core/session）。

## 集成说明

- 本包**不依赖**任何 `@deepseek-ai/*` 运行时包（零 peerDependencies），宿主能力全部通过 duck-typed 上下文访问，与安装形态的 dsh（desktop/web profile）解耦。
- 生成音频不落第三方服务：本地部署时数据不离开本地；远程部署由用户自行配置 `apiBase`。
