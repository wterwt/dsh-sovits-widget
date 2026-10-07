# 安装文档 · dsh-sovits-widget

GPT-SoVITS 语音播报插件 for DeepSeek Harness（dsh）。装好后，助手回复会自动用你克隆的声音朗读。

---

## 一、前置要求

| 项目 | 要求 |
| --- | --- |
| DeepSeek Harness | 桌面版（Windows）已安装并至少成功启动过一次 |
| GPT-SoVITS | 一份可用的部署，须包含 `api_v2.py`（推荐 v2Pro / v2ProPlus 整合包） |
| 显卡 | 本地推理建议 NVIDIA GPU（CPU 也能跑，只是慢） |
| Node.js | 用**预编译分发包**（Release 附件）时不需要；从源码 clone 安装时需要 |
| 系统 | Windows 10/11 |

### 先获取安装包（二选一）

- **预编译分发包（推荐给普通用户）**：到仓库的 Releases 页面下载 `dsh-sovits-widget-<版本>-dist.zip`。已含构建产物，无需 Node。
- **源码（开发者）**：`git clone` 仓库，然后 `pnpm install && pnpm build`。

> 说明：本仓库不提交构建产物，直接克隆源码得到的目录**缺少 `lib/` 与 `assets/`**，必须先构建才能安装。

---

## 二、安装步骤（三选一）

### 方式 A：官方 CLI（推荐，最简单）

如果 `dsh` 命令可用：

```bat
:: 桌面版
dsh plugin --profile desktop add link:D:/dsh-sovits-widget

:: 纯 Web 版
dsh plugin --profile web add link:D:/dsh-sovits-widget
```

已发布到 npm 时：

```bat
dsh plugin --profile desktop add dsh-sovits-widget
```

CLI 会自动把包写进 profile 的依赖与 bundles 列表，并执行安装。完成后跳到第三节。

### 方式 B：手动安装（不需要 CLI，最通用）

**1. 解压**

把 `dsh-sovits-widget-<版本>-dist.zip` 解压到固定目录，例如：

```
D:\dsh-sovits-widget
```

不要放在临时目录或桌面，路径后续不要改。

解压后目录应包含（共 8 项）：

```
dsh-sovits-widget\
  assets\sovits-widget.js     浏览器端插件（必需）
  lib\index.js                宿主端插件（必需，依赖已内联）
  scripts\start-sovits.bat    GPT-SoVITS 常驻启动脚本（可选）
  cordis.patch.yml            挂载声明（必需）
  package.json                包声明（必需）
  INSTALL.md  README.md  LICENSE
```

> `lib/index.js` 是**自包含构建**：`zod`、`p-queue` 等依赖已打进文件内，
> 因此**不需要 `node_modules`，也不需要执行 `pnpm install`**。
> 解压 → 改配置 → 重启 dsh 即可。

**2. 找到 profile 目录**

| dsh 形态 | 路径 |
| --- | --- |
| 桌面版 | `%USERPROFILE%\.dsh\profiles\desktop` |
| Web 版 | `%USERPROFILE%\.dsh\profiles\web` |

**3. 备份并编辑 `package.json`**

先复制一份 `package.json.bak`，然后编辑 `package.json`，加两处：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-sovits-widget": "link:D:/dsh-sovits-widget"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-sovits-widget"
      ]
    }
  }
}
```

注意：`link:` 后面用**正斜杠** `/`，路径必须是第 1 步解压的绝对路径。

**4. 建议执行一次安装（几秒钟，可跳过但推荐）**

在 profile 目录打开终端执行（用 dsh 自带运行时）：

```bat
cd /d "%USERPROFILE%\.dsh\profiles\desktop"

"%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" ^
  "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install
```

这一步会把 `link:` 依赖解析成 profile 的 `node_modules` 软链接，让 dsh 能按包名
找到插件。插件的运行依赖已内联在 `lib/index.js` 中，所以**即使跳过此步，插件
功能也完整**；但如果 dsh 提示找不到包，执行一次即可解决。

若报 `ERR_PNPM_IGNORED_BUILDS`（提示 esbuild 等构建脚本被忽略），属于正常警告，
不影响使用。

**5. 完全重启 dsh**

托盘图标右键 → 退出，重新打开。

### 方式 C：从源码构建（开发者）

```bat
git clone <仓库地址>
cd dsh-sovits-widget
pnpm install
pnpm build          :: 生成 lib/index.js 与 assets/sovits-widget.js（必需）
pnpm test           :: 可选，跑单测（72 个用例）
pnpm typecheck      :: 可选，类型检查
```

构建成功后，本目录就是可安装的插件包，按方式 B 的步骤 2-5 安装。

需要分发给别人时：

```bat
node scripts/package.mjs D:\输出目录
```

会生成 `dsh-sovits-widget-<版本>-dist.zip`（含构建产物与全部文档）。

---

## 三、配置 GPT-SoVITS 服务

### 步骤 0：确认服务端版本（插件自动兼容两代接口）

插件同时支持 GPT-SoVITS 的两代 HTTP 接口，**默认自动探测**，无需手动选择：

| 项目 | 新版 `api_v2.py`（推荐） | 旧版 `api.py` |
| --- | --- | --- |
| 合成端点 | `POST /tts` | `POST /` |
| 参考音频字段 | `ref_audio_path` | `refer_wav_path` |
| 语言字段 | `text_lang` / `prompt_lang` | `text_language` / `prompt_language` |
| 语速 | `speed_factor` | `speed` |
| 文本切分 | `text_split_method` | `cut_punc` |
| 音色融合 | `aux_ref_audio_paths` | `inp_refs` |
| 切换权重 | `/set_gpt_weights` + `/set_sovits_weights` | `/set_model` |
| 换参考音频 | `/set_refer_audio` | `/change_refer` |
| 按请求流式 | 支持（streaming_mode 0-3） | 不支持，自动退化为整段返回 |

探测结果会显示在 🔊 →「诊断」页的协议一行。若自动探测不准，可在
`dsh-tts-config.json` 的 `provider.server.flavor` 显式指定 `"v2"` 或 `"legacy"`。

**建议**：优先使用 `api_v2.py`（功能更全、支持流式）。若你的部署只有旧版
`api.py`，插件一样能跑，只是没有流式。

### 步骤 1：确认 GPT-SoVITS 配置没坏

打开 `你的GPT-SoVITS目录\GPT_SoVITS\configs\tts_infer.yaml`，检查 `custom` 段的 `t2s_weights_path`：

```yaml
custom:
  t2s_weights_path: "GPT_weights_v2ProPlus/你的模型.ckpt"   # 必须是 .ckpt 文件
  vits_weights_path: "SoVITS_weights_v2ProPlus/你的模型.pth"
  device: cuda
  is_half: true
  version: v2ProPlus
```

**必须是文件路径，不能是目录。** 如果指向的是 `GPT_weights_v2ProPlus` 这样的目录，服务会启动即崩，报 `PermissionError`。开过 GPT-SoVITS 的 webui 界面换模型后容易出现这个问题，改回文件路径即可。

> 使用旧版 `api.py` 时，权重路径写在 `GPT_SoVITS/configs/tts_infer.yaml` 之外的
> `config.py`（`gpt_path` / `sovits_path`），或通过启动参数 `-g` / `-s` 指定。

### 步骤 2：启动服务

**手动启动**（推荐先这样验证）：

```bat
cd /d 你的GPT-SoVITS目录
runtime\python.exe api_v2.py -a 0.0.0.0 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml
```

保持窗口开着。看到 `Uvicorn running on http://0.0.0.0:9880` 就绪。

**让插件自动拉起**：在插件设置「高级参数」里开启「自动拉起本地 api_v2.py」，填写 python 可执行文件、`api_v2.py` 绝对路径、工作目录。

**常驻运行**（推荐，避免每次重启 dsh 都等模型加载）：把 `scripts/start-sovits.bat` 放进开机启动文件夹：

```
Win+R → 输入 shell:startup → 回车 → 把 start-sovits.bat 快捷方式拖进去
```

模型加载约 **1 分钟**（155MB 权重上显存），属正常。插件检测到服务已在运行会直接复用，不会重复启动。

---

## 四、配置插件音色

先说清楚声音的来源：插件用 GPT-SoVITS 把你提供的**参考音频**（一段几秒的真人录音）克隆成音色，再用它朗读 AI 回复。**参考音频决定说话的声音**。

1. 重启 dsh 后，界面**右下角出现 🔊 按钮**，点击打开设置面板。
2. 切到「音色管理」→ 点「＋ 新建角色」：
   - **参考音频**：从列表选择 GPT-SoVITS `ref_audio/` 里的音频，或点「上传并处理」（自动降噪、截取 3-10 秒最佳片段）；
   - **人设**：填角色性格描述，会注入 system prompt 影响回复风格；
   - **提示文本**：参考音频对应的文字（如参考音频自带文本可留空）；
   - 可选：情感映射（开心/愤怒/悲伤 各自换音色）、音色混合（70% A + 30% B）。
3. 点角色卡上的「**试听**」按钮，先确认声音对不对。
4. 满意后点该角色的「**启用**」按钮。
5. 切到「基础设置」，打开 **自动播报助手回复**。

完成。之后每条助手回复结束会自动朗读。

---

## 五、日常使用

| 操作 | 方式 |
| --- | --- |
| 播放/重播某条回复 | 回复下方的 ▶ 按钮 |
| 重新生成语音 | 回复下方的 ↻ 按钮 |
| 停止播报 | ⏹ 按钮，或按 `Esc` |
| 调音量/语速 | 播放时弹出的悬浮控制台 |
| 试听某个音色 | 🔊 → 音色管理 → 点角色卡的「试听」按钮 |
| 全局开关 | 右下角 🔊 → 基础设置 |

---

## 六、故障排查

### 面板显示「无法连接 GPT-SoVITS 服务」

1. 确认服务在运行：浏览器打开 `http://127.0.0.1:9880/control?command=ping`，能看到响应即正常；
2. 若刚启动 dsh，模型可能还在加载，等 1 分钟，状态会自己转正常；
3. 确认端口没被占用：`netstat -ano | findstr :9880`。

### 服务启动即崩，日志报 `PermissionError`

`tts_infer.yaml` 的权重路径写成了目录。按第三节步骤 1 改回 `.ckpt` 文件。

### 有合成但没声音

1. 检查 Windows 音量混合器里 dsh 是否被静音；
2. 按 `Esc` 后重发消息重试；
3. 点右下角 🔊 →「诊断」查看日志，若有「合成成功」但无声音，属于浏览器音频权限问题，刷新窗口（Ctrl+R）。

### 右下角没有 🔊 按钮

刷新窗口（Ctrl+R）；仍无则完全重启 dsh。若一直没有：

1. 检查 profile 的 `package.json` 里 `dsh.profile.bundles` 是否包含 `dsh-sovits-widget`；
2. 检查是否跳过了手动安装的第 4 步。若 profile 的 `node_modules` 里没有 `zod`
   或 `p-queue`，插件会在加载时失败，界面上不会有任何提示，只是什么都没出现。
   打开 dsh 的日志（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\`）能看到类似
   `Cannot find package 'zod'` 的报错。补跑一次 `pnpm install` 即可。

### 声音是机械的浏览器语音

说明已降级到 Web Speech API（连续失败 3 次触发）。查看「诊断」页的失败原因，修好后会自动切回。

---

## 七、卸载 / 回滚

**卸载插件**：

```bat
dsh plugin --profile desktop remove dsh-sovits-widget
```

手动安装的：删掉 `package.json` 里的依赖与 bundles 条目，恢复备份，重新 `pnpm install`，重启 dsh。

**回滚配置**：插件每次保存配置都会自动备份（保留最近 5 份）。打开 🔊 →「诊断」→ 点备份文件即可一键回滚。

---

## 八、数据位置

| 内容 | 路径 |
| --- | --- |
| 插件配置 | `%USERPROFILE%\.dsh\sovits\dsh-tts-config.json` |
| 配置备份 | 同目录 `dsh-tts-config.json.bak-*` |
| 音频缓存 | `%USERPROFILE%\.dsh\sovits\cache\` |
| 上传的参考音频 | `%USERPROFILE%\.dsh\sovits\audio\` |
| 诊断日志导出 | `%USERPROFILE%\.dsh\sovits\diagnostics\` |

---

## 九、需要帮助时

反馈问题时请附上：

1. 「诊断」页的日志（或导出的诊断文件）；
2. GPT-SoVITS 服务窗口的输出；
3. dsh 版本、GPT-SoVITS 版本、操作系统。
