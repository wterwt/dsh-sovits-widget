/**
 * dsh-sovits-widget —— GPT-SoVITS 语音播报引擎（dsh bundle 插件宿主半面）。
 *
 * 形态与 dsh-whale-widget 一致（零 @deepseek-ai 运行时依赖、duck-typed ctx）：
 * - default export 对象式 Cordis 插件（无对象级 inject，apply 内 root.inject）
 * - /dsh-sovits/* 自建 HTTP 路由（配置/合成/音频/诊断）
 * - 客户端脚本双通道挂载：tapIndex（web）+ webserver/index-inject（Electron 桌面壳）
 * - ctx.on('session/event')：assistant/message → 自动播报；user/message → barge-in
 * - ctx.systemPrompt.section：角色提示词注入（StyleInjector，动态按当前角色渲染）
 * - 配置持久化：$DSH_HOME/sovits/dsh-tts-config.json（zod 校验、原子写、自动备份回滚）
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config-store.js';
import { defaultConfig, parseConfig } from './config.js';
import { Diagnostics } from './diagnostics.js';
import { TtsEngine } from './engine.js';
import {
  buildRoutes,
  createClientJsReader,
  desktopInjectRow,
  type TrustFence,
  type WebServerLike,
} from './routes.js';
import { assistantText } from './text-extract.js';
import { resolveInjection } from './style-injector.js';

/** 会话事件（duck-typed）。 */
interface SessionEventLike {
  type?: string;
  seq?: number;
  data?: {
    message?: { content?: Array<{ type?: string; text?: string }> };
    reason?: string;
    turn?: number;
  };
}

interface SessionLike {
  id?: string;
}

/** Cordis 上下文（duck-typed，仅声明实际用到的能力）。 */
export interface CordisContextLike {
  on?: (event: string, cb: (...args: unknown[]) => unknown) => () => void;
  inject?: (names: string[], cb: (ctx: CordisContextLike) => unknown) => unknown;
  get?: (name: string) => unknown;
  effect?: (fn: () => () => void, label?: string) => unknown;
  webServer?: WebServerLike;
  systemPrompt?: {
    section(section: {
      name: string;
      order: number;
      text: string | (() => string);
    }): () => void;
  };
  connection?: unknown;
}

/** 插件自述（诊断与 UI 展示）。 */
export const PLUGIN_NAME = 'dsh-sovits-widget';
export const PLUGIN_VERSION = '0.1.0';

/** 供脚本/测试生成与校验配置。 */
export { defaultConfig, parseConfig };

/** dataDir 解析：DSH_HOME 优先，其次 ~/.dsh。 */
export function resolveDataDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 包根目录（assets 的父目录）。 */
export function resolvePackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** 默认客户端脚本 URL。 */
export const CLIENT_SCRIPT_URL = '/dsh-sovits/client.js';

export default {
  name: PLUGIN_NAME,
  apply(root: CordisContextLike): void {
    const disposers: Array<() => void> = [];
    const dataDir = resolveDataDir();
    const packageRoot = resolvePackageRoot();
    const diagnostics = new Diagnostics(500);

    // ---- 配置加载（zod 校验 + 备份回滚）----
    const store = new ConfigStore(dataDir, 5, {
      onRollback: (from, reason) => {
        diagnostics.error('tts.config', `主配置损坏，已回滚到 ${from}`, { reason });
      },
    });
    let config: ReturnType<typeof defaultConfig>;
    try {
      config = store.load();
    } catch (err) {
      diagnostics.error(
        'tts.config',
        `配置加载失败，使用默认配置启动（请检查 dsh-tts-config.json）: ${err instanceof Error ? err.message : String(err)}`,
      );
      config = defaultConfig();
    }

    // ---- 引擎 ----
    const engine = new TtsEngine({ dataDir, diagnostics, initialConfig: config });
    engine.start();

    // ---- StyleInjector：角色提示词注入（动态按当前角色渲染）----
    if (root.inject) {
      root.inject(['systemPrompt'], (ctx) => {
        const systemPrompt = ctx.systemPrompt;
        if (systemPrompt) {
          disposers.push(
            systemPrompt.section({
              name: 'tts:sovits-style',
              order: 131,
              text: () => {
                try {
                  const { text } = resolveInjection(
                    engine.activeConfig.roles,
                    engine.activeConfig.activeRoleId,
                    engine.activeConfig.style.injectionTemplate,
                  );
                  return text;
                } catch (err) {
                  diagnostics.warn('tts.style', `注入解析失败: ${err instanceof Error ? err.message : String(err)}`);
                  return '';
                }
              },
            }),
          );
        }
      });
    }

    // ---- 会话事件：自动播报与 barge-in ----
    // dsh 的 assistant/message 在每轮“每次模型回复”（含带工具调用的中间
    // 回复）都会触发，直接合成会把半截话也读出来。正确时机是 turn/end：
    // 整轮结束（reason=completed）时，用本轮最后一条助手消息文本合成。
    if (root.on) {
      const lastAssistantText = new Map<string, string>();
      disposers.push(
        root.on('session/event', (session: unknown, event: unknown) => {
          const s = session as SessionLike;
          const e = event as SessionEventLike;
          const sid = s?.id ?? 'default';
          if (e?.type === 'assistant/message') {
            lastAssistantText.set(sid, assistantText(e.data?.message as never));
          } else if (e?.type === 'turn/end') {
            // dsh 的 TurnEndReason 是对象 {kind:'completed'|'aborted'|...}；
            // 兼容旧版字符串形态。
            const reasonField = (e.data as { reason?: string | { kind?: string } } | undefined)?.reason;
            const reasonKind = typeof reasonField === 'string' ? reasonField : reasonField?.kind;
            const text = lastAssistantText.get(sid) ?? '';
            lastAssistantText.delete(sid);
            if (reasonKind === 'completed' && engine.activeConfig.playback.autoPlay && text.trim().length > 0) {
              const messageId = `${sid}:${String(e.seq ?? Date.now())}`;
              diagnostics.info('tts.trigger', '回合结束，开始合成最终回复', { messageId, reason: reasonKind });
              engine.speakMessage(messageId, text);
            } else if (reasonKind && reasonKind !== 'completed') {
              diagnostics.info('tts.trigger', `回合结束但未播报（reason=${reasonKind}）`, { sid });
            }
          } else if (e?.type === 'turn/start') {
            lastAssistantText.delete(sid);
          } else if (e?.type === 'user/message') {
            if (engine.activeConfig.playback.bargeInOnUserMessage) {
              diagnostics.info('tts.trigger', '用户新消息，barge-in 停止播报');
              engine.stopAll();
            }
          }
        }) as unknown as () => void,
      );
    }

    // ---- HTTP 面 ----
    const clientJsPath = join(packageRoot, 'assets', 'sovits-widget.js');
    const reader = createClientJsReader(clientJsPath);
    const ffmpegCandidates = [
      join(engine.activeConfig.provider.kind === 'gpt-sovits' ? engine.activeConfig.provider.server.cwd : dataDir, 'runtime', 'ffmpeg.exe'),
      join(engine.activeConfig.provider.kind === 'gpt-sovits' ? engine.activeConfig.provider.server.cwd : dataDir, 'ffmpeg.exe'),
    ];
    const sovitsCwd =
      engine.activeConfig.provider.kind === 'gpt-sovits' ? engine.activeConfig.provider.server.cwd : dataDir;

    if (root.inject) {
      root.inject(['webServer'], (ctx) => {
        const webServer = ctx.webServer;
        if (!webServer) return;
        // 信任栅栏（宿主提供 connection.requestRejection 时委托之）
        const connection = ctx.get?.('connection');
        const fence: TrustFence | undefined =
          connection && typeof (connection as TrustFence).requestRejection === 'function'
            ? (connection as TrustFence)
            : undefined;

        for (const route of buildRoutes({
          engine,
          store,
          diagnostics,
          dataDir,
          clientJsPath,
          readClientJs: () => reader.read(),
          fence,
          sovitsCwd,
          ffmpegCandidates,
        })) {
          disposers.push(route.register(webServer));
        }

        // web 形态：index.html 注入 <script defer>（记录以便诊断注入通道）
        let tapLogged = false;
        disposers.push(
          webServer.tapIndex((html) => {
            if (!tapLogged) {
              tapLogged = true;
              diagnostics.info('tts.client', 'tapIndex 变换被调用（web 路径客户端注入生效）');
            }
            if (html.includes(CLIENT_SCRIPT_URL)) return html;
            const tag = `<script defer src="${CLIENT_SCRIPT_URL}"></script>`;
            if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`);
            return html + tag;
          }),
        );
      });
    }

    // ---- Electron 桌面壳：结构化注入行（tapIndex 在桌面壳不生效）----
    if (root.on) {
      disposers.push(
        root.on('webserver/index-inject', (table: unknown) => {
          if (Array.isArray(table)) {
            const row = desktopInjectRow(CLIENT_SCRIPT_URL);
            const exists = table.some(
              (entry) => entry && typeof entry === 'object' && (entry as { text?: string }).text === row.text,
            );
            if (!exists) table.push(row);
            diagnostics.info('tts.client', `桌面壳收集注入行：本次表长 ${table.length}，本插件行已加入`);
          } else {
            diagnostics.warn('tts.client', 'webserver/index-inject 收到非数组载荷');
          }
        }) as unknown as () => void,
      );
    }

    // ---- 清理 ----
    if (root.effect) {
      root.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // 清理失败不致命
          }
        }
        void engine.dispose();
      });
    }
  },
};
