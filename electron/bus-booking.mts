import type { PermissionManager } from './permissions.mjs'

const providers = [
  { name: 'AbhiBus', origin: 'https://www.abhibus.com', pattern: /\babhi\s*bus\b/i },
  { name: 'redBus', origin: 'https://www.redbus.in', pattern: /\bred\s*bus\b/i },
] as const

export function isBusRequest(request: string): boolean {
  return /\b(?:bus|buses|abhibus|redbus)\b/i.test(request) && /\b(?:book|buy|find|search|compare|cheapest|seat|ticket|travel|trip|fare|price|try)\b/i.test(request)
}

export function busProviders(request: string, permissions: Pick<PermissionManager, 'isAllowed'>): typeof providers[number][] {
  const named = providers.filter((provider) => provider.pattern.test(request))
  if (named.length) return [...named]
  return providers.filter((provider) => permissions.isAllowed('browser.read', provider.origin))
}

export function busTrip(request: string): string | null {
  const cities = /\bfrom\s+([a-z][a-z ]{1,35}?)\s+(?:to|→)\s+([a-z][a-z ]{1,35}?)(?=\s+(?:today|tomorrow|on\b|for\b|with\b|and\b|bus\b|\d|$))/i.exec(request)
    ?? /(?:^|:\s*)([a-z][a-z ]{1,35}?)\s+(?:to|→)\s+([a-z][a-z ]{1,35}?)(?=\s+(?:today|tomorrow|on\b|for\b|with\b|and\b|bus\b|\d|$))/i.exec(request)
  if (!cities) return null
  return `${cities[1].trim()} to ${cities[2].trim()}`
}

export function busTripSnapshot(request: string, now = new Date()): string | null {
  const route = busTrip(request)
  const seats = /\b(one|two|three|four|\d{1,2})\s+(?:seats?|passengers?|people)\b/i.exec(request)
  const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(request)?.[0]
  const relative = /\b(today|tomorrow)\b/i.exec(request)?.[1].toLowerCase()
  if (!route || !seats || (!date && !relative)) return null
  const count = { one: 1, two: 2, three: 3, four: 4 }[seats[1].toLowerCase() as 'one' | 'two' | 'three' | 'four'] ?? Number(seats[1])
  if (count < 1 || count > 20) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(({ type, value }) => [type, value]))
  const today = `${parts.year}-${parts.month}-${parts.day}`
  const travelDate = date ?? (relative === 'tomorrow' ? new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : today)
  if (Number.isNaN(Date.parse(travelDate)) || new Date(travelDate).toISOString().slice(0, 10) !== travelDate) return null
  return `${route} on ${travelDate} for ${count} seats`
}

export function busTask(request: string, origin: string): string {
  return `For this bus request: ${request}\nStart at ${origin}. Search only this operator for the stated route, date and passenger count. Report only live observed departures, seat availability, fare and fees with the URL. Do not invent a price, seat, QR code or confirmation. Ask before selecting a departure or seats. Stop at checkout for the user's review; never submit payment or claim a booking without observed confirmation.`
}