/**
 * Weather data source: Open-Meteo (free, no API key).
 * Geocoding: https://geocoding-api.open-meteo.com/v1/search
 * Forecast:  https://api.open-meteo.com/v1/forecast
 * @module weather
 */
/** Tool-facing parameters for a weather lookup. */
export interface WeatherParams {
    /** City name or place name, e.g. "Shanghai" or "Tokyo". */
    location: string;
    /** Temperature unit; defaults to the deployment's `defaultUnits`. */
    units?: 'celsius' | 'fahrenheit';
    /** Forecast days to include (1–7, clamped to `maxForecastDays`); 1 means current conditions only. */
    days?: number;
}
/** Deployment-tunable weather behavior, supplied by the plugin Config. */
export interface WeatherConfig {
    /** Temperature unit applied when the model omits `units`. */
    defaultUnits: 'celsius' | 'fahrenheit';
    /** Timeout for each weather API call, in milliseconds. */
    timeoutMs: number;
    /** Upper bound for the `days` parameter. */
    maxForecastDays: number;
}
/** One geocoding hit, as returned by Open-Meteo. */
interface GeocodeHit {
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
}
/** Resolve a place name to coordinates, or throw when nothing matches. */
export declare function geocode(location: string, timeoutMs: number): Promise<GeocodeHit>;
/** Format the current weather and optional multi-day forecast as model-facing text. */
export declare function getWeather(params: WeatherParams, config: WeatherConfig): Promise<string>;
export {};
