/**
 * 账号选择（gateway run 默认账号）。
 *
 * accounts-index.json 按登录顺序 append（旧→新）。扫码登录会创建新 bot
 * 账号（旧账号立即失效），因此"默认账号"必须是**最新登录**（数组末位），
 * 否则网关会空转失效旧账号（-14，消息无人处理）。
 */
/** 从已登录账号列表选默认账号：末位 = 最新登录。空列表返回 undefined。 */
export function pickDefaultAccount(accounts) {
    if (accounts.length === 0)
        return undefined;
    return accounts[accounts.length - 1];
}
