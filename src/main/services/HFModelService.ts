/**
 * HFModelService.ts — Singleton orchestrator for local Hugging Face inference.
 *
 * Manages the lifecycle of a dedicated worker_thread that runs
 * @huggingface/transformers pipelines. All heavy computation is
 * delegated to the worker to keep the Electron main process responsive.
 *
 * Dependencies (already in project):
 *   - p-queue (request serialization)
 *   - SystemResourceDetector (RAM safety checks)
 */

import { Worker } from 'worker_threads'
import { join } from 'path'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import PQueue from 'p-queue'
import { systemResourceDetector } from './SystemResourceDetector'
import { loadSettings } from '../ipc/settings'
import { trackioService } from './TrackioService'
import { getRegistryEntry, resolveModelId } from './hf-model-registry'
import type {
  HFTaskType,
  HFServiceStatus,
  TextGenOptions,
  ClassifyResult,
  DetectionResult,
  WorkerRequest,
  WorkerResponse,
} from './hf-types'

// ============================================================
// Constants
// ============================================================

const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes for model loading + inference
const IDLE_DISPOSE_MS = 5 * 60 * 1000 // Auto-unload after 5 min idle
const WORKER_SCRIPT_FILENAME = 'hf-inference.worker.js'

// ============================================================
// HFModelService
// ============================================================

class HFModelService {
  private worker: Worker | null = null
  private workerReady = false

  /** Pending requests awaiting worker response, keyed by taskId */
  private pendingRequests: Map<string, {
    resolve: (data: unknown) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }> = new Map()

  /** Tracks which models are currently loaded */
  private activeModels: Map<HFTaskType, { model: string; loadedAt: number }> = new Map()

  /** Idle timers — auto-dispose after inactivity */
  private idleTimers: Map<HFTaskType, ReturnType<typeof setTimeout>> = new Map()

  /** Serialized queue to prevent parallel inferences on the same worker */
  private queue: PQueue

  /** Monotonic counter for unique task IDs */
  private taskIdCounter = 0

  constructor() {
    this.queue = new PQueue({ concurrency: 1 })
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Generate text using a local LLM (e.g., Qwen 0.5B).
   * Auto-loads the model if not already loaded.
   */
  async generateText(prompt: string, options?: TextGenOptions): Promise<string> {
    this.assertEnabled()
    const task: HFTaskType = 'text-generation'
    const startTime = performance.now()
    const modelId = this.activeModels.get(task)?.model ?? 'unknown'

    try {
      const result = await this.queue.add(async () => {
        await this.ensureModelLoaded(task)
        this.resetIdleTimer(task)

        const predictOptions: Record<string, unknown> = {
          max_new_tokens: options?.maxNewTokens ?? 256,
          temperature: options?.temperature ?? 0.8,
          top_p: options?.topP ?? 0.95,
          do_sample: true,
        }

        // Chat models (e.g. Qwen1.5-*-Chat) need structured message input.
        // The @huggingface/transformers pipeline accepts [{role, content}] format.
        const chatInput = [
          { role: 'system', content: 'You are a helpful assistant. Respond concisely.' },
          { role: 'user', content: prompt },
        ]

        const response = await this.sendToWorker({
          type: 'predict',
          taskId: this.nextTaskId(),
          task,
          input: chatInput,
          options: predictOptions,
        })

        return response
      })

      // Extract generated text from pipeline output (strip prompt prefix)
      const text = this.extractTextFromResult(result, prompt)

      // Trackio: log successful inference
      trackioService.logInference({
        task,
        modelId: this.activeModels.get(task)?.model ?? modelId,
        durationMs: Math.round(performance.now() - startTime),
        success: true,
        inputLength: prompt.length,
        outputLength: text.length,
      })

      return text
    } catch (err: any) {
      // Trackio: log failed inference
      trackioService.logInference({
        task,
        modelId: this.activeModels.get(task)?.model ?? modelId,
        durationMs: Math.round(performance.now() - startTime),
        success: false,
        inputLength: prompt.length,
        errorMessage: err.message,
      })
      throw err
    }
  }

  /**
   * Classify an image against a set of text labels (e.g., captcha solving).
   * Returns sorted results with confidence scores.
   */
  async classifyImage(imageBase64: string, labels: string[]): Promise<ClassifyResult[]> {
    this.assertEnabled()
    const task: HFTaskType = 'zero-shot-image-classification'
    const startTime = performance.now()

    try {
      const result = await this.queue.add(async () => {
        await this.ensureModelLoaded(task)
        this.resetIdleTimer(task)

        const response = await this.sendToWorker({
          type: 'predict',
          taskId: this.nextTaskId(),
          task,
          input: imageBase64,
          options: { candidate_labels: labels },
        })

        return response
      })

      // Normalize result to ClassifyResult[]
      const results = Array.isArray(result)
        ? result.map((item: any) => ({ label: item.label || '', score: item.score || 0 }))
        : []

      trackioService.logInference({
        task,
        modelId: this.activeModels.get(task)?.model ?? 'unknown',
        durationMs: Math.round(performance.now() - startTime),
        success: true,
        inputLength: imageBase64.length,
        outputLength: results.length,
      })

      return results
    } catch (err: any) {
      trackioService.logInference({
        task,
        modelId: this.activeModels.get(task)?.model ?? 'unknown',
        durationMs: Math.round(performance.now() - startTime),
        success: false,
        inputLength: imageBase64.length,
        errorMessage: err.message,
      })
      throw err
    }
  }

  /**
   * Detect objects in a screenshot using text queries (e.g., DOM-Vision).
   * Returns bounding boxes for matched elements.
   */
  async detectObjects(imageBase64: string, queries: string[]): Promise<DetectionResult[]> {
    this.assertEnabled()
    const task: HFTaskType = 'zero-shot-object-detection'
    const startTime = performance.now()

    try {
      const result = await this.queue.add(async () => {
        await this.ensureModelLoaded(task)
        this.resetIdleTimer(task)

        const response = await this.sendToWorker({
          type: 'predict',
          taskId: this.nextTaskId(),
          task,
          input: imageBase64,
          options: { candidate_labels: queries },
        })

        return response
      })

      // Normalize result to DetectionResult[]
      const results = Array.isArray(result)
        ? result.map((item: any) => ({
            label: item.label || '',
            score: item.score || 0,
            box: item.box || { xmin: 0, ymin: 0, xmax: 0, ymax: 0 },
          }))
        : []

      trackioService.logInference({
        task,
        modelId: this.activeModels.get(task)?.model ?? 'unknown',
        durationMs: Math.round(performance.now() - startTime),
        success: true,
        inputLength: imageBase64.length,
        outputLength: results.length,
      })

      return results
    } catch (err: any) {
      trackioService.logInference({
        task,
        modelId: this.activeModels.get(task)?.model ?? 'unknown',
        durationMs: Math.round(performance.now() - startTime),
        success: false,
        inputLength: imageBase64.length,
        errorMessage: err.message,
      })
      throw err
    }
  }

  /**
   * Get current service status — loaded models, memory, worker health.
   */
  async getStatus(): Promise<HFServiceStatus> {
    const settings = loadSettings()
    const enabled = settings.hfModelEnabled === true
    const profile = systemResourceDetector.getSystemProfile()

    if (!this.worker || !this.workerReady) {
      return {
        enabled,
        workerAlive: false,
        loadedModels: [],
        totalMemoryMB: 0,
        systemProfile: profile,
      }
    }

    try {
      const statusResult = await this.sendToWorker({
        type: 'status',
        taskId: this.nextTaskId(),
      }, 5000)

      const statusData = statusResult as { loadedModels: string[]; memoryUsageMB: number }

      const loadedModels = (statusData.loadedModels || []).map((entry: string) => {
        const [task, model] = entry.split(':')
        return { task: task as HFTaskType, model, memoryMB: 0 }
      })

      return {
        enabled,
        workerAlive: true,
        loadedModels,
        totalMemoryMB: statusData.memoryUsageMB || 0,
        systemProfile: profile,
      }
    } catch {
      return {
        enabled,
        workerAlive: false,
        loadedModels: [],
        totalMemoryMB: 0,
        systemProfile: profile,
      }
    }
  }

  /**
   * Pre-load a specific model into memory.
   */
  async preloadModel(task: HFTaskType, modelOverride?: string): Promise<void> {
    this.assertEnabled()
    await this.ensureModelLoaded(task, modelOverride)
  }

  /**
   * Unload a specific model to free memory.
   */
  async unloadModel(task: HFTaskType): Promise<void> {
    if (!this.worker || !this.workerReady) return

    this.clearIdleTimer(task)
    this.activeModels.delete(task)

    await this.sendToWorker({
      type: 'unload',
      taskId: this.nextTaskId(),
      task,
    })
  }

  /**
   * Dispose all resources — kill worker, clear timers.
   */
  async dispose(): Promise<void> {
    // Clear all idle timers
    Array.from(this.idleTimers.values()).forEach((timer) => clearTimeout(timer))
    this.idleTimers.clear()
    this.activeModels.clear()

    // Reject all pending requests
    Array.from(this.pendingRequests.values()).forEach((pending) => {
      clearTimeout(pending.timeout)
      pending.reject(new Error('HFModelService disposed'))
    })
    this.pendingRequests.clear()

    // Kill worker
    if (this.worker) {
      try {
        await this.worker.terminate()
      } catch { /* ignore */ }
      this.worker = null
      this.workerReady = false
    }
  }

  // ============================================================
  // Internal — Worker Lifecycle
  // ============================================================

  private getWorkerScriptPath(): string {
    // Worker is built by Vite to dist-electron/main/workers/hf-inference.worker.js
    const possiblePaths = [
      join(__dirname, 'workers', WORKER_SCRIPT_FILENAME),
      join(__dirname, '..', 'workers', WORKER_SCRIPT_FILENAME),
      join(app.getAppPath(), 'dist-electron', 'main', 'workers', WORKER_SCRIPT_FILENAME),
    ]

    for (const p of possiblePaths) {
      if (existsSync(p)) return p
    }

    throw new Error(
      `[HFModelService] Worker script not found. Checked:\n${possiblePaths.join('\n')}`
    )
  }

  private getModelCacheDir(): string {
    const cacheDir = join(app.getPath('userData'), 'hf-models')
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true })
    }
    return cacheDir
  }

  private async ensureWorkerAlive(): Promise<void> {
    if (this.worker && this.workerReady) return

    // Kill existing dead worker
    if (this.worker) {
      try { await this.worker.terminate() } catch { /* ignore */ }
      this.worker = null
      this.workerReady = false
    }

    return new Promise<void>((resolve, reject) => {
      const workerPath = this.getWorkerScriptPath()
      console.log(`[HFModelService] Spawning worker from: ${workerPath}`)

      // NOTE: Electron blocks execArgv flags (e.g. --expose-gc) on worker_threads.
      // The worker has a defensive try/catch for global.gc(), so it's safe without the flag.
      this.worker = new Worker(workerPath)

      const initTimeout = setTimeout(() => {
        reject(new Error('Worker failed to initialize within 30s'))
      }, 30_000)

      this.worker.on('message', (msg: WorkerResponse) => {
        // Handle init ready signal
        if (msg.type === 'ready' && msg.taskId === '__init__') {
          clearTimeout(initTimeout)
          this.workerReady = true
          console.log('[HFModelService] Worker thread ready')
          resolve()
          return
        }

        // Route response to pending request
        this.handleWorkerMessage(msg)
      })

      this.worker.on('error', (err) => {
        console.error('[HFModelService] Worker error:', err.message)
        clearTimeout(initTimeout)
        this.workerReady = false
        reject(err)
      })

      this.worker.on('exit', (code) => {
        console.warn(`[HFModelService] Worker exited with code ${code}`)
        this.workerReady = false
        this.worker = null
        this.activeModels.clear()

        // Reject all pending
        Array.from(this.pendingRequests.values()).forEach((pending) => {
          clearTimeout(pending.timeout)
          pending.reject(new Error(`Worker exited unexpectedly (code=${code})`))
        })
        this.pendingRequests.clear()
      })
    })
  }

  // ============================================================
  // Internal — Message Handling
  // ============================================================

  private handleWorkerMessage(msg: WorkerResponse): void {
    const pending = this.pendingRequests.get(msg.taskId)
    if (!pending) {
      // Progress messages don't need a pending entry
      if (msg.type === 'progress') {
        console.log(`[HFModelService] Progress: ${msg.progress}% — ${msg.message}`)
        return
      }
      return
    }

    switch (msg.type) {
      case 'ready':
      case 'result':
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(msg.taskId)
        pending.resolve(msg.type === 'result' ? msg.data : undefined)
        break
      case 'status':
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(msg.taskId)
        pending.resolve({ loadedModels: msg.loadedModels, memoryUsageMB: msg.memoryUsageMB })
        break
      case 'error':
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(msg.taskId)
        pending.reject(new Error(msg.error))
        break
      case 'progress':
        // Don't resolve — model still loading. Reset timeout so it doesn't expire during download.
        clearTimeout(pending.timeout)
        pending.timeout = setTimeout(() => {
          this.pendingRequests.delete(msg.taskId)
          pending.reject(new Error(`Worker request timed out (taskId=${msg.taskId})`))
        }, 120_000) // 2 min grace after last progress
        console.log(`[HFModelService] Progress: ${msg.progress}% — ${msg.message}`)
        break
    }
  }

  private async sendToWorker(request: WorkerRequest, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    await this.ensureWorkerAlive()

    if (!this.worker) {
      throw new Error('Worker not available')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.taskId)
        reject(new Error(`Worker request timed out after ${timeoutMs}ms (taskId=${request.taskId})`))
      }, timeoutMs)

      this.pendingRequests.set(request.taskId, { resolve, reject, timeout })
      try {
        this.worker?.postMessage(request)
      } catch (err) {
        clearTimeout(timeout)
        this.pendingRequests.delete(request.taskId)
        reject(err)
      }
    })
  }

  // ============================================================
  // Internal — Model Lifecycle
  // ============================================================

  private async ensureModelLoaded(task: HFTaskType, modelOverride?: string): Promise<void> {
    const settings = loadSettings()
    const userModel = task === 'text-generation' ? settings.hfTextGenModel : undefined
    const modelId = resolveModelId(task, modelOverride || userModel)

    // Check if already loaded with same model
    const active = this.activeModels.get(task)
    if (active && active.model === modelId) return

    // RAM safety check
    const registry = getRegistryEntry(task)
    const recs = systemResourceDetector.getRecommendations()
    const freeRamGB = require('os').freemem() / (1024 * 1024 * 1024)

    if (freeRamGB < registry.minRamGB) {
      throw new Error(
        `Không đủ RAM để load model ${modelId}. ` +
        `Cần tối thiểu ${registry.minRamGB}GB, hiện chỉ còn ${freeRamGB.toFixed(1)}GB trống. ` +
        `System profile: ${recs.profile}`
      )
    }

    // Load model
    console.log(`[HFModelService] Loading model: ${modelId} for task: ${task}`)

    await this.sendToWorker({
      type: 'load',
      taskId: this.nextTaskId(),
      task,
      model: modelId,
      options: { dtype: registry.quantization },
      cacheDir: this.getModelCacheDir(),
    })

    this.activeModels.set(task, { model: modelId, loadedAt: Date.now() })
    console.log(`[HFModelService] Model loaded: ${modelId}`)
  }

  // ============================================================
  // Internal — Idle Management
  // ============================================================

  private resetIdleTimer(task: HFTaskType): void {
    this.clearIdleTimer(task)

    const settings = loadSettings()
    const idleMs = (settings.hfAutoUnloadMinutes ?? 5) * 60 * 1000

    if (idleMs <= 0) return // Disabled

    const timer = setTimeout(async () => {
      console.log(`[HFModelService] Auto-unloading idle model for task: ${task}`)
      try {
        await this.unloadModel(task)
      } catch (err: any) {
        console.error(`[HFModelService] Auto-unload failed: ${err.message}`)
      }
    }, idleMs)

    this.idleTimers.set(task, timer)
  }

  private clearIdleTimer(task: HFTaskType): void {
    const existing = this.idleTimers.get(task)
    if (existing) {
      clearTimeout(existing)
      this.idleTimers.delete(task)
    }
  }

  // ============================================================
  // Internal — Helpers
  // ============================================================

  private assertEnabled(): void {
    const settings = loadSettings()
    if (settings.hfModelEnabled !== true) {
      throw new Error('Hugging Face AI chưa được bật. Vào Settings → In-house AI → Bật toggle.')
    }
  }

  private nextTaskId(): string {
    return `hf_${++this.taskIdCounter}_${Date.now()}`
  }

  /**
   * Extract clean text from text-generation pipeline output.
   * Pipeline returns various formats — normalize to plain string.
   */
  private extractTextFromResult(result: unknown, prompt?: string): string {
    let text = ''

    if (typeof result === 'string') {
      text = result
    } else if (Array.isArray(result) && result.length > 0) {
      const first = result[0]
      if (typeof first === 'string') {
        text = first
      } else if (first && typeof first.generated_text === 'string') {
        text = first.generated_text
      }
    } else if (result && typeof result === 'object' && 'generated_text' in (result as any)) {
      text = String((result as any).generated_text)
    } else {
      text = String(result || '')
    }

    text = text.trim()

    // HF text-generation pipeline includes the prompt in the output.
    // Strip it so we only return the newly generated continuation.
    if (prompt && text.startsWith(prompt)) {
      text = text.slice(prompt.length).trim()
    }

    return text || '(empty response)'
  }
}

// ============================================================
// Singleton Export
// ============================================================

export const hfModelService = new HFModelService()
