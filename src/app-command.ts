export function parseVSCodeProjectOpen(request: string): string | null {
  const command = request.trim()
  const prefix = /^(?:please\s+)?open\s+(?:(?:the|my)\s+)?(?:vs\s*code|visual studio code)\s+([a-z0-9][a-z0-9 ._-]{0,79}?)\s+project[.!?]?$/i.exec(command)
  const suffix = /^(?:please\s+)?open\s+(?:(?:the|my)\s+)?([a-z0-9][a-z0-9 ._-]{0,79}?)\s+(?:project\s+|folder\s+)?(?:in|with)\s+(?:the\s+)?(?:vs\s*code|visual studio code)[.!?]?$/i.exec(command)
  return (prefix?.[1] || suffix?.[1])?.trim() || null
}

export function parseAppLaunch(request: string): string | null {
  const normalized = request.trim().toLowerCase().replace(/[?.!]$/, '').trim()
  if (parseWebSearch(request)) return null
  if (/^open\s+(?:(?:the|my)\s+)?(?:vs\s*code|visual studio code)\s+and\s+(?:show|list)\s+(?:(?:me|the|my|active)\s+)*(?:vs\s*code\s+)?projects$/.test(normalized)) return 'vscode'
  if (/\b(?:in|with)\s+(?:the\s+)?(?:vs\s*code|visual studio code)\b/.test(normalized)) return null
  const hindiPrefix = /^(?:kholo|khol\s*(?:do|de)|open\s+(?:kar|kr)\s*(?:do|de))\s+([a-z][a-z0-9 .+_-]{0,79})$/.exec(normalized)
  if (hindiPrefix) return hindiPrefix[1].trim()
  const hindiSuffix = /^([a-z][a-z0-9 .+_-]{0,79}?)\s+(?:kholo|khol\s*(?:do|de)|open\s+(?:kar|kr)\s*(?:do|de))(?:\s+be)?$/.exec(normalized)
  if (hindiSuffix) return hindiSuffix[1].trim()
  const match = /^(?:(?:hi|hello|hey)[,!\s]+)?(?:(?:(?:can|cna|could|would|will) you|please)\s+){0,2}(?:open|launch|start)\s+(?:(?:the|my)\s+)?([a-z][a-z0-9 .+_-]{0,79}?)(?:\s+(?:for me|please))?$/.exec(normalized)
  return match?.[1].trim() || null
}

export function parseWebSearch(request: string): { url: string, browser: 'safari' | null } | null {
  const normalized = request.trim().replace(/[?.!]$/, '').trim()
  const safari = /^(?:please\s+)?(?:open\s+)?safari\s+(?:and\s+)?search(?:\s+(?:for|the web for))?\s+(.+)$/i.exec(normalized)
    ?? /^(?:please\s+)?search(?:\s+the web)?\s+(?:for\s+)?(.+?)\s+in\s+safari$/i.exec(normalized)
  const google = /^(?:please\s+)?search(?:\s+the web)?\s+(?:for\s+)?(.+?)\s+on\s+google$/i.exec(normalized)
    ?? /^(?:please\s+)?(?:google|search the web for)\s+(.+)$/i.exec(normalized)
  const query = (safari?.[1] ?? google?.[1])?.trim()
  if (!query || query.length > 200 || /[\r\n]/.test(query)) return null
  const url = new URL('https://www.google.com/search')
  url.searchParams.set('q', query)
  return { url: url.href, browser: safari ? 'safari' : null }
}

export function parseBrowserResearch(request: string): string | null {
  const match = /^(?:please\s+)?(?:research|reserch)(?::|\s+)\s*(.{1,200})$/i.exec(request.trim())
  const query = match?.[1].trim()
  if (!query || /[\r\n]/.test(query)) return null
  const number = parseLiveResearch(query.replace(/\s+in google$/i, ' on google'))
  return number && /^"\d{8,15}" phone number$/.test(number) ? number : query.replace(/^compair\b/i, 'compare')
}

export function parseLiveResearch(request: string): string | null {
  const text = request.trim().replace(/[?.!]$/, '').trim()
  const weather = /^(?:what(?:'s| is)\s+)?(?:the\s+)?(?:(.{2,60}?)\s+(?:weather|forecast)|(?:weather|forecast)\s+(?:in|for)\s+(.{2,60}?))(?:\s+(?:today|now))?$/i.exec(text)
  if (weather) return `${(weather[1] || weather[2]).trim()} weather today`
  const numberLookup = /^(?:(?:search(?:\s+for)?|look\s+up|google|find\s+(?:info(?:rmation)?\s+(?:about|on)\s+)?|whose\s+number\s+is|who\s+owns|(?:what(?:'s| is)\s+)?(?:the\s+)?(?:owner\s+of\s+)?(?:phone\s+)?number(?:\s+for)?)\s+)?(\+?\d[\d\s()-]*\d)(?:\s+(?:on\s+google|phone\s+number))?$/i.exec(text)
  const digits = numberLookup?.[1].replace(/\D/g, '')
  if (digits && digits.length >= 8 && digits.length <= 15) return `"${digits}" phone number`
  const contact = /^(?:what(?:'s| is)\s+)?(?:the\s+)?(.{2,80}?)\s+(?:phone|contact)\s+number$/i.exec(text)
  return contact ? `${contact[1].trim()} official contact phone number` : null
}

export function parseFolderOpen(request: string): 'downloads' | null {
  return /^(?:please\s+)?open\s+(?:(?:my|the)\s+)?downloads\s+folder[.!?]?$/i.test(request.trim()) ? 'downloads' : null
}

export function parseWebsiteOpen(request: string): string | null {
  const match = /^(?:please\s+)?open\s+(?:(?:this|the)\s+website\s+)?(https:\/\/\S+)$/i.exec(request.trim())
  if (!match) return null
  try {
    const url = new URL(match[1])
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function parseFileSearch(request: string): string | null {
  const normalized = request.trim().replace(/[?.!]$/, '').trim()
  if (/\bscreenshots?\b/i.test(normalized) && /\b(?:today'?s?|yesterday|last|on|from|for|of|show|find|search|date|\d{4}-\d{2}-\d{2})\b/i.test(normalized)) return normalized.toLowerCase()
  const location = /^(?:(?:hi|hello|hey)[,!\s]+)?(?:(?:desktop\s+(?:me|pe)\s+)?(?:mera|meri|my)\s+)?(.{1,200}?)\s+(?:kaha(?:n)?|kidhar)\s+(?:h|hai|he)$/i.exec(normalized)
  if (location) return location[1].trim()
  const englishLocation = /^(?:where is|where's)\s+(?:(?:my|the)\s+)?(.{1,200}?)$/i.exec(normalized)
  if (englishLocation) return englishLocation[1].trim()
  const match = /^(?:(?:hi|hello|hey)[,!\s]+)?(?:(?:(?:can|cna|could|would|will) you|please)\s+){0,2}(?:find|search for|search)\s+(?:a\s+|the\s+|my\s+)?(?:file\s+)?(.+?)(?:\s+(?:on (?:my |the )?desktop|for me|please))?$/i.exec(normalized)
  return match?.[1].trim() || null
}

export function resolveFileSearch(request: string, previousDate: string | null): string | null {
  if (previousDate && /^(?:(?:show(?: me)?|find|only|and|filter(?: to)?|what about)\s+)?(?:(?:the )?same day\s+)?(?:between|from)\b/i.test(request.trim())) {
    return `screenshots on ${previousDate} ${request.trim()}`
  }
  return parseFileSearch(request)
}