/**
 * SpintaxParser - Parse and generate variations from spintax syntax
 * 
 * Spintax format: {option1|option2|option3}
 * Nested spintax: {Hello|Hi} {world|there}! -> "Hello world!" or "Hi there!" etc.
 * 
 * Example:
 * Input: "{Tuyệt vời|Rất tốt|Dịch vụ ok}! {Nhân viên|Staff} {thân thiện|nhiệt tình}."
 * Outputs: 
 *   - "Tuyệt vời! Nhân viên thân thiện."
 *   - "Rất tốt! Staff nhiệt tình."
 *   - etc.
 */

export class SpintaxParser {
    // Regular expression to match spintax patterns {option1|option2|...}
    private static readonly SPINTAX_REGEX = /\{([^{}]+)\}/g

    /**
     * Parse spintax and generate a random variation
     * @param text - Text containing spintax patterns
     * @returns Processed text with random selections
     */
    static spin(text: string): string {
        let result = text
        let match: RegExpExecArray | null

        // Clone regex to avoid shared mutable state under concurrent calls
        const regex = new RegExp(this.SPINTAX_REGEX.source, 'g')
        // Keep processing until no more spintax patterns found
        while ((match = regex.exec(result)) !== null) {
            const options = match[1].split('|')
            const randomOption = options[Math.floor(Math.random() * options.length)]
            result = result.replace(match[0], randomOption)
            // Reset regex lastIndex since we modified the string
            regex.lastIndex = 0
        }

        return result
    }

    /**
     * Generate multiple unique variations from spintax
     * @param text - Text containing spintax patterns
     * @param count - Number of variations to generate
     * @returns Array of unique text variations
     */
    static generateVariations(text: string, count: number): string[] {
        const variations = new Set<string>()
        const maxAttempts = count * 10 // Prevent infinite loops
        let attempts = 0

        while (variations.size < count && attempts < maxAttempts) {
            const variation = this.spin(text)
            variations.add(variation)
            attempts++
        }

        return Array.from(variations)
    }

    /**
     * Count total possible combinations in a spintax text
     * @param text - Text containing spintax patterns
     * @returns Number of possible combinations
     */
    static countCombinations(text: string): number {
        let total = 1
        let match: RegExpExecArray | null

        // Clone regex to avoid state issues
        const regex = new RegExp(this.SPINTAX_REGEX.source, 'g')

        while ((match = regex.exec(text)) !== null) {
            const options = match[1].split('|')
            total *= options.length
        }

        return total
    }

    /**
     * Validate spintax syntax (balanced braces)
     * @param text - Text to validate
     * @returns True if syntax is valid
     */
    static isValid(text: string): boolean {
        let depth = 0

        for (const char of text) {
            if (char === '{') depth++
            if (char === '}') depth--
            if (depth < 0) return false // Closing brace without opening
        }

        return depth === 0 // All braces should be closed
    }

    /**
     * Extract all options from spintax text
     * @param text - Text containing spintax patterns
     * @returns Array of all option groups
     */
    static extractOptions(text: string): string[][] {
        const groups: string[][] = []
        let match: RegExpExecArray | null

        const regex = new RegExp(this.SPINTAX_REGEX.source, 'g')

        while ((match = regex.exec(text)) !== null) {
            groups.push(match[1].split('|'))
        }

        return groups
    }

    /**
     * Add variables support: {$name} will be replaced with value from variables object
     * @param text - Text with spintax and variables
     * @param variables - Object with variable values
     * @returns Processed text
     */
    static spinWithVariables(text: string, variables: Record<string, string>): string {
        // First replace variables
        let result = text

        for (const [key, value] of Object.entries(variables)) {
            result = result.replace(new RegExp(`\\{\\$${key}\\}`, 'g'), value)
        }

        // Then process spintax
        return this.spin(result)
    }
}

// Export utility functions for convenience
export const spin = SpintaxParser.spin.bind(SpintaxParser)
export const generateVariations = SpintaxParser.generateVariations.bind(SpintaxParser)
export const countCombinations = SpintaxParser.countCombinations.bind(SpintaxParser)
