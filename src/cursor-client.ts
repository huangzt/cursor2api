/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 发送请求到 https://cursor.com/api/chat（带 TLS 指纹模拟 headers）
 * 2. 生成 x-is-human token（在 Node.js 进程内执行 Cursor 验证脚本）
 * 3. 管理 token 生命周期（25分钟有效期，提前刷新）
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

// Chrome 浏览器请求头模拟
function getChromeHeaders(xIsHuman: string): Record<string, string> {
    const config = getConfig();
    return {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/en-US/docs',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.fingerprint.userAgent,
        'x-is-human': xIsHuman,
    };
}

// ==================== Token 管理 ====================

let envJS: string = '';
let mainJS: string = '';

interface TokenEntry {
    value: string;
    createdAt: number;
}
const tokenPool: TokenEntry[] = [];
const MAX_POOL_SIZE = 5;
let isGenerating = false;

const TOKEN_EXPIRY_MS = 25 * 60 * 1000; // 25 分钟
const TOKEN_REFRESH_MS = 20 * 60 * 1000; // 20 分钟时刷新

/**
 * 加载 JS 脚本模板
 */
export function loadScripts(): void {
    if (existsSync('jscode/env.js')) {
        envJS = readFileSync('jscode/env.js', 'utf-8');
        console.log('[Token] 已加载 env.js');
    } else {
        console.warn('[Token] ⚠ jscode/env.js 不存在，token 生成将失败');
    }

    if (existsSync('jscode/main.js')) {
        mainJS = readFileSync('jscode/main.js', 'utf-8');
        console.log('[Token] 已加载 main.js');
    } else {
        console.warn('[Token] ⚠ jscode/main.js 不存在，token 生成将失败');
    }
}

/**
 * 获取验证脚本（从 Cursor CDN）
 */
async function fetchCursorScript(): Promise<string> {
    const config = getConfig();
    if (!config.scriptUrl) throw new Error('script_url 未配置');

    const resp = await fetch(config.scriptUrl, {
        headers: {
            'sec-ch-ua-arch': '"x86"',
            'sec-ch-ua-platform': '"Windows"',
            'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
            'sec-ch-ua-bitness': '"64"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform-version': '"19.0.0"',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-dest': 'script',
            'referer': 'https://cursor.com/',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'user-agent': config.fingerprint.userAgent,
        },
    });

    if (!resp.ok) throw new Error(`获取验证脚本失败: HTTP ${resp.status}`);
    return resp.text();
}

/**
 * 生成 x-is-human token
 * 在 Node.js 进程内执行 Cursor 的验证 JS 脚本
 */
async function generateToken(): Promise<string> {
    const config = getConfig();

    if (!envJS || !mainJS) {
        throw new Error('JS 脚本未加载，请确保 jscode/env.js 和 jscode/main.js 存在');
    }

    // 获取 Cursor 验证脚本
    const cursorJS = await fetchCursorScript();

    // 构建完整 JS 代码
    const code = mainJS
        .replace('$$currentScriptSrc$$', config.scriptUrl)
        .replace('$$UNMASKED_VENDOR_WEBGL$$', config.fingerprint.unmaskedVendorWebGL)
        .replace('$$UNMASKED_RENDERER_WEBGL$$', config.fingerprint.unmaskedRendererWebGL)
        .replace('$$userAgent$$', config.fingerprint.userAgent)
        .replace('$$env_jscode$$', envJS)
        .replace('$$cursor_jscode$$', cursorJS);

    // 写入临时文件并用 Node.js 子进程执行
    // 使用子进程而非 vm 模块，因为验证脚本可能依赖全局对象
    const tmpPath = join(tmpdir(), `cursor_token_${randomUUID()}.js`);
    writeFileSync(tmpPath, code, 'utf-8');

    try {
        const output = execSync(`node "${tmpPath}"`, {
            timeout: 30000,
            encoding: 'utf-8',
        });
        return output.trim();
    } finally {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

/**
 * 异步补充 Token 池
 */
async function replenishPool(): Promise<void> {
    if (isGenerating) return;
    isGenerating = true;
    try {
        console.log(`[Token] 补充 token 池 (当前有效: ${tokenPool.length}/${MAX_POOL_SIZE})...`);
        const token = await generateToken();
        tokenPool.push({ value: token, createdAt: Date.now() });
        console.log(`[Token] ✓ 成功添加到资源池 (当前大小: ${tokenPool.length})`);
    } catch (e) {
        console.error('[Token] ✗ 补充池失败:', e);
    } finally {
        isGenerating = false;
    }
}

/**
 * 获取有效的 x-is-human token（从池中随机抽取以分散风控特征）
 */
export async function getXIsHumanToken(): Promise<string> {
    // 如果没有脚本，返回空（某些场景可能不需要 token）
    if (!envJS || !mainJS) {
        console.warn('[Token] JS 脚本未加载，跳过 token 生成');
        return '';
    }

    const now = Date.now();

    // 1. 清理过期 Token (>=25分钟)
    for (let i = tokenPool.length - 1; i >= 0; i--) {
        if (now - tokenPool[i].createdAt >= TOKEN_EXPIRY_MS) {
            tokenPool.splice(i, 1);
        }
    }

    // 2. 筛选仍然新鲜的 Token (<20分钟)
    const freshTokens = tokenPool.filter(t => (now - t.createdAt) < TOKEN_REFRESH_MS);

    // 3. 如果池子没满，且当前没有在生成，则异步触发补充机制
    if (freshTokens.length < MAX_POOL_SIZE && !isGenerating) {
        // 后台异步生成，不阻塞请求
        replenishPool().catch(console.error);
    }

    // 4. 如果有新鲜 token，从中随机挑选一个（分散风控特征）
    if (freshTokens.length > 0) {
        const randomIndex = Math.floor(Math.random() * freshTokens.length);
        return freshTokens[randomIndex].value;
    }

    // 5. 如果没有新鲜的，但有即将过期的 (20-25分钟内)，作为过渡先使用最近生成的一个
    if (tokenPool.length > 0) {
        const lastValid = [...tokenPool].sort((a, b) => b.createdAt - a.createdAt)[0];
        console.warn('[Token] 暂无新鲜 token，使用临近过期的就近 token 作为过渡');
        return lastValid.value;
    }

    // 6. 连过期的都没有，只能同步阻塞等待生成一个
    try {
        console.log('[Token] 资源池为空，同步等待生成新 token...');
        const token = await generateToken();
        tokenPool.push({ value: token, createdAt: Date.now() });
        console.log('[Token] ✓ 同步生成成功');
        return token;
    } catch (e) {
        console.error('[Token] ✗ 同步生成失败:', e);
        return '';
    }
}

// ==================== API 请求 ====================

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应（带重试）
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sendCursorRequestInner(req, onChunk);
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg}`);
            if (attempt < maxRetries) {
                console.log(`[Cursor] ${2}s 后重试...`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const token = await getXIsHumanToken();
    const headers = getChromeHeaders(token);

    console.log(`[Cursor] 发送请求: model=${req.model}, messages=${req.messages.length}`);

    // 请求级超时
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000); // 2分钟

    try {
        const resp = await fetch(CURSOR_CHAT_API, {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Cursor API 错误: HTTP ${resp.status} - ${body}`);
        }

        if (!resp.body) {
            throw new Error('Cursor API 响应无 body');
        }

        // 流式读取 SSE 响应
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch {
                    // 非 JSON 数据，忽略
                }
            }
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data) {
                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch { /* ignore */ }
            }
        }
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 发送非流式请求，收集完整响应
 */
export async function sendCursorRequestFull(req: CursorChatRequest): Promise<string> {
    let fullText = '';
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
    });
    return fullText;
}
