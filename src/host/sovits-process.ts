/**
 * GPT-SoVITS 本地进程池（SovitsProcessPool）：
 * - 常驻单子进程：禁止每次合成都 spawn；通过 HTTP 与 api_v2.py 通信。
 * - autoStart 模式：dsh 启动时拉起 `python api_v2.py`（继承工作目录），
 *   健康失败 N 次后自动重启；dsh 退出时终止子进程。
 * - 远程部署（autoStart=false）本类退化为纯 HTTP 健康观察。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Diagnostics } from './diagnostics.js';

export interface ProcessPoolOptions {
  apiBase: string;
  pythonExecutable: string;
  apiScript: string;
  cwd: string;
  extraArgs: string[];
  /** 启动超时（毫秒）。 */
  startupTimeoutMs: number;
  /** 进程退出后自动重启的最大次数（窗口期内）。 */
  maxRestarts: number;
  /** 健康回调：注入外部 Ping（返回 ok）。 */
  ping: () => Promise<boolean>;
  diagnostics?: Diagnostics;
}

export class SovitsProcessPool {
  private readonly options: ProcessPoolOptions;
  private child: ChildProcess | null = null;
  private disposed = false;
  private restarts = 0;
  private lastRestartAt = 0;
  private childStartedAt = 0;
  private readonly RESTART_WINDOW_MS = 10 * 60 * 1000;

  constructor(options: ProcessPoolOptions) {
    this.options = options;
    /** 子进程启动后等待模型加载的宽限期（期间健康失败不重启、不计数）。 */
    this.startupGraceMs = options.startupTimeoutMs;
  }

  /** 子进程启动宽限期（毫秒）。 */
  readonly startupGraceMs: number;

  /** 是否由本插件托管子进程。 */
  get managed(): boolean {
    return this.options.apiScript.length > 0;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** 当前子进程启动时刻（0=未启动）。 */
  get startedAt(): number {
    return this.childStartedAt;
  }

  /** 启动托管子进程（幂等）。 */
  start(): void {
    if (this.disposed || !this.managed) return;
    if (this.alive) return;
    this.spawnChild();
  }

  /** 停止并回收子进程。 */
  stop(): void {
    this.disposed = true;
    this.killChild();
  }

  /**
   * 健康巡检（由引擎周期调用）：
   * - HTTP Ping 失败但子进程仍在宽限期内（模型加载中）→ 不干预；
   * - Ping 失败且已过宽限期 → 尝试重启；
   * - 进程意外退出 → 窗口期内重启，超限停止并上报。
   */
  async supervise(): Promise<{ ok: boolean; restarted: boolean }> {
    if (!this.managed) return { ok: true, restarted: false };
    const httpOk = await this.options.ping();
    if (httpOk) {
      // 服务恢复健康：清零重启预算，允许下一次故障窗口内再重启
      if (this.restarts > 0) this.restarts = 0;
      return { ok: true, restarted: false };
    }
    if (this.alive && Date.now() - this.childStartedAt < this.startupGraceMs) {
      // 模型加载中：给足宽限期，绝不误杀
      return { ok: false, restarted: false };
    }
    const now = Date.now();
    if (now - this.lastRestartAt > this.RESTART_WINDOW_MS) this.restarts = 0;
    if (this.restarts >= this.options.maxRestarts) {
      this.options.diagnostics?.error(
        'tts.process',
        `子进程重启次数超限（${this.options.maxRestarts} 次/10 分钟），请手动检查 GPT-SoVITS`,
      );
      return { ok: false, restarted: false };
    }
    this.killChild();
    this.spawnChild();
    this.restarts += 1;
    this.lastRestartAt = now;
    this.options.diagnostics?.warn('tts.process', `GPT-SoVITS 无响应，重启子进程（第 ${this.restarts} 次）`);
    return { ok: false, restarted: true };
  }

  private spawnChild(): void {
    const { pythonExecutable, apiScript, cwd, extraArgs, startupTimeoutMs, diagnostics } = this.options;
    diagnostics?.info('tts.process', `拉起常驻 GPT-SoVITS 子进程: ${pythonExecutable} ${apiScript}`, { cwd });
    const child = spawn(pythonExecutable, [apiScript, ...extraArgs], {
      cwd: cwd || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.childStartedAt = Date.now();

    const onExit = (code: number | null, signal: string | null): void => {
      if (this.disposed) return;
      diagnostics?.warn('tts.process', `GPT-SoVITS 子进程退出 code=${String(code)} signal=${String(signal)}`);
      if (this.child === child) this.child = null;
      // 由 supervise 周期决定是否重启
      if (this.managed && !this.disposed) {
        const now = Date.now();
        if (now - this.lastRestartAt > this.RESTART_WINDOW_MS) this.restarts = 0;
        if (this.restarts < this.options.maxRestarts) {
          this.restarts += 1;
          this.lastRestartAt = now;
          diagnostics?.warn('tts.process', `自动重启子进程（第 ${this.restarts} 次）`);
          this.spawnChild();
        }
      }
    };
    child.once('exit', onExit);
    child.stdout?.on('data', (d: Buffer) => diagnostics?.info('tts.process.stdout', d.toString('utf8').trimEnd()));
    child.stderr?.on('data', (d: Buffer) => diagnostics?.info('tts.process.stderr', d.toString('utf8').trimEnd()));
    child.once('error', (err) => {
      diagnostics?.error('tts.process', `子进程启动失败: ${err.message}`);
    });

    if (startupTimeoutMs > 0) {
      const timer = setTimeout(() => {
        if (this.child === child && child.exitCode === null) {
          diagnostics?.warn('tts.process', `子进程启动超时（${startupTimeoutMs}ms），仍在等待就绪`);
        }
      }, startupTimeoutMs);
      timer.unref?.();
    }
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill();
    } catch {
      // 已退出
    }
    // 兜底：2s 后强杀
    const killer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
      }
    }, 2000);
    killer.unref?.();
  }
}
