window.__ModuleLoader__.load({
  id: "dsh-settings-remote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * dsh web 的设置 describe 镜像默认只在 loopback 页面加载：
     * dsh-client-ui-settings 的 apply 以 connection.isLoopback 决定
     * persistence（"host" / "memory"）；memory 模式下 load()/ensure()
     * 直接空转、永不调用 settings.describe，于是模型/提供方目录页
     * （dsh-client-ui-settings-models）报
     * "settings are unavailable in this browser"（误导文案，实为设计门控）。
     *
     * 本插件把共享镜像切到 "host" 持久化并主动加载一次；之后的
     * document-updated / connection/reset 刷新由镜像自身的订阅负责
     * （persistence 已是 "host"，会真正发起 describe）。
     */
    const inject = ["settingsScope"];

    function apply(ctx) {
      try {
        const mirror = ctx.get("settingsScope").describe();
        mirror.persistence = "host";
        void mirror.load();
        console.log("[dsh-settings-remote] settings mirror forced to host persistence and loaded");
      } catch (error) {
        console.warn("[dsh-settings-remote]", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
