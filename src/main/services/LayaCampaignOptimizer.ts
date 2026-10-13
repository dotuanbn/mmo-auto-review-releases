import { layaService } from './LayaService';
import { 
  CampaignMetricsSnapshot, 
  CampaignOptimizationResult,
  LayaPacingStrategy
} from '../../shared/laya-types';

const MIN_LAYA_CONFIDENCE = 0.75;

export class LayaCampaignOptimizer {
  /**
   * Analyzes campaign performance metrics and returns optimization suggestions.
   * Uses local heuristics when Laya is fallback/low-confidence. The hard pause
   * gate remains authoritative.
   */
  public async optimize(metrics: CampaignMetricsSnapshot): Promise<CampaignOptimizationResult> {
    try {
      const decision = await layaService.decide(
        'campaign_optimization',
        metrics as unknown as Record<string, unknown>,
      );
      console.log(`[LayaOptimizer] Laya decision="${decision.decision}" conf=${decision.confidence} for campaign ${metrics.campaignId}`);
      if (isFallbackDecision(decision.tier, decision.confidence)) {
        return this.applyHardPauseGate(this.fallbackHeuristics(metrics), metrics);
      }
      return this.applyHardPauseGate(
        this.mapDecisionToOptimization(decision.decision, decision.confidence, metrics),
        metrics,
      );
    } catch {
      console.log(`[LayaOptimizer] Laya unavailable for campaign ${metrics.campaignId}. Using fallback.`);
      return this.applyHardPauseGate(this.fallbackHeuristics(metrics), metrics);
    }
  }

  /**
   * Quick local check without calling Laya.
   * Returns true if campaign should be paused based on critical failures.
   */
  public shouldPauseCampaign(metrics: CampaignMetricsSnapshot): boolean {
    if (metrics.consecutiveFailures > 15) return true;
    // successRate is 0-1 ratio (e.g. 0.2 = 20%)
    if (metrics.successRate < 0.20 && metrics.totalVisits > 10) return true;
    return false;
  }

  /** Map a Laya decision string to CampaignOptimizationResult. */
  private mapDecisionToOptimization(
    decision: string,
    confidence: number,
    metrics: CampaignMetricsSnapshot,
  ): CampaignOptimizationResult {
    const lower = decision.toLowerCase();
    if (lower.includes('pause') || lower.includes('stop')) {
      return this.buildResult('pause', 30000, 60000, metrics.currentThreadCount, false, confidence);
    }
    if (lower.includes('cautious') || lower.includes('slow')) {
      return this.buildResult('cautious', 15000, 30000, metrics.currentThreadCount, true, confidence);
    }
    if (lower.includes('aggressive') || lower.includes('fast')) {
      return this.buildResult('aggressive', 2000, 5000, metrics.currentThreadCount, true, confidence);
    }
    return this.buildResult('normal', 5000, 15000, metrics.currentThreadCount, true, confidence);
  }

  /** Provides local heuristic fallback when Laya is unavailable. */
  private fallbackHeuristics(metrics: CampaignMetricsSnapshot): CampaignOptimizationResult {
    // successRate is 0-1 ratio (e.g. 0.9 = 90%)
    const rate = metrics.successRate;
    if (rate > 0.90) {
      return this.buildResult('aggressive', 2000, 5000, metrics.currentThreadCount, true, 0.5);
    }
    if (rate >= 0.70) {
      return this.buildResult('normal', 5000, 15000, metrics.currentThreadCount, true, 0.5);
    }
    if (rate >= 0.50) {
      return this.buildResult('cautious', 15000, 30000, metrics.currentThreadCount, true, 0.5);
    }
    return this.buildResult('pause', 30000, 60000, metrics.currentThreadCount, false, 0.5);
  }

  private applyHardPauseGate(
    result: CampaignOptimizationResult,
    metrics: CampaignMetricsSnapshot,
  ): CampaignOptimizationResult {
    if (this.shouldPauseCampaign(metrics) || result.suggestedPacing === 'pause') {
      return {
        ...result,
        suggestedPacing: 'pause',
        shouldContinue: false,
        reasoning: this.shouldPauseCampaign(metrics)
          ? 'Hard pause gate: consecutive failures or success rate too low'
          : result.reasoning,
      };
    }
    return result;
  }

  private buildResult(
    pacing: LayaPacingStrategy, minMs: number, maxMs: number,
    threads: number, shouldContinue: boolean, confidence: number,
  ): CampaignOptimizationResult {
    return {
      suggestedPacing: pacing,
      suggestedDelayRange: { minMs, maxMs },
      suggestedThreadCount: threads,
      shouldContinue: pacing === 'pause' ? false : shouldContinue,
      reasoning: pacing === 'pause' ? 'High failure rate detected' : `Pacing: ${pacing}`,
      confidence,
    };
  }
}

function isFallbackDecision(tier: string, confidence: number): boolean {
  return tier.toLowerCase() === 'fallback' || confidence < MIN_LAYA_CONFIDENCE;
}

export const layaCampaignOptimizer = new LayaCampaignOptimizer();
