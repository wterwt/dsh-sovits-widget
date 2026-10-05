/**
 * 客户端播放器（AudioPlayer）：
 * - Web Audio API 顺序调度各分段（边合边播，首段就绪即出声）
 * - 打断（barge-in）：100ms 增益淡出，避免爆音
 * - Web Speech 兜底：kind='webspeech' 的分段用 speechSynthesis 朗读
 * - 音量/语速实时调节；进度与当前文本回调给悬浮控制台
 */

import { api, type ClientMessageStatus } from './api.js';

export interface PlaybackEvents {
  onSegmentStart?: (index: number, text: string) => void;
  onProgress?: (played: number, total: number) => void;
  onStateChange?: (state: PlaybackState) => void;
  onDone?: (interrupted: boolean) => void;
}

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

export interface PlayerOptions {
  volume: number;
  fadeOutMs: number;
  events?: PlaybackEvents;
}

interface ScheduledNode {
  source: AudioBufferSourceNode | null;
  startedAt: number;
  durationMs: number;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: ScheduledNode[] = [];
  private played = 0;
  private total = 0;
  private state: PlaybackState = 'idle';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seenIndices = new Set<number>();
  private currentMessageId: string | null = null;
  private volume: number;
  private fadeOutMs: number;
  private events: PlaybackEvents;
  private speechQueue: string[] = [];
  private speaking = false;
  private stopped = false;
  private lastPlayedText = '';

  constructor(options: PlayerOptions) {
    this.volume = options.volume;
    this.fadeOutMs = options.fadeOutMs;
    this.events = options.events ?? {};
  }

  /** 开始播放某条消息的合成结果（轮询式流式播放）。 */
  async play(messageId: string, total: number): Promise<void> {
    this.stopInternal(false);
    this.currentMessageId = messageId;
    this.total = total;
    this.played = 0;
    this.stopped = false;
    this.seenIndices.clear();
    this.speechQueue = [];
    this.speaking = false;
    this.lastPlayedText = '';
    this.setState('loading');
    this.ensureAudio();
    await this.pollOnce(messageId);
    if (this.stopped) return;
    this.setState(this.nodes.length > 0 ? 'playing' : 'loading');
    this.pollTimer = setInterval(() => void this.pollOnce(messageId), 250);
  }

  /** 暂停。 */
  pause(): void {
    if (this.state !== 'playing' && this.state !== 'loading') return;
    void this.ctx?.suspend();
    if ('speechSynthesis' in window) window.speechSynthesis.pause();
    this.setState('paused');
  }

  /** 继续。 */
  resume(): void {
    if (this.state !== 'paused') return;
    void this.ctx?.resume();
    if ('speechSynthesis' in window) window.speechSynthesis.resume();
    this.setState('playing');
  }

  /** 打断停止（淡出）。 */
  stop(fade = true): void {
    this.stopInternal(fade);
  }

  /** 设置音量。 */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /** 替换事件回调（UI 挂载后绑定）。 */
  setEvents(events: PlaybackEvents): void {
    this.events = events;
  }

  get currentState(): PlaybackState {
    return this.state;
  }

  get currentText(): string {
    return this.lastPlayedText;
  }

  /** 已播段 / 总段。 */
  get progress(): { played: number; total: number } {
    return { played: this.played, total: this.total };
  }

  // ---------- 内部 ----------

  private ensureAudio(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // 无 Web Audio：仅 Web Speech 兜底
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  private setState(state: PlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange?.(state);
  }

  private async pollOnce(messageId: string): Promise<void> {
    if (this.stopped || this.currentMessageId !== messageId) return;
    let status: ClientMessageStatus;
    try {
      const res = await api.status(messageId);
      status = res.status;
    } catch {
      return; // 暂时失败，下轮重试
    }
    for (const segment of status.ready) {
      if (this.seenIndices.has(segment.index)) continue;
      this.seenIndices.add(segment.index);
      if (segment.kind === 'webspeech') {
        this.speechQueue.push(segment.text);
        this.pumpSpeech();
      } else if (segment.token && !segment.error) {
        void this.fetchAndSchedule(segment);
      } else {
        this.markPlayed(segment.index); // 失败段：跳过并计数
      }
    }
    if (status.done && this.seenIndices.size >= status.total && this.nodes.length === 0 && !this.speaking) {
      this.finish(false);
    }
  }

  private async fetchAndSchedule(segment: {
    index: number;
    token: string;
    text: string;
    durationMs?: number;
  }): Promise<void> {
    try {
      const res = await api.audio(segment.token);
      if (!res.ok) {
        this.markPlayed(segment.index);
        return;
      }
      const buffer = await res.arrayBuffer();
      const ctx = this.ctx;
      if (!ctx) {
        this.markPlayed(segment.index);
        return;
      }
      const decoded = await ctx.decodeAudioData(buffer);
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(this.master ?? ctx.destination);
      const startAt = this.nextStartTime(decoded.duration * 1000);
      source.start(startAt);
      this.nodes.push({ source, startedAt: startAt, durationMs: decoded.duration * 1000 });
      source.onended = () => {
        this.markPlayed(segment.index);
        this.nodes = this.nodes.filter((n) => n.source !== source);
        if (this.state === 'playing' && this.nodes.length === 0 && !this.speaking && this.seenIndices.size >= this.total) {
          this.finish(false);
        }
      };
      if (this.state === 'loading') this.setState('playing');
    } catch {
      this.markPlayed(segment.index);
    }
  }

  private nextStartTime(durationMs: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const now = ctx.currentTime;
    let end = now;
    for (const node of this.nodes) {
      const nodeEnd = node.startedAt + node.durationMs / 1000;
      if (nodeEnd > end) end = nodeEnd;
    }
    return Math.max(now, end);
  }

  private markPlayed(index: number): void {
    this.played = Math.min(this.total, this.played + 1);
    this.events.onProgress?.(this.played, this.total);
  }

  /** Web Speech 串行朗读队列。 */
  private pumpSpeech(): void {
    if (this.speaking || this.stopped) return;
    const text = this.speechQueue.shift();
    if (!text) return;
    if (!('speechSynthesis' in window)) {
      this.markPlayed(this.played);
      this.pumpSpeech();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    this.speaking = true;
    this.lastPlayedText = text;
    this.events.onSegmentStart?.(this.played, text);
    utterance.onend = () => {
      this.speaking = false;
      this.markPlayed(this.played);
      if (this.state === 'playing' && this.nodes.length === 0 && this.speechQueue.length === 0 && this.seenIndices.size >= this.total) {
        this.finish(false);
      } else {
        this.pumpSpeech();
      }
    };
    utterance.onerror = () => {
      this.speaking = false;
      this.markPlayed(this.played);
      this.pumpSpeech();
    };
    window.speechSynthesis.speak(utterance);
    if (this.state === 'loading') this.setState('playing');
  }

  private stopInternal(fade: boolean): void {
    const ctx = this.ctx;
    const fadeMs = fade ? this.fadeOutMs : 0;
    if (ctx && this.master && this.nodes.length > 0 && fadeMs > 0) {
      const now = ctx.currentTime;
      this.master.gain.setTargetAtTime(0, now, fadeMs / 1000 / 3);
      const stopAt = now + fadeMs / 1000;
      for (const node of this.nodes) {
        node.source?.stop(stopAt);
      }
      setTimeout(() => {
        this.master?.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.02);
      }, fadeMs + 50);
    } else {
      for (const node of this.nodes) node.source?.stop();
    }
    this.nodes = [];
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.speaking = false;
    this.speechQueue = [];
    if (this.state !== 'idle') {
      const wasActive = this.state !== 'stopped';
      this.setState('stopped');
      if (wasActive) this.events.onDone?.(true);
    }
  }

  private finish(interrupted: boolean): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopped = true;
    this.setState('idle');
    this.events.onDone?.(interrupted);
  }
}
