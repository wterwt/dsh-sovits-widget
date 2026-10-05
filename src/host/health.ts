/**
 * 健康检查与降级（Health & Fallback）：
 * - 周期性 Ping TTS API；连续失败 N 次（默认 3）自动降级到
 *   Web Speech API（客户端执行），保证对话有声音。
 * - 恢复后自动解除降级。
 */

import type { HealthStatus } from './types.js';
import type { TTSProvider } from './provider/types.js';

export interface HealthOptions {
  /** 连续失败多少次后降级。 */
  maxConsecutiveFailures: number;
  /** 健康检查间隔（毫秒）。 */
  intervalMs: number;
  /** 状态变化回调（宿主用它向 UI 推 Toast）。 */
  onChange?: (status: HealthStatus) => void;
}

export class HealthMonitor {
  private readonly provider: TTSProvider;
  private readonly options: HealthOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: HealthStatus = {
    ok: false,
    consecutiveFailures: 0,
    degraded: false,
    lastError: '尚未检查',
  };
  private checking = false;

  constructor(provider: TTSProvider, options: HealthOptions) {
    this.provider = provider;
    this.options = options;
  }

  /** 当前状态快照。 */
  get current(): HealthStatus {
    return { ...this.status };
  }

  /** 立即执行一次 Ping（不等待周期）。 */
  async ping(): Promise<HealthStatus> {
    if (this.checking) return this.current;
    this.checking = true;
    try {
      const result = await this.provider.healthCheck();
      const failures = result.ok ? 0 : (this.status.consecutiveFailures || 0) + 1;
      const degraded =
        result.ok ? false : failures >= this.options.maxConsecutiveFailures;
      this.status = {
        ok: result.ok,
        consecutiveFailures: failures,
        degraded,
        lastError: result.lastError,
        ...(this.status.processAlive !== undefined ? { processAlive: this.status.processAlive } : {}),
      };
    } catch (err) {
      const failures = (this.status.consecutiveFailures || 0) + 1;
      this.status = {
        ok: false,
        consecutiveFailures: failures,
        degraded: failures >= this.options.maxConsecutiveFailures,
        lastError: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.checking = false;
    }
    this.options.onChange?.(this.current);
    return this.current;
  }

  /** 记录合成成功：清零连续失败。 */
  noteSuccess(): void {
    const wasDegraded = this.status.degraded;
    this.status = { ...this.status, ok: true, consecutiveFailures: 0, degraded: false, lastError: undefined };
    if (wasDegraded) this.options.onChange?.(this.current);
  }

  /** 记录合成失败：累计并判断降级。 */
  noteFailure(error: string): void {
    const failures = this.status.consecutiveFailures + 1;
    const degraded = failures >= this.options.maxConsecutiveFailures;
    const wasDegraded = this.status.degraded;
    this.status = {
      ...this.status,
      ok: false,
      consecutiveFailures: failures,
      degraded,
      lastError: error,
    };
    if (degraded !== wasDegraded) this.options.onChange?.(this.current);
  }

  /** 启动周期检查。 */
  start(): void {
    if (this.timer) return;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), this.options.intervalMs);
  }

  /** 停止周期检查。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
