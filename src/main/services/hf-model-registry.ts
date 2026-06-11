/**
 * hf-model-registry.ts — Default model configurations for each AI task.
 *
 * Models are downloaded on-demand from Hugging Face Hub.
 * All models listed here are ONNX-quantized variants optimized
 * for local inference via @huggingface/transformers.
 */

import type { HFTaskType, HFModelOptions } from './hf-types'

export interface ModelRegistryEntry {
  /** Default model ID on Hugging Face Hub */
  default: string
  /** Fallback model if default fails to load */
  fallback?: string
  /** Minimum free RAM (GB) required to load this model */
  minRamGB: number
  /** Default quantization level */
  quantization: HFModelOptions['dtype']
  /** Human-readable description */
  description: string
}

/**
 * Registry of recommended models per task type.
 * These are chosen for their small size and good accuracy trade-off
 * when running on consumer hardware.
 */
export const HF_MODEL_REGISTRY: Record<HFTaskType, ModelRegistryEntry> = {
  'text-generation': {
    default: 'Xenova/Qwen1.5-0.5B-Chat',
    fallback: 'Xenova/Phi-3-mini-4k-instruct',
    minRamGB: 1.5,
    quantization: 'q4',
    description: 'Small LLM for review text generation (0.5B params, ~350MB)',
  },
  'zero-shot-image-classification': {
    default: 'Xenova/clip-vit-base-patch32',
    minRamGB: 0.8,
    quantization: 'q8',
    description: 'CLIP model for image classification (captcha solving)',
  },
  'zero-shot-object-detection': {
    default: 'Xenova/owlvit-base-patch32',
    minRamGB: 1.0,
    quantization: 'q8',
    description: 'OWL-ViT model for UI element detection (DOM-Vision)',
  },
}

/**
 * Get registry entry for a task, with safe fallback.
 */
export function getRegistryEntry(task: HFTaskType): ModelRegistryEntry {
  const entry = HF_MODEL_REGISTRY[task]
  if (!entry) {
    throw new Error(`[HFModelRegistry] Unknown task type: ${task}`)
  }
  return entry
}

/**
 * Get the model ID to use for a task, considering user overrides.
 */
export function resolveModelId(task: HFTaskType, userOverride?: string): string {
  if (userOverride && userOverride.trim().length > 0) {
    return userOverride.trim()
  }
  return getRegistryEntry(task).default
}
