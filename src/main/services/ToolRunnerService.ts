/**
 * ToolRunnerService.ts — Execute reusable automation CLI scripts
 *
 * Runs shell/Python scripts from the scripts/tools/ directory
 * within the Electron main process. Captures stdout/stderr output.
 *
 * Based on HF Tool Builder SKILL: all scripts support --help,
 * output NDJSON, and use $HF_TOKEN for auth.
 */

import { spawn, ChildProcess } from 'child_process'
import { join, basename } from 'path'
import { readdirSync, existsSync, statSync } from 'fs'
import { app } from 'electron'

// ============================================================
// Types
// ============================================================

export interface ToolInfo {
  name: string
  filename: string
  path: string
  type: 'sh' | 'py' | 'ts'
  sizeBytes: number
}

export interface ToolRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

// ============================================================
// Constants
// ============================================================

/** Max execution time before force-kill */
const MAX_EXECUTION_MS = 5 * 60 * 1000 // 5 minutes

// ============================================================
// ToolRunnerService
// ============================================================

class ToolRunnerService {
  private runningProcess: ChildProcess | null = null

  /**
   * Get the tools directory path.
   * Looks in project root/scripts/tools/ during dev,
   * and in resources/scripts/tools/ in production.
   */
  private getToolsDir(): string {
    const possiblePaths = [
      join(app.getAppPath(), 'scripts', 'tools'),
      join(app.getAppPath(), '..', 'scripts', 'tools'),
      join(process.cwd(), 'scripts', 'tools'),
    ]

    for (const p of possiblePaths) {
      if (existsSync(p)) return p
    }

    // Return default (will be created if needed)
    return possiblePaths[0]
  }

  /**
   * List all available tool scripts.
   */
  listTools(): ToolInfo[] {
    const toolsDir = this.getToolsDir()

    if (!existsSync(toolsDir)) {
      return []
    }

    const extensions = ['.sh', '.py', '.ts']

    try {
      return readdirSync(toolsDir)
        .filter(f => extensions.some(ext => f.endsWith(ext)))
        .map(filename => {
          const fullPath = join(toolsDir, filename)
          const ext = filename.split('.').pop() as ToolInfo['type']
          const stat = statSync(fullPath)

          return {
            name: basename(filename, `.${ext}`),
            filename,
            path: fullPath,
            type: ext,
            sizeBytes: stat.size,
          }
        })
    } catch (err) {
      console.error('[ToolRunner] Failed to list tools:', err)
      return []
    }
  }

  /**
   * Run a tool script with arguments.
   */
  async runTool(toolName: string, args: string[] = []): Promise<ToolRunResult> {
    const tools = this.listTools()
    const tool = tools.find(t => t.name === toolName || t.filename === toolName)

    if (!tool) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Tool not found: ${toolName}. Available: ${tools.map(t => t.name).join(', ') || '(none)'}`,
        durationMs: 0,
      }
    }

    return this.executeScript(tool, args)
  }

  /**
   * Stop any currently running tool.
   */
  stop(): boolean {
    if (this.runningProcess) {
      this.runningProcess.kill('SIGTERM')
      this.runningProcess = null
      return true
    }
    return false
  }

  // ============================================================
  // Internal — Script Execution
  // ============================================================

  private executeScript(tool: ToolInfo, args: string[]): Promise<ToolRunResult> {
    return new Promise((resolve) => {
      const startTime = performance.now()
      let stdout = ''
      let stderr = ''

      // Determine command based on script type
      let command: string
      let cmdArgs: string[]

      switch (tool.type) {
        case 'sh':
          command = process.platform === 'win32' ? 'bash' : '/bin/bash'
          cmdArgs = [tool.path, ...args]
          break
        case 'py':
          command = 'python'
          cmdArgs = [tool.path, ...args]
          break
        case 'ts':
          command = 'npx'
          cmdArgs = ['tsx', tool.path, ...args]
          break
        default:
          resolve({
            exitCode: 1,
            stdout: '',
            stderr: `Unsupported script type: ${tool.type}`,
            durationMs: 0,
          })
          return
      }

      // Pass HF_TOKEN if available
      const env = {
        ...process.env,
        HF_TOKEN: process.env.HF_TOKEN ?? '',
      }

      try {
        const child = spawn(command, cmdArgs, {
          env,
          cwd: this.getToolsDir(),
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: MAX_EXECUTION_MS,
        })

        this.runningProcess = child

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        child.on('close', (code) => {
          this.runningProcess = null
          resolve({
            exitCode: code,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            durationMs: Math.round(performance.now() - startTime),
          })
        })

        child.on('error', (err) => {
          this.runningProcess = null
          resolve({
            exitCode: 1,
            stdout: '',
            stderr: `Failed to execute ${tool.filename}: ${err.message}`,
            durationMs: Math.round(performance.now() - startTime),
          })
        })
      } catch (err: any) {
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: `Spawn error: ${err.message}`,
          durationMs: Math.round(performance.now() - startTime),
        })
      }
    })
  }
}

// ============================================================
// Singleton Export
// ============================================================

export const toolRunnerService = new ToolRunnerService()
