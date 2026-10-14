export function isLocationLookup(request: string): boolean {
  return /^(?:browse|browser)-use\s*:/i.test(request)
    && /\b(?:my\s+(?:(?:exact|precise|current)\s+)?location|mylocation(?:app)?|current location|where am i)\b/i.test(request)
    && !/\b(?:tickets?|restaurants?|pizzas?|rides?|cabs?|taxis|booking)\b/i.test(request)
}

export function locationSuggestion(request: string, result: string): string | null {
  if (!isLocationLookup(request)) return null
  const matches = [...result.matchAll(/^Suggested saved area: ([^\r\n]+)$/gim)]
  if (matches.length !== 1) return null
  const location = matches[0][1].trim()
  return location.length >= 3 && location.length <= 300 && /^[\p{L}\p{N}\s,.-]+$/u.test(location) ? location : null
}