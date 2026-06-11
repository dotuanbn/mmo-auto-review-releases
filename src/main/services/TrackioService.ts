/**
 * TrackioService.ts — AI Performance Monitoring & Metrics Tracking
 *
 * Logs inference performance (latency, success rate, memory) to SQLite.
 * Provides query APIs for real-time dashboard and alert detection.
 *
 * Inspired by HuggingFace Trackio skill but runs 100% locally — no HF account needed.
 */

import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { desc, sql, and, gte } from 'drizzle-orm'
import type { HFTaskType } from './hf-types'

// ============================================================
// Types
// ============================================================

export interface MetricsSummary {
  /** Total inference calls in time range */
  totalCalls: number
  /** Successful calls */
  successCount: number
  /** Failed calls */
  failureCount: number
  /** Success rate as percentage */
  successRate: number
  /** Average inference duration in ms */
  avgDurationMs: number
  /** P95 inference duration in ms */
  p95DurationMs: number
  /** Total memory used across all loaded models */
  peakMemoryMB: number
  /** Breakdown by task type */
  byTask: Record<string, {
    calls: number
    avgDurationMs: number
    successRate: number
  }>
}

export interface InferenceLogEntry {
  id: number
  task: string
  modelId: string
  operation: string
  durationMs: number
  success: boolean
  memoryMB: number | null
  inputLength: number | null
  outputLength: number | null
  errorMessage: string | null
  createdAt: Date
}

export interface TrackioAlert {
  level: 'info' | 'warn' | 'error'
  title: string
  message: string
  timestamp: Date
}

// Thresholds for alert detection
const ALERT_THRESHOLDS = {
  /** Alert if inference takes longer than this (ms) */
  slowInferenceMs: 30_000,
  /** Alert if error rate exceeds this percentage in last hour */
  highErrorRatePercent: 30,
  /** Alert if memory usage exceeds this (MB) */
  highMemoryMB: 2048,
  /** Minimum sample size before alerting on error rate */
  minSamplesForAlert: 5,
}

// ============================================================
// TrackioService
// ============================================================

class TrackioService {
  // ============================================================
  // Logging — called by HFModelService
  // ============================================================

  /**
   * Log an inference call (text generation, image classification, etc.)
   */
  logInference(params: {
    task: HFTaskType
    modelId: string
    durationMs: number
    success: boolean
    memoryMB?: number
    inputLength?: number
    outputLength?: number
    errorMessage?: string
  }): void {
    try {
      const db = getDatabase()
      db.insert(schema.aiMetrics).values({
        task: params.task,
        modelId: params.modelId,
        operation: 'inference',
        durationMs: params.durationMs,
        success: params.success,
        memoryMB: params.memoryMB ?? null,
        inputLength: params.inputLength ?? null,
        outputLength: params.outputLength ?? null,
        errorMessage: params.errorMessage ?? null,
      }).run()
    } catch (err) {
      // Logging failure should NEVER crash the main flow
      console.error('[TrackioService] Failed to log inference:', err)
    }
  }

  /**
   * Log a model load/unload operation
   */
  logModelLifecycle(params: {
    task: HFTaskType
    modelId: string
    operation: 'load' | 'unload'
    durationMs: number
    success: boolean
    memoryMB?: number
    errorMessage?: string
  }): void {
    try {
      const db = getDatabase()
      db.insert(schema.aiMetrics).values({
        task: params.task,
        modelId: params.modelId,
        operation: params.operation,
        durationMs: params.durationMs,
        success: params.success,
        memoryMB: params.memoryMB ?? null,
        errorMessage: params.errorMessage ?? null,
      }).run()
    } catch (err) {
      console.error('[TrackioService] Failed to log model lifecycle:', err)
    }
  }

  // ============================================================
  // Querying — used by IPC handlers
  // ============================================================

  /**
   * Get aggregated metrics summary for a given time range.
   */
  getMetricsSummary(timeRange: 'hour' | 'day' | 'week' = 'day'): MetricsSummary {
    const db = getDatabase()
    const since = this.getTimeSince(timeRange)

    // Fetch all metrics in range
    const rows = db.select()
      .from(schema.aiMetrics)
      .where(gte(schema.aiMetrics.createdAt, since))
      .all()

    if (rows.length === 0) {
      return {
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 100,
        avgDurationMs: 0,
        p95DurationMs: 0,
        peakMemoryMB: 0,
        byTask: {},
      }
    }

    const inferenceRows = rows.filter(r => r.operation === 'inference')
    const successRows = inferenceRows.filter(r => r.success)
    const durations = inferenceRows.map(r => r.durationMs).sort((a, b) => a - b)

    // P95 calculation
    const p95Index = Math.floor(durations.length * 0.95)
    const p95Duration = durations[p95Index] ?? 0

    // Peak memory
    const memValues = rows.filter(r => r.memoryMB != null).map(r => r.memoryMB as number)
    const peakMemory = memValues.length > 0 ? Math.max(...memValues) : 0

    // By-task breakdown
    const byTask: MetricsSummary['byTask'] = {}
    for (const row of inferenceRows) {
      if (!byTask[row.task]) {
        byTask[row.task] = { calls: 0, avgDurationMs: 0, successRate: 0 }
      }
      byTask[row.task].calls++
    }

    for (const task of Object.keys(byTask)) {
      const taskRows = inferenceRows.filter(r => r.task === task)
      const taskSuccess = taskRows.filter(r => r.success)
      byTask[task].avgDurationMs = Math.round(
        taskRows.reduce((sum, r) => sum + r.durationMs, 0) / taskRows.length
      )
      byTask[task].successRate = Math.round((taskSuccess.length / taskRows.length) * 100)
    }

    return {
      totalCalls: inferenceRows.length,
      successCount: successRows.length,
      failureCount: inferenceRows.length - successRows.length,
      successRate: Math.round((successRows.length / inferenceRows.length) * 100),
      avgDurationMs: Math.round(
        inferenceRows.reduce((sum, r) => sum + r.durationMs, 0) / inferenceRows.length
      ),
      p95DurationMs: p95Duration,
      peakMemoryMB: peakMemory,
      byTask,
    }
  }

  /**
   * Get recent inference log entries.
   */
  getInferenceHistory(limit: number = 50): InferenceLogEntry[] {
    const db = getDatabase()
    return db.select()
      .from(schema.aiMetrics)
      .orderBy(desc(schema.aiMetrics.createdAt))
      .limit(limit)
      .all() as InferenceLogEntry[]
  }

  /**
   * Detect alerts based on current metrics.
   */
  checkAlerts(): TrackioAlert[] {
    const alerts: TrackioAlert[] = []
    const summary = this.getMetricsSummary('hour')

    // Alert: High error rate
    if (
      summary.totalCalls >= ALERT_THRESHOLDS.minSamplesForAlert &&
      summary.successRate < (100 - ALERT_THRESHOLDS.highErrorRatePercent)
    ) {
      alerts.push({
        level: 'error',
        title: 'Tỷ lệ lỗi AI cao',
        message: `${summary.failureCount}/${summary.totalCalls} lần inference thất bại trong 1 giờ qua (${100 - summary.successRate}% error rate)`,
        timestamp: new Date(),
      })
    }

    // Alert: Slow inference
    if (summary.p95DurationMs > ALERT_THRESHOLDS.slowInferenceMs) {
      alerts.push({
        level: 'warn',
        title: 'AI inference chậm',
        message: `P95 latency: ${(summary.p95DurationMs / 1000).toFixed(1)}s (ngưỡng: ${ALERT_THRESHOLDS.slowInferenceMs / 1000}s)`,
        timestamp: new Date(),
      })
    }

    // Alert: High memory usage
    if (summary.peakMemoryMB > ALERT_THRESHOLDS.highMemoryMB) {
      alerts.push({
        level: 'warn',
        title: 'AI sử dụng nhiều bộ nhớ',
        message: `Peak memory: ${summary.peakMemoryMB}MB (ngưỡng: ${ALERT_THRESHOLDS.highMemoryMB}MB)`,
        timestamp: new Date(),
      })
    }

    return alerts
  }

  /**
   * Clean up old metrics to prevent DB bloat.
   * Keeps last 30 days by default.
   */
  cleanup(keepDays: number = 30): number {
    try {
      const db = getDatabase()
      const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000)

      const result = db.delete(schema.aiMetrics)
        .where(sql`${schema.aiMetrics.createdAt} < ${cutoff.getTime()}`)
        .run()

      return result.changes
    } catch (err) {
      console.error('[TrackioService] Cleanup failed:', err)
      return 0
    }
  }

  // ============================================================
  // Internal Helpers
  // ============================================================

  private getTimeSince(timeRange: 'hour' | 'day' | 'week'): Date {
    const now = Date.now()
    const offsets: Record<string, number> = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
    }
    return new Date(now - (offsets[timeRange] ?? offsets.day))
  }
}

// ============================================================
// Singleton Export
// ============================================================

export const trackioService = new TrackioService()
