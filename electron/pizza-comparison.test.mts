import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareAndOrderPizza, isPizzaComparison, parsePizzaQuote, pizzaComparisonSite } from './pizza-comparison.mjs'

const request = 'compare cheap pizza delivery and order 2 large pizzas in Sector 18 Noida 201301'

function quote(origin: string, total: number): string {
  return JSON.stringify({ currency: 'INR', quantity: 2, size: 'large', pizzas: ['Margherita', 'Margherita'], total,
    source: `${origin}/menu`, deliveryAvailable: true })
}

test('comparison requires a real delivery PIN, not a guessed near-me location', async () => {
  assert.equal(isPizzaComparison(request), true)
  const result = await compareAndOrderPizza('find cheep pizza near me and order two large', async () => { throw new Error('Unexpected browse') }, new AbortController().signal, () => {})
  assert.match(result, /No order or payment was started/)
  const tasks: string[] = []
  await compareAndOrderPizza(`${request} near me`, async (task) => { tasks.push(task); return 'Unavailable' }, new AbortController().signal, () => {})
  assert.equal(tasks.length, 1)
})

test('missing location can be supplied on demand before browsing either retailer', async () => {
  const tasks: string[] = []
  const result = await compareAndOrderPizza('compare cheap pizza near me for 2 large pizzas', async (task) => { tasks.push(task); return 'Unavailable' },
    new AbortController().signal, () => {}, async () => 'Sector 18, Noida 201301')
  assert.equal(tasks.length, 1)
  assert.match(tasks[0], /Delivery location provided by user: Sector 18, Noida 201301/)
  assert.match(result, /comparison is incomplete/)
})

test('declined or incomplete location never browses or orders', async () => {
  const result = await compareAndOrderPizza('compare cheap pizza near me for 2 large pizzas', async () => { throw new Error('Unexpected browse') },
    new AbortController().signal, () => {}, async () => false)
  assert.match(result, /No order or payment was started/)
  let tries = 0
  await compareAndOrderPizza('compare cheap pizza near me for 2 large pizzas', async () => 'Unavailable',
    new AbortController().signal, () => {}, async () => ++tries === 1 ? 'Sector 18, Noida' : 'Sector 18, Noida 201301')
  assert.equal(tries, 2)
})

test('cancelling the location request stops comparison without browsing', async () => {
  const controller = new AbortController()
  await assert.rejects(compareAndOrderPizza('compare cheap pizza near me for 2 large pizzas', async () => { throw new Error('Unexpected browse') },
    controller.signal, () => {}, async () => { controller.abort(); return 'Sector 18, Noida 201301' }), /Cancelled/)
})

test('location sharing consent applies only to generated site-specific requests', () => {
  assert.equal(pizzaComparisonSite('At https://www.pizzahut.co.in, check delivery for this exact user request'), 'https://www.pizzahut.co.in')
  assert.equal(pizzaComparisonSite('At https://pizzaonline.dominos.co.in, start a delivery order for this user request'), 'https://pizzaonline.dominos.co.in')
  assert.equal(pizzaComparisonSite('At https://pizzaonline.dominos.co.in, find the lowest available price for one pizza'), 'https://pizzaonline.dominos.co.in')
  assert.equal(pizzaComparisonSite('At https://other.example, check delivery'), null)
})

test('only complete same-origin two-large delivered quotes can be ranked', () => {
  const origin = 'https://www.pizzahut.co.in'
  assert.equal(parsePizzaQuote(quote(origin, 540), 'Pizza Hut', origin)?.total, 540)
  assert.equal(parsePizzaQuote(quote('https://other.example', 100), 'Pizza Hut', origin), null)
  assert.equal(parsePizzaQuote(quote(origin, 0), 'Pizza Hut', origin), null)
  assert.equal(parsePizzaQuote(JSON.stringify({ ...JSON.parse(quote(origin, 540)), quantity: 1 }), 'Pizza Hut', origin), null)
  assert.equal(parsePizzaQuote('Estimated around INR 400', 'Pizza Hut', origin), null)
})

test('checks both sites before starting a guarded order on the cheaper origin', async () => {
  const calls: string[] = []
  const result = await compareAndOrderPizza(request, async (task) => {
    calls.push(task)
    if (calls.length === 1) return quote('https://pizzaonline.dominos.co.in', 600)
    if (calls.length === 2) return quote('https://www.pizzahut.co.in', 500)
    return 'Stopped at QR payment; no order confirmation observed.'
  }, new AbortController().signal, () => {})
  assert.equal(calls.length, 3)
  assert.match(calls[2], /At https:\/\/www\.pizzahut\.co\.in, start a delivery order/)
  assert.match(calls[2], /verify the current cart/)
  assert.match(result, /Domino's: INR 600\.00/)
  assert.match(result, /Pizza Hut: INR 500\.00/)
  assert.match(result, /no order confirmation observed/)
})

test('missing price at either site never starts ordering', async () => {
  let calls = 0
  const result = await compareAndOrderPizza(request, async () => {
    calls++
    return calls === 1 ? quote('https://pizzaonline.dominos.co.in', 600) : 'Price unavailable'
  }, new AbortController().signal, () => {})
  assert.equal(calls, 2)
  assert.match(result, /comparison is incomplete.*No order or payment was started/)
})