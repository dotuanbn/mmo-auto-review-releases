/**
 * hf-inference.worker.ts — Isolated Worker Thread for Hugging Face inference.
 *
 * Runs @huggingface/transformers pipelines in a separate V8 isolate
 * to prevent OOM crashes from killing the main Electron process.
 *
 * Communication via parentPort MessagePort using the WorkerRequest / WorkerResponse protocol.
 */

import { parentPort } from 'worker_threads'
import type {
  WorkerRequest,
  WorkerResponse,
  HFTaskType,
} from '../services/hf-types'

// ============================================================
// Pipeline Cache — one per task type
// ============================================================

const loadedPipelines: Map<HFTaskType, { pipeline: any; modelId: string }> = new Map()

/**
 * Dynamically import @huggingface/transformers.
 * Using dynamic import to allow the worker to be compiled without
 * bundling the entire transformers library at build time.
 */
async function getTransformers(): Promise<any> {
  return await import('@huggingface/transformers')
}

// ============================================================
// Handlers
// ============================================================

async function handleLoad(req: Extract<WorkerRequest, { type: 'load' }>): Promise<void> {
  const { taskId, task, model, options, cacheDir } = req

  try {
    // If already loaded with same model, skip
    const existing = loadedPipelines.get(task)
    if (existing && existing.modelId === model) {
      send({ type: 'ready', taskId })
      return
    }

    // Unload existing pipeline for this task if different model
    if (existing) {
      loadedPipelines.delete(task)
    }

    send({ type: 'progress', taskId, progress: 0, message: `Loading model ${model}...` })

    const { pipeline, env } = await getTransformers()

    // Configure cache directory
    if (cacheDir) {
      env.cacheDir = cacheDir
    }

    // Allow remote model fetching from Hugging Face Hub
    env.allowRemoteModels = true

    const pipelineOptions: Record<string, unknown> = {}

    if (options?.dtype) {
      pipelineOptions.dtype = options.dtype
    }

    // Create the pipeline
    const pipe = await pipeline(task, model, {
      ...pipelineOptions,
      progress_callback: (progress: any) => {
        if (progress && typeof progress.progress === 'number') {
          send({
            type: 'progress',
            taskId,
            progress: Math.round(progress.progress),
            message: progress.status || `Downloading ${model}...`,
          })
        }
      },
    })

    loadedPipelines.set(task, { pipeline: pipe, modelId: model })
    send({ type: 'ready', taskId })
  } catch (err: any) {
    send({ type: 'error', taskId, error: `Failed to load model ${model}: ${err?.message ?? String(err)}` })
  }
}

async function handlePredict(req: Extract<WorkerRequest, { type: 'predict' }>): Promise<void> {
  const { taskId, task, input, options } = req

  try {
    const entry = loadedPipelines.get(task)
    if (!entry) {
      send({ type: 'error', taskId, error: `No model loaded for task: ${task}. Call 'load' first.` })
      return
    }

    const result = await entry.pipeline(input, options || {})
    send({ type: 'result', taskId, data: result })
  } catch (err: any) {
    send({ type: 'error', taskId, error: `Inference failed for ${task}: ${err?.message ?? String(err)}` })
  }
}

async function handleUnload(req: Extract<WorkerRequest, { type: 'unload' }>): Promise<void> {
  const { taskId, task } = req

  try {
    const entry = loadedPipelines.get(task)
    if (entry) {
      // Dispose pipeline to free memory
      if (typeof entry.pipeline.dispose === 'function') {
        await entry.pipeline.dispose()
      }
      loadedPipelines.delete(task)
    }

    // Force garbage collection if available (requires --expose-gc flag)
    try {
      if (typeof global.gc === 'function') {
        global.gc()
      }
    } catch {
      // GC not available — safe to ignore
    }

    send({ type: 'ready', taskId })
  } catch (err: any) {
    send({ type: 'error', taskId, error: `Unload failed: ${err?.message ?? String(err)}` })
  }
}

function handleStatus(req: Extract<WorkerRequest, { type: 'status' }>): void {
  const memUsage = process.memoryUsage()
  const memoryUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024)
  const loadedModels = Array.from(loadedPipelines.entries()).map(
    ([task, entry]) => `${task}:${entry.modelId}`
  )

  send({
    type: 'status',
    taskId: req.taskId,
    loadedModels,
    memoryUsageMB,
  })
}

// ============================================================
// Message Router
// ============================================================

function send(msg: WorkerResponse): void {
  parentPort?.postMessage(msg)
}

parentPort?.on('message', async (msg: WorkerRequest) => {
  try {
    switch (msg.type) {
      case 'load':
        await handleLoad(msg)
        break
      case 'predict':
        await handlePredict(msg)
        break
      case 'unload':
        await handleUnload(msg)
        break
      case 'status':
        handleStatus(msg)
        break
      default:
        send({
          type: 'error',
          taskId: (msg as any).taskId || 'unknown',
          error: `Unknown message type: ${(msg as any).type}`,
        })
    }
  } catch (err: any) {
    send({
      type: 'error',
      taskId: (msg as any).taskId || 'unknown',
      error: `Worker unhandled error: ${err?.message ?? String(err)}`,
    })
  }
})

// Signal worker is ready
send({ type: 'ready', taskId: '__init__' })
