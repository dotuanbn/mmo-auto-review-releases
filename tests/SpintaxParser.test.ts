import { describe, expect, it } from 'vitest'
import {
    SpintaxParser,
    countCombinations,
    generateVariations,
    spin,
} from '../src/main/utils/SpintaxParser'

describe('SpintaxParser.isValid', () => {
    it('accepts balanced braces', () => {
        expect(SpintaxParser.isValid('{a|b}')).toBe(true)
        expect(SpintaxParser.isValid('{a|b} and {c|d}')).toBe(true)
        expect(SpintaxParser.isValid('plain text')).toBe(true)
        expect(SpintaxParser.isValid('')).toBe(true)
    })

    it('rejects unbalanced braces', () => {
        expect(SpintaxParser.isValid('{a|b')).toBe(false)
        expect(SpintaxParser.isValid('a|b}')).toBe(false)
        expect(SpintaxParser.isValid('}{')).toBe(false)
        expect(SpintaxParser.isValid('{{a|b}')).toBe(false)
    })
})

describe('SpintaxParser.countCombinations', () => {
    it('returns 1 for text without spintax', () => {
        expect(countCombinations('hello world')).toBe(1)
        expect(countCombinations('')).toBe(1)
    })

    it('multiplies option group sizes', () => {
        // 2 options × 3 options = 6
        expect(countCombinations('{a|b} {c|d|e}')).toBe(6)
        // single group with 3 options
        expect(countCombinations('{x|y|z}')).toBe(3)
    })
})

describe('SpintaxParser.extractOptions', () => {
    it('extracts option groups in order', () => {
        expect(SpintaxParser.extractOptions('{a|b} {c|d|e}')).toEqual([
            ['a', 'b'],
            ['c', 'd', 'e'],
        ])
    })

    it('returns empty array when no spintax present', () => {
        expect(SpintaxParser.extractOptions('no braces')).toEqual([])
    })
})

describe('SpintaxParser.spin (deterministic cases)', () => {
    it('returns plain text unchanged', () => {
        expect(spin('plain text without spintax')).toBe('plain text without spintax')
    })

    it('resolves single-option groups deterministically', () => {
        expect(spin('{only}')).toBe('only')
        expect(spin('{Hello} {world}')).toBe('Hello world')
    })

    it('always picks one of the declared options', () => {
        const options = new Set(['alpha', 'beta', 'gamma'])
        for (let i = 0; i < 20; i++) {
            expect(options.has(spin('{alpha|beta|gamma}'))).toBe(true)
        }
    })
})

describe('SpintaxParser.spinWithVariables', () => {
    it('substitutes variables before spinning', () => {
        const result = SpintaxParser.spinWithVariables(
            'Hello {$name}, {ok}!',
            { name: 'Tuan' }
        )
        expect(result).toBe('Hello Tuan, ok!')
    })

    it('treats unresolved {$var} as single-option spintax after variable pass', () => {
        // Variable substitution only replaces known keys; leftover {$x}
        // still matches the spintax regex and resolves to the sole option "$x".
        const result = SpintaxParser.spinWithVariables('Hi {$missing}', {})
        expect(result).toBe('Hi $missing')
    })
})

describe('SpintaxParser.generateVariations', () => {
    it('returns at most the requested unique count', () => {
        const variations = generateVariations('{a|b}', 10)
        expect(variations.length).toBeLessThanOrEqual(2)
        expect(new Set(variations).size).toBe(variations.length)
        for (const v of variations) {
            expect(['a', 'b']).toContain(v)
        }
    })

    it('returns a single entry for plain text', () => {
        expect(generateVariations('fixed', 5)).toEqual(['fixed'])
    })
})
