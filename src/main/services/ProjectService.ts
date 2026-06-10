import { getDatabase } from '../database'
import { projects, Project, NewProject, campaigns, trafficTasks, locations } from '../database/schema'
import { eq, desc, sql, and } from 'drizzle-orm'

export class ProjectService {
    // Get all projects
    async getAll(): Promise<Project[]> {
        const db = getDatabase()
        return db.select().from(projects).orderBy(desc(projects.createdAt)).all()
    }

    // Get project by ID
    async getById(id: number): Promise<Project | undefined> {
        const db = getDatabase()
        return db.select().from(projects).where(eq(projects.id, id)).get()
    }

    // Get active projects
    async getActive(): Promise<Project[]> {
        const db = getDatabase()
        return db.select().from(projects).where(eq(projects.status, 'active')).orderBy(desc(projects.createdAt)).all()
    }

    // Create a new project
    async create(data: NewProject): Promise<Project> {
        const db = getDatabase()
        return db.insert(projects).values(data).returning().get()
    }

    // Update a project
    async update(id: number, data: Partial<Project>): Promise<Project | undefined> {
        const db = getDatabase()
        return db.update(projects)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(projects.id, id))
            .returning()
            .get()
    }

    // Delete a project (and optionally its contents)
    async delete(id: number, deleteContents: boolean = false): Promise<void> {
        const db = getDatabase()

        if (deleteContents) {
            // Delete all related campaigns, traffic tasks, and locations
            db.delete(campaigns).where(eq(campaigns.projectId, id)).run()
            db.delete(trafficTasks).where(eq(trafficTasks.projectId, id)).run()
            db.delete(locations).where(eq(locations.projectId, id)).run()
        } else {
            // Just unlink - set projectId to null
            db.update(campaigns).set({ projectId: null }).where(eq(campaigns.projectId, id)).run()
            db.update(trafficTasks).set({ projectId: null }).where(eq(trafficTasks.projectId, id)).run()
            db.update(locations).set({ projectId: null }).where(eq(locations.projectId, id)).run()
        }

        db.delete(projects).where(eq(projects.id, id)).run()
    }

    // Archive a project
    async archive(id: number): Promise<Project | undefined> {
        return this.update(id, { status: 'archived' })
    }

    // Get project statistics
    async getStats(id: number): Promise<{
        totalLocations: number
        totalCampaigns: number
        totalTrafficTasks: number
        runningCampaigns: number
        completedTasks: number
    }> {
        const db = getDatabase()

        const totalLocations = db.select({ count: sql<number>`count(*)` })
            .from(locations)
            .where(eq(locations.projectId, id))
            .get()?.count || 0

        const totalCampaigns = db.select({ count: sql<number>`count(*)` })
            .from(campaigns)
            .where(eq(campaigns.projectId, id))
            .get()?.count || 0

        const runningCampaigns = db.select({ count: sql<number>`count(*)` })
            .from(campaigns)
            .where(and(eq(campaigns.projectId, id), eq(campaigns.status, 'running')))
            .get()?.count || 0

        const totalTrafficTasks = db.select({ count: sql<number>`count(*)` })
            .from(trafficTasks)
            .where(eq(trafficTasks.projectId, id))
            .get()?.count || 0

        const completedTasks = db.select({ count: sql<number>`count(*)` })
            .from(trafficTasks)
            .where(and(eq(trafficTasks.projectId, id), eq(trafficTasks.status, 'completed')))
            .get()?.count || 0

        return {
            totalLocations,
            totalCampaigns,
            totalTrafficTasks,
            runningCampaigns,
            completedTasks,
        }
    }

    // Get project with detailed info
    async getWithDetails(id: number): Promise<{
        project: Project
        locations: any[]
        campaigns: any[]
        trafficTasks: any[]
    } | null> {
        const db = getDatabase()

        const project = await this.getById(id)
        if (!project) return null

        const projectLocations = db.select().from(locations)
            .where(eq(locations.projectId, id)).all()

        const projectCampaigns = db.select().from(campaigns)
            .where(eq(campaigns.projectId, id)).all()

        const projectTrafficTasks = db.select().from(trafficTasks)
            .where(eq(trafficTasks.projectId, id)).all()

        return {
            project,
            locations: projectLocations,
            campaigns: projectCampaigns,
            trafficTasks: projectTrafficTasks,
        }
    }

    // Get all projects summary for dashboard
    async getAllWithSummary(): Promise<Array<Project & {
        locationCount: number
        campaignCount: number
        trafficCount: number
    }>> {
        const projectList = await this.getAll()
        const result = []

        for (const project of projectList) {
            const db = getDatabase()

            const locationCount = db.select({ count: sql<number>`count(*)` })
                .from(locations)
                .where(eq(locations.projectId, project.id))
                .get()?.count || 0

            const campaignCount = db.select({ count: sql<number>`count(*)` })
                .from(campaigns)
                .where(eq(campaigns.projectId, project.id))
                .get()?.count || 0

            const trafficCount = db.select({ count: sql<number>`count(*)` })
                .from(trafficTasks)
                .where(eq(trafficTasks.projectId, project.id))
                .get()?.count || 0

            result.push({
                ...project,
                locationCount,
                campaignCount,
                trafficCount,
            })
        }

        return result
    }
}

export const projectService = new ProjectService()
