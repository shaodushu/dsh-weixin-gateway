import { MessageItemType } from "./api/types.js";
import { logger } from "./util/logger.js";
import { sendMessageItemWeixin } from "./send.js";
function normalizeToolStatus(status) {
    if (status === "completed")
        return "completed";
    if (status === "failed")
        return "failed";
    if (status === "blocked")
        return "blocked";
    return "unknown";
}
export class WeixinReplyProgressSender {
    runId;
    to;
    accountId;
    opts;
    finalized = false;
    sendChain = Promise.resolve();
    constructor(deps) {
        this.runId = deps.runId;
        this.to = deps.to;
        this.accountId = deps.accountId;
        this.opts = { ...deps.opts, runId: deps.runId };
    }
    get replyOptions() {
        return {
            runId: this.runId,
            onItemEvent: (payload) => this.handleToolItemEvent(payload),
        };
    }
    enqueueMessage(item, label) {
        if (this.finalized)
            return;
        this.sendChain = this.sendChain
            .then(async () => {
            await sendMessageItemWeixin({
                to: this.to,
                item,
                opts: this.opts,
                label,
            });
        })
            .catch((err) => {
            logger.warn(`${label}: failed to=${this.to} accountId=${this.accountId} runId=${this.runId} err=${String(err)}`);
        });
    }
    handleToolItemEvent(payload) {
        if (this.finalized)
            return;
        if (payload.kind !== "tool")
            return;
        if (payload.phase !== "start" && payload.phase !== "end")
            return;
        const now = Date.now();
        const toolName = payload.name?.trim() || payload.title?.trim() || "tool";
        const toolCallId = payload.itemId?.trim() || undefined;
        if (payload.phase === "start") {
            this.enqueueMessage({
                type: MessageItemType.TOOL_CALL_START,
                create_time_ms: now,
                is_completed: false,
                tool_call_start_item: {
                    tool_name: toolName,
                    tool_call_id: toolCallId,
                },
            }, "sendToolCallStartMessage");
            return;
        }
        this.enqueueMessage({
            type: MessageItemType.TOOL_CALL_RESULT,
            create_time_ms: now,
            is_completed: true,
            tool_call_result_item: {
                tool_name: toolName,
                tool_call_id: toolCallId,
                status: normalizeToolStatus(payload.status),
            },
        }, "sendToolCallResultMessage");
    }
    async finalize() {
        if (this.finalized)
            return;
        this.finalized = true;
        try {
            await this.sendChain;
        }
        catch (err) {
            logger.warn(`WeixinReplyProgressSender.finalize: send drain failed runId=${this.runId} err=${String(err)}`);
        }
    }
}
