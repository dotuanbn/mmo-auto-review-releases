/**
 * hfmodel.ts — IPC handlers for Hugging Face local AI features.
 *
 * Exposes model status, preload/unload, and test inference
 * to the renderer process (Settings UI).
 */

import { ipcMain } from 'electron'
import { hfModelService } from '../services/HFModelService'
import type { HFTaskType } from '../services/hf-types'

export function registerHFModelHandlers(): void {
  /**
   * Get current HF service status — loaded models, memory, worker health.
   */
  ipcMain.handle('hfmodel:getStatus', async () => {
    try {
      return await hfModelService.getStatus()
    } catch (err: any) {
      return { error: err.message }
    }
  })

  /**
   * Preload a model for a specific task.
   * This triggers the download (if not cached) and loads into worker memory.
   */
  ipcMain.handle('hfmodel:preload', async (_event, task: HFTaskType, model?: string) => {
    try {
      await hfModelService.preloadModel(task, model)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  /**
   * Unload a model to free memory.
   */
  ipcMain.handle('hfmodel:unload', async (_event, task: HFTaskType) => {
    try {
      await hfModelService.unloadModel(task)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  /**
   * Test text generation — quick sanity check from Settings UI.
   */
  ipcMain.handle('hfmodel:testGenerate', async (_event, prompt?: string) => {
    try {
      const testPrompt = prompt || 'Write a short 2-sentence positive review for a coffee shop.'
      const result = await hfModelService.generateText(testPrompt, {
        maxNewTokens: 128,
        temperature: 0.8,
      })
      return { success: true, result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  /**
   * Dispose all models and kill the worker thread.
   */
  ipcMain.handle('hfmodel:dispose', async () => {
    try {
      await hfModelService.dispose()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  console.log('HF Model handlers registered')
}
