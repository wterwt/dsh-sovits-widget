import { describe, expect, it } from 'vitest';
import { renderInjection, resolveInjection, resolveVoiceForEmotion } from '../src/host/style-injector.js';
import type { Role } from '../src/host/config.js';

const role: Role = {
  id: 'r1',
  name: '守岸人',
  persona: '温柔冷静的向导',
  voice: { refAudioPath: 'a.wav', promptText: '', promptLang: 'zh' },
  emotions: {
    happy: {
      voice: { refAudioPath: 'happy.wav', promptText: '开心', promptLang: 'zh' },
      params: { speedFactor: 1.2 },
    },
  },
};

describe('style-injector', () => {
  it('默认模板渲染角色与人格', () => {
    const template = '扮演【{role}】。{persona} 回复口语化、短句，不使用 Markdown 列表。';
    expect(renderInjection(role, template)).toBe(
      '扮演【守岸人】。温柔冷静的向导 回复口语化、短句，不使用 Markdown 列表。',
    );
  });

  it('无激活角色时注入为空', () => {
    expect(resolveInjection([role], '', 't')).toEqual({ roleId: '', text: '', role: null });
  });

  it('激活角色不存在时抛错', () => {
    expect(() => resolveInjection([role], 'ghost', 't')).toThrow(/不存在/);
  });

  it('情感映射解析音色与参数覆盖', () => {
    const happy = resolveVoiceForEmotion(role, 'happy');
    expect(happy.voice.refAudioPath).toBe('happy.wav');
    expect(happy.params.speedFactor).toBe(1.2);
    const normal = resolveVoiceForEmotion(role, 'sad');
    expect(normal.voice.refAudioPath).toBe('a.wav');
    expect(normal.params).toEqual({});
  });
});
