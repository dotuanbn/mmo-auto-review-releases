export * from './types'
export { trafficReportService } from './TrafficReportService'
export { TrafficPageGuard, trafficPageGuard } from './TrafficPageGuard'
export {
    TrafficVisitExecutor,
    runWithTimeout,
    computeVisitWatchdogTimeoutMs,
    computeMaxActionsForWatchdog,
    isBrowserContextClosedError,
    isProxyConnectionError,
    resolveWebSeoSearchKeywords,
    resolveWebSeoDwellSeconds,
    recordWebSeoStructuredOutcome,
    assertWebSeoOutcomeOrThrow,
    randomBetweenInclusive,
    normalizeDesiredActions,
    pickRandomActions,
} from './TrafficVisitExecutor'
