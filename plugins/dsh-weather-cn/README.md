# dsh-weather

[English](README.en.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 天气工具：查询任意城市或地点的实时天气与多日预报，数据来自 [Open-Meteo](https://open-meteo.com/)——免费、无需 API key、无需注册。

## 功能特性

- `get_weather` 工具：实时温度、体感温度、湿度、风速与天气状况。
- 可选多日预报（最多 7 天）：每日最高/最低温度与天气状况。
- 支持摄氏 / 华氏温度单位。
- 无需 API key；数据来源：[Open-Meteo](https://open-meteo.com/)。

## 安装

### 从 GitHub 安装

```sh
dsh plugin --profile web add "github:sunshine-lang/dsh-weather"
```

然后重启 `dsh --profile web`。`lib/` 已预构建并提交，安装无需构建权限。

### 从本地源码安装（开发）

```sh
dsh plugin --profile web add ./dsh-weather
```

> 注意：pnpm 对 `link:` 方式的本地依赖不会自动安装其依赖，需要手动添加到 profile（通过 registry 或 GitHub 安装则会自动处理）：
>
> ```sh
> dsh plugin --profile web add @deepseek-ai/dsh-tools @deepseek-ai/cordis @deepseek-ai/schemastery
> ```

### 验证

```sh
dsh --profile web --dump-config   # 应能看到 "# == dsh-weather" 层
```

## 使用方法

启动 Web UI 后，向模型提问，例如：

> 上海现在天气怎么样？
>
> 查一下东京的天气，用华氏度，并给出 3 天预报。

模型会调用 `get_weather`：参数 `location`（必填），可选 `units`（`celsius` | `fahrenheit`）和 `days`（1–7）。

## 配置

可通过 `cordis.patch.yml` 或 profile 的 patch 层覆盖任意配置项：

```yaml
- patch:
    - id: dsh-weather
      config:
        defaultUnits: fahrenheit
        timeoutMs: 15000
        maxForecastDays: 5
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `defaultUnits` | `celsius` | 模型未传 `units` 时使用的温度单位 |
| `timeoutMs` | `10000` | 每次天气 API 调用的超时时间（毫秒） |
| `maxForecastDays` | `7` | `days` 参数的上限（1–7） |

配置无效时插件加载会直接失败，并给出可操作的错误信息。

## 开发

```sh
pnpm install
pnpm build        # tsc → lib/
```

在 DeepSeek Harness 仓库内构建（类型解析指向工作区源码）时，改用 `tsconfig.local.json`：`tsc -p tsconfig.local.json`。

## 同作者更多插件

该作者的全部 DeepSeek Harness 插件（统一入口）：[dsh-plugins](https://github.com/sunshine-lang/dsh-plugins)

## 许可证

MIT。天气数据 © [Open-Meteo](https://open-meteo.com/)。
