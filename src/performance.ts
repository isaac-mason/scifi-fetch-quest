import type { SparkRenderer } from '@sparkjsdev/spark';

export type Performance = {
    lodScale: number;
};

export function initPerformance(): Performance {
    return { lodScale: 0.8 };
}

export function applyPerformance(perf: Performance, spark: SparkRenderer): void {
    spark.lodSplatScale = perf.lodScale;
}
