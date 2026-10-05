/**
 * 插件 HTTP 面（/dsh-sovits/*）：客户端脚本、配置读写与回滚、合成触发/
 * 停止/状态/音频取件、健康、预览、上传参考音频、诊断导出。
 *
 * 全部 route 走 webServer.register（exact），JSON 一律带 CORS 头；
 * 非回环请求经宿主信任栅栏（ctx.get('connection').requestRejection）审查，
 * 无栅栏时 fail-closed 仅放行回环地址。
 */

import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseConfig, type RootConfig } from './config.js';
import type { ConfigStore } from './config-store.js';
import type { Diagnostics } from './diagnostics.js';
import type { TtsEngine } from './engine.js';
import { processReferenceAudio } from './audio-tool.js';

/** duck-typed 请求/响应/WebServer（不依赖 @deepseek-ai 包，宿主实现兼容）。 */
export interface HttpRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  connection?: { remoteAddress?: string };
  on?: (event: 'data', cb: (chunk: Uint8Array | string) => void) => unknown;
  once?: (event: 'end' | 'error', cb: (...args: unknown[]) => void) => unknown;
}

export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): unknown;
  setHeader?(name: string, value: string): unknown;
  end(body?: string | Uint8Array): unknown;
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>;
  }): () => void;
  tapIndex(fn: (html: string) => string): () => void;
}

export interface TrustFence {
  requestRejection?(req: HttpRequestLike): string | null | undefined;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

const AUDIO_HEADERS = {
  'Content-Type': 'audio/wav',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Access-Control-Allow-Origin': '*',
};

const JS_HEADERS = {
  'Content-Type': 'text/javascript; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface RoutesOptions {
  engine: TtsEngine;
  store: ConfigStore;
  diagnostics: Diagnostics;
  dataDir: string;
  /** 客户端 bundle 文件路径（由宿主从 assets 定位）。 */
  clientJsPath: string;
  /** 客户端 bundle 内容提供者（热读）。 */
  readClientJs: () => string;
  /** 信任栅栏（可选）。 */
  fence?: TrustFence;
  /** sovits 工作目录（ref-audios 相对路径解析用）。 */
  sovitsCwd: string;
  /** ffmpeg 候选路径。 */
  ffmpegCandidates: string[];
}

export interface RouteEntry {
  path: string;
  register(webServer: WebServerLike): () => void;
}

/** 请求体流（duck-typed 附加字段）。 */
interface BodyStreamLike extends HttpRequestLike {
  complete?: boolean;
  readableEnded?: boolean;
}

/** 读取请求体（二进制，带大小上限与超时兜底）。 */
export function readBodyBuffer(req: HttpRequestLike): Promise<Uint8Array> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = req as BodyStreamLike;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolvePromise(Buffer.concat(chunks));
    };
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      rejectPromise(err);
    };
    // 请求体已完整交付（无 body / 已被消费）：立即完成
    if (stream.complete === true && stream.readableEnded === true) {
      finish();
      return;
    }
    req.on?.('data', (chunk) => {
      if (done) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > MAX_BODY_BYTES) {
        fail(new Error('请求体过大'));
        return;
      }
      chunks.push(buf);
    });
    req.once?.('end', finish);
    req.once?.('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    // 兜底：事件已错过（如已消费完）时立即完成
    if (stream.readableEnded === true) finish();
  });
}

/** 读取请求体为 UTF-8 文本。 */
export async function readBody(req: HttpRequestLike): Promise<string> {
  return Buffer.from(await readBodyBuffer(req)).toString('utf8');
}

export function sendJson(res: HttpResponseLike, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

export function isLoopback(req: HttpRequestLike): boolean {
  const addr = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

/** 信任审查：拒绝则返回拒绝原因字符串；放行返回 null。 */
export function auditRequest(fence: TrustFence | undefined, req: HttpRequestLike): string | null {
  if (fence?.requestRejection) {
    const rejection = fence.requestRejection(req);
    if (rejection) return rejection;
    return null;
  }
  if (!isLoopback(req)) return '非回环请求被拒绝（无信任栅栏，fail-closed）';
  return null;
}

/**
 * 组装全部路由。
 */
export function buildRoutes(options: RoutesOptions): RouteEntry[] {
  const { engine, store, diagnostics, dataDir, readClientJs, fence, sovitsCwd, ffmpegCandidates } = options;
  const guard =
    (handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>) =>
    async (req: HttpRequestLike, res: HttpResponseLike): Promise<void> => {
      const rejection = auditRequest(fence, req);
      if (rejection) {
        sendJson(res, 403, { ok: false, error: rejection });
        return;
      }
      try {
        await handler(req, res);
      } catch (err) {
        diagnostics.error('tts.http', `路由处理失败: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };

  const routes: RouteEntry[] = [
    // ---- 客户端脚本 ----
    {
      path: '/dsh-sovits/client.js',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/client.js',
          handler: guard((_req, res) => {
            res.writeHead(200, JS_HEADERS);
            res.end(readClientJs());
          }),
        }),
    },

    // ---- 配置 ----
    {
      path: '/dsh-sovits/config.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/config.json',
          handler: guard(async (req, res) => {
            // GET 读取 / PUT 保存（同一路径按方法分发，宿主路由不允许重复注册）
            if ((req.method ?? 'GET').toUpperCase() === 'PUT') {
              const body = await readBody(req);
              let next: RootConfig;
              try {
                next = parseConfig(JSON.parse(body) as unknown);
              } catch (err) {
                sendJson(res, 400, {
                  ok: false,
                  error: `配置校验失败: ${err instanceof Error ? err.message : String(err)}`,
                });
                return;
              }
              store.save(next); // 原子写 + 备份回滚链
              engine.applyConfig(next);
              diagnostics.info('tts.config', '配置已保存（已备份旧配置）');
              sendJson(res, 200, { ok: true });
              return;
            }
            sendJson(res, 200, { ok: true, config: engine.activeConfig });
          }),
        }),
    },
    {
      path: '/dsh-sovits/backups.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/backups.json',
          handler: guard((_req, res) => {
            sendJson(res, 200, { ok: true, backups: store.listBackups().map((p) => basename(p)) });
          }),
        }),
    },
    {
      path: '/dsh-sovits/rollback.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/rollback.json',
          handler: guard(async (req, res) => {
            const body = JSON.parse(await readBody(req)) as { file?: string };
            if (!body.file || !body.file.startsWith('dsh-tts-config.json.bak-')) {
              sendJson(res, 400, { ok: false, error: '非法的备份文件名' });
              return;
            }
            const backupPath = join(store.configDir, basename(body.file));
            if (!existsSync(backupPath)) {
              sendJson(res, 404, { ok: false, error: '备份不存在' });
              return;
            }
            const raw = readFileSync(backupPath, 'utf8');
            const restored = parseConfig(JSON.parse(raw) as unknown);
            writeFileSync(store.filePath, `${JSON.stringify(restored, null, 2)}\n`, 'utf8');
            engine.applyConfig(restored);
            diagnostics.info('tts.config', `配置已回滚: ${body.file}`);
            sendJson(res, 200, { ok: true });
          }),
        }),
    },

    // ---- 合成控制 ----
    {
      path: '/dsh-sovits/speak.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/speak.json',
          handler: guard(async (req, res) => {
            const body = JSON.parse(await readBody(req)) as { text?: string; messageId?: string };
            const text = (body.text ?? '').trim();
            if (!text) {
              sendJson(res, 400, { ok: false, error: '文本为空' });
              return;
            }
            const messageId = body.messageId && body.messageId.length <= 200 ? body.messageId : randomUUID();
            engine.speakMessage(messageId, text);
            sendJson(res, 200, { ok: true, messageId });
          }),
        }),
    },
    {
      path: '/dsh-sovits/stop.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/stop.json',
          handler: guard(async (req, res) => {
            const body = JSON.parse(await readBody(req)) as { messageId?: string };
            if (body.messageId) engine.stopMessage(body.messageId);
            else engine.stopAll();
            sendJson(res, 200, { ok: true });
          }),
        }),
    },
    {
      path: '/dsh-sovits/status.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/status.json',
          handler: guard((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const messageId = url.searchParams.get('messageId') ?? '';
            const status = messageId ? engine.getStatus(messageId) : null;
            if (!status) {
              sendJson(res, 404, { ok: false, error: '未知消息' });
              return;
            }
            sendJson(res, 200, { ok: true, status });
          }),
        }),
    },
    {
      path: '/dsh-sovits/audio.bin',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/audio.bin',
          handler: guard((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const token = url.searchParams.get('token') ?? '';
            const audio = engine.getAudio(token);
            if (!audio) {
              sendJson(res, 404, { ok: false, error: '音频已失效' });
              return;
            }
            res.writeHead(200, { ...AUDIO_HEADERS, 'Content-Length': String(audio.audio.byteLength) });
            res.end(audio.audio);
          }),
        }),
    },
    {
      path: '/dsh-sovits/messages.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/messages.json',
          handler: guard((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const since = Number(url.searchParams.get('since') ?? '-1');
            const list: Array<{ messageId: string; total: number; ready: number; done: boolean; seq: number }> = [];
            let seq = 0;
            for (const messageId of engine.messageIds()) {
              const status = engine.getStatus(messageId);
              if (!status) continue;
              if (seq > since) {
                list.push({ messageId, total: status.total, ready: status.ready.length, done: status.done, seq });
              }
              seq += 1;
            }
            sendJson(res, 200, { ok: true, messages: list, lastSeq: seq - 1 });
          }),
        }),
    },

    // ---- 健康 / 预览 / 诊断 ----
    {
      path: '/dsh-sovits/health.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/health.json',
          handler: guard((_req, res) => {
            sendJson(res, 200, {
              ok: true,
              health: engine.healthStatus,
              provider: engine.activeConfig.provider.kind,
              protocol: engine.protocolInfo,
              version: '0.1.0',
            });
          }),
        }),
    },
    {
      path: '/dsh-sovits/preview.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/preview.json',
          handler: guard(async (req, res) => {
            const body = JSON.parse(await readBody(req)) as { text?: string; roleId?: string };
            const result = await engine.preview(body.text ?? '你好，这是音色预览。', body.roleId);
            sendJson(res, result.ok ? 200 : 400, { ok: result.ok, token: result.token, error: result.error });
          }),
        }),
    },
    {
      path: '/dsh-sovits/export-logs.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/export-logs.json',
          handler: guard((_req, res) => {
            const path = engine.exportDiagnostics();
            sendJson(res, 200, { ok: true, path });
          }),
        }),
    },
    {
      path: '/dsh-sovits/logs.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/logs.json',
          handler: guard((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
            sendJson(res, 200, { ok: true, entries: engine.diagnosticsEntries(limit) });
          }),
        }),
    },

    // ---- 参考音频 ----
    {
      path: '/dsh-sovits/ref-audios.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/ref-audios.json',
          handler: guard((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const requested = url.searchParams.get('dir') ?? engine.activeConfig.audio.refAudioDir;
            const dir = isAbsolute(requested) ? requested : resolve(sovitsCwd || dataDir, requested);
            let files: string[] = [];
            try {
              files = readdirSync(dir)
                .filter((n) => /\.(wav|mp3|flac|ogg|m4a)$/i.test(n))
                .sort();
            } catch {
              files = [];
            }
            sendJson(res, 200, { ok: true, dir, files });
          }),
        }),
    },
    {
      path: '/dsh-sovits/upload-audio.json',
      register: (webServer) =>
        webServer.register({
          kind: 'exact',
          path: '/dsh-sovits/upload-audio.json',
          handler: guard(async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const filename = basename(url.searchParams.get('filename') ?? 'upload.wav');
            const ext = extname(filename).toLowerCase();
            if (!['.wav', '.mp3', '.flac', '.ogg', '.m4a'].includes(ext)) {
              sendJson(res, 400, { ok: false, error: '不支持的音频格式（wav/mp3/flac/ogg/m4a）' });
              return;
            }
            const body = await readBodyBuffer(req);
            const uploadDir = engine.activeConfig.audio.uploadDir || join(dataDir, 'sovits', 'audio');
            mkdirSync(uploadDir, { recursive: true });
            const tmp = join(uploadDir, `upload-${randomUUID()}${ext}`);
            writeFileSync(tmp, body);
            const result = processReferenceAudio(tmp, {
              outputDir: uploadDir,
              ffmpegPath: engine.activeConfig.audio.ffmpegPath,
              extraCandidates: ffmpegCandidates,
              maxSeconds: engine.activeConfig.audio.trimMaxSeconds,
              minSeconds: engine.activeConfig.audio.trimMinSeconds,
              diagnostics,
            });
            sendJson(res, result.ok ? 200 : 400, {
              ok: result.ok,
              path: result.path,
              durationMs: result.durationMs,
              error: result.error,
            });
          }),
        }),
    },
  ];

  return routes;
}

/** 注入客户端脚本到 index.html（web 形态）与桌面壳（webserver/index-inject 行）。 */
export function clientScriptTag(scriptUrl: string): string {
  return `<script defer src="${scriptUrl}"></script>`;
}

/** 桌面形态结构化注入行（Electron 宿主契约，与 dsh-whale-widget 相同）。 */
export function desktopInjectRow(scriptUrl: string): { kind: string; placement: string; text: string } {
  const text =
    '(function(){try{var d=document.body||document.head||document.documentElement;' +
    `var s=document.createElement("script");s.src=${JSON.stringify(scriptUrl)};` +
    's.onerror=function(){};d.appendChild(s)}catch(e){}})()';
  return { kind: 'script', placement: 'body', text };
}

/** 客户端 bundle 热读（按 mtime 缓存，同 dsh-whale-widget）。 */
export function createClientJsReader(clientJsPath: string): { read: () => string } {
  let cache: { mtimeMs: number; text: string } | null = null;
  return {
    read: (): string => {
      const stat = statSync(clientJsPath);
      if (cache && cache.mtimeMs === stat.mtimeMs) return cache.text;
      cache = { mtimeMs: stat.mtimeMs, text: readFileSync(clientJsPath, 'utf8') };
      return cache.text;
    },
  };
}
