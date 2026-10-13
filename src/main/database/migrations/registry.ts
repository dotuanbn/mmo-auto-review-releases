import { migration001AccountsWarmupStyle } from './001_accounts_warmup_style'
import { migration002WebSeoQuality } from './002_web_seo_quality'
import { migration003CaptchaMetrics } from './003_captcha_metrics'
import { migration004OperationsDurability } from './004_operations_durability'
import { migration005FproxyPool } from './005_fproxy_pool'
import { migration006BirthStoryScheduler } from './006_birth_story_scheduler'
import { migration007BehaviorProfile } from './007_behavior_profile'
import { migration008ReviewVerification } from './008_review_verification'
import type { Migration } from './types'

/**
 * Ordered registry of versioned migrations.
 * Append new migrations here; never renumber or reorder existing versions.
 */
export const migrations: readonly Migration[] = [
  migration001AccountsWarmupStyle,
  migration002WebSeoQuality,
  migration003CaptchaMetrics,
  migration004OperationsDurability,
  migration005FproxyPool,
  migration006BirthStoryScheduler,
  migration007BehaviorProfile,
  migration008ReviewVerification,
]

