/**
 * FormatFlow 本地代理（零依赖，Node 18+）
 * ---------------------------------------------------------------
 * 和 worker/proxy.js 的路由完全一致，只是跑在你自己电脑上。
 *
 * 为什么需要它：Cloudflare 的 *.workers.dev 在国内经常被 DNS 污染 +
 * SNI 重置，页面里填 Worker 地址会直接连不通；而 mineru.net 服务端又
 * 不给浏览器开跨域（带 Origin 时预检返回 403 "Invalid CORS request"），
 * 所以纯前端也直连不了。本地代理这两个问题都没有：
 * mineru.net / 阿里云 OSS 在国内是可达的。
 *
 * 用法（在项目根目录或 worker 目录都行）：
 *   node worker/local-proxy.mjs            # 默认 127.0.0.1:8788
 *   node worker/local-proxy.mjs 9000       # 换端口
 *
 * 然后打开 http://127.0.0.1:8788 —— 这就是本机的完整工具（页面也由
 * 它提供），不需要翻墙，也不涉及密钥写进前端代码。
 *
 * 密钥读取优先级（任一即可，都不会打印明文）：
 *   1. 环境变量 MINERU_API_TOKEN / CLOUDCONVERT_API_KEY
 *   2. 项目根目录 .env 文件（已在 .gitignore 里）
 *   3. 本机 secrets-manager 工具：~/.secrets-manager/secrets.js
 *      （名字 mineru_api_token / cloudconvert）
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const CLOUDCONVERT_API = 'https://api.cloudconvert.com/v2';
const MINERU_API = 'https://mineru.net/api/v4';

const ALLOWED_HOST_SUFFIXES = [
    'mineru.net',
    'api.cloudconvert.com',
    'cloudconvert.com',
    'aliyuncs.com',
    'openxlab.org.cn',
];

// 只在本机回环上监听；写成 0.0.0.0 会让同网段的人共用你的 token。
const HOST = '127.0.0.1';
const PORT = Number(process.argv[2] || process.env.PORT || 8788);

/** 请求体上限：MinerU v4 单文件支持到 200MB，这里留足余量 */
const MAX_BODY = 220 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 密钥加载                                                            */
/* ------------------------------------------------------------------ */

// secrets-manager 里存的名字（和这台机器上已存的一致）；别人用环境变量就行
const SECRET_NAMES = { mineru: 'mineru_api_token', cloudconvert: 'cloudconvert' };

function fromSecretsManager(name) {
    const cli = process.env.SECRETS_CLI || path.join(os.homedir(), '.secrets-manager', 'secrets.js');
    if (!existsSync(cli)) return '';
    try {
        return execFileSync(process.execPath, [cli, 'get', name], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function corsHeaders(origin) {
    return {
        // 回显 Origin 而不是 *，这样将来要带凭证也不会踩 CORS 规则
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Max-Age': '600',
        // Chrome 的 Private Network Access：公网 https 页面访问本机 http 时要这个头
        'Access-Control-Allow-Private-Network': 'true',
        'Vary': 'Origin',
    };
}

function json(res, data, status = 200, origin) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        ...corsHeaders(origin),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function checkTarget(rawTarget) {
    if (!rawTarget) return { error: 'missing target' };
    let parsed;
    try {
        parsed = new URL(rawTarget);
    } catch {
        return { error: 'malformed target' };
    }
    if (parsed.protocol !== 'https:') return { error: 'only https allowed' };
    const ok = ALLOWED_HOST_SUFFIXES.some(
        s => parsed.hostname === s || parsed.hostname.endsWith('.' + s)
    );
    if (!ok) return { error: 'host not allowed: ' + parsed.hostname };
    return { url: parsed.toString() };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function passThrough(res, upstream, origin, overrideType) {
    const type = overrideType || upstream.headers.get('content-type') || 'application/octet-stream';
    const len = upstream.headers.get('content-length');
    res.writeHead(upstream.status, {
        ...corsHeaders(origin),
        'Content-Type': type,
        ...(len ? { 'Content-Length': len } : {}),
    });
    if (!upstream.body) { res.end(); return; }
    await new Promise((resolve, reject) => {
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.on('error', reject);
        res.on('error', reject);
        res.on('close', resolve);
        nodeStream.pipe(res, { end: true });
    });
}

async function upstreamJson(res, upstream, origin) {
    const text = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
    json(res, parsed, upstream.status, origin);
}

/* ------------------------------------------------------------------ */
/* 静态文件：让 http://127.0.0.1:PORT 直接就是完整本地工具             */
/* ------------------------------------------------------------------ */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

async function serveStatic(res, pathname, origin) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    // 只允许仓库内的文件，防止变成任意文件读取
    const full = path.resolve(REPO_ROOT, rel);
    if (!full.startsWith(REPO_ROOT + path.sep) && full !== REPO_ROOT) {
        return json(res, { error: 'forbidden path' }, 403, origin);
    }
    try {
        const buf = await readFile(full);
        res.writeHead(200, {
            ...corsHeaders(origin),
            'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
        });
        res.end(buf);
    } catch {
        json(res, { error: 'not found', path: rel }, 404, origin);
    }
}

/* ------------------------------------------------------------------ */
/* 路由                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    try {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, corsHeaders(origin));
            res.end();
            return;
        }

        if (pathname === '/health' && req.method === 'GET') {
            json(res, {
                ok: true,
                mode: 'local',
                cloudconvert: Boolean(secrets.CLOUDCONVERT_API_KEY),
                mineru: Boolean(secrets.MINERU_API_TOKEN),
            }, 200, origin);
            return;
        }

        /* ---------- CloudConvert ---------- */

        if (pathname === '/jobs' && req.method === 'POST') {
            if (!secrets.CLOUDCONVERT_API_KEY) return json(res, { error: 'CLOUDCONVERT_API_KEY not configured' }, 500, origin);
            const body = await readBody(req);
            const upstream = await fetch(`${CLOUDCONVERT_API}/jobs`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${secrets.CLOUDCONVERT_API_KEY}`, 'Content-Type': 'application/json' },
                body,
            });
            return upstreamJson(res, upstream, origin);
        }

        const ccJob = pathname.match(/^\/jobs\/([^/]+)$/);
        if (ccJob && req.method === 'GET') {
            if (!secrets.CLOUDCONVERT_API_KEY) return json(res, { error: 'CLOUDCONVERT_API_KEY not configured' }, 500, origin);
            const upstream = await fetch(`${CLOUDCONVERT_API}/jobs/${ccJob[1]}`, {
                headers: { Authorization: `Bearer ${secrets.CLOUDCONVERT_API_KEY}` },
            });
            return upstreamJson(res, upstream, origin);
        }

        /* ---------- MinerU 精准解析 v4 ---------- */

        if (pathname === '/mineru/file-urls/batch' && req.method === 'POST') {
            if (!secrets.MINERU_API_TOKEN) return json(res, { error: 'MINERU_API_TOKEN not configured' }, 500, origin);
            const body = await readBody(req);
            const upstream = await fetch(`${MINERU_API}/file-urls/batch`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${secrets.MINERU_API_TOKEN}`, 'Content-Type': 'application/json' },
                body,
            });
            return upstreamJson(res, upstream, origin);
        }

        // 关键：这一路不能带 Content-Type。OSS 预签名地址的签名是按
        // 「无 Content-Type」算的，带了就 SignatureDoesNotMatch。
        if (pathname === '/mineru/upload' && req.method === 'PUT') {
            const target = checkTarget(url.searchParams.get('target'));
            if (target.error) return json(res, { error: target.error }, 400, origin);
            const body = await readBody(req);
            const upstream = await fetch(target.url, { method: 'PUT', body, headers: {} });
            if (!upstream.ok) {
                return json(res, { error: 'upload rejected', status: upstream.status, detail: (await upstream.text()).slice(0, 400) }, upstream.status, origin);
            }
            return json(res, { ok: true }, 200, origin);
        }

        const batch = pathname.match(/^\/mineru\/extract-results\/batch\/([^/]+)$/);
        if (batch && req.method === 'GET') {
            if (!secrets.MINERU_API_TOKEN) return json(res, { error: 'MINERU_API_TOKEN not configured' }, 500, origin);
            const upstream = await fetch(`${MINERU_API}/extract-results/batch/${batch[1]}`, {
                headers: { Authorization: `Bearer ${secrets.MINERU_API_TOKEN}` },
            });
            return upstreamJson(res, upstream, origin);
        }

        if (pathname === '/mineru/download' && req.method === 'GET') {
            const target = checkTarget(url.searchParams.get('target'));
            if (target.error) return json(res, { error: target.error }, 400, origin);
            const upstream = await fetch(target.url);
            if (!upstream.ok) return json(res, { error: 'download failed', status: upstream.status }, upstream.status, origin);
            return passThrough(res, upstream, origin, upstream.headers.get('content-type') || 'application/zip');
        }

        /* ---------- 其它路径当静态文件处理 ---------- */

        if (req.method === 'GET' || req.method === 'HEAD') {
            if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
            return serveStatic(res, pathname, origin);
        }

        json(res, { error: 'Not found', pathname }, 404, origin);
    } catch (e) {
        json(res, { error: e.message }, 500, origin);
    }
});

/* ------------------------------------------------------------------ */
/* 启动                                                              */
/* ------------------------------------------------------------------ */

// 先按 环境变量 → .env → secrets-manager 的优先级把密钥凑齐
const secrets = { MINERU_API_TOKEN: '', CLOUDCONVERT_API_KEY: '' };

function loadSecrets() {
    const envFile = readDotEnv();
    for (const key of Object.keys(secrets)) {
        secrets[key] = (process.env[key] || envFile[key] || '').trim();
    }
    if (!secrets.MINERU_API_TOKEN) {
        secrets.MINERU_API_TOKEN = fromSecretsManager(SECRET_NAMES.mineru);
    }
    if (!secrets.CLOUDCONVERT_API_KEY) {
        secrets.CLOUDCONVERT_API_KEY = fromSecretsManager(SECRET_NAMES.cloudconvert);
    }
}

function readDotEnv() {
    const envPath = path.join(REPO_ROOT, '.env');
    if (!existsSync(envPath)) return {};
    const out = {};
    try {
        for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
            if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch { /* ignore */ }
    return out;
}

loadSecrets();

const indexExists = existsSync(path.join(REPO_ROOT, 'index.html'));

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`端口 ${PORT} 已被占用：要么已经有一个本地代理在跑（直接用它就行），` +
            `要么换个端口：node worker/local-proxy.mjs ${PORT + 1}`);
    } else if (e.code === 'EACCES') {
        console.error(`没有权限监听 ${HOST}:${PORT}，换个端口。`);
    } else {
        console.error('启动失败：', e.message);
    }
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    const mask = (v) => v ? `已加载（${v.slice(0, 4)}…${v.length} 位）` : '未找到';
    console.log(`FormatFlow 本地代理已启动： http://${HOST}:${PORT}`);
    console.log(`  MinerU token  : ${mask(secrets.MINERU_API_TOKEN)}`);
    console.log(`  CloudConvert  : ${mask(secrets.CLOUDCONVERT_API_KEY)}`);
    console.log(indexExists
        ? `  页面          : 直接用浏览器打开 http://${HOST}:${PORT} 就是完整工具`
        : `  页面          : 仓库里没找到 index.html，只当代理用；在线页面把代理地址填 http://${HOST}:${PORT} 即可`);
    if (!secrets.MINERU_API_TOKEN) {
        console.log('  提示：MinerU 用不了（PDF 会退回 CloudConvert）。可以从 https://mineru.net/apiManage/token 拿 token 后设成环境变量 MINERU_API_TOKEN，或写进项目根目录 .env。');
    }
    console.log('  Ctrl+C 退出。密钥只在内存里，不会打印明文、不会写盘。');
});
