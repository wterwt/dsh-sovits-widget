/**
 * 配置面板（插件界面）：
 * - 基础设置：自动播报开关、音量、打断行为、淡出时长、最大分段字符数
 * - 音色管理：角色卡（人设注入、参考音频选择/上传、情感映射、音色混合）
 * - 高级参数：GPT-SoVITS 服务端（地址/autoStart/并发）与合成参数
 * - 诊断：健康状态、日志、导出、备份回滚
 */

import type { RootConfig, Role, SynthParams } from '../host/config.js';
import { api } from './api.js';
import { el, toast } from './ui.js';

export interface ConfigPanelOptions {
  onSaved?: (config: RootConfig) => void;
}

type RoleLike = Role;

const SOVITS_LANGS = ['auto', 'auto_yue', 'en', 'zh', 'ja', 'yue', 'ko', 'all_zh', 'all_ja', 'all_yue', 'all_ko'];

export class ConfigPanel {
  private readonly options: ConfigPanelOptions;
  private config: RootConfig;
  private mask: HTMLElement;
  private tabBodies: Map<string, HTMLElement> = new Map();
  private activeTab = 'basic';
  private editingRoleId: string | null = null;

  constructor(config: RootConfig, options: ConfigPanelOptions = {}) {
    this.config = structuredClone(config);
    this.options = options;
    this.mask = this.build();
    document.body.appendChild(this.mask);
  }

  open(): void {
    void this.refreshFromServer();
    this.mask.classList.add('dshs-visible');
  }

  close(): void {
    this.mask.classList.remove('dshs-visible');
  }

  getConfig(): RootConfig {
    return this.config;
  }

  /** 从服务器重新拉取（打开时同步最新）。 */
  private async refreshFromServer(): Promise<void> {
    try {
      const res = await api.getConfig();
      this.config = res.config;
      this.renderAll();
    } catch (err) {
      toast(`读取配置失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private build(): HTMLElement {
    const mask = el('div', { class: 'dshs-panel-mask' });
    mask.dataset.plugin = 'dsh-sovits-widget';
    mask.addEventListener('click', (event) => {
      if (event.target === mask) this.close();
    });
    const panel = el('div', { class: 'dshs-panel' });
    const head = el('div', { class: 'dshs-panel-head' }, [
      el('div', { class: 'dshs-panel-title' }, ['GPT-SoVITS 语音播报设置']),
      el('div', { class: 'dshs-console-buttons' }, [
        el('button', { class: 'dshs-btn dshs-primary', id: 'dshs-save' }, ['保存配置']),
        el('button', { class: 'dshs-btn', id: 'dshs-close' }, ['关闭']),
      ]),
    ]);
    const tabs = el('div', { class: 'dshs-tabs' });
    const bodies = el('div', {});
    for (const [id, label] of [
      ['basic', '基础设置'],
      ['voices', '音色管理'],
      ['advanced', '高级参数'],
      ['diagnostics', '诊断'],
    ] as const) {
      const tab = el('div', { class: `dshs-tab${id === this.activeTab ? ' dshs-active' : ''}`, 'data-tab': id }, [label]);
      tab.addEventListener('click', () => this.switchTab(id));
      tabs.appendChild(tab);
      const body = el('div', { class: `dshs-tab-body${id === this.activeTab ? ' dshs-active' : ''}`, 'data-body': id });
      this.tabBodies.set(id, body);
      bodies.appendChild(body);
    }
    panel.append(head, tabs, bodies);
    mask.appendChild(panel);
    panel.querySelector('#dshs-save')?.addEventListener('click', () => void this.save());
    panel.querySelector('#dshs-close')?.addEventListener('click', () => this.close());
    return mask;
  }

  private switchTab(id: string): void {
    this.activeTab = id;
    for (const tab of this.mask.querySelectorAll('.dshs-tab')) {
      tab.classList.toggle('dshs-active', tab.getAttribute('data-tab') === id);
    }
    for (const body of this.mask.querySelectorAll('.dshs-tab-body')) {
      body.classList.toggle('dshs-active', body.getAttribute('data-body') === id);
    }
    if (id === 'diagnostics') void this.renderDiagnostics();
  }

  private renderAll(): void {
    this.renderBasic();
    this.renderVoices();
    this.renderAdvanced();
  }

  // ---------- 基础设置 ----------

  private renderBasic(): void {
    const body = this.tabBodies.get('basic');
    if (!body) return;
    body.replaceChildren();
    const c = this.config;
    body.append(
      this.checkField('自动播报助手回复', c.playback.autoPlay, (v) => (c.playback.autoPlay = v)),
      this.rangeField('音量', c.playback.volume, 0, 1, 0.05, (v) => (c.playback.volume = v)),
      this.checkField('用户发新消息时打断播报', c.playback.bargeInOnUserMessage, (v) => (c.playback.bargeInOnUserMessage = v)),
      this.checkField('按 Esc 打断播报', c.playback.bargeInOnEsc, (v) => (c.playback.bargeInOnEsc = v)),
      this.checkField('点击停止按钮打断', c.playback.bargeInOnStop, (v) => (c.playback.bargeInOnStop = v)),
      this.numberField('打断淡出时长（毫秒）', c.playback.fadeOutMs, 0, 1000, (v) => (c.playback.fadeOutMs = v)),
      this.numberField('单段最大字符数', c.segments.maxChars, 10, 300, (v) => (c.segments.maxChars = v)),
      this.checkField('启用磁盘缓存（LRU，默认 2GB）', c.cache.enabled, (v) => (c.cache.enabled = v)),
      this.numberField('缓存上限（MB）', Math.round(c.cache.maxBytes / 1024 / 1024), 16, 65536, (v) => (c.cache.maxBytes = v * 1024 * 1024)),
      this.textField('注入模板（{role}/{persona} 占位）', c.style.injectionTemplate, (v) => (c.style.injectionTemplate = v)),
      this.checkField('连续失败降级 Web Speech', c.fallback.enabled, (v) => (c.fallback.enabled = v)),
      this.numberField('连续失败降级阈值', c.fallback.maxConsecutiveFailures, 1, 20, (v) => (c.fallback.maxConsecutiveFailures = v)),
      this.selectField('当前角色', c.activeRoleId, [['', '（无角色，浏览器朗读）'], ...c.roles.map((r) => [r.id, r.name] as [string, string])], (v) => (c.activeRoleId = v)),
    );
  }

  // ---------- 音色管理 ----------

  private renderVoices(): void {
    const body = this.tabBodies.get('voices');
    if (!body) return;
    body.replaceChildren();
    const addBtn = el('button', { class: 'dshs-btn dshs-primary' }, ['＋ 新建角色']);
    addBtn.addEventListener('click', () => {
      const role: RoleLike = {
        id: `role-${Date.now().toString(36)}`,
        name: '新角色',
        persona: '',
        voice: { refAudioPath: '', promptText: '', promptLang: 'zh' },
      };
      this.config.roles.push(role);
      this.editingRoleId = role.id;
      this.renderVoices();
      this.renderBasic();
    });
    body.appendChild(addBtn);
    for (const role of this.config.roles) {
      body.appendChild(this.renderRoleCard(role));
    }
  }

  private renderRoleCard(role: RoleLike): HTMLElement {
    const card = el('div', { class: 'dshs-role-card' });
    const expanded = this.editingRoleId === role.id;
    const head = el('div', { class: 'dshs-role-card-head' }, [
      el('div', { class: 'dshs-role-name' }, [`${role.name}${this.config.activeRoleId === role.id ? '（当前）' : ''}`]),
      el('div', { class: 'dshs-console-buttons' }, [
        el('button', { class: 'dshs-btn', 'data-act': 'preview', title: '试听这个角色的声音' }, ['试听']),
        el('button', { class: 'dshs-btn', 'data-act': 'edit' }, [expanded ? '收起' : '编辑']),
        el('button', { class: 'dshs-btn', 'data-act': 'activate' }, ['启用']),
        el('button', { class: 'dshs-btn dshs-danger', 'data-act': 'delete' }, ['删除']),
      ]),
    ]);
    card.appendChild(head);
    const toggleBtn = head.querySelector('[data-act="edit"]') as HTMLElement;
    toggleBtn.addEventListener('click', () => {
      this.editingRoleId = expanded ? null : role.id;
      this.renderVoices();
    });
    head.querySelector('[data-act="preview"]')?.addEventListener('click', () => void this.previewVoice(role.id));
    head.querySelector('[data-act="activate"]')?.addEventListener('click', () => {
      this.config.activeRoleId = role.id;
      toast(`已切换到角色「${role.name}」（音色与提示词注入同步生效）`);
      this.renderVoices();
      this.renderBasic();
    });
    head.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
      this.config.roles = this.config.roles.filter((r) => r.id !== role.id);
      if (this.config.activeRoleId === role.id) this.config.activeRoleId = '';
      this.renderVoices();
      this.renderBasic();
    });

    if (!expanded) return card;

    card.append(
      this.textField('角色名', role.name, (v) => (role.name = v)),
      this.areaField('人设（注入 system prompt）', role.persona, (v) => (role.persona = v)),
      this.refAudioField(role),
      this.textField('参考音频提示文本（prompt_text）', role.voice.promptText, (v) => (role.voice.promptText = v)),
      this.selectField('提示语言', role.voice.promptLang, SOVITS_LANGS.map((l) => [l, l]), (v) => (role.voice.promptLang = v as never)),
      this.textField('GPT 权重路径（可选）', role.voice.gptWeightsPath ?? '', (v) => (role.voice.gptWeightsPath = v || undefined)),
      this.textField('SoVITS 权重路径（可选）', role.voice.sovitsWeightsPath ?? '', (v) => (role.voice.sovitsWeightsPath = v || undefined)),
      el('div', { class: 'dshs-field' }, [
        el('label', {}, ['情感映射（开心/愤怒/悲伤 可覆盖参考音频）']),
        ...this.emotionFields(role),
      ]),
      el('div', { class: 'dshs-field' }, [
        el('label', {}, ['音色混合（按比例混合两音色，如 70% A + 30% B）']),
        ...this.mixFields(role),
      ]),
    );
    return card;
  }

  private refAudioField(role: RoleLike): HTMLElement {
    const wrapper = el('div', { class: 'dshs-field' });
    const label = el('label', {}, ['参考音频']);
    const select = el('select', {}) as HTMLSelectElement;
    const refresh = el('button', { class: 'dshs-btn', type: 'button' }, ['刷新列表']);
    const upload = el('input', { type: 'file', accept: '.wav,.mp3,.flac,.ogg,.m4a' }) as HTMLInputElement;
    const uploadBtn = el('button', { class: 'dshs-btn', type: 'button' }, ['上传并处理']);
    const hint = el('div', { class: 'dshs-hint' }, ['上传后自动降噪并截取 3-10 秒片段；也可选择 GPT-SoVITS 已有参考音频']);

    const loadOptions = async (): Promise<void> => {
      try {
        const res = await api.refAudios(this.config.audio.refAudioDir);
        select.replaceChildren(el('option', { value: '' }, ['（选择参考音频）']));
        const dir = res.dir.replace(/[/\\]+$/, '');
        for (const file of res.files) {
          select.appendChild(el('option', { value: `${dir}/${file}` }, [file]));
        }
        if (role.voice.refAudioPath) {
          for (const opt of Array.from(select.options)) {
            if (opt.value === role.voice.refAudioPath || opt.value.endsWith(role.voice.refAudioPath)) {
              select.value = opt.value;
              break;
            }
          }
        }
      } catch (err) {
        hint.textContent = `读取参考音频列表失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    void loadOptions();
    refresh.addEventListener('click', () => void loadOptions());
    select.addEventListener('change', () => {
      role.voice.refAudioPath = select.value;
    });
    uploadBtn.addEventListener('click', () => {
      const file = upload.files?.[0];
      if (!file) return;
      toast('正在上传并处理音频（降噪+截取）…');
      void (async () => {
        try {
          const res = await api.uploadAudio(file);
          if (res.ok && res.path) {
            role.voice.refAudioPath = res.path;
            toast(`处理完成，时长 ${res.durationMs ?? '?'}ms，已选为参考音频`);
            await loadOptions();
          } else {
            toast(res.error ?? '处理失败', 'error');
          }
        } catch (err) {
          toast(`上传失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      })();
    });
    wrapper.append(label, el('div', { class: 'dshs-field-row' }, [select, refresh]), el('div', { class: 'dshs-field-row' }, [upload, uploadBtn]), hint);
    return wrapper;
  }

  private emotionFields(role: RoleLike): HTMLElement[] {
    const fields: HTMLElement[] = [];
    for (const tag of ['happy', 'angry', 'sad'] as const) {
      const labelMap: Record<string, string> = { happy: '开心', angry: '愤怒', sad: '悲伤' };
      const emotion = (role.emotions ??= {});
      const patch = (emotion[tag] ??= {});
      const row = el('div', { class: 'dshs-field-row' }, [
        el('div', { class: 'dshs-field' }, [
          el('label', {}, [labelMap[tag] ?? tag]),
          el('input', {
            type: 'text',
            placeholder: '可选：该情绪的参考音频路径',
            value: patch.voice?.refAudioPath ?? '',
          }) as HTMLInputElement,
        ]),
      ]);
      const input = row.querySelector('input') as HTMLInputElement;
      input.addEventListener('change', () => {
        if (input.value) {
          patch.voice = { ...(patch.voice ?? { refAudioPath: '', promptText: '', promptLang: 'zh' }), refAudioPath: input.value };
        } else {
          patch.voice = undefined;
        }
      });
      fields.push(row);
    }
    return fields;
  }

  private mixFields(role: RoleLike): HTMLElement[] {
    const mix = role.mix ?? { voiceB: { refAudioPath: '', promptText: '', promptLang: 'zh' }, ratioA: 0.7 };
    const enable = el('input', { type: 'checkbox' }) as HTMLInputElement;
    enable.checked = role.mix !== undefined;
    const pathInput = el('input', { type: 'text', placeholder: '音色 B 参考音频路径', value: mix.voiceB.refAudioPath }) as HTMLInputElement;
    const ratioInput = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(mix.ratioA) }) as HTMLInputElement;
    const ratioLabel = el('span', {}, [`A ${Math.round(mix.ratioA * 100)}% / B ${Math.round((1 - mix.ratioA) * 100)}%`]);
    const apply = (): void => {
      if (enable.checked) {
        mix.voiceB.refAudioPath = pathInput.value;
        mix.ratioA = Number(ratioInput.value);
        role.mix = mix;
        ratioLabel.textContent = `A ${Math.round(mix.ratioA * 100)}% / B ${Math.round((1 - mix.ratioA) * 100)}%`;
      } else {
        role.mix = undefined;
      }
    };
    enable.addEventListener('change', apply);
    pathInput.addEventListener('change', apply);
    ratioInput.addEventListener('input', apply);
    return [
      el('div', { class: 'dshs-check' }, [enable, el('span', {}, ['启用音色混合'])]),
      el('div', { class: 'dshs-field' }, [pathInput]),
      el('div', { class: 'dshs-slider-row' }, [ratioInput, ratioLabel]),
      el('div', { class: 'dshs-hint' }, ['混合=并行合成两音色后按比例加权叠加（需 GPT-SoVITS 可同时承载两次推理）']),
    ];
  }

  // ---------- 高级参数 ----------

  private renderAdvanced(): void {
    const body = this.tabBodies.get('advanced');
    if (!body) return;
    body.replaceChildren();
    const c = this.config;
    const p = c.provider.kind === 'gpt-sovits' ? c.provider : null;
    if (!p) {
      body.append(el('div', { class: 'dshs-hint' }, ['当前 provider 为 Web Speech，无高级参数。']));
      return;
    }
    const s = p.server;
    const params = p.params;
    body.append(
      this.textField('API 基址（http://127.0.0.1:9880）', s.apiBase, (v) => {
        s.apiBase = v;
      }),
      this.checkField('自动拉起本地 api_v2.py（常驻子进程）', s.autoStart, (v) => (s.autoStart = v)),
      this.textField('python 可执行文件', s.pythonExecutable, (v) => (s.pythonExecutable = v)),
      this.textField('api_v2.py 绝对路径', s.apiScript, (v) => (s.apiScript = v)),
      this.textField('GPT-SoVITS 工作目录', s.cwd, (v) => (s.cwd = v)),
      this.numberField('并发合成数（本地 GPU 建议 1，远程 API 可 2-4）', s.concurrency, 1, 8, (v) => (s.concurrency = v)),
      this.numberField('请求超时（毫秒）', s.timeoutMs, 1000, 600000, (v) => (s.timeoutMs = v)),
      this.selectField(
        '服务端接口版本',
        s.flavor,
        [
          ['auto', '自动探测（推荐）'],
          ['v2', '新版 api_v2.py（/tts，支持流式）'],
          ['legacy', '旧版 api.py（/，无流式）'],
        ],
        (v) => (s.flavor = v as never),
      ),
      this.selectField('合成语言', params.textLang, SOVITS_LANGS.map((l) => [l, l]), (v) => (params.textLang = v as never)),
      this.numberField('top_k', params.topK, 1, 50, (v) => (params.topK = v)),
      this.numberField('top_p', params.topP, 0.05, 1, (v) => (params.topP = v), 0.05),
      this.numberField('temperature', params.temperature, 0.05, 2, (v) => (params.temperature = v), 0.05),
      this.rangeField('语速 speed_factor', params.speedFactor, 0.5, 2, 0.05, (v) => (params.speedFactor = v)),
      this.numberField('片段间隔（秒）', params.fragmentInterval, 0, 2, (v) => (params.fragmentInterval = v), 0.05),
      this.selectField('流式模式', String(params.streamingMode === true ? 1 : params.streamingMode === false ? 0 : params.streamingMode), [['0', '整段返回（最稳）'], ['1', '流式（高质，旧版）'], ['2', '流式（中质较快）'], ['3', '流式（低质最快）']], (v) => {
        params.streamingMode = v === 'true' ? true : v === 'false' ? false : (Number(v) as never);
      }),
      this.selectField('媒体格式', params.mediaType, [['wav', 'wav'], ['ogg', 'ogg'], ['aac', 'aac']], (v) => (params.mediaType = v as never)),
      this.textField('参考音频目录（列表来源）', c.audio.refAudioDir, (v) => (c.audio.refAudioDir = v)),
      this.textField('ffmpeg 路径（空=自动探测）', c.audio.ffmpegPath, (v) => (c.audio.ffmpegPath = v)),
      el('div', { class: 'dshs-field' }, [
        el('button', { class: 'dshs-btn dshs-primary', 'data-act': 'preview' }, ['试听当前角色音色']),
        el('span', { class: 'dshs-hint' }, ['   将合成“你好，这是音色预览。”']),
      ]),
    );
    body.querySelector('[data-act="preview"]')?.addEventListener('click', () => void this.previewVoice());
  }

  /** 试听某个角色的音色（不传 roleId 则用当前激活角色）。 */
  private async previewVoice(roleId?: string): Promise<void> {
    toast('正在合成试听音频…');
    try {
      const res = await api.preview('你好，这是音色预览。', roleId);
      if (res.ok && res.token) {
        const audio = await api.audio(res.token);
        const blob = await audio.blob();
        const url = URL.createObjectURL(blob);
        const player = new Audio(url);
        player.volume = this.config.playback.volume;
        void player.play();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } else {
        toast(res.error ?? '试听失败', 'error');
      }
    } catch (err) {
      toast(`试听失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  // ---------- 诊断 ----------

  private async renderDiagnostics(): Promise<void> {
    const body = this.tabBodies.get('diagnostics');
    if (!body) return;
    body.replaceChildren();
    try {
      const health = await api.health();
      const h = health.health;
      body.append(
        el('div', { class: 'dshs-field' }, [
          el('label', {}, ['健康状态']),
          el('div', {}, [
            h.ok
              ? el('span', { class: 'dshs-badge' }, [`✓ 正常（${health.provider} v${health.version}）`])
              : el('span', { class: 'dshs-badge dshs-badge-warn' }, [
                  `✗ 异常（连续失败 ${h.consecutiveFailures} 次${h.degraded ? '，已降级 Web Speech' : ''}）`,
                ]),
            h.lastError ? el('div', { class: 'dshs-hint' }, [`${h.lastError}`]) : el('span', {}, []),
          ]),
        ]),
        el('div', { class: 'dshs-field' }, [
          el('label', {}, ['服务端接口']),
          el('div', {}, [
            el('span', { class: 'dshs-badge' }, [
              health.protocol.flavor === 'legacy' ? '旧版 api.py' : health.protocol.flavor === 'v2' ? '新版 api_v2.py' : '未探测',
            ]),
            el('div', { class: 'dshs-hint' }, [`探测依据：${health.protocol.reason}`]),
          ]),
        ]),
        el('div', { class: 'dshs-field' }, [
          el('label', {}, ['诊断日志']),
          await this.buildLogs(),
        ]),
        el('div', { class: 'dshs-field-row' }, [
          this.actionButton('导出 TTS 诊断日志', async () => {
            const res = await api.exportLogs();
            toast(`日志已导出: ${res.path}`);
          }),
          this.actionButton('刷新', async () => this.renderDiagnostics()),
          this.actionButton('恢复出厂配置', async () => {
            if (!window.confirm('确定恢复默认配置？（当前配置会先自动备份）')) return;
            const current = await api.getConfig();
            await api.putConfig(structuredClone(current.config));
          }),
        ]),
      );
      const backups = await api.listBackups();
      if (backups.backups.length > 0) {
        const row = el('div', { class: 'dshs-field' });
        row.appendChild(el('label', {}, ['配置备份（点击回滚）']));
        for (const file of backups.backups.slice(0, 8)) {
          const btn = el('button', { class: 'dshs-btn', title: file }, [file.slice(0, 48)]);
          btn.addEventListener('click', () => {
            if (!window.confirm(`回滚到备份 ${file}？`)) return;
            void api.rollback(file).then(
              () => {
                toast('已回滚，配置已生效');
                void this.refreshFromServer();
              },
              (err: Error) => toast(`回滚失败: ${err.message}`, 'error'),
            );
          });
          row.appendChild(el('div', { class: 'dshs-field-row' }, [btn]));
        }
        body.appendChild(row);
      }
    } catch (err) {
      body.append(el('div', { class: 'dshs-log-line dshs-error' }, [`诊断加载失败: ${err instanceof Error ? err.message : String(err)}`]));
    }
  }

  private async buildLogs(): Promise<HTMLElement> {
    const box = el('div', { class: 'dshs-logs' });
    try {
      const res = await api.logs(120);
      for (const entry of res.entries) {
        const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
        box.appendChild(
          el('div', { class: `dshs-log-line${entry.level === 'warn' ? ' dshs-warn' : entry.level === 'error' ? ' dshs-error' : ''}` }, [
            `[${time}] [${entry.event}] ${entry.message}`,
          ]),
        );
      }
      if (res.entries.length === 0) box.appendChild(el('div', { class: 'dshs-log-line' }, ['暂无日志']));
    } catch (err) {
      box.appendChild(el('div', { class: 'dshs-log-line dshs-error' }, [`日志加载失败: ${err instanceof Error ? err.message : String(err)}`]));
    }
    return box;
  }

  private actionButton(label: string, onClick: () => void | Promise<void>): HTMLElement {
    const btn = el('button', { class: 'dshs-btn', type: 'button' }, [label]);
    btn.addEventListener('click', () => void onClick());
    return btn;
  }

  // ---------- 保存 ----------

  private async save(): Promise<void> {
    try {
      await api.putConfig(this.config);
      toast('配置已保存（旧配置已备份，可回滚）');
      this.options.onSaved?.(this.config);
      this.close();
    } catch (err) {
      toast(`保存失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  // ---------- 表单小部件 ----------

  private checkField(label: string, value: boolean, set: (v: boolean) => void): HTMLElement {
    const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = value;
    input.addEventListener('change', () => set(input.checked));
    return el('div', { class: 'dshs-check' }, [input, el('span', {}, [label])]);
  }

  private textField(label: string, value: string, set: (v: string) => void): HTMLElement {
    const input = el('input', { type: 'text', value }) as HTMLInputElement;
    input.addEventListener('change', () => set(input.value));
    return el('div', { class: 'dshs-field' }, [el('label', {}, [label]), input]);
  }

  private areaField(label: string, value: string, set: (v: string) => void): HTMLElement {
    const area = el('textarea', {}) as HTMLTextAreaElement;
    area.value = value;
    area.addEventListener('change', () => set(area.value));
    return el('div', { class: 'dshs-field' }, [el('label', {}, [label]), area]);
  }

  private numberField(
    label: string,
    value: number,
    min: number,
    max: number,
    set: (v: number) => void,
    step = 1,
  ): HTMLElement {
    const input = el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) set(Math.max(min, Math.min(max, v)));
    });
    return el('div', { class: 'dshs-field' }, [el('label', {}, [label]), input]);
  }

  private rangeField(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void): HTMLElement {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    const badge = el('span', { class: 'dshs-badge' }, [String(value)]);
    input.addEventListener('input', () => {
      badge.textContent = input.value;
      set(Number(input.value));
    });
    return el('div', { class: 'dshs-field' }, [el('label', {}, [label]), el('div', { class: 'dshs-slider-row' }, [input, badge])]);
  }

  private selectField(label: string, value: string, options: Array<[string, string]>, set: (v: string) => void): HTMLElement {
    const select = el('select', {}) as HTMLSelectElement;
    for (const [v, text] of options) select.appendChild(el('option', { value: v }, [text]));
    select.value = value;
    select.addEventListener('change', () => set(select.value));
    return el('div', { class: 'dshs-field' }, [el('label', {}, [label]), select]);
  }
}
