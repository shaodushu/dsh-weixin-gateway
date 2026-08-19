/**
 * Weather data source: Open-Meteo (free, no API key).
 * Geocoding: https://geocoding-api.open-meteo.com/v1/search
 * Forecast:  https://api.open-meteo.com/v1/forecast
 * @module weather
 */
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
/** WMO weather code → human description. Codes: https://open-meteo.com/en/docs */
const WMO_DESCRIPTIONS = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
};
function describeWeather(code) {
    return WMO_DESCRIPTIONS[code] ?? `Weather code ${code}`;
}
/** Clamp a value into a range, for the `days` parameter. */
function clampDays(days, max) {
    const value = days ?? 1;
    return Math.min(Math.max(value, 1), max);
}
/** Resolve a place name to coordinates, or throw when nothing matches. */
export async function geocode(location, timeoutMs) {
    // CN fix: Open-Meteo 对中文地名必须带 language=zh，否则返回空 results；
    // 非 CJK 地名（如 Chengdu/Tokyo）加 language=zh 也能正常解析（显示中文名）。
    const lang = /[\u3400-\u9fff\uf900-\ufaff]/.test(location) ? '&language=zh' : '';
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(location)}&count=1${lang}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok)
        throw new Error(`Geocoding API failed with status ${response.status}`);
    const data = (await response.json());
    const hit = data.results?.[0];
    if (hit === undefined)
        throw new Error(`Location not found: ${location}`);
    return hit;
}
/** Format the current weather and optional multi-day forecast as model-facing text. */
export async function getWeather(params, config) {
    const unit = params.units ?? config.defaultUnits;
    const days = clampDays(params.days, config.maxForecastDays);
    const hit = await geocode(params.location, config.timeoutMs);
    const url = `${FORECAST_URL}?latitude=${hit.latitude}&longitude=${hit.longitude}`
        + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
        + (days > 1 ? `&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=${days}` : '')
        + `&timezone=auto&temperature_unit=${unit}&wind_speed_unit=kmh`;
    const response = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });
    if (!response.ok)
        throw new Error(`Forecast API failed with status ${response.status}`);
    const data = (await response.json());
    const current = data.current;
    if (current === undefined)
        throw new Error(`No current weather returned for ${params.location}`);
    const degree = unit === 'fahrenheit' ? '°F' : '°C';
    const place = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
    const lines = [
        `${place}: ${current.temperature_2m}${degree} (feels like ${current.apparent_temperature}${degree}), ${describeWeather(current.weather_code ?? 0)}.`,
        `Humidity ${current.relative_humidity_2m}%, wind ${current.wind_speed_10m} km/h. Observed at ${current.time}.`,
    ];
    const daily = data.daily;
    if (days > 1 && daily?.time !== undefined) {
        lines.push('Forecast:');
        for (let i = 0; i < daily.time.length; i++) {
            const max = daily.temperature_2m_max?.[i];
            const min = daily.temperature_2m_min?.[i];
            const code = daily.weather_code?.[i] ?? 0;
            if (max === undefined || min === undefined)
                continue;
            lines.push(`- ${daily.time[i]}: ${min}${degree} to ${max}${degree}, ${describeWeather(code)}`);
        }
    }
    return lines.join(' ');
}
