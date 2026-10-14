const sites = [
  { name: "Domino's", origin: 'https://pizzaonline.dominos.co.in' },
  { name: 'Pizza Hut', origin: 'https://www.pizzahut.co.in' },
] as const

type Quote = { name: string, origin: string, source: string, pizzas: [string, string], total: number }

export function isPizzaComparison(task: string): boolean {
  return /\bpizzas?\b/i.test(task) && /\b(?:compar\w*|compair\w*|cheap\w*|cheep\w*)\b/i.test(task)
}

export function isPizzaPriceSearch(task: string): boolean {
  return /\bpizzas?\b/i.test(task) && /\b(?:lowest|cheapest|cheap|price|prices)\b/i.test(task)
    && !/\b(?:order|buy|book|checkout)\b/i.test(task) && !/\b(?:two|2)\s+(?:large\s+)?pizzas?\b/i.test(task)
}

export async function comparePizzaPrices(
  task: string,
  browse: (request: string, signal: AbortSignal, step: (detail: string) => void) => Promise<string>,
  signal: AbortSignal,
  step: (detail: string) => void,
  requestLocation: (signal: AbortSignal, step: (detail: string) => void) => Promise<string | false>,
): Promise<string> {
  if (!/\b\d{6}\b/.test(task)) {
    const location = await requestLocation(signal, step)
    if (!location || signal.aborted) throw new Error('Cancelled')
    if (!/\b\d{6}\b/.test(location)) return 'Please provide a delivery area, city and six-digit PIN code. No price was verified.'
    task += `\nDelivery location provided by user: ${location}`
  }
  const quotes: { name: string; price: number; source: string; pizza: string }[] = []
  for (const site of sites) {
    if (signal.aborted) throw new Error('Cancelled')
    step(`Checking pizza prices at ${site.name}`)
    try {
      const result = await browse(`At ${site.origin}, find the lowest available price for one pizza delivered to the location in this request: ${JSON.stringify(task)}. Do not add to cart, place an order or pay. Do not infer location from IP. Return ONLY JSON: {"currency":"INR","pizza":"observed pizza name and size","price":123,"source":"same-origin menu URL"}. If no location-specific price is visible, explain why instead of guessing.`, signal, step)
      const value: unknown = JSON.parse(result.trim())
      if (!value || typeof value !== 'object') throw new Error('Missing quote')
      const quote = value as Record<string, unknown>
      if (quote.currency !== 'INR' || typeof quote.pizza !== 'string' || !quote.pizza.trim() || quote.pizza.length > 120
        || typeof quote.price !== 'number' || !Number.isFinite(quote.price) || quote.price <= 0 || quote.price > 10000
        || typeof quote.source !== 'string' || new URL(quote.source).origin !== site.origin) throw new Error('Invalid quote')
      quotes.push({ name: site.name, pizza: quote.pizza, price: quote.price, source: quote.source })
    } catch {
      return `Could not verify a location-specific pizza price at ${site.name}. Comparison is incomplete; no lowest price or order is confirmed.`
    }
  }
  const lowest = quotes[0].price <= quotes[1].price ? quotes[0] : quotes[1]
  return `${quotes.map((quote) => `${quote.name}: INR ${quote.price.toFixed(2)} for ${quote.pizza} (${quote.source})`).join('\n')}\nLowest observed menu price: ${lowest.name}, INR ${lowest.price.toFixed(2)}. Delivery fees, taxes and discounts were not verified; no order was started.`
}

export function pizzaComparisonSite(task: string): string | null {
  return /^At (https:\/\/(?:pizzaonline\.dominos\.co\.in|www\.pizzahut\.co\.in)), (?:check delivery|start a delivery order|find the lowest available price)\b/.exec(task)?.[1] ?? null
}

export function parsePizzaQuote(result: string, name: string, origin: string): Quote | null {
  try {
    const quote: unknown = JSON.parse(result.trim())
    if (!quote || typeof quote !== 'object') return null
    const data = quote as Record<string, unknown>
    if (data.currency !== 'INR' || data.quantity !== 2 || data.size !== 'large'
      || !Array.isArray(data.pizzas) || data.pizzas.length !== 2
      || !data.pizzas.every((pizza) => typeof pizza === 'string' && pizza.trim().length > 0 && pizza.length <= 100)
      || typeof data.total !== 'number' || !Number.isFinite(data.total) || data.total <= 0 || data.total > 10000
      || typeof data.source !== 'string' || typeof data.deliveryAvailable !== 'boolean' || !data.deliveryAvailable) return null
    const url = new URL(data.source)
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password) return null
    return { name, origin, source: url.href, pizzas: data.pizzas as [string, string], total: data.total }
  } catch { return null }
}

export async function compareAndOrderPizza(
  task: string,
  browse: (request: string, signal: AbortSignal, step: (detail: string) => void) => Promise<string>,
  signal: AbortSignal,
  step: (detail: string) => void,
  requestLocation: (signal: AbortSignal, step: (detail: string) => void) => Promise<string | false> = async () => false,
): Promise<string> {
  while (!/\b\d{6}\b/.test(task)) {
    const location = await requestLocation(signal, step)
    if (signal.aborted) throw new Error('Cancelled')
    if (!location) return 'Delivery location was not provided. No order or payment was started.'
    if (!/\b\d{6}\b/.test(location)) { step('That location has no six-digit PIN code. Reply in this chat with your delivery area, city and PIN code.'); continue }
    task += `\nDelivery location provided by user: ${location}`
  }

  const quotes: Quote[] = []
  for (const site of sites) {
    if (signal.aborted) throw new Error('Cancelled')
    step(`Checking two-large-pizza delivery prices at ${site.name}`)
    let result: string
    try {
      result = await browse(`At ${site.origin}, check delivery for this exact user request: ${JSON.stringify(task)}. Do not place an order or enter payment details. Find the cheapest available two large pizzas matching any specified dietary or topping requirements. Include taxes, delivery fees and discounts in the payable total. If you cannot observe a complete location-specific total, say unavailable. Return ONLY one JSON object: {"currency":"INR","quantity":2,"size":"large","pizzas":["first name","second name"],"total":123,"source":"same-origin menu or checkout URL","deliveryAvailable":true}. Do not estimate.`, signal, step)
    } catch {
      return `Unable to verify a delivered two-large-pizza total at ${site.name}; comparison is incomplete. No order or payment was started.`
    }
    const quote = parsePizzaQuote(result, site.name, site.origin)
    if (!quote) return `Unable to verify a delivered two-large-pizza total at ${site.name}; comparison is incomplete. No order or payment was started.`
    quotes.push(quote)
  }

  const [first, second] = quotes
  const cheapest = first.total <= second.total ? first : second
  const comparison = quotes.map((quote) => `${quote.name}: INR ${quote.total.toFixed(2)} for ${quote.pizzas.join(' + ')} (${quote.source})`).join('\n')
  if (signal.aborted) throw new Error('Cancelled')
  step(`Lower observed total: ${cheapest.name}, INR ${cheapest.total.toFixed(2)}`)
  let booking: string
  try {
    booking = await browse(`At ${cheapest.origin}, start a delivery order for this user request: ${JSON.stringify(task)}. Add two large pizzas (${cheapest.pizzas.join(' and ')}) only if the site still offers them at the confirmed delivery address. The earlier observed two-pizza total was INR ${cheapest.total.toFixed(2)}; verify the current cart, taxes, delivery fees and full payable total before submitting. If price, variants or delivery change, STOP and ask the user; do not substitute silently. User must approve consequential actions and personally complete any QR payment. Stop at payment handoff and do not claim order success without a site confirmation.`, signal, step)
  } catch {
    return `${comparison}\n${cheapest.name} was the lower observed total, but checkout could not be verified. No completed order is confirmed.`
  }
  return `${comparison}\nLower observed total: ${cheapest.name}. Browser report (payment and order confirmation not independently verified): ${booking}`
}