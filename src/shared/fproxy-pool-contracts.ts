import { z } from 'zod'

export const FPROXY_ROTATION_POLICIES = [
  'rotate_per_visit',
  'sticky_session',
] as const

export const FPROXY_SLOT_STATUSES = [
  'disabled',
  'idle',
  'testing',
  'rotating',
  'leased',
  'cooldown',
  'error',
] as const

const FPROXY_API_KEY_MAX = 512
const FPROXY_LABEL_MAX = 100
const FPROXY_OWNER_ID_MAX = 160
const FPROXY_ERROR_MAX = 512

const epochMillisecondsSchema = z.number().int().nonnegative().finite()
const nullableEpochMillisecondsSchema = epochMillisecondsSchema.nullable()
const sanitizedErrorSchema = z
  .string()
  .trim()
  .min(1)
  .max(FPROXY_ERROR_MAX)
  .refine((value) => !/[\0\r\n]/.test(value), {
    message: 'Error must be a single sanitized line',
  })

export const fproxySlotIdSchema = z.number().int().positive()

export const fproxyRotationPolicySchema = z.enum(FPROXY_ROTATION_POLICIES)

export const fproxySlotStatusSchema = z.enum(FPROXY_SLOT_STATUSES)

export const fproxyPoolPolicySchema = z
  .object({
    strictUnique: z.boolean(),
    rotationPolicy: fproxyRotationPolicySchema,
  })
  .strict()

export const fproxyEgressSchema = z
  .object({
    ip: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[0-9A-Fa-f:.]+$/, 'Invalid IP address'),
    location: z.string().trim().min(1).max(160).nullable(),
  })
  .strict()

export const fproxyLeaseOwnerSchema = z
  .object({
    kind: z.enum(['traffic_visit', 'automation_job']),
    id: z.string().trim().min(1).max(FPROXY_OWNER_ID_MAX),
    threadId: z.number().int().nonnegative(),
  })
  .strict()

export const fproxySlotPublicSchema = z
  .object({
    id: fproxySlotIdSchema,
    label: z.string().trim().min(1).max(FPROXY_LABEL_MAX),
    enabled: z.boolean(),
    hasSecret: z.boolean(),
    status: fproxySlotStatusSchema,
    available: z.boolean(),
    cooldownUntil: nullableEpochMillisecondsSchema,
    /** Absolute ms when current FProxy IP dies / can no longer be used (time_die). */
    ipExpiresAt: nullableEpochMillisecondsSchema,
    /** Absolute ms when next rotate is allowed (waiting_time countdown on FProxy dashboard). */
    nextRotateAt: nullableEpochMillisecondsSchema,
    currentEgress: fproxyEgressSchema.nullable(),
    leaseOwner: fproxyLeaseOwnerSchema.nullable(),
    lastTest: nullableEpochMillisecondsSchema,
    error: sanitizedErrorSchema.nullable(),
  })
  .strict()

export const fproxyPoolSnapshotSchema = z
  .object({
    slots: z.array(fproxySlotPublicSchema).max(1000),
    policy: fproxyPoolPolicySchema,
    capacity: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    serverNow: epochMillisecondsSchema,
  })
  .strict()

export const fproxySlotTestResultSchema = z
  .object({
    id: fproxySlotIdSchema,
    success: z.boolean(),
    testedAt: epochMillisecondsSchema,
    latencyMs: z.number().int().nonnegative().nullable(),
    currentEgress: fproxyEgressSchema.nullable(),
    error: sanitizedErrorSchema.nullable(),
  })
  .strict()

const fproxyApiKeyInputSchema = z
  .string()
  .min(1)
  .max(FPROXY_API_KEY_MAX)
  .refine((value) => value === value.trim(), {
    message: 'API key must not have leading or trailing whitespace',
  })

const fproxyLabelInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(FPROXY_LABEL_MAX)

export const fproxySnapshotInputSchema = z.object({}).strict()

export const fproxyAddSlotSchema = z
  .object({
    label: fproxyLabelInputSchema,
    apiKey: fproxyApiKeyInputSchema,
    enabled: z.boolean().optional(),
  })
  .strict()

export const fproxyRemoveSlotInputSchema = z
  .object({
    id: fproxySlotIdSchema,
  })
  .strict()

export const fproxySetEnabledInputSchema = z
  .object({
    id: fproxySlotIdSchema,
    enabled: z.boolean(),
  })
  .strict()

export const fproxyUpdatePolicyInputSchema = fproxyPoolPolicySchema

export const fproxyTestSlotInputSchema = z
  .object({
    id: fproxySlotIdSchema,
  })
  .strict()

export const fproxyTestAllInputSchema = z.object({}).strict()

export const fproxySnapshotArgsSchema = z.tuple([
  fproxySnapshotInputSchema.optional(),
])
export const fproxyAddSlotArgsSchema = z.tuple([fproxyAddSlotSchema])
export const fproxyRemoveSlotArgsSchema = z.tuple([fproxySlotIdSchema])
export const fproxySetEnabledArgsSchema = z.tuple([
  fproxySlotIdSchema,
  z.boolean(),
])
export const fproxyUpdatePolicyArgsSchema = z.tuple([
  fproxyUpdatePolicyInputSchema,
])
export const fproxyTestSlotArgsSchema = z.tuple([fproxySlotIdSchema])
export const fproxyTestAllArgsSchema = z.tuple([
  fproxyTestAllInputSchema.optional(),
])

export type FProxyRotationPolicy = z.output<typeof fproxyRotationPolicySchema>
export type FProxyPoolPolicy = z.output<typeof fproxyPoolPolicySchema>
export type FProxyEgressDto = z.output<typeof fproxyEgressSchema>
export type FProxyLeaseOwnerDto = z.output<typeof fproxyLeaseOwnerSchema>
export type FProxySlotPublicDto = z.output<typeof fproxySlotPublicSchema>
export type FProxyPoolSnapshotDto = z.output<typeof fproxyPoolSnapshotSchema>
export type FProxySlotTestResultDto = z.output<
  typeof fproxySlotTestResultSchema
>
export type FProxyAddSlotInput = z.output<typeof fproxyAddSlotSchema>
export type FProxySetEnabledInput = z.output<
  typeof fproxySetEnabledInputSchema
>
