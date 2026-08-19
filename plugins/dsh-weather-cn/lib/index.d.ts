import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-weather-cn";
export declare const inject: string[];
/** Deployment-tunable weather behavior. */
export interface Config {
    /** Temperature unit applied when the model omits `units`. */
    defaultUnits: 'celsius' | 'fahrenheit';
    /** Timeout for each weather API call, in milliseconds. */
    timeoutMs: number;
    /** Upper bound for the `days` forecast parameter. */
    maxForecastDays: number;
}
/** Schemastery configuration: validates on load and fills defaults. */
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
