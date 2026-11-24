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
const INIT_TIMEOUT_MS = 30_000
const IDLE_DISPOSE_MS = 5 * 60 * 1000 // Auto-unload after 5 min idle
const WORKER_SCRIPT_FILENAME = 'hf-inference.worker.js'

type PendingWorkerRequest = {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
  generation: number
}

function asError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(fallback)
}

// ============================================================
// HFModelService
// ============================================================

class HFModelService {
  private worker: Worker | null = null
  private workerReady = false
  /** Bumped on every spawn and on dispose so stale worker callbacks cannot mutate the replacement. */
  private workerGeneration = 0
  /** Bumped only on dispose; queued work captures this at admission. */
  private disposalEpoch = 0
  private initPromise: Promise<void> | null = null
  private initTimeout: ReturnType<typeof setTimeout> | null = null
  private initReject: ((err: Error) => void) | null = null

  /** Pending requests awaiting worker response, keyed by taskId */
  private pendingRequests: Map<string, PendingWorkerRequest> = new Map()

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
    const epoch = this.disposalEpoch
    const task: HFTaskType = 'text-generation'
    const startTime = performance.now()
    const modelId = this.activeModels.get(task)?.model ?? 'unknown'

    try {
      const result = await this.queue.add(async () => {
        this.assertAdmission(epoch)
        await this.ensureModelLoaded(task, epoch)
        this.assertAdmission(epoch)
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
        this.assertAdmission(epoch)
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
    const epoch = this.disposalEpoch
    const task: HFTaskType = 'zero-shot-image-classification'
    const startTime = performance.now()

    try {
      const result = await this.queue.add(async () => {
        this.assertAdmission(epoch)
        await this.ensureModelLoaded(task, epoch)
        this.assertAdmission(epoch)
        this.resetIdleTimer(task)

        const response = await this.sendToWorker({
          type: 'predict',
          taskId: this.nextTaskId(),
          task,
          input: imageBase64,
          options: { candidate_labels: labels },
        })
        this.assertAdmission(epoch)
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
    const epoch = this.disposalEpoch
    const task: HFTaskType = 'zero-shot-object-detection'
    const startTime = performance.now()

    try {
      const result = await this.queue.add(async () => {
        this.assertAdmission(epoch)
        await this.ensureModelLoaded(task, epoch)
        this.assertAdmission(epoch)
        this.resetIdleTimer(task)

        const response = await this.sendToWorker({
          type: 'predict',
          taskId: this.nextTaskId(),
          task,
          input: imageBase64,
          options: { candidate_labels: queries },
        })
        this.assertAdmission(epoch)
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
    const epoch = this.disposalEpoch
    await this.ensureModelLoaded(task, epoch, modelOverride)
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
   * Dispose all resources — cancel in-flight init, kill owned worker, clear timers.
   * Later explicit requests may initialize a new worker.
   */
  async dispose(): Promise<void> {
    this.disposalEpoch += 1
    this.workerGeneration += 1
    this.clearInitTimeout()

    const rejectInit = this.initReject
    this.initReject = null
    this.initPromise = null

    this.clearAllIdleTimers()
    this.activeModels.clear()
    this.rejectAllPending(new Error('HFModelService disposed'))

    const worker = this.worker
    this.worker = null
    this.workerReady = false

    if (rejectInit) {
      rejectInit(new Error('HFModelService disposed'))
    }

    if (worker) {
      try {
        await worker.terminate()
      } catch { /* ignore */ }
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
    if (this.initPromise) return this.initPromise

    // Generation is bumped before leftover terminate so a stale exit cannot clobber the replacement.
    const generation = ++this.workerGeneration
    const spawnPromise = this.spawnWorker(generation)
    this.initPromise = spawnPromise
    try {
      await spawnPromise
    } finally {
      if (this.initPromise === spawnPromise) {
        this.initPromise = null
      }
    }
  }

  private spawnWorker(generation: number): Promise<void> {
    const leftover = this.worker
    this.worker = null
    this.workerReady = false
    if (leftover) {
      void leftover.terminate().catch(() => undefined)
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        this.clearInitTimeout()
        if (this.initReject === settleReject) {
          this.initReject = null
        }
        if (error) reject(error)
        else resolve()
      }

      const settleReject = (error: Error): void => {
        settle(error)
      }
      this.initReject = settleReject

      let worker: Worker
      try {
        const workerPath = this.getWorkerScriptPath()
        console.log(`[HFModelService] Spawning worker from: ${workerPath}`)
        // NOTE: Electron blocks execArgv flags (e.g. --expose-gc) on worker_threads.
        // The worker has a defensive try/catch for global.gc(), so it's safe without the flag.
        worker = new Worker(workerPath)
      } catch (err) {
        settle(asError(err, 'Failed to spawn HF worker'))
        return
      }

      this.worker = worker

      this.initTimeout = setTimeout(() => {
        if (settled || this.workerGeneration !== generation) return
        const error = new Error('Worker failed to initialize within 30s')
        settle(error)
        this.failOwnedWorker(worker, generation, error, true)
      }, INIT_TIMEOUT_MS)

      worker.on('message', (msg: WorkerResponse) => {
        if (this.workerGeneration !== generation) return
        if (msg.type === 'ready' && msg.taskId === '__init__') {
          if (settled || this.worker !== worker) return
          this.workerReady = true
          console.log('[HFModelService] Worker thread ready')
          settle()
          return
        }
        this.handleWorkerMessage(msg)
      })

      worker.on('error', (err) => {
        if (this.workerGeneration !== generation) return
        console.error('[HFModelService] Worker error:', err.message)
        const error = asError(err, 'HF worker error')
        settle(error)
        this.failOwnedWorker(worker, generation, error, true)
      })

      worker.on('exit', (code) => {
        if (this.workerGeneration !== generation) return
        console.warn(`[HFModelService] Worker exited with code ${code}`)
        const error = new Error(`Worker exited unexpectedly (code=${code})`)
        this.failOwnedWorker(worker, generation, error, false)
        settle(error)
      })
    })
  }

  private failOwnedWorker(
    worker: Worker,
    generation: number,
    error: Error,
    terminate: boolean,
  ): void {
    if (this.workerGeneration !== generation) return

    this.workerReady = false
    if (this.worker === worker) {
      this.worker = null
    }
    this.activeModels.clear()
    this.clearAllIdleTimers()
    this.rejectPendingForGeneration(generation, error)

    if (terminate) {
      void worker.terminate().catch(() => undefined)
    }
  }

  private clearInitTimeout(): void {
    if (!this.initTimeout) return
    clearTimeout(this.initTimeout)
    this.initTimeout = null
  }

  private clearAllIdleTimers(): void {
    Array.from(this.idleTimers.values()).forEach((timer) => clearTimeout(timer))
    this.idleTimers.clear()
  }

  private rejectAllPending(error: Error): void {
    Array.from(this.pendingRequests.values()).forEach((pending) => {
      clearTimeout(pending.timeout)
      pending.reject(error)
    })
    this.pendingRequests.clear()
  }

  private rejectPendingForGeneration(generation: number, error: Error): void {
    for (const [taskId, pending] of Array.from(this.pendingRequests.entries())) {
      if (pending.generation !== generation) continue
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(taskId)
      pending.reject(error)
    }
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

    if (!this.worker || !this.workerReady) {
      throw new Error('Worker not available')
    }

    const generation = this.workerGeneration
    const worker = this.worker

    return new Promise((resolve, reject) => {
      if (this.workerGeneration !== generation || this.worker !== worker || !this.workerReady) {
        reject(new Error('Worker not available'))
        return
      }

      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(request.taskId)
        if (!pending) return
        this.pendingRequests.delete(request.taskId)
        reject(new Error(`Worker request timed out after ${timeoutMs}ms (taskId=${request.taskId})`))
      }, timeoutMs)

      this.pendingRequests.set(request.taskId, { resolve, reject, timeout, generation })
      try {
        worker.postMessage(request)
      } catch (err) {
        clearTimeout(timeout)
        this.pendingRequests.delete(request.taskId)
        reject(asError(err, 'Failed to post message to HF worker'))
      }
    })
  }

  // ============================================================
  // Internal — Model Lifecycle
  // ============================================================

  private async ensureModelLoaded(
    task: HFTaskType,
    epoch: number,
    modelOverride?: string,
  ): Promise<void> {
    this.assertAdmission(epoch)
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

    this.assertAdmission(epoch)
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

  private assertAdmission(epoch: number): void {
    if (epoch !== this.disposalEpoch) {
      throw new Error('HFModelService disposed')
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
