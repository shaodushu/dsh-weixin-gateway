/**
 * ai-config — AI 能力（语音转文字 / 图像理解 / 文生图 / 语音合成）配置中枢。
 *
 * 每个能力可完全独立配置（各自 端点+密钥+模型）；未单独配置的能力回退到
 * 全局一组凭据（AI_GATEWAY_BASE_URL/AI_GATEWAY_KEY，兼容早期单网关配置）。
 * 判定优先级（每能力独立，取第一个满足的分支）：
 *   1. 能力级：${PREFIX}BASE_URL 与 ${PREFIX}KEY 均非空 → 模型用 ${PREFIX}MODEL 或默认值
 *   2. 全局 fallback：AI_GATEWAY_BASE_URL 与 AI_GATEWAY_KEY 均非空 → 模型用该能力默认值
 *   3. 未配置 → null（调用方降级或抛错提示）
 *
 * 本模块同时承载 setup 交互式引导的纯逻辑（问题清单构建、.env 文本 upsert），
 * cli.ts 与 ai-service.ts 共用，消除 REPO_ROOT/.env 逻辑重复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateDir } from './storage/state-dir.js';
/** 4 个能力的单一定义源（新增能力时在此注册一组即可，cli 引导自动覆盖）。 */
export const AI_CAPABILITIES = [
    { id: 'asr', label: '语音转文字', prefix: 'AI_ASR_', defaultModel: 'SenseVoiceSmall', endpointPath: '/audio/transcriptions' },
    { id: 'vision', label: '图像理解', prefix: 'AI_VISION_', defaultModel: 'qwen2.5-vl', endpointPath: '/chat/completions' },
    { id: 'image', label: '文生图', prefix: 'AI_IMAGE_', defaultModel: 'gpt-image-2', endpointPath: '/images/generations' },
    { id: 'tts', label: '语音合成', prefix: 'AI_TTS_', defaultModel: 'IndexTTS-1.5', endpointPath: '/audio/speech' },
];
/** 按 id 取能力定义。 */
export function capabilityDef(id) {
    const def = AI_CAPABILITIES.find((d) => d.id === id);
    if (!def)
        throw new Error(`未知 AI 能力: ${id}`);
    return def;
}
/** 仓库根目录（找旧位置 .env 用；源码为 src/weixin/.. = 仓库根，编译产物为 lib/weixin/.. = 包安装根）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * .env 固定位置：<stateDir>/weixin-dsh/.env。
 *
 * 为什么不用 REPO_ROOT/.env：同一插件存在多个 lib 副本（全局 CLI 装在
 * npm 全局目录、profile bundle 装在 ~/.dsh/profiles/<p>/、仓库开发模式
 * 在仓库根），每个副本的 REPO_ROOT 都不同——配置写一处、另一处读不到
 * （实测：全局 CLI setup 引导读不到仓库 .env，4 个能力全判未配置）。
 * 固定位置经 resolveStateDir() 解析，所有副本（daemon/CLI/profile）都
 * 指向同一个 ~/.openclaw/weixin-dsh/.env，且测试可用 OPENCLAW_STATE_DIR 隔离。
 */
export function envPath() {
    return path.join(resolveStateDir(), 'weixin-dsh', '.env');
}
/** 记录每个加载目标（文件路径）注入过的键（reloadAiEnv 只清默认路径的，不误删其他来源）。 */
const injectedByFile = new Map();
/**
 * 极简 .env 加载（KEY=VALUE 逐行，不覆盖已存在的环境变量；envPath 供测试注入临时文件）。
 * 默认加载固定位置，并兼容加载 REPO_ROOT/.env（0.2.x 旧位置兜底）。
 * 不做"已加载"缓存：文件很小，每次调用读一次无妨。
 */
export function loadEnvFile(p = envPath()) {
    for (const target of [p, p === envPath() ? path.join(REPO_ROOT, '.env') : '']) {
        if (!target)
            continue;
        try {
            const raw = fs.readFileSync(target, 'utf8');
            for (const line of raw.split('\n')) {
                const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
                if (m && process.env[m[1]] === undefined) {
                    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
                    let keys = injectedByFile.get(target);
                    if (!keys) {
                        keys = new Set();
                        injectedByFile.set(target, keys);
                    }
                    keys.add(m[1]);
                }
            }
        }
        catch {
            // .env 不存在时静默
        }
    }
}
/**
 * 丢弃此前从固定位置 .env 注入的键并重新加载（setup 写入 .env 后刷新内存
 * 快照用：不重载则摘要/后续判定仍显示旧值——实测 r 重配后摘要显示全局、
 * x 清除后摘要仍显示旧能力级配置）。真实环境变量（export 的）不受影响。
 */
export function reloadAiEnv() {
    const p = envPath();
    for (const [target, keys] of injectedByFile) {
        if (target === p) {
            for (const k of keys)
                delete process.env[k];
        }
    }
    injectedByFile.set(p, new Set());
    loadEnvFile();
}
/** 纯解析：env 快照 → 该能力配置（能力级优先 → 全局 fallback → null）。测试直接注入合成 env。 */
export function resolveCapabilityConfig(id, env) {
    const def = capabilityDef(id);
    const capBase = env[`${def.prefix}BASE_URL`]?.trim();
    const capKey = env[`${def.prefix}KEY`]?.trim();
    if (capBase && capKey) {
        return {
            def,
            baseUrl: capBase.replace(/\/+$/, ''),
            apiKey: capKey,
            model: env[`${def.prefix}MODEL`]?.trim() || def.defaultModel,
        };
    }
    const globalBase = env.AI_GATEWAY_BASE_URL?.trim();
    const globalKey = env.AI_GATEWAY_KEY?.trim();
    if (globalBase && globalKey) {
        return { def, baseUrl: globalBase.replace(/\/+$/, ''), apiKey: globalKey, model: def.defaultModel };
    }
    return null;
}
/** 运行时入口：加载 .env 后解析（ai-service 各能力函数用）。 */
export function getCapabilityConfig(id) {
    loadEnvFile();
    return resolveCapabilityConfig(id, process.env);
}
/** 同步判定该能力是否已配置（网关注册工具用）。 */
export function isCapabilityConfigured(id) {
    return getCapabilityConfig(id) !== null;
}
/** 未配置抛错，消息含能力名与所需变量名（ai-service 四个能力函数共用）。 */
export function requireCapabilityConfig(id) {
    const cfg = getCapabilityConfig(id);
    if (!cfg) {
        const def = capabilityDef(id);
        throw new Error(`缺少 ${def.prefix}BASE_URL/${def.prefix}KEY（或全局 AI_GATEWAY_BASE_URL/AI_GATEWAY_KEY）：${def.label}未配置`);
    }
    return cfg;
}
/** 密钥打码显示（sk-****末4位），避免明文出现在终端。 */
function maskKey(key) {
    if (key.length <= 8)
        return '****';
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}
/** 根据 env 快照构建问答束（无交互、纯数据）。 */
export function buildAiConfigQuestions(env = process.env) {
    return AI_CAPABILITIES.map((def) => {
        const current = resolveCapabilityConfig(def.id, env);
        if (current) {
            return {
                capId: def.id,
                label: def.label,
                configured: true,
                current,
                action: {
                    id: `${def.id}.action`,
                    prompt: `${def.label} 已配置（${current.baseUrl}，key ${maskKey(current.apiKey)}），回车保持 / r 重新配置 / x 清除: `,
                },
                fields: [
                    { id: `${def.id}.url`, prompt: `  网关地址 [${current.baseUrl}]: `, defaultValue: current.baseUrl },
                    { id: `${def.id}.key`, prompt: `  API 密钥 [${maskKey(current.apiKey)}]: `, defaultValue: current.apiKey },
                    { id: `${def.id}.model`, prompt: `  模型 [${current.model}]: `, defaultValue: current.model },
                ],
            };
        }
        return {
            capId: def.id,
            label: def.label,
            configured: false,
            current: null,
            fields: [
                { id: `${def.id}.url`, prompt: `${def.label}：网关地址（回车跳过）: ` },
                { id: `${def.id}.key`, prompt: `  API 密钥（必填）: `, required: true },
                { id: `${def.id}.model`, prompt: `  模型 [${def.defaultModel}]: `, defaultValue: def.defaultModel },
            ],
        };
    });
}
/**
 * 纯函数：现有 .env 文本 + 问答结果 → 新文本。只增改涉及行，其余行原样保留。
 * answers 键：`${capId}.url` / `.key` / `.model`（非空才写）；`${capId}.action` === 'x' 删除该组三键。
 * - 'x' 优先于同组写入（防御）；空字符串值不写；
 * - 键已存在 → 替换首个出现行、删除重复行；不存在 → 追加到文件末尾；
 * - 无任何变更时返回原文本（幂等）；发生变更时输出以单个 \n 结尾。
 */
export function applyAiEnvAnswers(existing, answers) {
    const lines = existing.split('\n');
    // 1. 收集删除集（action='x' 的组）与写入映射
    const toDelete = new Set();
    const toWrite = new Map();
    for (const [k, v] of Object.entries(answers)) {
        const dot = k.lastIndexOf('.');
        const cap = k.slice(0, dot);
        const field = k.slice(dot + 1);
        const def = AI_CAPABILITIES.find((d) => d.id === cap);
        if (!def)
            continue;
        if (field === 'action' && v === 'x') {
            toDelete.add(`${def.prefix}BASE_URL`);
            toDelete.add(`${def.prefix}KEY`);
            toDelete.add(`${def.prefix}MODEL`);
        }
        else if (v !== '' && field !== 'action') {
            const envKey = field === 'url' ? `${def.prefix}BASE_URL` : field === 'key' ? `${def.prefix}KEY` : `${def.prefix}MODEL`;
            toWrite.set(envKey, v);
        }
    }
    for (const k of toDelete)
        toWrite.delete(k);
    if (toDelete.size === 0 && toWrite.size === 0)
        return existing;
    // 2. 定位每键的首个出现行，供替换与去重
    const firstIndex = new Map();
    const keyOf = new Map();
    lines.forEach((line, i) => {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        if (!m)
            return;
        const key = m[1];
        keyOf.set(i, key);
        if (!firstIndex.has(key))
            firstIndex.set(key, i);
    });
    // 3. 重写：删 toDelete 行；替换 toWrite 首个行并删重复行；其余原样
    const next = [];
    lines.forEach((line, i) => {
        const key = keyOf.get(i);
        if (!key) {
            next.push(line);
            return;
        }
        if (toDelete.has(key))
            return;
        if (toWrite.has(key)) {
            if (firstIndex.get(key) !== i)
                return; // 重复行删除
            next.push(`${key}=${toWrite.get(key)}`);
            return;
        }
        next.push(line);
    });
    // 4. 追加新键（原文不存在的写入键）；尾部空行占位移除后追加
    while (next.length > 0 && next[next.length - 1] === '')
        next.pop();
    for (const [key, value] of toWrite) {
        if (firstIndex.has(key))
            continue; // 已原地替换
        next.push(`${key}=${value}`);
    }
    let text = next.join('\n');
    if (text !== '')
        text += '\n';
    return text;
}
/** 写回固定位置 .env（权限 0600）。失败返回 false 由调用方打印手动指引。 */
export function writeEnvFile(text) {
    try {
        const p = envPath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text, { mode: 0o600 });
        return true;
    }
    catch {
        return false;
    }
}
/** 非交互环境的手动配置指引文本。 */
export function aiEnvGuide() {
    const rows = AI_CAPABILITIES.map((d) => `    ${d.prefix}BASE_URL / ${d.prefix}KEY / ${d.prefix}MODEL（${d.label}，默认 ${d.defaultModel}）`).join('\n');
    return [
        `  AI 能力环境变量（写入 ${envPath()} 或导出到环境）：`,
        rows,
        `  也可只配全局一组（4 个能力共用，模型用各自默认）：`,
        `    AI_GATEWAY_BASE_URL / AI_GATEWAY_KEY`,
        `  未配置的能力在收消息时静默降级，不影响收发。`,
    ].join('\n');
}
/** 打印用摘要：逐能力 ✅ 地址（模型）/ ⚪ 未配置 → 静默降级。 */
export function summarizeAiConfig(env = process.env) {
    return AI_CAPABILITIES.map((def) => {
        const cfg = resolveCapabilityConfig(def.id, env);
        if (!cfg)
            return `  ⚪ ${def.label}: 未配置 → 静默降级`;
        const source = env[`${def.prefix}BASE_URL`]?.trim() ? '能力级' : '全局';
        return `  ✅ ${def.label}: ${cfg.baseUrl}（${cfg.model}，${source}）`;
    }).join('\n');
}
