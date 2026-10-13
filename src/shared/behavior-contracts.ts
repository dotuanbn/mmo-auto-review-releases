/**
 * Per-account behavior contracts (fatigue / input style).
 * Shared between main automation and pure helpers. No Electron or DB deps.
 */

/** Baseline input style and fatigue limits for one account. */
export interface BehaviorProfile {
    /** 0.7–1.3, baseline typing speed (higher = faster). */
    typingSpeedMultiplier: number
    /** 0.7–1.3, baseline mouse speed (higher = faster). */
    mouseSpeedMultiplier: number
    /** 0.5–2.0, mistake rate scaling. */
    mistakeMultiplier: number
    /** 15–45, minutes before fatigue starts. */
    fatigueOnsetMinutes: number
    /** 0.0–0.5, max slowdown at full fatigue. */
    maxFatigueFactor: number
    /** 0.5–1.5, scroll distance variation. */
    scrollVariance: number
}

/** Coarse session energy, derived from elapsed time. */
export type MoodState = 'focused' | 'normal' | 'tired' | 'distracted'

/** Mutable fatigue counters for a single browser session. */
export interface SessionFatigueState {
    sessionStartedAt: number
    currentMood: MoodState
    actionCount: number
    lastMoodChangeAt: number
}

/** Hard bounds for generated behavior profiles. */
export const BEHAVIOR_PROFILE_BOUNDS = {
    typingSpeedMultiplier: { min: 0.7, max: 1.3 },
    mouseSpeedMultiplier: { min: 0.7, max: 1.3 },
    mistakeMultiplier: { min: 0.5, max: 2.0 },
    fatigueOnsetMinutes: { min: 15, max: 45 },
    maxFatigueFactor: { min: 0.0, max: 0.5 },
    scrollVariance: { min: 0.5, max: 1.5 },
} as const

type SeededRng = () => number

/** FNV-1a style string → 32-bit seed. Deterministic across platforms. */
function hashStringToSeed(input: string): number {
    let h = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
}

/** Mulberry32 — returns [0, 1). Same seed ⇒ same sequence. */
function createSeededRng(seed: string): SeededRng {
    let state = hashStringToSeed(seed) || 1
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function rngFloat(rng: SeededRng, min: number, max: number): number {
    return min + rng() * (max - min)
}

function rngIntInclusive(rng: SeededRng, min: number, max: number): number {
    return min + Math.floor(rng() * (max - min + 1))
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000
}

/**
 * Build a deterministic BehaviorProfile from a seed.
 * Same seed always yields the same profile.
 */
export function generateBehaviorProfileFromSeed(seed: string): BehaviorProfile {
    const rng = createSeededRng(`behavior:${seed}`)
    const b = BEHAVIOR_PROFILE_BOUNDS

    return {
        typingSpeedMultiplier: clamp(
            round3(rngFloat(rng, b.typingSpeedMultiplier.min, b.typingSpeedMultiplier.max)),
            b.typingSpeedMultiplier.min,
            b.typingSpeedMultiplier.max,
        ),
        mouseSpeedMultiplier: clamp(
            round3(rngFloat(rng, b.mouseSpeedMultiplier.min, b.mouseSpeedMultiplier.max)),
            b.mouseSpeedMultiplier.min,
            b.mouseSpeedMultiplier.max,
        ),
        mistakeMultiplier: clamp(
            round3(rngFloat(rng, b.mistakeMultiplier.min, b.mistakeMultiplier.max)),
            b.mistakeMultiplier.min,
            b.mistakeMultiplier.max,
        ),
        fatigueOnsetMinutes: rngIntInclusive(
            rng,
            b.fatigueOnsetMinutes.min,
            b.fatigueOnsetMinutes.max,
        ),
        maxFatigueFactor: clamp(
            round3(rngFloat(rng, b.maxFatigueFactor.min, b.maxFatigueFactor.max)),
            b.maxFatigueFactor.min,
            b.maxFatigueFactor.max,
        ),
        scrollVariance: clamp(
            round3(rngFloat(rng, b.scrollVariance.min, b.scrollVariance.max)),
            b.scrollVariance.min,
            b.scrollVariance.max,
        ),
    }
}
