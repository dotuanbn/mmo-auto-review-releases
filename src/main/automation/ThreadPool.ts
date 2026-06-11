import { EventEmitter } from 'events'

/**
 * ThreadPool - Manage concurrent browser automation tasks
 * Limits parallel executions and provides queue-based task distribution
 */

export interface ThreadTask<T = any> {
    id: string
    name: string
    execute: () => Promise<T>
    priority?: number
    retries?: number
    timeout?: number
}

export interface ThreadResult<T = any> {
    taskId: string
    success: boolean
    result?: T
    error?: string
    duration: number
}

interface ActiveThread {
    taskId: string
    startTime: number
    threadIndex: number
}

export class ThreadPool extends EventEmitter {
    private maxThreads: number
    private activeThreads: Map<number, ActiveThread> = new Map()
    private taskQueue: ThreadTask[] = []
    private results: Map<string, ThreadResult> = new Map()
    private isRunning: boolean = false
    private processedCount: number = 0
    private totalCount: number = 0

    constructor(maxThreads: number = 3) {
        super()
        this.maxThreads = Math.max(1, Math.min(maxThreads, 10)) // 1-10 threads
    }

    /**
     * Add task to queue
     */
    addTask(task: ThreadTask): void {
        this.taskQueue.push(task)
        this.totalCount++

        // Sort by priority (higher first)
        this.taskQueue.sort((a, b) => (b.priority || 0) - (a.priority || 0))

        this.emit('taskAdded', { taskId: task.id, queueSize: this.taskQueue.length })
    }

    /**
     * Add multiple tasks
     */
    addTasks(tasks: ThreadTask[]): void {
        tasks.forEach(task => this.addTask(task))
    }

    /**
     * Start processing queue
     */
    async start(): Promise<ThreadResult[]> {
        if (this.isRunning) {
            throw new Error('ThreadPool is already running')
        }

        this.isRunning = true
        this.emit('started', { totalTasks: this.totalCount })

        // Start initial threads
        const threadPromises: Promise<void>[] = []
        for (let i = 0; i < this.maxThreads; i++) {
            threadPromises.push(this.runThread(i))
        }

        // Wait for all threads to complete
        await Promise.all(threadPromises)

        this.isRunning = false
        this.emit('completed', {
            totalProcessed: this.processedCount,
            results: Array.from(this.results.values())
        })

        return Array.from(this.results.values())
    }

    /**
     * Stop processing (gracefully)
     */
    stop(): void {
        this.isRunning = false
        this.emit('stopping')
    }

    /**
     * Run a single thread loop
     */
    private async runThread(threadIndex: number): Promise<void> {
        while (this.isRunning && this.taskQueue.length > 0) {
            const task = this.taskQueue.shift()
            if (!task) break

            const startTime = Date.now()
            this.activeThreads.set(threadIndex, {
                taskId: task.id,
                startTime,
                threadIndex,
            })

            this.emit('taskStarted', {
                taskId: task.id,
                threadIndex,
                remaining: this.taskQueue.length
            })

            try {
                // Execute with timeout if specified
                let result: any
                if (task.timeout) {
                    result = await Promise.race([
                        task.execute(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Task timeout')), task.timeout)
                        )
                    ])
                } else {
                    result = await task.execute()
                }

                const duration = Date.now() - startTime
                this.results.set(task.id, {
                    taskId: task.id,
                    success: true,
                    result,
                    duration,
                })

                this.emit('taskCompleted', { taskId: task.id, duration, success: true })

            } catch (error) {
                const duration = Date.now() - startTime
                const errorMessage = error instanceof Error ? error.message : 'Unknown error'

                // Retry logic
                if (task.retries && task.retries > 0) {
                    task.retries--
                    this.taskQueue.unshift(task) // Add back to front
                    this.emit('taskRetry', { taskId: task.id, retriesLeft: task.retries })
                } else {
                    this.results.set(task.id, {
                        taskId: task.id,
                        success: false,
                        error: errorMessage,
                        duration,
                    })
                    this.emit('taskFailed', { taskId: task.id, error: errorMessage, duration })
                }
            }

            this.activeThreads.delete(threadIndex)
            this.processedCount++

            this.emit('progress', {
                processed: this.processedCount,
                total: this.totalCount,
                percentage: Math.round((this.processedCount / this.totalCount) * 100),
                activeThreads: this.activeThreads.size,
                queueRemaining: this.taskQueue.length,
            })
        }
    }

    /**
     * Get current status
     */
    getStatus(): {
        isRunning: boolean
        activeThreads: number
        queueSize: number
        processedCount: number
        totalCount: number
    } {
        return {
            isRunning: this.isRunning,
            activeThreads: this.activeThreads.size,
            queueSize: this.taskQueue.length,
            processedCount: this.processedCount,
            totalCount: this.totalCount,
        }
    }

    /**
     * Get results
     */
    getResults(): ThreadResult[] {
        return Array.from(this.results.values())
    }

    /**
     * Clear all data
     */
    clear(): void {
        this.taskQueue = []
        this.results.clear()
        this.processedCount = 0
        this.totalCount = 0
    }

    /**
     * Set max threads
     */
    setMaxThreads(count: number): void {
        this.maxThreads = Math.max(1, Math.min(count, 10))
    }

    /**
     * Get active thread info
     */
    getActiveThreads(): Array<{ threadIndex: number; taskId: string; runningTime: number }> {
        const now = Date.now()
        return Array.from(this.activeThreads.values()).map(t => ({
            threadIndex: t.threadIndex,
            taskId: t.taskId,
            runningTime: now - t.startTime,
        }))
    }
}

// Factory function for convenience
export function createThreadPool(maxThreads: number = 3): ThreadPool {
    return new ThreadPool(maxThreads)
}

// Export singleton for global use
export const threadPool = new ThreadPool(5)
