/**
 * 客户端 API 层：与宿主 /dsh-sovits/* 路由通信。
 */

import type { HealthStatus } from '../host/types.js';
import type { RootConfig } from '../host/config.js';

const BASE = '/dsh-sovits';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // 非 JSON 响应体
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface ClientMessageStatus {
  messageId: string;
  total: number;
  ready: Array<{
    index: number;
    token: string;
    text: string;
    kind: 'audio' | 'webspeech';
    mime?: string;
    sampleRate?: number;
    durationMs?: number;
    emotion?: string;
    fromCache?: boolean;
    error?: string;
  }>;
  done: boolean;
  error?: string;
  degraded: boolean;
  activeRoleId: string;
}

export interface ClientMessageRow {
  messageId: string;
  total: number;
  ready: number;
  done: boolean;
  seq: number;
}

export const api = {
  getConfig: () => json<{ ok: boolean; config: RootConfig }>(`${BASE}/config.json`),
  putConfig: (config: RootConfig) =>
    json<{ ok: boolean }>(`${BASE}/config.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),
  listBackups: () => json<{ ok: boolean; backups: string[] }>(`${BASE}/backups.json`),
  rollback: (file: string) =>
    json<{ ok: boolean }>(`${BASE}/rollback.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    }),
  speak: (text: string, messageId?: string) =>
    json<{ ok: boolean; messageId: string }>(`${BASE}/speak.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, messageId }),
    }),
  stop: (messageId?: string) =>
    json<{ ok: boolean }>(`${BASE}/stop.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    }),
  status: (messageId: string) =>
    json<{ ok: boolean; status: ClientMessageStatus }>(`${BASE}/status.json?messageId=${encodeURIComponent(messageId)}`),
  messages: (since: number) =>
    json<{ ok: boolean; messages: ClientMessageRow[]; lastSeq: number }>(`${BASE}/messages.json?since=${since}`),
  health: () =>
    json<{
      ok: boolean;
      health: HealthStatus;
      provider: string;
      version: string;
      /** 服务端接口代际与探测依据。 */
      protocol: { flavor: 'v2' | 'legacy' | 'n/a'; reason: string };
    }>(`${BASE}/health.json`),
  preview: (text: string, roleId?: string) =>
    json<{ ok: boolean; token: string; error?: string }>(`${BASE}/preview.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, roleId }),
    }),
  audio: (token: string) => fetch(`${BASE}/audio.bin?token=${encodeURIComponent(token)}`, { cache: 'no-store' }),
  exportLogs: () => json<{ ok: boolean; path: string }>(`${BASE}/export-logs.json`, { method: 'POST' }),
  logs: (limit = 100) =>
    json<{ ok: boolean; entries: Array<{ ts: number; level: string; event: string; message: string }> }>(
      `${BASE}/logs.json?limit=${limit}`,
    ),
  refAudios: (dir?: string) =>
    json<{ ok: boolean; dir: string; files: string[] }>(
      `${BASE}/ref-audios.json${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`,
    ),
  uploadAudio: (file: File) =>
    json<{ ok: boolean; path?: string; durationMs?: number; error?: string }>(
      `${BASE}/upload-audio.json?filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    ),
};
