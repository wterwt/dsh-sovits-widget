# 贡献指南

感谢愿意帮忙改进这个插件。

## 开发环境

```sh
pnpm install
pnpm test        # 单元测试（无网络依赖）
pnpm typecheck   # tsc --noEmit
pnpm build       # 生成 lib/index.js 与 assets/sovits-widget.js
```

提交前请确保 `pnpm test`、`pnpm typecheck`、`pnpm build` 全部通过。

## 代码约定

- 全 ESM（`"type": "module"`），本地相对导入带 `.js` 后缀。
- TypeScript 严格模式，不用 `any`（确实不可避免时要写明原因）。
- 宿主半面（`src/host/`）**不允许**依赖 `@deepseek-ai/*` 运行时包：宿主能力一律 duck-typed 访问，保持与安装形态的 dsh 解耦。
- 客户端半面（`src/client/`）是纯 IIFE，会被 esbuild 全内联，不要引入 node 内置模块。
- 注释写清契约与原因，不复述代码。
- 每个导出都有 JSDoc；函数说明 `@param` / `@returns`。

## 测试要求

- 行为变更必须带测试。纯函数放 `tests/`，覆盖正常路径与边界。
- 涉及宿主能力（路由、事件、进程）的改动，请在 `scripts/smoke.mjs` 里补一条断言。

## 提交信息

用祈使句简述改动，例如：

```
修复回合结束时未触发自动播报
新增音色混合的缓存键参数
```

一次提交聚焦一件事。

## 反馈问题

请附上：

1. 插件「诊断」页的日志（或导出的诊断文件）；
2. GPT-SoVITS 服务窗口输出；
3. dsh 版本、GPT-SoVITS 版本、操作系统版本；
4. 复现步骤。

## 发布新版本（维护者）

1. 更新 `package.json` 的 `version`；
2. 在 `CHANGELOG.md` 记录本次变更；
3. `pnpm test && pnpm typecheck && pnpm build`；
4. 打 tag 并推送：`git tag v0.1.0 && git push origin v0.1.0`；
5. 如需发布到 npm：`npm publish`（注意 pnpm 的 `minimumReleaseAge` 供应链保护对新版本的影响）。
