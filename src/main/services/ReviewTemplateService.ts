/**
 * ReviewTemplateService
 * Manages spintax review templates with parsing and variation generation
 */

import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'

export interface ReviewTemplate {
    id: number
    name: string
    content: string
    category: string
    isActive: boolean
    useCount: number
    createdAt: string
    updatedAt: string
}

export interface ParsedSpintax {
    original: string
    generated: string
    variations: string[][]
}

class ReviewTemplateService {
    /**
     * Get all templates
     */
    async getAll(): Promise<ReviewTemplate[]> {
        const db = getDatabase()
        return db.select().from(schema.reviewTemplates).all() as ReviewTemplate[]
    }

    /**
     * Get template by ID
     */
    async getById(id: number): Promise<ReviewTemplate | undefined> {
        const db = getDatabase()
        return db.select().from(schema.reviewTemplates).where(eq(schema.reviewTemplates.id, id)).get() as ReviewTemplate | undefined
    }

    /**
     * Get active templates by category
     */
    async getByCategory(category: string): Promise<ReviewTemplate[]> {
        const db = getDatabase()
        return db.select()
            .from(schema.reviewTemplates)
            .where(eq(schema.reviewTemplates.category, category))
            .all() as ReviewTemplate[]
    }

    /**
     * Get random active template
     */
    async getRandomActive(): Promise<ReviewTemplate | undefined> {
        const db = getDatabase()
        const templates = db.select()
            .from(schema.reviewTemplates)
            .where(eq(schema.reviewTemplates.isActive, true))
            .all() as ReviewTemplate[]

        if (templates.length === 0) return undefined
        return templates[Math.floor(Math.random() * templates.length)]
    }

    /**
     * Create a new template
     */
    async create(data: Omit<ReviewTemplate, 'id' | 'useCount' | 'createdAt' | 'updatedAt'>): Promise<ReviewTemplate> {
        const db = getDatabase()
        const now = new Date().toISOString()
        const result = db.insert(schema.reviewTemplates).values({
            name: data.name,
            content: data.content,
            category: data.category,
            isActive: data.isActive,
            useCount: 0,
            createdAt: now,
            updatedAt: now,
        }).returning().get()
        return result as ReviewTemplate
    }

    /**
     * Update a template
     */
    async update(id: number, data: Partial<ReviewTemplate>): Promise<void> {
        const db = getDatabase()
        db.update(schema.reviewTemplates)
            .set({ ...data, updatedAt: new Date().toISOString() })
            .where(eq(schema.reviewTemplates.id, id))
            .run()
    }

    /**
     * Delete a template
     */
    async delete(id: number): Promise<void> {
        const db = getDatabase()
        db.delete(schema.reviewTemplates).where(eq(schema.reviewTemplates.id, id)).run()
    }

    /**
     * Increment use count
     */
    async incrementUseCount(id: number): Promise<void> {
        const template = await this.getById(id)
        if (template) {
            await this.update(id, { useCount: template.useCount + 1 })
        }
    }

    /**
     * Parse spintax and generate a random variation
     * Spintax format: {option1|option2|option3}
     * 
     * Example: "Dịch vụ {tuyệt vời|rất tốt|xuất sắc}! {Tôi|Mình} rất hài lòng."
     * Could generate: "Dịch vụ tuyệt vời! Mình rất hài lòng."
     */
    parseSpintax(text: string): ParsedSpintax {
        const variations: string[][] = []
        let result = text

        // Regex to match {option1|option2|...}
        const spintaxRegex = /\{([^{}]+)\}/g
        let match: RegExpExecArray | null

        // First pass: collect all variations
        const tempText = text
        while ((match = spintaxRegex.exec(tempText)) !== null) {
            const options = match[1].split('|').map(s => s.trim())
            variations.push(options)
        }

        // Second pass: replace with random choices
        result = text.replace(spintaxRegex, (_, options: string) => {
            const choices = options.split('|').map((s: string) => s.trim())
            return choices[Math.floor(Math.random() * choices.length)]
        })

        return {
            original: text,
            generated: result,
            variations
        }
    }

    /**
     * Generate multiple variations from a template
     */
    generateVariations(text: string, count: number = 5): string[] {
        const results: Set<string> = new Set()
        let attempts = 0
        const maxAttempts = count * 10

        while (results.size < count && attempts < maxAttempts) {
            results.add(this.parseSpintax(text).generated)
            attempts++
        }

        return Array.from(results)
    }

    /**
     * Get a generated review from template
     */
    async generateReview(templateId?: number): Promise<{ text: string; templateId: number } | null> {
        let template: ReviewTemplate | undefined

        if (templateId) {
            template = await this.getById(templateId)
        } else {
            template = await this.getRandomActive()
        }

        if (!template) return null

        const parsed = this.parseSpintax(template.content)
        await this.incrementUseCount(template.id)

        return {
            text: parsed.generated,
            templateId: template.id
        }
    }

    /**
     * Preview spintax parsing without saving
     */
    previewSpintax(text: string): { preview: string; variationCount: number } {
        const parsed = this.parseSpintax(text)
        let variationCount = 1

        for (const options of parsed.variations) {
            variationCount *= options.length
        }

        return {
            preview: parsed.generated,
            variationCount
        }
    }

    /**
     * Get default templates for seeding
     */
    getDefaultTemplates(): Omit<ReviewTemplate, 'id' | 'useCount' | 'createdAt' | 'updatedAt'>[] {
        return [
            {
                name: 'Đánh giá 5 sao - Tích cực',
                category: '5_star',
                isActive: true,
                content: '{Dịch vụ|Trải nghiệm|Chất lượng} {tuyệt vời|xuất sắc|rất tốt|hoàn hảo}! {Tôi|Mình} {rất hài lòng|rất thích|đánh giá cao} với {dịch vụ|chất lượng|sản phẩm} ở đây. {Nhân viên|Staff} {thân thiện|nhiệt tình|chuyên nghiệp}, {giá cả hợp lý|giá tốt|đáng đồng tiền}. {Chắc chắn sẽ quay lại|Sẽ giới thiệu cho bạn bè|Highly recommend}! ⭐⭐⭐⭐⭐'
            },
            {
                name: 'Đánh giá 4 sao - Tốt',
                category: '4_star',
                isActive: true,
                content: '{Khá tốt|Tốt|Ổn áp}! {Dịch vụ|Chất lượng} {tốt|ổn|khá ổn}. {Nhân viên|Staff} {nhiệt tình|thân thiện}. {Có vài điểm cần cải thiện nhưng nhìn chung tốt|Nhìn chung hài lòng|Recommend}.'
            },
            {
                name: 'Đánh giá ngắn gọn',
                category: 'short',
                isActive: true,
                content: '{Tuyệt vời|Rất tốt|Xuất sắc|Đỉnh|10 điểm}! {👍|⭐⭐⭐⭐⭐|💯}'
            },
            {
                name: 'Đánh giá chi tiết',
                category: 'detailed',
                isActive: true,
                content: '{Mình|Tôi} đã {ghé|đến|sử dụng dịch vụ} ở đây {hôm qua|tuần trước|gần đây} và {rất hài lòng|ấn tượng|thích thú}.\n\n✅ {Điểm cộng|Ưu điểm}:\n- {Chất lượng dịch vụ tốt|Dịch vụ chuyên nghiệp}\n- {Nhân viên thân thiện, nhiệt tình|Staff chu đáo}\n- {Giá cả hợp lý|Đáng đồng tiền}\n\n{Chắc chắn sẽ quay lại và giới thiệu cho bạn bè!|Highly recommend!|Sẽ ủng hộ dài lâu!}'
            }
        ]
    }

    /**
     * Seed default templates if empty
     */
    async seedDefaults(): Promise<number> {
        const existing = await this.getAll()
        if (existing.length > 0) return 0

        const defaults = this.getDefaultTemplates()
        for (const template of defaults) {
            await this.create(template)
        }
        return defaults.length
    }
}

export const reviewTemplateService = new ReviewTemplateService()
