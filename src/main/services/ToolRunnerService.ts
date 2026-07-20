/**
 * ToolRunnerService.ts — Execute reusable automation CLI scripts
 *
 * Runs shell/Python scripts from the scripts/tools/ directory
 * within the Electron main process. Captures stdout/stderr output.
 *
 * Security: tool names are allowlisted against the on-disk registry;
 * script paths must resolve under the tools directory; args reject shell metas.
 */

import { spawn, ChildProcess } from 'child_process'
import { join, basename, resolve, sep } from 'path'
import { readdirSync, existsSync, statSync } from 'fs'
import { app } from 'electron'
import { toolNameSchema, safeCliArgSchema } from '../../shared/ipc-schemas'

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

const ALLOWED_EXTENSIONS = ['.sh', '.py', '.ts'] as const

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
      if (existsSync(p)) return resolve(p)
    }

    // Return default (will be created if needed)
    return resolve(possiblePaths[0])
  }

  private isPathInsideToolsDir(candidate: string, toolsDir: string): boolean {
    const resolvedCandidate = resolve(candidate)
    const resolvedRoot = resolve(toolsDir)
    if (process.platform === 'win32') {
      const c = resolvedCandidate.toLowerCase()
      const r = resolvedRoot.toLowerCase()
      return c === r || c.startsWith(r + sep.toLowerCase()) || c.startsWith(r + '\\') || c.startsWith(r + '/')
    }
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep)
  }

  /**
   * List all available tool scripts (the allowlist registry).
   */
  listTools(): ToolInfo[] {
    const toolsDir = this.getToolsDir()

    if (!existsSync(toolsDir)) {
      return []
    }

    try {
      return readdirSync(toolsDir)
        .filter(f => ALLOWED_EXTENSIONS.some(ext => f.endsWith(ext)))
        .map(filename => {
          const fullPath = resolve(join(toolsDir, filename))
          // Hard reject path escape via crafted filenames
          if (!this.isPathInsideToolsDir(fullPath, toolsDir)) {
            return null
          }
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
        .filter((t): t is ToolInfo => t !== null)
    } catch (err) {
      console.error('[ToolRunner] Failed to list tools:', err)
      return []
    }
  }

  /**
   * Return the current allowlist of tool names from the registry.
   */
  getAllowedToolNames(): string[] {
    return this.listTools().flatMap(t => [t.name, t.filename])
  }

  /**
   * Validate tool name against registry + schema.
   */
  private resolveAllowlistedTool(toolName: string): ToolInfo | null {
    const nameResult = toolNameSchema.safeParse(toolName)
    if (!nameResult.success) {
      return null
    }

    const tools = this.listTools()
    const match = tools.find(t => t.name === nameResult.data || t.filename === nameResult.data)
    if (!match) {
      return null
    }

    // Re-verify path is still inside tools dir
    const toolsDir = this.getToolsDir()
    if (!this.isPathInsideToolsDir(match.path, toolsDir)) {
      return null
    }

    return match
  }

  private sanitizeArgs(args: string[]): { ok: true; args: string[] } | { ok: false; error: string } {
    if (!Array.isArray(args)) {
      return { ok: false, error: 'Args must be an array of strings' }
    }
    if (args.length > 64) {
      return { ok: false, error: 'Too many arguments (max 64)' }
    }

    const sanitized: string[] = []
    for (const arg of args) {
      const parsed = safeCliArgSchema.safeParse(arg)
      if (!parsed.success) {
        return { ok: false, error: `Invalid arg: ${parsed.error.issues[0]?.message || 'rejected'}` }
      }
      sanitized.push(parsed.data)
    }
    return { ok: true, args: sanitized }
  }

  /**
   * Run a tool script with arguments.
   * Only tools present in the on-disk registry can run.
   */
  async runTool(toolName: string, args: string[] = []): Promise<ToolRunResult> {
    const tool = this.resolveAllowlistedTool(toolName)

    if (!tool) {
      const available = this.listTools().map(t => t.name).join(', ') || '(none)'
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Tool not allowed or not found: ${toolName}. Available: ${available}`,
        durationMs: 0,
      }
    }

    const argCheck = this.sanitizeArgs(args)
    if (!argCheck.ok) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: argCheck.error,
        durationMs: 0,
      }
    }

    return this.executeScript(tool, argCheck.args)
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
    return new Promise((resolvePromise) => {
      const startTime = performance.now()
      let stdout = ''
      let stderr = ''

      // Re-check path confinement immediately before spawn
      const toolsDir = this.getToolsDir()
      if (!this.isPathInsideToolsDir(tool.path, toolsDir) || !existsSync(tool.path)) {
        resolvePromise({
          exitCode: 1,
          stdout: '',
          stderr: `Tool path rejected or missing: ${tool.filename}`,
          durationMs: 0,
        })
        return
      }

      // Determine command based on script type — never pass user tool path as the command itself
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
          resolvePromise({
            exitCode: 1,
            stdout: '',
            stderr: `Unsupported script type: ${String(tool.type)}`,
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
          cwd: toolsDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: MAX_EXECUTION_MS,
          shell: false, // never shell-execute user input
          windowsHide: true,
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
          resolvePromise({
            exitCode: code,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            durationMs: Math.round(performance.now() - startTime),
          })
        })

        child.on('error', (err) => {
          this.runningProcess = null
          resolvePromise({
            exitCode: 1,
            stdout: '',
            stderr: `Failed to execute ${tool.filename}: ${err.message}`,
            durationMs: Math.round(performance.now() - startTime),
          })
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        resolvePromise({
          exitCode: 1,
          stdout: '',
          stderr: `Spawn error: ${message}`,
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
