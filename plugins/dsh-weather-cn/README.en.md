# dsh-weather

[中文](README.md) | English

Weather tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): current conditions and multi-day forecasts for any city or place, powered by [Open-Meteo](https://open-meteo.com/) — free, no API key, no sign-up.

## Features

- `get_weather` tool: current temperature, feels-like, humidity, wind, and conditions.
- Optional multi-day forecast (up to 7 days): daily min/max and conditions.
- Celsius or Fahrenheit.
- No API key required; attribution: data © [Open-Meteo](https://open-meteo.com/).

## Install

### From GitHub

```sh
dsh plugin --profile web add "github:sunshine-lang/dsh-weather"
```

Then restart `dsh --profile web`. `lib/` is prebuilt and committed, so no build permission is needed.

### From a local checkout (development)

```sh
dsh plugin --profile web add ./dsh-weather
```

> Note: pnpm installs the dependencies of a `link:`-style local dependency only if you add them to the profile yourself. A registry/GitHub install handles them automatically:
>
> ```sh
> dsh plugin --profile web add @deepseek-ai/dsh-tools @deepseek-ai/cordis @deepseek-ai/schemastery
> ```

### Verify

```sh
dsh --profile web --dump-config   # should show a "# == dsh-weather" layer
```

## Use

Start the Web UI and ask the model, for example:

> What's the weather in Shanghai right now?
>
> Check the weather in Tokyo and give me a 3-day forecast in Fahrenheit.

The model calls `get_weather` with `location` (required), and optionally `units` (`celsius` | `fahrenheit`) and `days` (1–7).

## Configuration

Override any key through `cordis.patch.yml` or the profile's patch layer:

```yaml
- patch:
    - id: dsh-weather
      config:
        defaultUnits: fahrenheit
        timeoutMs: 15000
        maxForecastDays: 5
```

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultUnits` | `celsius` | Temperature unit applied when the model omits `units`. |
| `timeoutMs` | `10000` | Timeout for each weather API call, in milliseconds. |
| `maxForecastDays` | `7` | Upper bound for the `days` parameter (1–7). |

Invalid configuration fails the load with an actionable error.

## Development

```sh
pnpm install
pnpm build        # tsc → lib/
```

Rebuild from a DeepSeek Harness checkout (for type resolution against the workspace source) uses `tsconfig.local.json` instead: `tsc -p tsconfig.local.json`.

## More plugins by this author

All DeepSeek Harness plugins by this author, in one place: [dsh-plugins](https://github.com/sunshine-lang/dsh-plugins)

## License

MIT. Weather data © [Open-Meteo](https://open-meteo.com/).
