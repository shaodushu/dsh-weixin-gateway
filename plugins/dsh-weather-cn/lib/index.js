import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { getWeather } from './weather.js';
export const name = 'dsh-weather-cn';
export const inject = ['tools'];
/** Schemastery configuration: validates on load and fills defaults. */
export const Config = z.object({
    defaultUnits: z.union(['celsius', 'fahrenheit']).default('celsius'),
    timeoutMs: z.natural().min(1).default(10_000),
    maxForecastDays: z.natural().min(1).max(7).default(7),
});
export function apply(ctx, config) {
    // Required dependencies (tools) are ready before apply runs.
    console.log('[dsh-weather-cn] plugin loaded!');
    const weatherConfig = {
        defaultUnits: config.defaultUnits,
        timeoutMs: config.timeoutMs,
        maxForecastDays: config.maxForecastDays,
    };
    ctx.tools.register(defineTool({
        name: 'get_weather',
        description: 'Get the current weather for a city or place, e.g. "Shanghai" or "Tokyo", plus an optional multi-day forecast.',
        parameters: {
            location: { type: 'string', required: true, description: 'City name or place name' },
            units: {
                type: 'string',
                description: 'Temperature unit; omit to use the configured default',
                enum: ['celsius', 'fahrenheit'],
            },
            days: {
                type: 'integer',
                description: 'Forecast days to include, from 1 to 7; 1 (default) means current conditions only',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: args => getWeather(args, weatherConfig),
    }));
}
