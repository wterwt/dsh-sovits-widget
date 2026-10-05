/**
 * 合成任务队列（TaskQueue）：基于 p-queue 控制并发。
 * - API 模式建议并发 2-4；本地 GPU 模式由配置层强制 1（防显存溢出）。
 * - Barge-in：clear() 中止全部任务（等待中的直接丢弃，进行中的经 AbortSignal
 *   取消 HTTP 请求）；任务自带的外部 signal 会级联到内部 signal。
 * - enqueue 返回的 Promise 永不 reject（失败由 worker 内部记录并上报）。
 */

import PQueue from 'p-queue';
import type { Segment, TtsParams } from './types.js';

/** 一次合成任务（队列单元）。 */
export interface SynthTask {
  /** 任务唯一 id（消息 id + 段序号）。 */
  id: string;
  messageId: string;
  segment: Segment;
  params: TtsParams;
  /** 任务级中止信号（打断/停止时触发）。 */
  signal: AbortSignal;
}

export interface TaskQueueEvents {
  /** 任务开始（真正进入 worker）。 */
  onTaskStart?: (task: SynthTask) => void;
  /** 队列全部空闲（含失败任务结算）。 */
  onIdle?: () => void;
}

export type SynthWorker = (task: SynthTask) => Promise<void>;

export class TaskQueue {
  private readonly queue: PQueue;
  private readonly worker: SynthWorker;
  private readonly controllers = new Map<string, AbortController>();
  private readonly events: TaskQueueEvents;

  constructor(worker: SynthWorker, concurrency: number, events: TaskQueueEvents = {}) {
    this.worker = worker;
    this.events = events;
    this.queue = new PQueue({
      concurrency: Math.max(1, Math.min(8, concurrency)),
    });
    // PQueue 空闲回调
    void this.queue.onIdle().then(() => this.events.onIdle?.());
  }

  /**
   * 入队一个任务。
   * @returns 任务结束（完成/失败/被丢弃）时 resolve，绝不 reject。
   */
  enqueue(task: SynthTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    // 外部信号级联：任务级/消息级打断 → 内部 signal
    const forward = (): void => controller.abort(task.signal.reason);
    if (task.signal.aborted) controller.abort(task.signal.reason);
    else task.signal.addEventListener('abort', forward, { once: true });
    const effectiveTask: SynthTask = { ...task, signal: controller.signal };
    const run = this.queue.add(async () => {
      if (controller.signal.aborted) return;
      this.events.onTaskStart?.(effectiveTask);
      await this.worker(effectiveTask);
    });
    const aborted = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return Promise.race([run, aborted])
      .catch(() => {}) // worker 失败已由 worker 自行记录；此处仅防未处理拒绝
      .finally(() => {
        task.signal.removeEventListener('abort', forward);
        this.controllers.delete(task.id);
      });
  }

  /** Barge-in：丢弃等待任务并中止进行中任务（HTTP 层取消）。 */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.queue.clear();
  }

  /** 队列中等待的任务数。 */
  get pending(): number {
    return this.queue.pending;
  }

  /** 队列总大小（等待 + 进行中）。 */
  get size(): number {
    return this.queue.size;
  }

  /** 动态调整并发。 */
  setConcurrency(concurrency: number): void {
    this.queue.concurrency = Math.max(1, Math.min(8, concurrency));
  }
}
