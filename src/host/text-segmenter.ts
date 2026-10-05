/**
 * 文本分段（Segmenter）：按标点（。！？；\n）与最大字符数安全切分。
 *
 * 规则：
 * 1. 先按换行切块；
 * 2. 每块按句末标点（。！？；…）贪婪切分，句段过长（> maxChars）时：
 *    a. 优先在逗号/顿号/冒号处二次切分；
 *    b. 仍超长则按 maxChars 硬切（尽量在标点后、绝不断开单词/拉丁串）。
 * 3. 过滤空白段，保留段内首尾空白修剪。
 */

import type { Segment } from './types.js';

const SENTENCE_END = /[。！？；…!?;]/;
const SOFT_BREAK = /[，、,：:]/;

/** 一段文本（不含换行）。 */
function splitBySoft(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  const out: string[] = [];
  let rest = block;
  while (rest.length > maxChars) {
    // 在窗口内找最后一个软切分点（尽量靠右）
    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (let i = window.length - 1; i >= maxChars * 0.4; i--) {
      if (SOFT_BREAK.test(window[i] ?? '')) {
        cut = i + 1; // 标点归前一段
        break;
      }
    }
    if (cut <= 0) {
      // 无软切分点：硬切，并避免截断连续拉丁/数字串
      cut = maxChars;
      if (/[A-Za-z0-9]$/.test(window) && /[A-Za-z0-9]/.test(rest[cut] ?? '')) {
        // 回退到串首
        let back = cut - 1;
        while (back > maxChars * 0.4 && /[A-Za-z0-9]/.test(rest[back] ?? '')) back--;
        if (back > maxChars * 0.4) cut = back + 1;
      }
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * 切分清洗后的文本。
 * @param text 已清洗文本
 * @param maxChars 单段最大字符数（默认 50）
 * @param emotion 为全部段附加的情感标签（供队列按情感选音色）
 */
export function segmentText(text: string, maxChars = 50, emotion?: Segment['emotion']): Segment[] {
  const blocks = text.split('\n');
  const segments: Segment[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    // 句末标点切分
    const sentences: string[] = [];
    let buf = '';
    for (const ch of trimmed) {
      buf += ch;
      if (SENTENCE_END.test(ch)) {
        sentences.push(buf);
        buf = '';
      }
    }
    if (buf.trim().length > 0) sentences.push(buf);

    for (const sentence of sentences) {
      const t = sentence.trim();
      if (t.length === 0) continue;
      if (t.length <= maxChars) {
        segments.push({ index: segments.length, text: t, emotion });
      } else {
        for (const piece of splitBySoft(t, maxChars)) {
          if (piece.length > 0) segments.push({ index: segments.length, text: piece, emotion });
        }
      }
    }
  }
  return segments;
}

/** 整段文本切分入口（附清洗），返回段列表；空文本返回空数组。 */
export function prepareSegments(rawText: string, maxChars = 50, emotion?: Segment['emotion']): Segment[] {
  const cleaned = rawText.replace(/\r\n?/g, '\n');
  return segmentText(cleaned, maxChars, emotion);
}
