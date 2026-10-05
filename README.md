# dsh-sovits-widget · GPT-SoVITS 语音播报引擎（dsh 适配插件）

为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/DeepSeek-Harness) 桌面/web 形态提供的 GPT-SoVITS 语音播报插件：助手回复自动（或手动）朗读，角色卡与音色强绑定，支持情感映射、音色混合、流式边合边播、打断淡出与 Web Speech 降级。

形态与 `dsh-whale-widget` 一致：一个 npm bundle 包（`dsh.bundle.patch` + 宿主 `lib/index.js` + 客户端 `assets/sovits-widget.js`），通过 `dsh plugin add` 或 profile 的 pnpm workspace 安装，web profile 与 desktop（Electron 外壳 + `dsh web` 子进程）共用。

## 功能总览

| 模块 | 说明 |
| --- | --- |
| StyleInjector（角色提示词注入） | 经 `ctx.systemPrompt.section`（order 131）按当前角色动态注入“扮演【角色名】…回复口语化、短句，不使用 Markdown 列表”；角色卡与音色/权重强绑定，切换角色即切换注入与音色 |
| TextCleaner / Segmenter | Markdown/Emoji/URL（→“链接”）/代码块（→“（省略代码）”）清洗；按 `。！？；…\n` 与最大字符数（默认 50）安全切分，软切分点（逗号/顿号）优先、不断开拉丁串 |
| TaskQueue（p-queue） | 并发可控：本地 GPU 建议 1（防显存溢出），远程 API 可 2-4；barge-in 时清空等待队列并中止在途 HTTP 请求 |
| LRU 磁盘缓存 | 键 = `sha256(roleId+text+ttsParams)`，默认上限 2GB，按 lastUsed 淘汰；重启后索引可恢复 |
| AudioPlayer（客户端） | Web Audio API 按段顺序调度（边合边播，首段就绪即出声）；打断时按配置淡出（默认 100ms）防爆音；`kind=webspeech` 段走浏览器语音 |
| 配置面板（客户端） | 基础设置（自动播报/音量/打断/淡出）、音色管理（角色卡、参考音频上传自动降噪+截取 3-10 秒、情感映射、音色混合 70/30 滑杆）、GPT-SoVITS 高级参数（top_k/top_p/temperature/text_lang=auto 等）、诊断（健康、日志、导出、备份回滚） |
| 消息级操作 | 每条助手回复下方注入 ▶播放 / ↻重新生成语音 / ⏹停止 小图标 |
| 悬浮控制台 | 播放时角落显示进度条、当前朗读文本高亮、暂停/停止、语速调节；Esc 打断 |
| 本地进程池 | autoStart 模式由插件拉起常驻 `api_v2.py` 子进程（绝不每次合成都 spawn），健康失败自动重启（10 分钟窗口限次） |
| 健康检查与降级 | 周期 Ping `/control`；连续失败 3 次自动降级 Web Speech，恢复后自动解除；启动时未启动则 Toast 提示 |
| 双代接口兼容 | 同时支持新版 `api_v2.py`（`/tts`、`ref_audio_path`、`speed_factor`）与旧版 `api.py`（`/`、`refer_wav_path`、`speed`、`cut_punc`、`inp_refs`），启动后自动探测协议，也可手动指定 |
| 配置回滚与 zod 校验 | 配置持久化到 `$DSH_HOME/sovits/dsh-tts-config.json`：写入前自动备份（保留 5 份）、原子写、损坏自动回滚；zod 严格校验（非法端口/URL 拒绝加载，绝不带病启动） |
| 诊断日志 | 环形缓冲记录 API 耗时/切分/报错/健康事件；“导出 TTS 诊断日志”按钮 |
| 开箱即装 | 发布包中的 `lib/index.js` 为自包含构建（`zod`、`p-queue` 已内联），解压改配置即可用，**无需 `node_modules` 与 `pnpm install`** |

## 安装

**普通用户（推荐，开箱即装）**：到 Releases 下载 `dsh-sovits-widget-<版本>-dist.zip`，解压到固定目录 → 在 profile 的 `package.json` 里加两行 → 重启 dsh。**不需要 Node 环境，也不需要 `pnpm install`**（插件依赖已内联）。逐步说明见 [INSTALL.md](INSTALL.md)。

```sh
# 本地开发安装：链接本项目（需先 pnpm build）
dsh plugin --profile desktop add link:D:/dsh-sovits-widget

# 或从 registry 安装（发布后）
dsh plugin --profile desktop add dsh-sovits-widget
```

`dsh plugin add` 会自动完成三件事：把包写入 profile 的 `package.json` 依赖、把包名追加进 `dsh.profile.bundles`、执行 `pnpm install`（hoisted workspace）。**重启 dsh 生效**。

手动等价操作（profile 目录 `%USERPROFILE%\.dsh\profiles\desktop` 或 `...\profiles\web`）：

1. `package.json` 的 `dependencies` 增加 `"dsh-sovits-widget": "link:D:/dsh-sovits-widget"`；
2. `package.json` 的 `dsh.profile.bundles` 追加 `"dsh-sovits-widget"`（改前备份为 `package.json.bak-*`）；
3. 完全重启 dsh。建议顺手执行一次 `pnpm install`（几秒）把 `link:` 解析成 `node_modules` 软链接；跳过也能正常加载。

> 注意：本仓库不提交构建产物。`git clone` 得到的源码目录缺少 `lib/` 与 `assets/`，必须先 `pnpm install && pnpm build` 才能作为插件安装。

### 回滚 / 卸载

```sh
dsh plugin --profile desktop remove dsh-sovits-widget   # 自动同步 bundles
```

插件更新或大改配置前，旧配置都会自动备份到 `$DSH_HOME/sovits/dsh-tts-config.json.bak-<时间戳>`（保留最近 5 份），可在插件“诊断”页一键回滚。

## 快速上手

1. 启动 GPT-SoVITS API（以 v2pro 整合包为例）：
   ```bat
   cd /d D:\1\GPT-SoVITS-v2pro-20250604
   python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
   ```
   或在插件“高级参数”里开启 **自动拉起本地 api_v2.py**（填 python 路径、api_v2.py 绝对路径、工作目录）。
2. 重启 dsh → 点右下角 🔊 打开设置 →「音色管理」新建角色：
   - 参考音频：从 GPT-SoVITS `ref_audio/` 列表选择，或“上传并处理”（自动降噪、截取 3-10 秒）；
   - 填写提示文本（参考音频对应的文字）与提示语言；
   - （可选）配置 GPT/SoVITS 权重路径、情感映射、音色混合；
3. 启用角色（“启用”按钮），打开“自动播报助手回复”；
4. 之后每条助手回复合成完成后自动朗读；消息下方按钮可随时重播/重生成/停止，Esc 打断。

## 开发

```sh
pnpm install
pnpm test          # vitest 单测（61 个用例，无网络依赖）
pnpm typecheck     # tsc --noEmit
pnpm build         # esbuild → lib/index.js + assets/sovits-widget.js
node scripts/smoke.mjs   # 冒烟：模拟 Cordis 上下文加载构建产物
```

- 宿主半面（`src/host/`）：零 `@deepseek-ai` 运行时依赖，全部 duck-typed（`ctx.webServer.register`、`ctx.systemPrompt.section`、`ctx.on('session/event')`、`webserver/index-inject`），运行时依赖仅 `zod`、`p-queue`（由 profile 的 hoisted workspace 提供）。
- 客户端半面（`src/client/`）：纯 IIFE（esbuild 全内联），经宿主路由 `/dsh-sovits/client.js` 下发；web 形态走 `tapIndex` 注入 `<script>`，Electron 桌面壳走 `webserver/index-inject` 结构化行（同 `dsh-whale-widget` 双通道）。
- 客户端改动后需 `pnpm build` 再硬刷新页面（宿主对 client.js 按 mtime 热读，无需重启 dsh）。

## HTTP 面（/dsh-sovits/*）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `client.js` | GET | 客户端 bundle（mtime 热读） |
| `config.json` | GET/PUT | 读/存配置（PUT 经 zod 校验，保存前自动备份） |
| `backups.json` / `rollback.json` | GET/POST | 备份列表 / 一键回滚 |
| `speak.json` / `stop.json` | POST | 触发合成 / 停止（barge-in） |
| `status.json?messageId=` | GET | 消息合成状态（分段就绪/进度/降级标记） |
| `audio.bin?token=` | GET | 取音频（WAV） |
| `messages.json?since=` | GET | 最近消息（客户端自动播报轮询） |
| `health.json` | GET | 健康状态（连续失败次数/降级/版本） |
| `preview.json` | POST | 音色试听 |
| `upload-audio.json?filename=` | POST | 上传参考音频（ffmpeg 降噪+截取 3-10 秒） |
| `ref-audios.json?dir=` | GET | 参考音频目录列表 |
| `logs.json` / `export-logs.json` | GET/POST | 诊断日志读取 / 导出文件 |

## 目录结构

```
src/host/    宿主半面（主进程）：config(zod)/config-store(备份回滚)/engine(管线)/
             provider/(sovits api_v2 + types)/task-queue/lru-cache/text-cleaner/
             text-segmenter/emotion/style-injector/sovits-process/health/diagnostics/
             audio-tool(ffmpeg)/wav/routes/index
src/client/  客户端半面（渲染进程）：player(Web Audio)/console-ui/config-panel/
             message-buttons/ui/api/index
tests/       vitest 单测（text/segment/wav/cache/config/store/queue/provider/engine/emotion/style）
scripts/     build.mjs（esbuild 双 bundle）/ smoke.mjs（模拟宿主冒烟）
```

## 常见问题

- **端口填错导致启动失败？** 配置经 zod 校验（端口 1-65535、URL 格式），非法值直接拒绝并提示，不影响 dsh 启动；主文件损坏会自动回滚到最近备份。
- **连续失败后没声音？** 连续 3 次失败自动降级 Web Speech（Toast 提示）；GPT-SoVITS 恢复后自动切回。
- **本地 GPU 并发导致显存溢出？** 本地部署并发请保持 1（默认值）；仅远程 API 模式才建议调到 2-4。
- **音色混合原理？** 并行合成 A、B 两路后按比例加权叠加（如 70% A + 30% B）；B 失败时自动退化为 A 独播。
- **流式模式？** 服务端 streaming_mode 1/2/3（质量↔速度权衡）；客户端始终“段就绪即播放”，首段延迟由合成耗时决定。
