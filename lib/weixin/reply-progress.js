export function resolveReplyProgressMessagesEnabled(cfg) {
    const section = cfg.channels?.["openclaw-weixin"];
    return section?.replyProgressMessages !== false;
}
