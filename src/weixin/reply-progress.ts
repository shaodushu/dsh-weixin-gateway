import type { OpenClawConfig } from "./types.js";

type WeixinChannelConfig = {
  replyProgressMessages?: boolean;
};

export function resolveReplyProgressMessagesEnabled(cfg: OpenClawConfig): boolean {
  const section = cfg.channels?.["openclaw-weixin"] as WeixinChannelConfig | undefined;
  return section?.replyProgressMessages !== false;
}
