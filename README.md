# dsh-sovits-widget

给 DeepSeek Harness 的 AI 回复加上**语音播报**，用你自己克隆的声音读出来。

基于 GPT-SoVITS。装好后，AI 每回复一段，就用你设定的音色朗读一段。

> 不需要写代码，不需要装 Node.js，不需要命令行。

---

## 三步装好

### 第 1 步：准备 GPT-SoVITS

去 [GPT-SoVITS 官方仓库](https://github.com/RVC-Boss/GPT-SoVITS) 的 Releases 页面，下载 **Windows 整合包**（形如 `GPT-SoVITS-v2pro-xxxxxxxx.7z`）。

它自带 Python 环境和全部依赖，解压就能用，**不需要自己配环境**。

解压后启动服务：双击整合包里的 `api.bat`，或使用本插件提供的 [start-sovits.bat](scripts/start-sovits.bat)（会自动查找安装位置、检查端口占用）。

看到下面这行就是就绪了：

```
Uvicorn running on http://0.0.0.0:9880
```

第一次启动要加载模型，**约 1 分钟**，期间请保持窗口打开。

### 第 2 步：安装本插件

到 [Releases](https://github.com/wterwt/dsh-sovits-widget/releases) 下载最新版：

```
dsh-sovits-widget-0.1.0-dist.zip
```

1. 解压到固定目录，例如 `D:\dsh-sovits-widget`
2. 进入 `scripts` 文件夹，**双击 `install.bat`**
3. 看到「安装完成」后，**完全退出 DeepSeek Harness**（托盘图标右键 → 退出），再重新打开

`install.bat` 会自动找到 dsh 配置目录、备份你原来的配置、写入插件声明。装错了想还原，把备份文件改回原名即可。

### 第 3 步：配置音色

重启后，界面**右下角会出现一个 🔊 按钮**，点它打开设置面板：

1. 切到「**音色管理**」→ 点「**＋ 新建角色**」
2. 填角色名、人设，并选一段**参考音频**（决定用什么声音）
   - 没有现成素材？点「**上传并处理**」，会自动降噪并截取 3-10 秒最佳片段
   - 推荐 5 秒左右、干净无背景音乐的人声
3. 点该角色的「**启用**」按钮
4. 切到「**基础设置**」→ 勾选「**自动播报助手回复**」

**完成。** 以后 AI 每次回复都会自动朗读。

更详细的图文步骤（含每步截图说明与排查方法）见 [新手安装指南.md](新手安装指南.md)。

---

## 日常使用

| 想做什么 | 怎么做 |
| --- | --- |
| 重听某条回复 | 点回复下方的 ▶ 按钮 |
| 换一种读法 | 点回复下方的 ↻ 按钮 |
| 让它停下来 | 点 ⏹ 按钮，或按 `Esc` |
| 调音量 / 语速 | 播放时右下角弹出的悬浮控制台 |
| 临时关掉播报 | 点右下角 🔊 → 基础设置 → 取消勾选自动播报 |
| 换个声音 | 🔊 → 音色管理 → 新建/切换角色 |

---

## 功能

- **角色与音色绑定**：角色卡同时决定人设提示词和朗读音色，切换角色即整体切换
- **情感映射**：开心 / 愤怒 / 悲伤 可各自指定不同音色
- **音色混合**：按比例混合两个音色（如 70% A + 30% B）
- **文本清洗**：自动过滤 Markdown、Emoji、代码块、URL，只读该读的内容
- **智能分段**：按标点切分，长句自动在逗号处断开，不会读半截
- **流式播放**：分段合成、就绪即播，首句不用等全文合成完
- **打断淡出**：发新消息或按 Esc 时 100ms 淡出，不会爆音
- **自动降级**：GPT-SoVITS 连续失败 3 次会临时改用浏览器语音，服务恢复后自动切回
- **配置安全**：每次保存前自动备份，配置损坏能自动回滚，非法参数会被拒绝加载
- **本地服务托管**：可让插件自动拉起常驻 GPT-SoVITS 进程，并检测复用已运行的实例

---

## 兼容性

| 项目 | 支持情况 |
| --- | --- |
| DeepSeek Harness | 桌面版、web profile |
| GPT-SoVITS `api_v2.py`（新版） | ✅ 完整支持，含流式 |
| GPT-SoVITS `api.py`（旧版） | ✅ 支持（自动探测协议，无流式） |
| 操作系统 | Windows 10/11 |
| Node.js | **安装不需要**（发布包依赖已内联） |

插件启动后会自动探测服务端接口版本并在「诊断」页显示。如果探测不准，可在配置面板「高级参数 → 服务端接口版本」手动指定 `v2` 或 `legacy`。

---

## 常见问题

**右下角没有 🔊 按钮？**
先按 `Ctrl + R` 刷新界面；仍无则完全重启 dsh。若一直没有，检查 `install.bat` 是否真的运行成功了。

**面板显示「无法连接 GPT-SoVITS 服务」？**
声音服务没在运行。检查启动窗口是否还开着（关掉就停），重新双击 `api.bat` 或 `scripts\start-sovits.bat`。刚启动时需等约 1 分钟加载模型。

**服务启动就闪退？**
多半是 GPT-SoVITS 的模型配置坏了。打开 `你的GPT-SoVITS目录\GPT_SoVITS\configs\tts_infer.yaml`，确认 `t2s_weights_path` 结尾是 `.ckpt` **文件名**而不是文件夹名。

**声音听起来很机械？**
说明已降级为浏览器语音。点 🔊 →「诊断」查看失败原因，修好后会自动切回。

**每次重启电脑都要手动开服务？**
按 `Win + R` 输入 `shell:startup`，把 `start-sovits.bat` 的快捷方式放进去，即可开机自启。

**本地 GPU 显存溢出？**
「高级参数 → 并发合成数」保持 1（默认）。只有远程 API 部署才建议调到 2-4。

---

## 卸载

把 dsh 配置目录里的备份改回原名：

```
%USERPROFILE%\.dsh\profiles\desktop\package.json.bak-sovits
    → 重命名为 package.json
```

然后重启 DeepSeek Harness。用 CLI 安装的可以执行：

```sh
dsh plugin --profile desktop remove dsh-sovits-widget
```

---

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 插件配置 | `%USERPROFILE%\.dsh\sovits\dsh-tts-config.json` |
| 配置备份 | 同目录 `dsh-tts-config.json.bak-*`（保留最近 5 份） |
| 音频缓存 | `%USERPROFILE%\.dsh\sovits\cache\` |
| 上传的参考音频 | `%USERPROFILE%\.dsh\sovits\audio\` |
| 诊断日志 | 插件「诊断」页可导出 |

---

## 开发者

```sh
pnpm install
pnpm test          # vitest 单测（72 个用例，无网络依赖）
pnpm typecheck     # tsc --noEmit
pnpm build         # esbuild → lib/index.js + assets/sovits-widget.js
node scripts/smoke.mjs   # 冒烟：模拟 Cordis 上下文加载构建产物
```

构建与分发：

```sh
node scripts/package.mjs D:\输出目录          # 安装包（运行时必需文件）
node scripts/package.mjs D:\输出目录 --dev    # 开发包（含源码与测试）
```

从源码安装（需先构建）：

```sh
pnpm install && pnpm build
dsh plugin --profile desktop add link:D:/dsh-sovits-widget
```

> 本仓库不提交构建产物。`git clone` 得到的目录缺少 `lib/` 与 `assets/`，必须先构建才能作为插件安装；普通用户请直接下载 Releases 里的包。

### 架构

- **宿主半面**（`src/host/`）：零 `@deepseek-ai` 运行时依赖，全部 duck-typed 访问（`ctx.webServer.register`、`ctx.systemPrompt.section`、`ctx.on('session/event')`、`webserver/index-inject`）。协议探测见 `provider/protocol.ts`。
- **客户端半面**（`src/client/`）：纯 IIFE（esbuild 全内联），经宿主路由 `/dsh-sovits/client.js` 下发。web 形态走 `tapIndex` 注入 `<script>`，Electron 桌面壳走 `webserver/index-inject` 结构化行。
- 发布包中 `lib/index.js` 为自包含构建（`zod`、`p-queue` 已内联），因此运行时无需 `node_modules`。

客户端改动后需 `pnpm build` 再刷新页面（宿主按 mtime 热读 client.js，无需重启 dsh）。

### HTTP 面（`/dsh-sovits/*`）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `client.js` | GET | 客户端 bundle（mtime 热读） |
| `config.json` | GET/PUT | 读/存配置（PUT 经 zod 校验，保存前自动备份） |
| `backups.json` / `rollback.json` | GET/POST | 备份列表 / 一键回滚 |
| `speak.json` / `stop.json` | POST | 触发合成 / 停止（barge-in） |
| `status.json?messageId=` | GET | 消息合成状态（分段就绪/进度/降级标记） |
| `audio.bin?token=` | GET | 取音频（WAV） |
| `messages.json?since=` | GET | 最近消息（客户端自动播报轮询） |
| `health.json` | GET | 健康状态与服务端协议探测结果 |
| `preview.json` | POST | 音色试听 |
| `upload-audio.json?filename=` | POST | 上传参考音频（ffmpeg 降噪 + 截取 3-10 秒） |
| `ref-audios.json?dir=` | GET | 参考音频目录列表 |
| `logs.json` / `export-logs.json` | GET/POST | 诊断日志读取 / 导出文件 |

非回环请求默认拒绝（除非宿主提供信任栅栏）。

### 目录结构

```
src/host/    宿主半面：config(zod)/config-store(备份回滚)/engine(管线)/
             provider/(sovits + protocol 协议探测)/task-queue/lru-cache/
             text-cleaner/text-segmenter/emotion/style-injector/
             sovits-process(进程池)/health/diagnostics/audio-tool(ffmpeg)/
             wav/routes/index
src/client/  客户端半面：player(Web Audio)/console-ui/config-panel/
             message-buttons/ui/api/index
tests/       vitest 单测（72 用例）
scripts/     install.bat(一键安装)/start-sovits.bat/build.mjs/package.mjs/
             smoke.mjs/release.mjs/e2e-probe.mjs
```

---

## 相关文档

- [新手安装指南.md](新手安装指南.md) — 面向普通用户的逐步操作说明
- [INSTALL.md](INSTALL.md) — 完整安装文档（含手动安装、服务配置、故障排查）
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献指南

## 许可

MIT，见 [LICENSE](LICENSE)。
