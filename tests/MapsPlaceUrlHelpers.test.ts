import { describe, expect, it } from 'vitest'
import { isBareMapsViewportUrl, normalizeMapsPlaceUrl } from '../src/main/automation/KpiSkills'

describe('Maps place URL helpers (direction recovery)', () => {
  it('detects bare @lat,lng viewport as non-place', () => {
    expect(isBareMapsViewportUrl('https://www.google.com/maps/@21.0260523,105.8985958,19z?entry=ttu')).toBe(true)
    expect(isBareMapsViewportUrl('https://www.google.com/maps/@21.0258396,105.8989633,20.67z?entry=ttu&g_ep=EgoyMD')).toBe(true)
  })

  it('keeps place URLs as place context', () => {
    expect(isBareMapsViewportUrl('https://www.google.com/maps/place/Aeon+Mall+Long+Bi%C3%AAn/@21.02,105.89,17z')).toBe(false)
    expect(isBareMapsViewportUrl('https://maps.google.com/maps/place/Foo')).toBe(false)
  })

  it('normalizes place URLs by stripping noisy query params', () => {
    const input = 'https://www.google.com/maps/place/Aeon+Mall/@21.02,105.89,17z/data=!3m1!4b1?entry=ttu&g_ep=xxx'
    const out = normalizeMapsPlaceUrl(input)
    expect(out).toContain('/maps/place/')
    expect(out).not.toContain('entry=ttu')
    expect(out).not.toContain('g_ep=')
  })

  it('does not invent place path for bare viewport urls', () => {
    const bare = 'https://www.google.com/maps/@21.02,105.89,19z?entry=ttu'
    expect(normalizeMapsPlaceUrl(bare)).toContain('/maps/@21.02,105.89')
  })
})

  it('Aeon first visit place restore target stays place path', () => {
    const place = 'https://www.google.com/maps/place/Aeon+Mall+Long+Bi%C3%AAn/@21.0260523,105.89923,17z/data=!3m1!4b1?entry=ttu'
    const bare = 'https://www.google.com/maps/@21.0260523,105.8985958,19z?entry=ttu'
    const normalized = normalizeMapsPlaceUrl(place)
    expect(isBareMapsViewportUrl(bare)).toBe(true)
    expect(isBareMapsViewportUrl(normalized)).toBe(false)
    expect(normalized).toContain('/maps/place/Aeon')
    expect(normalized).not.toContain('entry=ttu')
  })

