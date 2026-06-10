/**
 * AIService - AI Review Generation Service
 * 
 * Uses Google OpenRouter API to generate review content
 */

import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import { net } from 'electron'
import { hfModelService } from './HFModelService'
import { loadSettings as loadAppSettings } from '../ipc/settings'

// Groq API Configuration
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'

export interface GenerateReviewOptions {
    style?: 'casual' | 'professional' | 'enthusiastic'
    language?: 'vi' | 'en'
    rating?: number
    length?: 'short' | 'medium' | 'long'
}

export interface GeneratedReview {
    content: string
    rating: number
    style: string
    language: string
}

class AIService {
    private apiKey: string | null = null
    private aiModel: string = 'llama-3.3-70b-versatile'

    constructor() {
        this.loadSettings()
    }

    /**
     * Load API key and model from database settings
     */
    private async loadSettings(): Promise<void> {
        try {
            const db = getDatabase()
            const keyResult = db.select().from(schema.settings).where(eq(schema.settings.key, 'groqApiKey')).get()
            if (keyResult) {
                this.apiKey = keyResult.value
            }
            const modelResult = db.select().from(schema.settings).where(eq(schema.settings.key, 'groqModel')).get()
            if (modelResult && modelResult.value) {
                this.aiModel = modelResult.value
            }
        } catch (error) {
            console.error('Failed to load AI settings:', error)
        }
    }

    /**
     * Set and save API key
     */
    async setApiKey(key: string): Promise<{ success: boolean; error?: string }> {
        try {
            const db = getDatabase()

            // Test the key first
            const testResult = await this.testApiKey(key)
            if (!testResult.success) {
                return { success: false, error: testResult.error }
            }

            // Save to database
            const existing = db.select().from(schema.settings).where(eq(schema.settings.key, 'groqApiKey')).get()

            if (existing) {
                db.update(schema.settings)
                    .set({ value: key, updatedAt: new Date() })
                    .where(eq(schema.settings.key, 'groqApiKey'))
                    .run()
            } else {
                db.insert(schema.settings).values({
                    key: 'groqApiKey',
                    value: key,
                }).run()
            }

            this.apiKey = key
            return { success: true }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    }

    /**
     * Test if API key is valid
     */
    private async testApiKey(key: string): Promise<{ success: boolean; error?: string }> {
        try {
            const response = await net.fetch('https://api.groq.com/openai/v1/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${key}`
                }
            })

            if (!response.ok) {
                const error = await response.json() as any
                return { success: false, error: error.error?.message || 'Invalid API key' }
            }

            return { success: true }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    }

    /**
     * Get API key status
     */
    async getApiKeyStatus(): Promise<{ hasKey: boolean; isValid?: boolean }> {
        if (!this.apiKey) {
            await this.loadSettings()
        }

        if (!this.apiKey) {
            return { hasKey: false }
        }

        const testResult = await this.testApiKey(this.apiKey)
        return { hasKey: true, isValid: testResult.success }
    }

    /**
     * Generate a review using Groq AI
     */
    async generateReview(
        locationName: string,
        category?: string,
        options: GenerateReviewOptions = {}
    ): Promise<{ success: boolean; review?: GeneratedReview; error?: string }> {
        if (!this.apiKey) {
            await this.loadSettings()
            if (!this.apiKey) {
                // Fallback to local HF model if enabled
                return this.generateReviewLocal(locationName, category, options)
            }
        }

        const {
            style = 'casual',
            language = 'vi',
            rating = 5,
            length = 'medium'
        } = options

        const lengthGuide = {
            short: '30-50 từ',
            medium: '50-100 từ',
            long: '100-200 từ'
        }

        const styleGuide = {
            casual: 'thân thiện, tự nhiên như người dùng thực',
            professional: 'chuyên nghiệp, chi tiết và có cấu trúc',
            enthusiastic: 'nhiệt tình, sử dụng nhiều tính từ tích cực'
        }

        const prompt = language === 'vi'
            ? `Bạn là một khách hàng thực sự đang viết đánh giá trên Google Maps. Hãy viết một đánh giá ${rating} sao cho "${locationName}"${category ? ` (loại hình: ${category})` : ''}.

Yêu cầu:
- Phong cách: ${styleGuide[style]}
- Độ dài: ${lengthGuide[length]}
- Đánh giá ${rating} sao
- KHÔNG sử dụng emoji
- KHÔNG dùng các cụm từ: "Tôi xin đánh giá", "Đánh giá của tôi", "Review"
- Viết tự nhiên như một khách hàng thực, chia sẻ trải nghiệm cá nhân
- Có thể đề cập: chất lượng dịch vụ, thái độ nhân viên, không gian, giá cả (nếu phù hợp)

Chỉ trả lời nội dung đánh giá, không cần giải thích thêm.`
            : `You are a real customer writing a Google Maps review. Write a ${rating}-star review for "${locationName}"${category ? ` (type: ${category})` : ''}.

Requirements:
- Style: ${style}
- Length: ${length} (about ${lengthGuide[length].replace('từ', 'words')})
- ${rating}-star rating
- NO emojis
- Write naturally like a real customer sharing personal experience
- May mention: service quality, staff attitude, atmosphere, pricing (if relevant)

Only respond with the review content, no explanations.`

        try {
            const response = await net.fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.aiModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.9,
                    top_p: 0.95,
                    max_tokens: 500
                })
            })

            if (!response.ok) {
                const error = await response.json()
                return { success: false, error: error.error?.message || 'API request failed' }
            }

            const data = await response.json()
            const content = data.choices?.[0]?.message?.content?.trim()

            if (!content) {
                return { success: false, error: 'No content generated' }
            }

            return {
                success: true,
                review: {
                    content,
                    rating,
                    style,
                    language
                }
            }
        } catch (error: any) {
            // Cloud failed — attempt local fallback
            console.warn(`[AIService] Groq API failed: ${error.message}. Trying local HF fallback...`)
            return this.generateReviewLocal(locationName, category, options)
        }
    }

    /**
     * Generate multiple reviews
     */
    async generateBulkReviews(
        count: number,
        locationName: string,
        category?: string,
        options: GenerateReviewOptions = {}
    ): Promise<{ success: boolean; reviews?: GeneratedReview[]; error?: string }> {
        const reviews: GeneratedReview[] = []
        const errors: string[] = []

        // Vary the styles for natural diversity
        const styles: Array<'casual' | 'professional' | 'enthusiastic'> = ['casual', 'professional', 'enthusiastic']
        const lengths: Array<'short' | 'medium' | 'long'> = ['short', 'medium', 'long']

        for (let i = 0; i < count; i++) {
            const style = styles[i % styles.length]
            const length = lengths[i % lengths.length]

            const result = await this.generateReview(locationName, category, {
                ...options,
                style,
                length
            })

            if (result.success && result.review) {
                reviews.push(result.review)
            } else if (result.error) {
                errors.push(result.error)
            }

            // Small delay between requests to avoid rate limiting
            if (i < count - 1) {
                await new Promise(resolve => setTimeout(resolve, 500))
            }
        }

        if (reviews.length === 0) {
            return { success: false, error: errors[0] || 'Failed to generate reviews' }
        }

        return { success: true, reviews }
    }

    /**
     * Improve existing review text
     */
    async improveReview(
        text: string,
        language: 'vi' | 'en' = 'vi'
    ): Promise<{ success: boolean; improved?: string; error?: string }> {
        if (!this.apiKey) {
            await this.loadSettings()
            if (!this.apiKey) {
                return { success: false, error: 'API key not configured' }
            }
        }

        const prompt = language === 'vi'
            ? `Hãy cải thiện đánh giá Google Maps sau đây để tự nhiên và thuyết phục hơn, giữ nguyên ý nghĩa chính:

"${text}"

Yêu cầu:
- Giữ độ dài tương tự
- Không dùng emoji
- Viết tự nhiên như khách hàng thực
- Chỉ trả lời nội dung đánh giá đã cải thiện`
            : `Improve the following Google Maps review to be more natural and convincing, keeping the main message:

"${text}"

Requirements:
- Keep similar length
- No emojis
- Write naturally like a real customer
- Only respond with the improved review content`

        try {
            const response = await net.fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.aiModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 500
                })
            })

            if (!response.ok) {
                const error = await response.json()
                return { success: false, error: error.error?.message || 'API request failed' }
            }

            const data = await response.json()
            const improved = data.choices?.[0]?.message?.content?.trim()

            if (!improved) {
                return { success: false, error: 'No content generated' }
            }

            return { success: true, improved }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    }

    /**
     * Generic chat method for Agentic AI fallback (supports JSON format)
     */
    async chat(
        prompt: string,
        systemPrompt?: string,
        jsonFormat: boolean = false
    ): Promise<{ success: boolean; response?: string; error?: string }> {
        if (!this.apiKey) {
            await this.loadSettings()
            if (!this.apiKey) {
                return this.chatLocal(prompt, systemPrompt)
            }
        }

        try {
            const messages = []
            
            if (systemPrompt) {
                messages.push({ role: 'system', content: systemPrompt })
            }
            messages.push({ role: 'user', content: prompt })

            const requestBody: any = {
                model: this.aiModel,
                messages,
                temperature: 0.1, // Low temperature for deterministic output
                top_p: 0.9,
                max_tokens: 2048,
            }

            if (jsonFormat) {
                requestBody.response_format = { type: 'json_object' }
            }

            const response = await net.fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(requestBody)
            })

            if (!response.ok) {
                const error = await response.json()
                return { success: false, error: error.error?.message || 'API request failed' }
            }

            const data = await response.json()
            const content = data.choices?.[0]?.message?.content?.trim()

            if (!content) {
                return { success: false, error: 'Empty response from Groq' }
            }

            return { success: true, response: content }
        } catch (error: any) {
            // Cloud failed — attempt local fallback
            console.warn(`[AIService] Groq chat failed: ${error.message}. Trying local HF fallback...`)
            return this.chatLocal(prompt, systemPrompt)
        }
    }

    /**
     * Save generated review to database
     */
    async saveGeneratedReview(
        review: GeneratedReview,
        locationId?: number
    ): Promise<{ success: boolean; id?: number; error?: string }> {
        try {
            const db = getDatabase()

            // Save as template
            const result = db.insert(schema.reviewTemplates).values({
                name: `AI Generated - ${new Date().toLocaleString()}`,
                content: review.content,
                category: `${review.rating}_star`,
                isActive: true,
            }).run()

            return { success: true, id: Number(result.lastInsertRowid) }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    }
    // ============================================================
    // Local AI Fallback (HuggingFace Transformers.js)
    // ============================================================

    /**
     * Generate review using local HF model (Qwen 0.5B).
     * Called when Groq API is unavailable or fails.
     */
    private async generateReviewLocal(
        locationName: string,
        category?: string,
        options: GenerateReviewOptions = {}
    ): Promise<{ success: boolean; review?: GeneratedReview; error?: string }> {
        const appSettings = loadAppSettings()
        if (!appSettings.hfModelEnabled) {
            return {
                success: false,
                error: 'Groq API key chưa cấu hình và In-house AI chưa bật. Vào Settings để cấu hình.',
            }
        }

        const {
            style = 'casual',
            language = 'vi',
            rating = 5,
            length = 'medium',
        } = options

        const lengthGuide: Record<string, string> = {
            short: '30-50 từ',
            medium: '50-100 từ',
            long: '100-200 từ',
        }

        const prompt = language === 'vi'
            ? `Viết đánh giá ${rating} sao cho "${locationName}"${category ? ` (${category})` : ''}. Phong cách ${style}, khoảng ${lengthGuide[length]}. Không dùng emoji. Viết tự nhiên như khách hàng thực.`
            : `Write a ${rating}-star review for "${locationName}"${category ? ` (${category})` : ''}. Style: ${style}, length: ${length}. No emojis. Write naturally like a real customer.`

        try {
            console.log('[AIService] Generating review via local HF model...')
            const content = await hfModelService.generateText(prompt, {
                maxNewTokens: length === 'short' ? 80 : length === 'long' ? 300 : 150,
                temperature: 0.9,
                topP: 0.95,
            })

            if (!content || content.trim().length === 0) {
                return { success: false, error: 'Local AI: không sinh được nội dung' }
            }

            return {
                success: true,
                review: {
                    content: content.trim(),
                    rating,
                    style,
                    language,
                },
            }
        } catch (err: any) {
            return { success: false, error: `Local AI error: ${err.message}` }
        }
    }

    /**
     * Generic chat with local HF fallback.
     */
    private async chatLocal(
        prompt: string,
        systemPrompt?: string,
    ): Promise<{ success: boolean; response?: string; error?: string }> {
        const appSettings = loadAppSettings()
        if (!appSettings.hfModelEnabled) {
            return { success: false, error: 'Both Groq API and In-house AI are unavailable.' }
        }

        try {
            const result = await hfModelService.generateText(prompt, {
                maxNewTokens: 512,
                temperature: 0.3,
                systemPrompt,
            })
            return { success: true, response: result }
        } catch (err: any) {
            return { success: false, error: `Local AI error: ${err.message}` }
        }
    }
}

export const aiService = new AIService()
