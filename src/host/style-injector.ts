/**
 * 角色与风格注入（StyleInjector）：
 * 生成注入 system prompt 的角色段文本。角色卡与音色强绑定，
 * 切换角色即切换 TTS 参考音频与模型参数。
 */

import type { Role } from './config.js';

export interface StyleInjection {
  /** 角色 id（空=无注入）。 */
  roleId: string;
  /** 注入文本（供 system prompt 追加）。 */
  text: string;
  role: Role | null;
}

/**
 * 按模板渲染注入文本。
 * 模板占位符：{role}（角色名）、{persona}（人设）。
 * 默认模板：「扮演【{role}】。{persona} 回复口语化、短句，不使用 Markdown 列表。」
 */
export function renderInjection(role: Role, template: string): string {
  return template
    .replace(/\{role\}/g, role.name)
    .replace(/\{persona\}/g, role.persona.trim())
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 从角色列表解析当前注入。
 * @param roles 角色列表
 * @param activeRoleId 当前角色 id（空=不注入）
 * @param template 注入模板
 */
export function resolveInjection(
  roles: Role[],
  activeRoleId: string,
  template: string,
): StyleInjection {
  if (!activeRoleId) return { roleId: '', text: '', role: null };
  const role = roles.find((r) => r.id === activeRoleId);
  if (!role) {
    // 角色被删除/不存在：响亮失败（不静默注入半截文本）
    throw new Error(`激活角色不存在: ${activeRoleId}`);
  }
  return {
    roleId: role.id,
    text: renderInjection(role, template),
    role,
  };
}

/**
 * 按情感与音色混合解析一条音色（spec：情感映射 开心/愤怒/悲伤 动态切换）。
 */
export function resolveVoiceForEmotion(role: Role, emotion?: 'happy' | 'angry' | 'sad') {
  if (emotion) {
    const patch = role.emotions?.[emotion];
    if (patch?.voice) return { voice: patch.voice, params: patch.params ?? {} };
  }
  return { voice: role.voice, params: {} };
}
