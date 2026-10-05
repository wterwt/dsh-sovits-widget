import { describe, expect, it, vi } from 'vitest';
import { TaskQueue, type SynthTask } from '../src/host/task-queue.js';
import type { Segment } from '../src/host/types.js';

function task(id: string, signal: AbortSignal = new AbortController().signal): SynthTask {
  const segment: Segment = { index: 0, text: '你好。' };
  return { id, messageId: 'm1', segment, params: {} as never, signal };
}

describe('TaskQueue', () => {
  it('按并发上限执行任务', async () => {
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const queue = new TaskQueue(
      async (t) => {
        running += 1;
        peak = Math.max(peak, running);
        started.push(t.id);
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
      },
      2,
    );
    const done: string[] = [];
    for (const id of ['a', 'b', 'c', 'd']) {
      void queue.enqueue(task(id)).then(() => done.push(id));
    }
    await vi.waitFor(() => expect(done).toHaveLength(4));
    expect(peak).toBe(2);
    expect(started).toHaveLength(4);
  });

  it('clear 丢弃未开始任务并中止进行中任务', async () => {
    const abortedIds: string[] = [];
    const queue = new TaskQueue(async (t) => {
      await new Promise<void>((resolve, reject) => {
        t.signal.addEventListener('abort', () => {
          abortedIds.push(t.id);
          reject(new Error('aborted'));
        });
      });
    }, 1);
    const done: string[] = [];
    void queue.enqueue(task('a')).then(() => done.push('a'));
    void queue.enqueue(task('b')).then(() => done.push('b'));
    await vi.waitFor(() => expect(queue.size).toBeGreaterThan(0));
    queue.clear();
    await vi.waitFor(() => expect(abortedIds).toContain('a'));
    await vi.waitFor(() => expect(done).toEqual(expect.arrayContaining(['b']))); // 等待任务以“丢弃”结算
  });

  it('外部 signal 级联中止任务', async () => {
    const controller = new AbortController();
    let workerSignal: AbortSignal | null = null;
    const queue = new TaskQueue(async (t) => {
      workerSignal = t.signal;
      await new Promise<void>((resolve, reject) => {
        t.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }, 1);
    void queue.enqueue(task('a', controller.signal));
    await vi.waitFor(() => expect(workerSignal).not.toBeNull());
    controller.abort();
    await vi.waitFor(() => expect(workerSignal?.aborted).toBe(true));
  });

  it('enqueue 永不 reject（worker 抛错被吞）', async () => {
    const queue = new TaskQueue(async () => {
      throw new Error('boom');
    }, 1);
    await expect(queue.enqueue(task('a'))).resolves.toBeUndefined();
  });
});
