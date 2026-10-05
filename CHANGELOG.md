# 更新日志

本文件记录本项目的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **旧版 `api.py` 接口兼容**：新增协议探测（`src/host/provider/protocol.ts`），自动识别服务端是
  新版 `api_v2.py`（`/tts`、`ref_audio_path`、`text_lang`、`speed_factor`、`text_split_method`、
  `aux_ref_audio_paths`、`/set_gpt_weights` + `/set_sovits_weights`、`/set_refer_audio`）
  还是旧版 `api.py`（`/`、`refer_wav_path`、`text_language`、`speed`、`cut_punc`、`inp_refs`、
  `/set_model`、`/change_refer`），并按代际映射请求字段与端点。
- 配置项 `provider.server.flavor`（`auto` / `v2` / `legacy`），可在配置面板「高级参数」选择，
  诊断页显示探测结果与依据。
- 旧版协议下流式请求自动退化为整段返回（旧版无按请求流式）。

### 变更

- **构建产物改为自包含**：`lib/index.js` 内联 `zod` 与 `p-queue`，安装包不再需要
  `node_modules` 或 `pnpm install`，解压改配置即可用（体积 169 KB → 103 KB 安装包）。
- 发布包精简为运行时必需文件（8 项），不含源码、测试与开发配置。

### 修复

- 健康检查在服务可用时顺带完成协议探测，避免并发重复探测。

## [0.1.0] - 2026-09-30

首个可用版本。

### 新增

- 宿主插件（`lib/index.js`）与浏览器插件（`assets/sovits-widget.js`）双半面 bundle 形态，`cordis.patch.yml` 声明挂载。
- GPT-SoVITS `api_v2.py` Provider：`/tts`、`/control`、`/set_gpt_weights`、`/set_sovits_weights`、`/set_refer_audio`，支持流式模式 0-3。
- 角色提示词注入（`ctx.systemPrompt.section`，order 131），按当前角色动态渲染，与音色强绑定。
- 文本清洗（Markdown / Emoji / URL / 代码块）与按标点、长度安全分段。
- 基于 p-queue 的并发合成队列；本地 GPU 默认并发 1，远程 API 可调 2-4。
- 磁盘 LRU 音频缓存，键为 `hash(roleId + text + ttsParams)`，默认上限 2GB。
- 客户端 Web Audio 分段顺序播放、暂停、停止，打断时 100ms 淡出。
- 消息级播放 / 重新生成 / 停止按钮；悬浮控制台（进度、当前文本、语速）；`Esc` 打断。
- 配置面板：基础设置、音色管理（角色卡、参考音频上传自动降噪与 3-10 秒截取、情感映射、音色混合）、GPT-SoVITS 高级参数、诊断。
- 常驻子进程托管（可选自动拉起 `api_v2.py`），健康巡检与失败自动重启；检测到已有服务时直接复用。
- 连续失败 3 次自动降级到浏览器 Web Speech API，恢复后自动切回。
- zod 严格配置校验、原子写、自动备份（保留 5 份）与损坏自动回滚；诊断日志环形缓冲与导出。
- `/dsh-sovits/*` HTTP 面，非回环请求默认拒绝。
- 分词、缓存、队列、Provider、引擎、情感、样式注入等 62 个单元测试。
