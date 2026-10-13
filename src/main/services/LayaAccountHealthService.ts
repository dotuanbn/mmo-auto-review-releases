import { layaService } from './LayaService';
import type {
  AccountHealthContext,
  AccountHealthGrade,
  AccountHealthResult,
  LayaDecisionResult,
} from '../../shared/laya-types';

const MIN_LAYA_CONFIDENCE = 0.75;
const READY_MIN_SCORE = 40;
const BLOCKING_BAN_COUNT = 3;
const BAN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export class LayaAccountHealthService {
  /**
   * Evaluates the health of an account for traffic campaigns
   */
  async evaluateHealth(ctx: AccountHealthContext): Promise<AccountHealthResult> {
    try {
      console.log(`[LayaHealth] Evaluating health via Laya for account: ${ctx.accountId}`);
      const response = await layaService.decide('account_health_score', { ...ctx });
      if (isFallbackDecision(response.tier, response.confidence)) {
        return this.evaluateHealthFallback(ctx);
      }
      const health = parseAccountHealthResult(response, ctx);
      if (!health) return this.evaluateHealthFallback(ctx);
      return this.applyLocalReadinessGates(health, ctx);
    } catch (error) {
      console.log(`[LayaHealth] Laya service failed for ${ctx.accountId}, using local heuristics`);
      return this.evaluateHealthFallback(ctx);
    }
  }

  /**
   * Converts a numeric score to an AccountHealthGrade
   */
  scoreToGrade(score: number): AccountHealthGrade {
    return scoreToGrade(score);
  }

  /**
   * Fallback heuristic logic when Laya is unavailable
   */
  private evaluateHealthFallback(ctx: AccountHealthContext): AccountHealthResult {
    let score = 100;
    const risks: string[] = [];

    if (ctx.banCount > 0) {
      score -= 30;
      score -= Math.min(ctx.banCount * 10, 30);
      risks.push('Account has previous bans');
    }

    if (ctx.daysSinceCreation < 7) {
      score -= 20;
      risks.push('Account is too new (less than 7 days)');
    } else if (ctx.daysSinceCreation > 90) {
      score += 10;
    }

    if (ctx.warmupLevel < 3) {
      score -= 10;
      risks.push('Warmup level is low (less than 3)');
    }

    if (ctx.totalReviews > 10) {
      score += 5;
    }

    score = Math.max(0, Math.min(100, score));
    const cooldownMs = this.calculateCooldown(ctx.lastBanAt);

    return {
      score,
      grade: this.scoreToGrade(score),
      risks,
      recommendations: ['Consider running more warmup tasks'],
      readyForTraffic: isLocallyReady(score, ctx.banCount, cooldownMs),
      cooldownMs,
    };
  }

  /**
   * Calculates cooldown in ms if last ban was within 7 days
   */
  private calculateCooldown(lastBanAt?: Date | string | number): number {
    if (!lastBanAt) return 0;
    
    const lastBanDate = new Date(lastBanAt);
    const now = new Date();
    const msSinceBan = now.getTime() - lastBanDate.getTime();
    
    if (msSinceBan > 0 && msSinceBan < BAN_COOLDOWN_MS) {
      return BAN_COOLDOWN_MS - msSinceBan;
    }
    
    return 0;
  }

  private applyLocalReadinessGates(
    health: AccountHealthResult,
    ctx: AccountHealthContext,
  ): AccountHealthResult {
    const cooldownMs = Math.max(health.cooldownMs, this.calculateCooldown(ctx.lastBanAt));
    return {
      ...health,
      cooldownMs,
      readyForTraffic: health.readyForTraffic && isLocallyReady(health.score, ctx.banCount, cooldownMs),
    };
  }

  /**
   * Evaluates all accounts in parallel and ranks them by score descending
   */
  async rankAccounts(
    accounts: AccountHealthContext[]
  ): Promise<Array<AccountHealthContext & { health: AccountHealthResult }>> {
    console.log(`[LayaHealth] Ranking ${accounts.length} accounts`);
    
    const results = await Promise.allSettled(
      accounts.map(async (acc) => {
        const health = await this.evaluateHealth(acc);
        return { ...acc, health };
      })
    );

    const successfulEvaluations = results
      .filter((r): r is PromiseFulfilledResult<AccountHealthContext & { health: AccountHealthResult }> => 
        r.status === 'fulfilled'
      )
      .map(r => r.value);

    return successfulEvaluations.sort((a, b) => b.health.score - a.health.score);
  }
}

export const layaAccountHealthService = new LayaAccountHealthService();

function isFallbackDecision(tier: string, confidence: number): boolean {
  return tier.toLowerCase() === 'fallback' || confidence < MIN_LAYA_CONFIDENCE;
}

function isLocallyReady(score: number, banCount: number, cooldownMs: number): boolean {
  return score >= READY_MIN_SCORE && banCount < BLOCKING_BAN_COUNT && cooldownMs === 0;
}

function parseAccountHealthResult(
  response: LayaDecisionResult,
  ctx: AccountHealthContext,
): AccountHealthResult | undefined {
  const payload = parseDecisionPayload(response.decision) ?? parseDecisionPayload(response.reasoning);
  if (!payload) return undefined;

  const rawScore = payload.score;
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return undefined;
  const score = Math.max(0, Math.min(100, rawScore));
  const grade = parseGrade(payload.grade) ?? scoreToGrade(score);
  const risks = parseStringArray(payload.risks);
  const recommendations = parseStringArray(payload.recommendations);
  const cooldownMs = parseNonNegativeInteger(payload.cooldownMs) ?? 0;

  return {
    score,
    grade,
    risks,
    recommendations,
    readyForTraffic:
      typeof payload.readyForTraffic === 'boolean'
        ? payload.readyForTraffic
        : isLocallyReady(score, ctx.banCount, cooldownMs),
    cooldownMs,
  };
}

function parseDecisionPayload(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrade(value: unknown): AccountHealthGrade | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toUpperCase();
  return normalized === 'A' || normalized === 'B' || normalized === 'C' || normalized === 'D' || normalized === 'F'
    ? normalized
    : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function scoreToGrade(score: number): AccountHealthGrade {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}
