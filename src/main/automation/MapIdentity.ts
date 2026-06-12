// src/main/automation/MapIdentity.ts
// Centralized Google Maps place identity parser + matcher.
// Strong identifiers (placeId ChIJ, featureHex 0x..:0x.., cid) take priority over name+address.
// Reusable across add-location, search flows, direct verify.

export interface MapIdentity {
  placeId?: string
  featureHex?: string // normalized lowercase "0x...:0x..."
  cid?: string // decimal string (may be very large, keep as string)
  lat?: number
  lng?: number
}

const RE_PLACE_ID = /\b(ChIJ[0-9A-Za-z_-]{10,})\b/i
const RE_FEATURE_HEX = /(0x[0-9a-fA-F]{6,}):?(0x[0-9a-fA-F]{6,})/i
const RE_CID_DEC = /[?&](?:cid|ludocid)=(\d{6,})/i
const RE_AT_COORD = /@(-?\d+\.\d+),(-?\d+\.\d+)/
const RE_DATA_COORD = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/

function normalizeHex(hex?: string | null): string | undefined {
  if (!hex) return undefined
  const m = hex.match(RE_FEATURE_HEX)
  if (!m) return undefined
  return `${m[1].toLowerCase()}:${m[2].toLowerCase()}`
}

function hexToCid(hex?: string | null): string | undefined {
  if (!hex) return undefined
  const m = hex.match(RE_FEATURE_HEX)
  if (!m || !m[2]) return undefined
  try {
    // Use BigInt for safety with large CIDs
    return BigInt('0x' + m[2].toLowerCase()).toString()
  } catch {
    const n = parseInt(m[2], 16)
    return Number.isFinite(n) ? String(n) : undefined
  }
}

function normCid(c?: string | number | null): string | undefined {
  if (c === null || c === undefined) return undefined
  const s = String(c).trim()
  return /^\d{6,}$/.test(s) ? s : undefined
}

/**
 * Parse URL or arbitrary string for any Google Maps identifiers.
 * Returns first credible hits; does not require full URL.
 */
export function parseMapIdentity(input: string | null | undefined): MapIdentity | null {
  if (!input || typeof input !== 'string') return null
  const id: MapIdentity = {}

  // 1. Place ID (canonical strongest, ChIJ...)
  const pid = input.match(RE_PLACE_ID)
  if (pid) id.placeId = pid[1]

  // 2. Feature hex (0x...:0x...) from data= or !1s or bare
  const fhex = input.match(RE_FEATURE_HEX)
  if (fhex) {
    id.featureHex = normalizeHex(fhex[0])
    if (!id.cid) id.cid = hexToCid(fhex[0])
  }

  // 3. CID decimal (cid= or ludocid=)
  const cidm = input.match(RE_CID_DEC)
  if (cidm) id.cid = normCid(cidm[1])

  // 4. Coordinates (supplementary only)
  const at = input.match(RE_AT_COORD)
  if (at) {
    id.lat = parseFloat(at[1])
    id.lng = parseFloat(at[2])
  } else {
    const dc = input.match(RE_DATA_COORD)
    if (dc) {
      id.lat = parseFloat(dc[1])
      id.lng = parseFloat(dc[2])
    }
  }

  return (id.placeId || id.featureHex || id.cid) ? id : null
}

/** Cross-normalize + merge stored fields with parsed-from-url. */
export function extractIdentity(loc: {
  placeId?: string | null
  url?: string | null
  cid?: string | null
  featureHex?: string | null
  address?: string | null
  name?: string | null
}): MapIdentity {
  const fromUrl = parseMapIdentity(loc.url || '')
  const storedPid = (loc.placeId && /^ChIJ/i.test(loc.placeId)) ? loc.placeId : undefined
  const pid = storedPid || fromUrl?.placeId || (loc.placeId || undefined)
  const fhex = loc.featureHex ? normalizeHex(loc.featureHex) : fromUrl?.featureHex
  const cid = normCid(loc.cid) || fromUrl?.cid || (fhex ? hexToCid(fhex) : undefined)

  return {
    placeId: pid,
    featureHex: fhex,
    cid,
    lat: fromUrl?.lat,
    lng: fromUrl?.lng,
  }
}

function hasStrongId(id?: MapIdentity | null): boolean {
  if (!id) return false
  return !!(id.placeId || id.featureHex || id.cid)
}

/**
 * identitiesMatch(target, candidate)
 * True on strong ID criteria:
 *  - placeId exact match (case sensitive as-is, ChIJ canonical)
 *  - featureHex normalized equal (full 0x..:0x..)
 *  - cid equal (decimal string) OR cross cid derived from featureHex hex2 part
 * Lat/lng proximity is supplementary only (not sufficient alone for "is target").
 * If target has NO strong identifier at all, caller should fall back to name+address (outside this fn).
 */
export function identitiesMatch(
  target: MapIdentity | null | undefined,
  candidate: MapIdentity | null | undefined
): boolean {
  if (!target || !candidate) return false

  const tPid = target.placeId?.trim()
  const cPid = candidate.placeId?.trim()
  if (tPid && cPid && tPid === cPid) return true

  const tHex = normalizeHex(target.featureHex)
  const cHex = normalizeHex(candidate.featureHex)
  if (tHex && cHex && tHex === cHex) return true

  // cid direct or cross from hex
  let tC = normCid(target.cid)
  if (!tC && target.featureHex) tC = hexToCid(target.featureHex)
  let cC = normCid(candidate.cid)
  if (!cC && candidate.featureHex) cC = hexToCid(candidate.featureHex)
  if (tC && cC && tC === cC) return true

  return false
}

/** Small helper for logging which criterion won (call after match true). */
export function describeMatch(target: MapIdentity | null | undefined, candidate: MapIdentity | null | undefined): string {
  if (!target || !candidate) return 'no-id'
  const tPid = target.placeId?.trim()
  const cPid = candidate.placeId?.trim()
  if (tPid && cPid && tPid === cPid) return 'placeId'
  const tHex = normalizeHex(target.featureHex)
  const cHex = normalizeHex(candidate.featureHex)
  if (tHex && cHex && tHex === cHex) return 'featureHex'
  let tC = normCid(target.cid); if (!tC && target.featureHex) tC = hexToCid(target.featureHex)
  let cC = normCid(candidate.cid); if (!cC && candidate.featureHex) cC = hexToCid(candidate.featureHex)
  if (tC && cC && tC === cC) return 'cid'
  return 'weak'
}
