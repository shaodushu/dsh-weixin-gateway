/**
 * SILK 语音转码 stub（垂直切片阶段）。
 *
 * 原实现使用 silk-wasm 把微信 SILK 音频转成 WAV；
 * 调用方有 fallback（转码失败时保存原始 SILK），
 * 这里先返回 null 走 fallback，后续需要语音能力再接入 silk-wasm。
 */
export async function silkToWav(_silkBuf) {
    return null;
}
