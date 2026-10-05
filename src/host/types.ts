/**
 * 插件共享类型（宿主与客户端通过 JSON 边界使用的可序列化类型）。
 */

/** JSON 可序列化值（配置/边界载荷）。 */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/** 一段待合成文本。 */
export interface Segment {
  /** 分段序号（消息内从 0 开始）。 */
  index: number;
  /** 清洗后的纯文本。 */
  text: string;
  /** 触发合成时命中的情感标签（happy/angry/sad/undefined）。 */
  emotion?: EmotionTag;
}

export type EmotionTag = 'happy' | 'angry' | 'sad';

/** 缓存键组成部分。 */
export interface TtsParams {
  roleId: string;
  textLang: string;
  topK: number;
  topP: number;
  temperature: number;
  speedFactor: number;
  textSplitMethod: string;
  refAudioPath: string;
  promptText: string;
  promptLang: string;
  gptWeightsPath?: string;
  sovitsWeightsPath?: string;
  auxRefAudioPaths?: string[];
  /** 音色混合：B 音色参考音频路径（与 mixRatioA 共同参与缓存键）。 */
  mixVoiceB?: string;
  mixRatioA?: number;
  mediaType: string;
  streamingMode: boolean | number;
}

/** 单次合成结果（宿主 -> 客户端）。 */
export interface SynthesizeResult {
  ok: boolean;
  /** 音频字节（mediaType=wav 时为完整 WAV；流式时宿主代理为完整 wav）。 */
  audio?: Uint8Array;
  /** 音频格式 mime。 */
  mime?: string;
  /** 采样率（宿主合成后统一 32000/22050 等，以解析为准）。 */
  sampleRate?: number;
  /** 失败时的可读错误。 */
  error?: string;
  /** 是否命中缓存。 */
  fromCache?: boolean;
  /** 合成耗时（毫秒）。 */
  elapsedMs?: number;
  /** 使用的音色（角色/情感解析后）。 */
  voice?: {
    refAudioPath: string;
    promptText: string;
    promptLang: string;
  };
}

/** 健康状态。 */
export interface HealthStatus {
  ok: boolean;
  /** 连续失败次数。 */
  consecutiveFailures: number;
  /** 已降级到 Web Speech。 */
  degraded: boolean;
  /** 最后一次 Ping 的可读结果。 */
  lastError?: string;
  /** 本地子进程是否存活（autoStart 模式）。 */
  processAlive?: boolean;
}

/** 诊断日志条目。 */
export interface DiagnosticsEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  /** 事件名（如 tts.synthesize、tts.segment、tts.health、tts.cache）。 */
  event: string;
  /** 结构化消息。 */
  message: string;
  /** 附加数据（JSON）。 */
  data?: Record<string, JSONValue>;
}
