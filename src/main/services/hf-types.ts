/**
 * hf-types.ts — Shared type definitions for Hugging Face inference layer.
 *
 * Used by both the Main process (HFModelService) and
 * the Worker thread (hf-inference.worker).
 */

// ============================================================
// Task Types
// ============================================================

export type HFTaskType =
  | 'text-generation'
  | 'zero-shot-image-classification'
  | 'zero-shot-object-detection'

// ============================================================
// Model Options
// ============================================================

export interface HFModelOptions {
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4'
  device?: 'cpu' | 'gpu'
}

export interface TextGenOptions {
  maxNewTokens?: number
  temperature?: number
  topP?: number
  systemPrompt?: string
}

// ============================================================
// Results
// ============================================================

export interface ClassifyResult {
  label: string
  score: number
}

export interface DetectionResult {
  label: string
  score: number
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
}

// ============================================================
// Service Status
// ============================================================

export interface HFServiceStatus {
  enabled: boolean
  workerAlive: boolean
  loadedModels: { task: HFTaskType; model: string; memoryMB: number }[]
  totalMemoryMB: number
  systemProfile: 'low' | 'medium' | 'high'
}

// ============================================================
// Worker Message Protocol
// ============================================================

export type WorkerRequest =
  | { type: 'load'; taskId: string; task: HFTaskType; model: string; options?: HFModelOptions; cacheDir?: string }
  | { type: 'predict'; taskId: string; task: HFTaskType; input: unknown; options?: Record<string, unknown> }
  | { type: 'unload'; taskId: string; task: HFTaskType }
  | { type: 'status'; taskId: string }

export type WorkerResponse =
  | { type: 'ready'; taskId: string }
  | { type: 'result'; taskId: string; data: unknown }
  | { type: 'error'; taskId: string; error: string }
  | { type: 'progress'; taskId: string; progress: number; message: string }
  | { type: 'status'; taskId: string; loadedModels: string[]; memoryUsageMB: number }
