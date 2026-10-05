/**
 * 情感检测（轻量关键词启发式）：为整条助手回复判定情感标签，
 * 供角色情感映射选择音色（开心/愤怒/悲伤）。未命中返回 undefined。
 */

import type { EmotionTag } from './types.js';

interface EmotionRule {
  tag: EmotionTag;
  keywords: string[];
}

const RULES: EmotionRule[] = [
  {
    tag: 'angry',
    keywords: ['生气', '愤怒', '气死', '可恶', '混蛋', '滚蛋', '别烦', '闭嘴', '讨厌', '烦死', '受够', '气人', '滚开'],
  },
  {
    tag: 'sad',
    keywords: ['难过', '伤心', '抱歉', '遗憾', '对不起', '呜呜', '唉', '失落', '可惜', '悲', '哭', '安慰', '节哀'],
  },
  {
    tag: 'happy',
    keywords: ['哈哈', '开心', '太棒', '恭喜', '高兴', '喜欢', '赞', '太好了', '棒极了', '嘿嘿', '嘻嘻', '真不错', '厉害'],
  },
];

/**
 * 检测情感标签；多条规则命中时取关键词命中数最多者，平局按规则顺序。
 */
export function detectEmotion(text: string): EmotionTag | undefined {
  const scores = new Map<EmotionTag, number>();
  for (const rule of RULES) {
    let hits = 0;
    for (const kw of rule.keywords) {
      if (text.includes(kw)) hits += 1;
    }
    if (hits > 0) scores.set(rule.tag, hits);
  }
  if (scores.size === 0) return undefined;
  let best: EmotionTag | undefined;
  let bestScore = 0;
  for (const [tag, score] of scores) {
    if (score > bestScore) {
      best = tag;
      bestScore = score;
    }
  }
  return best;
}
