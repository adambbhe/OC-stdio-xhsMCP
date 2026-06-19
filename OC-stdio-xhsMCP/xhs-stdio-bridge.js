#!/usr/bin/env node
/*
 * xhs-stdio-bridge.js  (v1.2)
 * OpenClaw stdio <-> xiaohongshu-mcp HTTP(SSE) 协议桥接
 *
 * 特性：
 *   - 分级超时：tools/call 300s，其余 30s
 *   - 会话自愈：Mcp-Session-Id 失效(404/400)自动重新 initialize 并重试一次
 *   - 通知转发：转发无 id 的 notifications（如 notifications/initialized）
 *   - 发布幂等去重：publish_content / publish_with_video 按内容指纹去重，
 *       挡住「在途重试 / 超时后重试 / 桥重启后重试」三类重复发布
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const XHS_URL = 'http://127.0.0.1:18060/mcp';

const TOOL_TIMEOUT = 300000;     // 工具调用 5 分钟（发视频/全量评论较慢）
const DEFAULT_TIMEOUT = 30000;   // 其他请求 30 秒

// ---- 发布幂等去重配置 ----
const DEDUP_FILE = '/home/it/.xhs-publish-dedup.json';
const DEDUP_TTL = 6 * 3600 * 1000;          // 已确认成功：6h 内同内容视为重复
const UNCERTAIN_COOLDOWN = 15 * 60 * 1000;  // 超时/结果未知：15min 内抑制重试
const PUBLISH_TOOLS = new Set(['publish_content', 'publish_with_video']);

let sessionId = null;
let initParams = null;            // 记住 initialize 参数，供会话自愈重放

// 去重持久化存储（桥随 gateway 重启，须落盘）
let dedup = {};
try { dedup = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')); } catch (_) { dedup = {}; }
const inflight = new Map();       // key -> Promise（在途发布请求）

function saveDedup() {
  const now = Date.now();
  for (const k of Object.keys(dedup)) {
    if (now - dedup[k].ts > DEDUP_TTL) delete dedup[k];
  }
  try { fs.writeFileSync(DEDUP_FILE, JSON.stringify(dedup)); } catch (_) {}
}

function publishKey(a) {
  a = a || {};
  const media = [].concat(a.images || [], a.video || []).slice().sort();
  const basis = JSON.stringify({
    t: a.title, c: a.content, m: media, g: (a.tags || []).slice().sort()
  });
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

function dupResult(text) {
  return { jsonrpc: '2.0', result: { content: [{ type: 'text', text }], isError: false } };
}

function parseSseText(text) {
  let jsonStr = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) jsonStr = line.slice(6);
  }
  return JSON.parse(jsonStr);
}

async function rawRequest(method, params, id, timeout) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'   // 必须
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body = { jsonrpc: '2.0', method, params };
  if (id !== undefined && id !== null) body.id = id;   // 无 id 即为通知

  const response = await fetch(XHS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });

  const newSession = response.headers.get('Mcp-Session-Id');
  if (newSession) sessionId = newSession;
  return response;
}

async function xhsRequest(method, params, id) {
  const timeout = method === 'tools/call' ? TOOL_TIMEOUT : DEFAULT_TIMEOUT;
  if (method === 'initialize') initParams = params;

  let response = await rawRequest(method, params, id, timeout);

  // 会话自愈：会话失效（404/400）时清空 sessionId，重放 initialize 后重试一次
  if ((response.status === 404 || response.status === 400)
      && sessionId && method !== 'initialize' && initParams) {
    sessionId = null;
    const reinit = await rawRequest('initialize', initParams, 'reinit', DEFAULT_TIMEOUT);
    await reinit.text();           // 读掉响应体完成握手
    response = await rawRequest(method, params, id, timeout);
  }

  const text = await response.text();
  const ct = response.headers.get('content-type') || '';
  return ct.includes('text/event-stream') ? parseSseText(text) : JSON.parse(text);
}

// 发布类工具：幂等去重包装
async function handleToolCall(params, id) {
  const name = params && params.name;
  if (!PUBLISH_TOOLS.has(name)) return xhsRequest('tools/call', params, id);

  const key = publishKey(params.arguments);
  const now = Date.now();
  const rec = dedup[key];

  // 1) 已确认成功 → 直接返回，不再发布
  if (rec && rec.state === 'done' && now - rec.ts < DEDUP_TTL) {
    return dupResult('检测到相同内容已于近期成功发布，已抑制重复发布。');
  }
  // 2) 上次超时/结果未知 → 冷却期内抑制，提示核实
  if (rec && rec.state === 'uncertain' && now - rec.ts < UNCERTAIN_COOLDOWN) {
    return dupResult('相同内容的上一次发布已提交但响应超时，结果未知，已抑制重复发布。'
      + '请用 list_feeds 核实是否已发出，确认未发出再重试。');
  }
  // 3) 正在进行中 → 复用同一在途请求，绝不二次发送
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const r = await xhsRequest('tools/call', params, id);
      const failed = (r && r.result && r.result.isError) || (r && r.error);
      dedup[key] = { state: failed ? 'uncertain' : 'done', ts: Date.now() };
      saveDedup();
      return r;
    } catch (e) {
      // 超时/网络错误：后端可能已发布 → 标记 uncertain，抑制后续重试
      dedup[key] = { state: 'uncertain', ts: Date.now() };
      saveDedup();
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

// ---- stdin：逐行读取 JSON-RPC 并转发 ----
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let nl;
  while ((nl = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, nl).trim();
    stdinBuffer = stdinBuffer.slice(nl + 1);
    if (!line) continue;

    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }

    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId) {
      const p = (msg.method === 'tools/call')
        ? handleToolCall(msg.params, String(msg.id))
        : xhsRequest(msg.method, msg.params, String(msg.id));
      p.then(r => process.stdout.write(JSON.stringify(r) + '\n'))
       .catch(e => process.stdout.write(JSON.stringify({
         jsonrpc: '2.0', id: String(msg.id),
         error: { code: -32603, message: e.message }
       }) + '\n'));
    } else if (msg.method) {
      // 通知（如 notifications/initialized）：fire-and-forget
      xhsRequest(msg.method, msg.params, undefined).catch(() => {});
    }
  }
});
