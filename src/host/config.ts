/**
 * 配置 Schema（zod 严格校验）。
 *
 * 全部配置持久化到 `<dataDir>/sovits/dsh-tts-config.json`，写入前自动备份
 * （`dsh-tts-config.json.bak-<timestamp>`，保留最近 N 份），任何字段填错
 * （如非法端口）都会在加载期抛出可读错误，绝不带病启动。
 */

import { z } from 'zod';

/** GPT-SoVITS v2+ 支持的语言集合（api_v2 的 tts_config.languages）。 */
export const SOVITS_LANGUAGES = [
  'auto',
  'auto_yue',
  'en',
  'zh',
  'ja',
  'yue',
  'ko',
  'all_zh',
  'all_ja',
  'all_yue',
  'all_ko',
] as const;

export const LanguageSchema = z.enum(SOVITS_LANGUAGES);

/** http(s) 地址：仅允许合法 URL，且显式端口必须落在 1..65535。 */
export const HttpBaseSchema = z
  .string()
  .min(1, 'TTS 服务地址不能为空')
  .regex(/^https?:\/\/[^\s/$.?#][^\s]*$/i, '必须是 http(s):// 开头的合法地址')
  .refine((value) => {
    let port: number | null = null;
    try {
      const u = new URL(value);
      port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
    } catch {
      return false;
    }
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }, '端口必须为 1..65535 之间的整数');

/** 一条“参考音频 + 提示词”音色定义。 */
export const VoiceParamsSchema = z.object({
  /** 参考音频路径（相对 GPT-SoVITS 工作目录或绝对路径）。 */
  refAudioPath: z.string().min(1, '参考音频路径不能为空'),
  /** 参考音频对应的提示文本（prompt_text）。 */
  promptText: z.string().default(''),
  /** 提示文本语言（prompt_lang）。 */
  promptLang: LanguageSchema.default('zh'),
  /** 可选：该音色专属 GPT 权重（不填则沿用服务器当前权重）。 */
  gptWeightsPath: z.string().optional(),
  /** 可选：该音色专属 SoVITS 权重。 */
  sovitsWeightsPath: z.string().optional(),
});
export type VoiceParams = z.infer<typeof VoiceParamsSchema>;

/** 合成参数（映射 api_v2 /tts 的请求字段）。 */
export const SynthParamsSchema = z.object({
  /** 待合成文本语言，"auto" 为中英日粤混合。 */
  textLang: LanguageSchema.default('auto'),
  topK: z.number().int().min(1).max(50).default(15),
  topP: z.number().min(0.05).max(1).default(1),
  temperature: z.number().min(0.05).max(2).default(1),
  /** 语速（speed_factor，1.0 为原速）。 */
  speedFactor: z.number().min(0.5).max(2).default(1),
  /** 服务端文本切分方法（cut0..cut5 等；服务端会校验）。 */
  textSplitMethod: z.string().default('cut5'),
  batchSize: z.number().int().min(1).max(16).default(1),
  /** 片段间隔（秒）。 */
  fragmentInterval: z.number().min(0).max(2).default(0.3),
  seed: z.number().int().min(-1).default(-1),
  /** false=整段返回；1/2/3=流式（质量/速度权衡），true 等价 1。 */
  streamingMode: z.union([z.boolean(), z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(false),
  mediaType: z.enum(['wav', 'raw', 'ogg', 'aac']).default('wav'),
  parallelInfer: z.boolean().default(true),
  repetitionPenalty: z.number().min(0.5).max(3).default(1.35),
  /** VITS V3 采样步数。 */
  sampleSteps: z.number().int().min(8).max(64).default(32),
  superSampling: z.boolean().default(false),
  overlapLength: z.number().int().min(0).max(8).default(2),
  minChunkLength: z.number().int().min(4).max(64).default(16),
});
export type SynthParams = z.infer<typeof SynthParamsSchema>;

/** 情感映射：开心/愤怒/悲伤 各自可覆盖参数与音色。 */
export const EmotionPatchSchema = z.object({
  /** 覆盖的合成参数（可只给部分字段）。 */
  params: SynthParamsSchema.partial().optional(),
  /** 覆盖的参考音频（为空则沿用角色主音色）。 */
  voice: VoiceParamsSchema.optional(),
});

export const EmotionMapSchema = z.object({
  happy: EmotionPatchSchema.optional(),
  angry: EmotionPatchSchema.optional(),
  sad: EmotionPatchSchema.optional(),
});
export type EmotionMap = z.infer<typeof EmotionMapSchema>;

/** 音色混合：ratioA 为音色 A 的权重（0..1），B 占 1-ratioA。 */
export const VoiceMixSchema = z.object({
  voiceB: VoiceParamsSchema,
  ratioA: z.number().min(0).max(1).default(0.7),
});
export type VoiceMix = z.infer<typeof VoiceMixSchema>;

/** 角色卡：Prompt 注入、音色、情感映射、音色混合。 */
export const RoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 注入 system prompt 的人设文本（为空则不注入）。 */
  persona: z.string().default(''),
  voice: VoiceParamsSchema,
  emotions: EmotionMapSchema.optional(),
  mix: VoiceMixSchema.optional(),
});
export type Role = z.infer<typeof RoleSchema>;

/** GPT-SoVITS 服务端配置。 */
export const SovitsServerSchema = z.object({
  /** API 基址，例如 http://127.0.0.1:9880。 */
  apiBase: HttpBaseSchema.default('http://127.0.0.1:9880'),
  /**
   * 自动拉起本地 api_v2.py（常驻子进程，健康失败自动重启）。
   * 远程部署请关闭。
   */
  autoStart: z.boolean().default(false),
  /** python 可执行文件（绝对路径或 PATH 名）。 */
  pythonExecutable: z.string().default('python'),
  /** api_v2.py 的绝对路径（autoStart 时必填）。 */
  apiScript: z.string().default(''),
  /** 子进程工作目录（GPT-SoVITS 安装根目录）。 */
  cwd: z.string().default(''),
  /** 额外命令行参数。 */
  extraArgs: z.array(z.string()).default([]),
  /**
   * 并发合成数：本地 GPU 模式强制 1（防显存溢出）；纯远程 API 可 2-4。
   */
  concurrency: z.number().int().min(1).max(8).default(1),
  /** 启动/切换权重等长操作超时（毫秒）。 */
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  /** 健康检查间隔（毫秒）。 */
  healthCheckIntervalMs: z.number().int().min(5000).max(600000).default(30000),
  /**
   * 服务端接口代际：
   * - auto：自动探测（默认，推荐）
   * - v2：新版 api_v2.py（/tts、ref_audio_path、speed_factor…）
   * - legacy：旧版 api.py（/、refer_wav_path、speed、cut_punc、inp_refs…）
   */
  flavor: z.enum(['auto', 'v2', 'legacy']).default('auto'),
});

export const ProviderSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gpt-sovits'),
    server: SovitsServerSchema.default({}),
    params: SynthParamsSchema.default({}),
  }),
  /** 浏览器内置 Web Speech API 兜底（由客户端执行）。 */
  z.object({ kind: z.literal('webspeech') }),
]);
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const RootConfigSchema = z.object({
  /** 配置格式版本。 */
  version: z.literal(1),
  /** 当前激活的角色 id（空=无角色注入）。 */
  activeRoleId: z.string().default(''),
  provider: ProviderSchema.default({ kind: 'gpt-sovits', server: {}, params: {} }),
  playback: z
    .object({
      /** 助手回复完成后自动播报（首次安装默认关，配置好角色后再开）。 */
      autoPlay: z.boolean().default(false),
      /** 音量 0..1。 */
      volume: z.number().min(0).max(1).default(1),
      /** 打断行为。 */
      bargeInOnUserMessage: z.boolean().default(true),
      bargeInOnEsc: z.boolean().default(true),
      bargeInOnStop: z.boolean().default(true),
      /** 打断淡出时长（毫秒）。 */
      fadeOutMs: z.number().int().min(0).max(1000).default(100),
    })
    .default({}),
  segments: z
    .object({
      /** 单段最大字符数（约 50）。 */
      maxChars: z.number().int().min(10).max(300).default(50),
    })
    .default({}),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      /** 磁盘占用上限（字节，默认 2GB）。 */
      maxBytes: z.number().int().min(16 * 1024 * 1024).max(64 * 1024 ** 3).default(2 * 1024 ** 3),
      /** 缓存目录（空=默认 <dataDir>/sovits/cache）。 */
      dir: z.string().default(''),
    })
    .default({}),
  fallback: z
    .object({
      /** 连续失败 N 次后降级到 Web Speech API。 */
      maxConsecutiveFailures: z.number().int().min(1).max(20).default(3),
      enabled: z.boolean().default(true),
      /** 连接级失败自动重试次数（跨过服务加载窗口）。 */
      retryCount: z.number().int().min(0).max(10).default(2),
      /** 重试间隔（毫秒）。 */
      retryDelayMs: z.number().int().min(1000).max(60000).default(8000),
    })
    .default({}),
  style: z
    .object({
      /** 注入模板：{role} 与 {persona} 占位符。 */
      injectionTemplate: z
        .string()
        .default('扮演【{role}】。{persona} 回复口语化、短句，不使用 Markdown 列表。'),
    })
    .default({}),
  audio: z
    .object({
      /** ffmpeg 可执行文件路径（空=自动探测）。 */
      ffmpegPath: z.string().default(''),
      /** GPT-SoVITS 参考音频目录（选参考音频用，可绝对或相对 sovits cwd）。 */
      refAudioDir: z.string().default('ref_audio'),
      /** 上传参考音频的存放目录（空=默认 <dataDir>/sovits/audio）。 */
      uploadDir: z.string().default(''),
      /** 参考音频截取上限（秒）。 */
      trimMaxSeconds: z.number().min(3).max(30).default(10),
      /** 参考音频建议最小时长（秒）。 */
      trimMinSeconds: z.number().min(1).max(10).default(3),
    })
    .default({}),
  diagnostics: z
    .object({
      enabled: z.boolean().default(true),
      /** 内存环形日志条数。 */
      ringSize: z.number().int().min(10).max(5000).default(500),
    })
    .default({}),
  roles: z.array(RoleSchema).default([]),
});
export type RootConfig = z.infer<typeof RootConfigSchema>;

export type TTSKind = ProviderConfig['kind'];

/** 解析用户输入，失败时抛出带路径说明的 Error（zod 错误会列出每个字段）。 */
export function parseConfig(input: unknown): RootConfig {
  return RootConfigSchema.parse(input);
}

/** 默认配置（首次运行生成）。 */
export function defaultConfig(): RootConfig {
  return RootConfigSchema.parse({ version: 1 });
}

/**
 * 解析合成参数：基础参数 <- 角色情感覆盖（同字段浅合并，voice 单独解析）。
 * @param base 全局基础参数
 * @param patch 情感覆盖（可空）
 */
export function resolveSynthParams(base: SynthParams, patch?: Partial<SynthParams>): SynthParams {
  if (!patch) return base;
  return { ...base, ...patch };
}
