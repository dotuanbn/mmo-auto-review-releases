/**
 * AppShutdownService.ts
 *
 * Pure, Electron-decoupled shutdown coordinator.
 * Executes ordered cleanup steps with error isolation and single-flight semantics.
 * Provides a lifecycle router port to wire Electron lifecycle events safely.
 */

export interface ShutdownStep {
    name: string
    run: () => Promise<void> | void
    timeoutMs?: number
}

export interface ShutdownResult {
    clean: boolean
    failedSteps: string[]
}

export interface AppShutdownServiceOptions {
    defaultStepTimeoutMs?: number
    logger?: (message: string, error?: unknown) => void
}

export interface EventWithPreventDefault {
    preventDefault: () => void
    readonly defaultPrevented?: boolean
}

export interface LifecyclePort {
    on(event: 'before-quit', listener: (event: EventWithPreventDefault) => void): unknown
    on(event: 'window-all-closed', listener: () => void): unknown
    on(event: 'will-quit', listener: (event: EventWithPreventDefault) => void): unknown
    quit(): void
}

export interface LifecycleRouterOptions {
    port: LifecyclePort
    shutdownService: AppShutdownService
    onShutdownComplete?: (result: ShutdownResult) => void
    onWillQuit?: (isClean: boolean) => void
    isMac?: boolean
    logger?: (message: string, error?: unknown) => void
}

export class AppShutdownService {
    private readonly steps: ShutdownStep[] = []
    private readonly defaultStepTimeoutMs: number
    private readonly logger?: (message: string, error?: unknown) => void

    private shutdownPromise: Promise<ShutdownResult> | null = null
    private complete = false
    private result: ShutdownResult | null = null

    constructor(options: AppShutdownServiceOptions = {}) {
        this.defaultStepTimeoutMs = options.defaultStepTimeoutMs ?? 15_000
        this.logger = options.logger
    }

    /**
     * Registers an ordered cleanup step. Steps execute in registration order.
     */
    registerStep(step: ShutdownStep): this {
        if (this.shutdownPromise) {
            throw new Error(`Cannot register step "${step.name}" while shutdown is in progress or completed`)
        }
        this.steps.push(step)
        return this
    }

    getSteps(): readonly ShutdownStep[] {
        return this.steps
    }

    isShuttingDown(): boolean {
        return this.shutdownPromise !== null && !this.complete
    }

    isComplete(): boolean {
        return this.complete
    }

    isClean(): boolean {
        return this.result !== null && this.result.clean
    }

    getResult(): ShutdownResult | null {
        return this.result
    }

    /**
     * Executes all registered cleanup steps in order.
     * Single-flight: concurrent or repeated calls return the same promise and result.
     * Defer execution via Promise.resolve().then so this.shutdownPromise is assigned strictly
     * BEFORE executing the first step, preventing synchronously reentrant calls from launching duplicate cleanup.
     * Errors in individual steps are isolated and do not prevent remaining steps from executing.
     */
    shutdown(): Promise<ShutdownResult> {
        if (this.shutdownPromise) {
            return this.shutdownPromise
        }

        this.shutdownPromise = Promise.resolve().then(() => this.executeShutdown())
        return this.shutdownPromise
    }

    private async executeShutdown(): Promise<ShutdownResult> {
        const failedSteps: string[] = []

        for (const step of this.steps) {
            const timeoutMs = step.timeoutMs ?? this.defaultStepTimeoutMs
            try {
                if (timeoutMs > 0) {
                    await this.runWithTimeout(step.run, timeoutMs, step.name)
                } else {
                    await step.run()
                }
            } catch (err) {
                failedSteps.push(step.name)
                this.safeLog(`[AppShutdownService] Step "${step.name}" failed`, err)
            }
        }

        const clean = failedSteps.length === 0
        this.result = { clean, failedSteps }
        this.complete = true
        return this.result
    }

    /**
     * Runs an action with a finite deadline.
     * Limitation note: Promise.race timeout cannot cancel or abort an underlying
     * JavaScript task that lacks built-in abort support. When a timeout occurs,
     * the step is recorded in failedSteps and clean is marked false, allowing subsequent
     * cleanup (such as database closing) to continue safely without claiming clean.
     */
    private async runWithTimeout(
        action: () => Promise<void> | void,
        timeoutMs: number,
        stepName: string
    ): Promise<void> {
        let timer: NodeJS.Timeout | null = null

        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Shutdown step "${stepName}" timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            if (timer && typeof timer.unref === 'function') {
                timer.unref()
            }
        })

        try {
            await Promise.race([
                Promise.resolve(action()),
                timeoutPromise,
            ])
        } finally {
            if (timer) {
                clearTimeout(timer)
                timer = null
            }
        }
    }

    private safeLog(message: string, error?: unknown): void {
        try {
            this.logger?.(message, error)
        } catch {
            // Injected logger throwing must not fail shutdown
        }
    }
}

/**
 * Connects AppShutdownService to application lifecycle events (Electron or test mock).
 * - Intercepts before-quit: prevents default until all cleanup completes, then calls quit().
 * - Intercepts window-all-closed: routes to quit() on non-mac platforms so before-quit handles cleanup.
 * - Handles will-quit: provides fallback hook ensuring runtime health never claims clean prematurely.
 * - Uses protected logging and error handling so logger/callback failures cannot strand final quit or create unhandled rejections.
 */
export function registerLifecycleRouter(options: LifecycleRouterOptions): void {
    const { port, shutdownService, onShutdownComplete, onWillQuit, isMac = false, logger } = options

    const safeLog = (message: string, error?: unknown): void => {
        try {
            logger?.(message, error)
        } catch {
            // Protected logging: throwing logger must never crash router or leak unhandled rejections
        }
    }

    let finalQuitTriggered = false

    const triggerFinalQuit = (): void => {
        if (finalQuitTriggered) {
            return
        }
        finalQuitTriggered = true
        try {
            port.quit()
        } catch (quitErr) {
            safeLog('[LifecycleRouter] port.quit error after shutdown completion', quitErr)
        }
    }

    port.on('before-quit', (event: EventWithPreventDefault) => {
        if (shutdownService.isComplete()) {
            // Cleanup already finished; allow default quit action to proceed.
            return
        }

        // Synchronously prevent premature quit so async cleanup can finish.
        try {
            event.preventDefault()
        } catch (err) {
            safeLog('[LifecycleRouter] event.preventDefault failed', err)
        }

        if (!shutdownService.isShuttingDown()) {
            shutdownService.shutdown().then((result) => {
                try {
                    onShutdownComplete?.(result)
                } catch (err) {
                    safeLog('[LifecycleRouter] onShutdownComplete error', err)
                } finally {
                    triggerFinalQuit()
                }
            }).catch((err) => {
                safeLog('[LifecycleRouter] Fatal shutdown rejection', err)
                try {
                    onShutdownComplete?.({ clean: false, failedSteps: ['unhandled_shutdown_error'] })
                } catch (cbErr) {
                    safeLog('[LifecycleRouter] onShutdownComplete error on fatal rejection', cbErr)
                } finally {
                    triggerFinalQuit()
                }
            })
        }
    })

    port.on('window-all-closed', () => {
        // Route through app.quit() so the canonical before-quit cleanup path handles it.
        if (!isMac) {
            try {
                port.quit()
            } catch (err) {
                safeLog('[LifecycleRouter] port.quit error in window-all-closed handler', err)
            }
        }
    })

    port.on('will-quit', () => {
        try {
            onWillQuit?.(shutdownService.isClean())
        } catch (err) {
            safeLog('[LifecycleRouter] onWillQuit error', err)
        }
    })
}
