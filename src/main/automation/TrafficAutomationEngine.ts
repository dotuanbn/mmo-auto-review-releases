import { BrowserWindow } from 'electron'
import { browserService, BrowserConfig } from './BrowserService'
import { proxyService } from '../services/ProxyService'
import { locationService } from '../services/LocationService'
import { getDatabase } from '../database'
import { trafficTasks, TrafficTask } from '../database/schema'
import { eq } from 'drizzle-orm'
import { loadSettings } from '../ipc/settings'

export interface TrafficStatus {
    running: boolean
    taskId?: number
    currentLocation?: string
    currentViews: number
    targetViews: number
    message: string
}

export class TrafficAutomationEngine {
    private running = false
    private shouldStop = false
    private currentTaskId: number | null = null
    private activeContexts: number[] = []

    // Send status update to renderer
    private sendStatus(status: TrafficStatus) {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('traffic:progress', status)
        }
    }

    // Get random delay between min and max
    private getRandomDelay(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    // Get random item from array
    private getRandomItem<T>(array: T[]): T {
        return array[Math.floor(Math.random() * array.length)]
    }

    // Start traffic task
    async startTask(taskId: number): Promise<void> {
        if (this.running) {
            console.log('Traffic engine already running')
            return
        }

        this.running = true
        this.shouldStop = false
        this.currentTaskId = taskId

        try {
            const db = getDatabase()
            console.log(`[Traffic] Looking for task ID: ${taskId}`)
            const task = db.select().from(trafficTasks).where(eq(trafficTasks.id, taskId)).get() as TrafficTask | undefined

            if (!task) {
                console.error(`[Traffic] Task ${taskId} not found in database`)
                throw new Error('Traffic task not found')
            }
            console.log(`[Traffic] Found task:`, task)

            // Get location
            console.log(`[Traffic] Looking for location ID: ${task.locationId}`)
            const location = await locationService.getById(task.locationId)
            if (!location) {
                console.error(`[Traffic] Location ${task.locationId} not found`)
                throw new Error('Location not found')
            }
            console.log(`[Traffic] Found location:`, location.name, location.url)

            // Update task status
            db.update(trafficTasks)
                .set({ status: 'running', startedAt: new Date() })
                .where(eq(trafficTasks.id, taskId))
                .run()

            this.sendStatus({
                running: true,
                taskId,
                currentLocation: location.name,
                currentViews: task.currentViews,
                targetViews: task.targetViews,
                message: 'Starting traffic boost...'
            })

            // Get proxies if enabled
            let proxies: any[] = []
            if (task.useProxies) {
                proxies = await proxyService.getActive()
            }

            // Calculate views per session
            const viewsPerDay = task.viewsPerDay || 100
            const remainingViews = task.targetViews - task.currentViews

            let completedViews = task.currentViews

            // Traffic loop
            while (!this.shouldStop && completedViews < task.targetViews) {
                try {
                    // Get proxy if available
                    const proxy = proxies.length > 0 ? this.getRandomItem(proxies) : undefined

                    const settings = loadSettings()
                    
                    // Browser config - VISIBLE so user can see progress (unless disabled)
                    const config: BrowserConfig = {
                        headless: settings.headless ?? false,
                        userAgent: settings.randomizeUserAgent ? browserService.getRandomUserAgent() : undefined,
                        viewport: settings.randomizeViewport ? browserService.getRandomViewport() : undefined,
                    }

                    if (proxy) {
                        config.proxy = {
                            host: proxy.host,
                            port: proxy.port,
                            username: proxy.username,
                            password: proxy.password,
                        }
                    }

                    console.log(`[Traffic] Starting view ${completedViews + 1}/${task.targetViews}, proxy: ${proxy ? proxy.host : 'none'}`)

                    // Create browser context
                    const contextId = await browserService.createContext(config)
                    this.activeContexts.push(contextId)

                    try {
                        // Navigate to location
                        this.sendStatus({
                            running: true,
                            taskId,
                            currentLocation: location.name,
                            currentViews: completedViews,
                            targetViews: task.targetViews,
                            message: `Visiting ${location.name}... (${completedViews}/${task.targetViews})`
                        })

                        const page = await browserService.getPage(contextId)
                        if (!page) {
                            throw new Error('Could not get page')
                        }

                        // Visit the Maps page
                        await page.goto(location.url, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        })

                        // Simulate user behavior - scroll and wait
                        await page.waitForTimeout(this.getRandomDelay(3000, 8000))

                        // Random scroll
                        await page.evaluate(() => {
                            window.scrollBy(0, Math.random() * 500)
                        })

                        await page.waitForTimeout(this.getRandomDelay(2000, 5000))

                        // View complete
                        completedViews++

                        // Update database
                        db.update(trafficTasks)
                            .set({ currentViews: completedViews })
                            .where(eq(trafficTasks.id, taskId))
                            .run()

                    } finally {
                        // Close context
                        await browserService.closeContext(contextId)
                        this.activeContexts = this.activeContexts.filter(id => id !== contextId)
                    }

                    // Delay between visits
                    if (!this.shouldStop && completedViews < task.targetViews) {
                        const delay = this.getRandomDelay(5000, 15000) // 5-15 seconds between views
                        this.sendStatus({
                            running: true,
                            taskId,
                            currentLocation: location.name,
                            currentViews: completedViews,
                            targetViews: task.targetViews,
                            message: `Waiting ${Math.round(delay / 1000)}s...`
                        })
                        await new Promise(resolve => setTimeout(resolve, delay))
                    }

                    // Check daily limit
                    const todayViews = completedViews - task.currentViews
                    if (todayViews >= viewsPerDay) {
                        this.sendStatus({
                            running: false,
                            taskId,
                            currentLocation: location.name,
                            currentViews: completedViews,
                            targetViews: task.targetViews,
                            message: `Daily limit reached (${viewsPerDay} views). Resuming tomorrow.`
                        })
                        break
                    }

                } catch (error) {
                    console.error('Traffic view error:', error)
                    // Continue on error, don't stop the whole task
                    await new Promise(resolve => setTimeout(resolve, 5000))
                }
            }

            // Task complete or stopped
            const finalStatus = completedViews >= task.targetViews ? 'completed' : 'stopped'
            db.update(trafficTasks)
                .set({
                    status: finalStatus,
                    currentViews: completedViews,
                    completedAt: finalStatus === 'completed' ? new Date() : null
                })
                .where(eq(trafficTasks.id, taskId))
                .run()

            this.sendStatus({
                running: false,
                taskId,
                currentLocation: location.name,
                currentViews: completedViews,
                targetViews: task.targetViews,
                message: finalStatus === 'completed' ? 'Traffic boost completed!' : 'Traffic boost stopped'
            })

        } catch (error) {
            console.error('Traffic task error:', error)
            const db = getDatabase()
            db.update(trafficTasks)
                .set({ status: 'stopped' })
                .where(eq(trafficTasks.id, taskId))
                .run()

            this.sendStatus({
                running: false,
                taskId,
                currentViews: 0,
                targetViews: 0,
                message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            })
        } finally {
            this.running = false
            this.currentTaskId = null

            // Clean up any remaining contexts
            for (const contextId of this.activeContexts) {
                try {
                    await browserService.closeContext(contextId)
                } catch { }
            }
            this.activeContexts = []
        }
    }

    // Stop current task
    async stopTask(): Promise<void> {
        this.shouldStop = true

        if (this.currentTaskId) {
            const db = getDatabase()
            db.update(trafficTasks)
                .set({ status: 'stopped' })
                .where(eq(trafficTasks.id, this.currentTaskId))
                .run()
        }

        this.sendStatus({
            running: false,
            message: 'Traffic boost stopped'
        } as TrafficStatus)
    }

    // Check if running
    isRunning(): boolean {
        return this.running
    }

    // Get status
    getStatus(): TrafficStatus {
        return {
            running: this.running,
            taskId: this.currentTaskId || undefined,
            currentViews: 0,
            targetViews: 0,
            message: this.running ? 'Running...' : 'Idle'
        }
    }
}

export const trafficAutomationEngine = new TrafficAutomationEngine()
