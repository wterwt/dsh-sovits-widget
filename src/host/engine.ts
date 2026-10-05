/**
 * TTS 引擎（宿主侧管线中枢）：
 * 清洗 → 情感检测 → 角色/音色解析 → 分段 → 队列(并发/缓存) → 合成/混合
 * → 音频仓库 → 状态发布（客户端轮询 status.json + audio.bin）。
 *
 * 降级：GPT-SoVITS 连续失败 N 次后，未合成段改由客户端 Web Speech 朗读
 * （宿主只发布文本段），保证对话始终有声。
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RootConfig, SynthParams, VoiceParams, Role } from './config.js';
import type { Diagnostics } from './diagnostics.js';
import { detectEmotion } from './emotion.js';
import { HealthMonitor } from './health.js';
import { LruAudioCache, cacheKey } from './lru-cache.js';
import { SovitsProvider, synthesizeVoiceMix } from './provider/sovits.js';
import type { TTSProvider } from './provider/types.js';
import { SovitsProcessPool } from './sovits-process.js';
import { resolveVoiceForEmotion } from './style-injector.js';
import { TaskQueue } from './task-queue.js';
import { cleanText } from './text-cleaner.js';
import { segmentText } from './text-segmenter.js';
import type { DiagnosticsEntry, EmotionTag, Segment, SynthesizeResult, TtsParams } from './types.js';
import { parseWav } from './wav.js';

/** 客户端可见的“已就绪分段”。 */
export interface ReadySegment {
  index: number;
  /** 音频取件 token（kind='audio' 时）。 */
  token: string;
  text: string;
  kind: 'audio' | 'webspeech';
  mime?: string;
  sampleRate?: number;
  /** 估算时长（毫秒）。 */
  durationMs?: number;
  emotion?: EmotionTag;
  fromCache?: boolean;
  /** 合成失败时的可读错误（客户端可显示/跳过）。 */
  error?: string;
}

/** 消息合成状态（status.json 的载荷）。 */
export interface MessageStatus {
  messageId: string;
  /** 总段数。 */
  total: number;
  ready: ReadySegment[];
  done: boolean;
  /** 整条消息级错误（如角色缺失）。 */
  error?: string;
  /** 当前是否处于 Web Speech 降级。 */
  degraded: boolean;
  /** 当前激活角色 id。 */
  activeRoleId: string;
}

interface MessageState {
  messageId: string;
  total: number;
  ready: ReadySegment[];
  done: boolean;
  error?: string;
  rawText: string;
}

export interface EngineOptions {
  dataDir: string;
  diagnostics: Diagnostics;
  initialConfig: RootConfig;
  fetchImpl?: typeof fetch;
}

const MAX_RETAINED_MESSAGES = 20;
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;

export class TtsEngine {
  readonly diagnostics: Diagnostics;
  private readonly dataDir: string;
  private config: RootConfig;
  private provider: TTSProvider;
  private readonly fetchImpl?: typeof fetch;
  private queue: TaskQueue;
  private cache: LruAudioCache | null = null;
  private health: HealthMonitor;
  private readonly messages = new Map<string, MessageState>();
  private readonly messageOrder: string[] = [];
  private readonly messageAborts = new Map<string, AbortController>();
  /** 每条消息未结算的任务数。 */
  private readonly remaining = new Map<string, number>();
  private readonly audioStore = new Map<
    string,
    { audio: Uint8Array; mime: string; sampleRate: number; messageId: string; text: string }
  >();
  private audioBytes = 0;
  /** 服务端当前已切换的权重（避免重复切换）。 */
  private currentWeights: { gpt?: string; sovits?: string } = {};
  /** autoStart 模式的常驻子进程（本地进程池）。 */
  private pool: SovitsProcessPool | null = null;
  private superviseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EngineOptions) {
    this.diagnostics = options.diagnostics;
    this.dataDir = options.dataDir;
    this.config = options.initialConfig;
    this.fetchImpl = options.fetchImpl;
    this.provider = this.buildProvider();
    this.cache = this.buildCache();
    this.queue = this.buildQueue();
    this.pool = this.buildPool();
    this.health = this.buildHealth();
  }

  /** 应用新配置（配置面板保存后调用）。 */
  applyConfig(next: RootConfig): void {
    const prev = this.config;
    this.config = next;
    this.provider = this.buildProvider();
    this.cache = this.buildCache();
    // 仅当进程池相关配置变化时才重建池（避免普通配置保存误杀正在运行的服务）
    const poolConfigChanged = this.poolFingerprint(prev) !== this.poolFingerprint(next);
    if (poolConfigChanged) {
      this.pool?.stop();
      this.pool = this.buildPool();
      if (this.superviseTimer) {
        clearInterval(this.superviseTimer);
        this.superviseTimer = null;
      }
    }
    this.health.stop();
    this.health = this.buildHealth();
    this.health.start(); // 重建后必须重启周期检查，否则健康状态冻结
    this.queue.setConcurrency(this.effectiveConcurrency());
    if (this.provider.kind === 'gpt-sovits' && this.config.provider.kind === 'gpt-sovits') {
      this.currentWeights = {}; // 服务端可能已重启，重置权重记忆
    }
    this.diagnostics.info('tts.config', '配置已更新');
    if (poolConfigChanged) void this.ensurePool();
  }

  /** 进程池相关配置指纹（判断是否需要重建池）。 */
  private poolFingerprint(config: RootConfig): string {
    if (config.provider.kind !== 'gpt-sovits') return 'webspeech';
    const s = config.provider.server;
    return JSON.stringify([s.autoStart, s.apiBase, s.pythonExecutable, s.apiScript, s.cwd, s.extraArgs]);
  }

  get activeConfig(): RootConfig {
    return this.config;
  }

  get healthStatus() {
    return this.health.current;
  }

  /** 当前服务端接口代际与探测依据（诊断展示）。 */
  get protocolInfo(): { flavor: string; reason: string } {
    const provider = this.provider;
    if (provider instanceof SovitsProvider) {
      return { flavor: provider.protocolFlavor, reason: provider.protocolReason };
    }
    return { flavor: 'n/a', reason: '当前 provider 非 GPT-SoVITS' };
  }

  /** 启动周期健康检查与本地子进程托管。 */
  start(): void {
    this.health.start();
    void this.ensurePool();
  }

  /** 确保本地进程池：已有可用服务则复用，否则拉起并周期巡检。 */
  private async ensurePool(): Promise<void> {
    const pool = this.pool;
    if (!pool?.managed) return;
    if (!this.superviseTimer) {
      this.superviseTimer = setInterval(() => void this.pool?.supervise(), this.poolSuperviseMs());
      this.superviseTimer.unref?.();
    }
    const existing = await this.provider.healthCheck();
    if (existing.ok) {
      this.diagnostics.info('tts.process', '检测到已在运行的 GPT-SoVITS 服务，复用（不重复拉起）');
      return;
    }
    pool.start();
  }

  /**
   * 为一条助手回复启动合成（自动播报入口；消息级“重新生成”也可复用）。
   * 已存在同 id 的合成会先被停止。
   */
  speakMessage(messageId: string, rawText: string): void {
    this.stopMessage(messageId);
    const cleaned = cleanText(rawText);
    const state: MessageState = {
      messageId,
      total: 0,
      ready: [],
      done: false,
      rawText,
    };
    this.messages.set(messageId, state);
    this.messageOrder.push(messageId);

    const role = this.activeRole();
    const emotion = detectEmotion(cleaned);

    if (cleaned.trim().length === 0) {
      state.done = true;
      this.diagnostics.info('tts.speak', '清洗后文本为空，跳过合成', { messageId });
      return;
    }
    if (!role) {
      // 无角色：无法确定参考音频，整条交给 Web Speech 朗读
      state.total = 1;
      state.error = '未配置或未选择角色，使用浏览器语音朗读';
      state.ready.push({ index: 0, token: '', text: cleaned, kind: 'webspeech', emotion });
      state.done = true;
      this.diagnostics.warn('tts.speak', '无激活角色，降级 Web Speech', { messageId });
      return;
    }

    const segments = segmentText(cleaned, this.config.segments.maxChars, emotion);
    state.total = segments.length;
    this.diagnostics.info('tts.segment', `切分为 ${segments.length} 段`, {
      messageId,
      emotion: emotion ?? 'none',
      roleId: role.id,
    });

    const controller = new AbortController();
    this.messageAborts.set(messageId, controller);
    this.remaining.set(messageId, segments.length);

    for (const segment of segments) {
      const taskId = `${messageId}#${segment.index}`;
      void this.queue
        .enqueue({
          id: taskId,
          messageId,
          segment,
          params: this.buildTtsParams(role, segment.emotion),
          signal: controller.signal,
        })
        .then(() => this.settle(messageId, state));
    }
    if (segments.length === 0) {
      state.done = true;
    }
  }

  /** Barge-in：停止一条消息的合成（等待段丢弃、在途请求取消）。 */
  stopMessage(messageId: string): void {
    this.messageAborts.get(messageId)?.abort();
    this.messageAborts.delete(messageId);
    const state = this.messages.get(messageId);
    if (state && !state.done) {
      state.done = true;
      state.error = '已停止';
      this.diagnostics.info('tts.stop', '消息合成被停止（barge-in）', { messageId });
    }
  }

  /** 停止全部合成（Esc/停止按钮）。 */
  stopAll(): void {
    for (const controller of this.messageAborts.values()) controller.abort();
    this.messageAborts.clear();
    for (const state of this.messages.values()) {
      if (!state.done) {
        state.done = true;
        state.error = '已停止';
      }
    }
    this.queue.clear();
    this.diagnostics.info('tts.stop', '全部合成已停止');
  }

  /** 客户端轮询入口。 */
  getStatus(messageId: string): MessageStatus | null {
    const state = this.messages.get(messageId);
    if (!state) return null;
    return {
      messageId: state.messageId,
      total: state.total,
      ready: [...state.ready],
      done: state.done,
      error: state.error,
      degraded: this.health.current.degraded,
      activeRoleId: this.config.activeRoleId,
    };
  }

  /** 最近消息 id 列表（时间正序，客户端自动播报轮询用）。 */
  messageIds(): string[] {
    return [...this.messageOrder];
  }

  /** 取音频。 */
  getAudio(token: string): { audio: Uint8Array; mime: string } | null {
    const entry = this.audioStore.get(token);
    if (!entry) return null;
    return { audio: entry.audio, mime: entry.mime };
  }

  /** 试听：合成一段文本（配置面板音色预览）。 */
  async preview(text: string, roleId?: string): Promise<{ token: string; ok: boolean; error?: string }> {
    const role = this.roles().find((r) => r.id === (roleId ?? this.config.activeRoleId));
    if (!role) return { token: '', ok: false, error: '未找到角色' };
    const cleaned = cleanText(text);
    const segments = segmentText(cleaned, this.config.segments.maxChars);
    if (segments.length === 0) return { token: '', ok: false, error: '文本为空' };
    const segment = segments[0] as Segment;
    const params = this.buildTtsParams(role, undefined);
    const result = await this.synthesizeSegment('preview', role, segment, params, new AbortController().signal);
    if (!result.ok || !result.audio) return { token: '', ok: false, error: result.error };
    const token = this.storeAudio(
      'preview',
      result.audio,
      result.mime ?? 'audio/wav',
      result.sampleRate ?? 32000,
      segment.text,
    );
    return { token, ok: true };
  }

  /** 导出诊断日志，返回文件路径。 */
  exportDiagnostics(): string {
    const dir = join(this.dataDir, 'diagnostics');
    return this.diagnostics.exportToFile(dir);
  }

  /** 近 N 条诊断（诊断面板展示）。 */
  diagnosticsEntries(limit = 100): DiagnosticsEntry[] {
    const all = this.diagnostics.entries();
    return all.slice(-limit);
  }

  /** 释放资源。 */
  async dispose(): Promise<void> {
    this.stopAll();
    this.health.stop();
    if (this.superviseTimer) {
      clearInterval(this.superviseTimer);
      this.superviseTimer = null;
    }
    this.pool?.stop();
    await this.provider.dispose();
  }

  // ---------- 内部 ----------

  private buildProvider(): TTSProvider {
    if (this.config.provider.kind === 'gpt-sovits') {
      const { server } = this.config.provider;
      return new SovitsProvider({
        apiBase: server.apiBase,
        timeoutMs: server.timeoutMs,
        flavor: server.flavor,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
    }
    return {
      kind: 'webspeech',
      healthCheck: async () => ({ ok: true, consecutiveFailures: 0, degraded: false }),
      synthesize: async () => ({ ok: false, error: 'webspeech provider 不支持宿主侧合成' }),
      dispose: async () => {},
    };
  }

  private buildCache(): LruAudioCache | null {
    if (!this.config.cache.enabled) return null;
    const dir = this.config.cache.dir || join(this.dataDir, 'sovits', 'cache');
    return new LruAudioCache(dir, this.config.cache.maxBytes);
  }

  private effectiveConcurrency(): number {
    if (this.config.provider.kind !== 'gpt-sovits') return 1;
    return this.config.provider.server.concurrency;
  }

  private buildQueue(): TaskQueue {
    return new TaskQueue(
      async (task) => {
        const state = this.messages.get(task.messageId);
        if (!state || state.done || task.signal.aborted) return; // 已被停止
        const role = this.activeRole();
        if (!role) {
          this.publishWebSpeech(state, task.segment);
          return;
        }
        // 合成 + 连接级失败自动重试（跨过服务启动/重启的加载窗口）
        let result = await this.synthesizeSegment(task.messageId, role, task.segment, task.params, task.signal);
        let attempts = 1;
        const maxAttempts = 1 + this.config.fallback.retryCount;
        while (
          !result.ok &&
          attempts < maxAttempts &&
          !task.signal.aborted &&
          this.isConnectionFailure(result.error)
        ) {
          await this.sleep(this.config.fallback.retryDelayMs, task.signal);
          if (task.signal.aborted || state.done) return;
          attempts += 1;
          this.diagnostics.info('tts.retry', `合成重试（第 ${attempts}/${maxAttempts} 次）`, {
            messageId: task.messageId,
            index: task.segment.index,
          });
          result = await this.synthesizeSegment(task.messageId, role, task.segment, task.params, task.signal);
        }
        if (task.signal.aborted || state.done) return;
        if (result.ok && result.audio) {
          const sampleRate = result.sampleRate ?? 32000;
          const token = this.storeAudio(
            task.messageId,
            result.audio,
            result.mime ?? 'audio/wav',
            sampleRate,
            task.segment.text,
          );
          state.ready.push({
            index: task.segment.index,
            token,
            text: task.segment.text,
            kind: 'audio',
            mime: result.mime,
            sampleRate,
            durationMs: this.durationOf(result.audio, sampleRate),
            emotion: task.segment.emotion,
            fromCache: result.fromCache,
          });
          this.health.noteSuccess();
        } else {
          // 重试耗尽：计入连续失败（触发降级阈值）
          this.health.noteFailure(result.error ?? '合成失败');
          if (this.health.current.degraded && this.config.fallback.enabled) {
            this.publishWebSpeech(state, task.segment);
          } else {
            state.ready.push({
              index: task.segment.index,
              token: '',
              text: task.segment.text,
              kind: 'audio',
              error: result.error ?? '合成失败',
              emotion: task.segment.emotion,
            });
          }
        }
      },
      this.effectiveConcurrency(),
      {
        onTaskStart: (task) =>
          this.diagnostics.info('tts.queue', `任务开始: ${task.id}`, { text: task.segment.text }),
      },
    );
  }

  /** 连接级失败（服务未就绪/超时/取消/5xx），值得重试。 */
  private isConnectionFailure(error: string | undefined): boolean {
    if (!error) return false;
    return error.includes('无法连接') || error.includes('取消') || error.includes('超时') || /HTTP 5\d\d/.test(error);
  }

  /** 可中止的延时。 */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private buildHealth(): HealthMonitor {
    // 池感知健康检查：autoStart 模式下子进程仍在加载模型时不记为失败
    const wrapped: TTSProvider = {
      ...this.provider,
      healthCheck: async (signal) => {
        const result = await this.provider.healthCheck(signal);
        if (result.ok) return result;
        const pool = this.pool;
        if (pool?.managed && pool.alive && pool.startedAt > 0 && Date.now() - pool.startedAt < pool.startupGraceMs) {
          return {
            ok: true,
            consecutiveFailures: 0,
            degraded: false,
            lastError: 'GPT-SoVITS 正在加载模型…',
            processAlive: true,
          };
        }
        return result;
      },
    };
    return new HealthMonitor(wrapped, {
      maxConsecutiveFailures: this.config.fallback.maxConsecutiveFailures,
      intervalMs:
        this.config.provider.kind === 'gpt-sovits'
          ? this.config.provider.server.healthCheckIntervalMs
          : 60000,
      onChange: (status) => {
        this.diagnostics.log(
          status.ok ? 'info' : 'warn',
          'tts.health',
          status.ok
            ? 'TTS 服务健康'
            : status.degraded
              ? `TTS 连续失败 ${status.consecutiveFailures} 次，降级到 Web Speech`
              : `TTS 服务异常（第 ${status.consecutiveFailures} 次）: ${status.lastError ?? ''}`,
        );
      },
    });
  }

  private activeRole(): Role | null {
    if (!this.config.activeRoleId) return null;
    return this.roles().find((r) => r.id === this.config.activeRoleId) ?? null;
  }

  /** 构建本地进程池（仅 autoStart 且配置了 apiScript 时）。 */
  private buildPool(): SovitsProcessPool | null {
    if (this.config.provider.kind !== 'gpt-sovits') return null;
    const { server } = this.config.provider;
    if (!server.autoStart || server.apiScript.length === 0) return null;
    return new SovitsProcessPool({
      apiBase: server.apiBase,
      pythonExecutable: server.pythonExecutable,
      apiScript: server.apiScript,
      cwd: server.cwd,
      extraArgs: server.extraArgs,
      startupTimeoutMs: server.timeoutMs,
      maxRestarts: 5,
      ping: async () => (await this.provider.healthCheck()).ok,
      diagnostics: this.diagnostics,
    });
  }

  private poolSuperviseMs(): number {
    if (this.config.provider.kind !== 'gpt-sovits') return 30000;
    return this.config.provider.server.healthCheckIntervalMs;
  }

  private roles(): Role[] {
    return this.config.roles;
  }

  /** 段级合成（含音色混合与缓存）。 */
  private async synthesizeSegment(
    messageId: string,
    role: Role,
    segment: Segment,
    params: TtsParams,
    signal: AbortSignal,
  ): Promise<SynthesizeResult> {
    if (this.config.provider.kind !== 'gpt-sovits') {
      return { ok: false, error: '当前 provider 不支持宿主合成' };
    }
    const provider = this.provider as SovitsProvider;
    const mix = role.mix;
    const useMix = mix !== undefined && mix.ratioA > 0 && mix.ratioA < 1;

    const started = Date.now();
    // 权重切换（角色级，记忆避免重复切换）
    await this.ensureWeights(role, signal);

    const keyParams: TtsParams = useMix
      ? {
          ...params,
          mixRatioA: mix?.ratioA,
          mixVoiceB: mix?.voiceB.refAudioPath,
          auxRefAudioPaths: undefined,
        }
      : { ...params, mixRatioA: undefined, mixVoiceB: undefined, auxRefAudioPaths: undefined };

    const key = cacheKey(role.id, segment.text, keyParams);

    // 缓存命中
    if (this.cache) {
      const hit = this.cache.get(key);
      if (hit) {
        this.diagnostics.info('tts.cache', '缓存命中', { messageId, index: segment.index });
        return {
          ok: true,
          audio: new Uint8Array(hit.audio),
          mime: hit.mime,
          sampleRate: hit.sampleRate,
          fromCache: true,
          elapsedMs: Date.now() - started,
        };
      }
    }

    const baseReq = { text: segment.text, params, signal };
    let result: SynthesizeResult;
    if (useMix && mix) {
      result = await synthesizeVoiceMix(provider, baseReq, mix.voiceB, {}, mix.ratioA, signal);
    } else {
      result = await provider.synthesize(baseReq);
    }

    if (!result.ok) {
      // 失败计数由队列 worker 在重试耗尽后统一处理，避免重试期间误触发降级
      this.diagnostics.error('tts.synthesize', `合成失败: ${result.error}`, {
        messageId,
        index: segment.index,
        text: segment.text,
      });
      return result;
    }

    this.diagnostics.info('tts.synthesize', `合成成功（${result.elapsedMs ?? 0}ms）`, {
      messageId,
      index: segment.index,
      bytes: result.audio?.byteLength ?? 0,
      fromCache: false,
    });

    if (result.audio && this.cache) {
      this.cache.put(key, Buffer.from(result.audio), result.mime ?? 'audio/wav', result.sampleRate ?? 32000);
    }
    return result;
  }

  /** 角色切换时同步服务端权重（记忆避免重复切换）。 */
  private async ensureWeights(role: Role, signal: AbortSignal): Promise<void> {
    if (this.config.provider.kind !== 'gpt-sovits') return;
    const provider = this.provider as SovitsProvider;
    const voice = role.voice;
    if (voice.gptWeightsPath && voice.gptWeightsPath !== this.currentWeights.gpt) {
      await provider.setGptWeights(voice.gptWeightsPath, signal);
      this.currentWeights.gpt = voice.gptWeightsPath;
      this.diagnostics.info('tts.weights', `切换 GPT 权重: ${voice.gptWeightsPath}`);
    }
    if (voice.sovitsWeightsPath && voice.sovitsWeightsPath !== this.currentWeights.sovits) {
      await provider.setSovitsWeights(voice.sovitsWeightsPath, signal);
      this.currentWeights.sovits = voice.sovitsWeightsPath;
      this.diagnostics.info('tts.weights', `切换 SoVITS 权重: ${voice.sovitsWeightsPath}`);
    }
  }

  private publishWebSpeech(state: MessageState, segment: Segment): void {
    state.ready.push({
      index: segment.index,
      token: '',
      text: segment.text,
      kind: 'webspeech',
      emotion: segment.emotion,
    });
  }

  private buildTtsParams(role: Role, emotion?: EmotionTag): TtsParams {
    const { voice, params: patch } = resolveVoiceForEmotion(role, emotion);
    const synth: SynthParams =
      this.config.provider.kind === 'gpt-sovits'
        ? { ...this.config.provider.params, ...patch }
        : defaultSynthParams();
    return {
      roleId: role.id,
      textLang: synth.textLang,
      topK: synth.topK,
      topP: synth.topP,
      temperature: synth.temperature,
      speedFactor: synth.speedFactor,
      textSplitMethod: synth.textSplitMethod,
      refAudioPath: voice.refAudioPath,
      promptText: voice.promptText,
      promptLang: voice.promptLang,
      ...(voice.gptWeightsPath ? { gptWeightsPath: voice.gptWeightsPath } : {}),
      ...(voice.sovitsWeightsPath ? { sovitsWeightsPath: voice.sovitsWeightsPath } : {}),
      mediaType: synth.mediaType,
      streamingMode: synth.streamingMode,
    };
  }

  private storeAudio(
    messageId: string,
    audio: Uint8Array,
    mime: string,
    sampleRate: number,
    text: string,
  ): string {
    const token = randomUUID();
    this.audioStore.set(token, { audio, mime, sampleRate, messageId, text });
    this.audioBytes += audio.byteLength;
    this.pruneAudio(messageId);
    return token;
  }

  private durationOf(audio: Uint8Array, fallbackRate: number): number {
    try {
      const { sampleRate, pcm16 } = parseWav(audio);
      return Math.round((pcm16.length / sampleRate) * 1000);
    } catch {
      return Math.round((audio.byteLength / 2 / fallbackRate) * 1000);
    }
  }

  /** 单任务结算：剩余计数归零且全部出段时收尾。 */
  private settle(messageId: string, state: MessageState): void {
    const left = (this.remaining.get(messageId) ?? 1) - 1;
    if (left <= 0) this.remaining.delete(messageId);
    else this.remaining.set(messageId, left);
    if (state.done) return;
    if (left <= 0 && state.ready.length >= state.total) {
      state.done = true;
      this.diagnostics.info('tts.done', '消息合成完成', {
        messageId: state.messageId,
        segments: state.ready.length,
      });
    }
  }

  /** 保留最近 N 条消息的音频；超量淘汰最旧消息。 */
  private pruneAudio(currentMessageId: string): void {
    while (this.messageOrder.length > MAX_RETAINED_MESSAGES) {
      const oldest = this.messageOrder.shift();
      if (!oldest || oldest === currentMessageId) continue;
      this.dropMessageAudio(oldest);
    }
    while (this.audioBytes > MAX_AUDIO_BYTES) {
      const oldest = this.messageOrder.find((id) => id !== currentMessageId);
      if (!oldest) break;
      this.messageOrder.splice(this.messageOrder.indexOf(oldest), 1);
      this.dropMessageAudio(oldest);
    }
  }

  private dropMessageAudio(messageId: string): void {
    this.messages.delete(messageId);
    for (const [token, entry] of this.audioStore) {
      if (entry.messageId === messageId) {
        this.audioBytes -= entry.audio.byteLength;
        this.audioStore.delete(token);
      }
    }
  }
}

function defaultSynthParams(): SynthParams {
  return {
    textLang: 'zh',
    topK: 15,
    topP: 1,
    temperature: 1,
    speedFactor: 1,
    textSplitMethod: 'cut5',
    batchSize: 1,
    fragmentInterval: 0.3,
    seed: -1,
    streamingMode: false,
    mediaType: 'wav',
    parallelInfer: true,
    repetitionPenalty: 1.35,
    sampleSteps: 32,
    superSampling: false,
    overlapLength: 2,
    minChunkLength: 16,
  };
}
