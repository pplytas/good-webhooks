import type { Delivery, DeliveryDetail, Endpoint } from 'good-webhooks'

type Product = { sku: string; name: string; unitPriceCents: number }
type Order = {
  id: string
  customer: string
  sku: string
  quantity: number
  totalCents: number
  eventId: string
  createdAt: string
}
type State = {
  products: Product[]
  orders: Order[]
  endpoint: Endpoint | null
  deliveries: Delivery[]
  shipments: { eventId: string; orderId: string; customer: string; receivedAt: string }[]
  receiver: { mode: 'healthy' | 'reject'; accepted: number; duplicates: number }
  worker: { running: boolean }
}

class ApiError extends Error {
  code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

const element = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing element: ${id}`)
  return found as T
}
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
const currency = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
const time = (value: string | Date) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const statusLabel = (value: string) =>
  ({
    in_flight: 'Sending',
    pending: 'Queued',
    succeeded: 'Delivered',
    failed: 'Failed',
    cancelled: 'Cancelled',
    active: 'Connected',
    paused: 'Paused',
  })[value] ?? value
const badge = (value: string) =>
  `<span class="badge ${escape(value)}">${escape(statusLabel(value))}</span>`
let state: State | undefined
let selected: string | undefined
let busy = false
let refreshing = false
let productSignature = ''
let requestKey = crypto.randomUUID()
const product = element<HTMLSelectElement>('product')
const quantity = element<HTMLInputElement>('quantity')
const form = element<HTMLFormElement>('order-form')
const rendered = new Map<string, string>()

function render(id: string, html: string) {
  const target = element(id)
  if (rendered.get(id) !== html) {
    const focused = target.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.delivery
      : undefined
    target.innerHTML = html
    rendered.set(id, html)
    if (focused)
      target
        .querySelector<HTMLElement>(`[data-delivery="${CSS.escape(focused)}"]`)
        ?.focus({ preventScroll: true })
  }
}

function notice(message: string, error = false) {
  const target = element('notice')
  target.hidden = false
  target.className = error ? 'error' : ''
  target.textContent = message
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(10_000),
  })
  const data = (await response.json()) as T & { error?: string; code?: string }
  if (!response.ok)
    throw new ApiError(data.error ?? `Request failed (${response.status})`, data.code)
  return data
}

function updateTotal() {
  const selectedProduct = state?.products.find((item) => item.sku === product.value)
  element<HTMLOutputElement>('total').value = selectedProduct
    ? currency(selectedProduct.unitPriceCents * Number(quantity.value))
    : '—'
}

function setBusy(value: boolean) {
  busy = value
  for (const id of ['connect', 'pause', 'receiver-mode'])
    element<HTMLButtonElement | HTMLSelectElement>(id).disabled = value
  for (const id of ['place-order', 'rollback'])
    element<HTMLButtonElement>(id).disabled = value || !state?.endpoint
}

async function action(operation: () => Promise<void>) {
  if (busy) return
  setBusy(true)
  try {
    await operation()
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error), true)
  } finally {
    setBusy(false)
    await refresh()
  }
}

async function showDetail() {
  if (!selected) return
  const id = selected
  const detail = await api<DeliveryDetail>(`/api/deliveries/${encodeURIComponent(id)}`)
  if (selected !== id) return
  const canReplay =
    !detail.replayOf &&
    ['succeeded', 'failed'].includes(detail.status) &&
    state?.endpoint?.status === 'active'
  const attempts = detail.attempts
    .map(
      (attempt) =>
        `<li><strong>Attempt ${attempt.number} ${attempt.responseStatus ? `· HTTP ${attempt.responseStatus}` : ''}</strong><span>${escape(time(attempt.startedAt))} · ${escape(attempt.outcome)}</span>${attempt.error ? `<p>${escape(attempt.error)}</p>` : ''}${attempt.responseBody ? `<pre class="response">${escape(attempt.responseBody)}</pre>` : ''}</li>`,
    )
    .join('')
  render(
    'detail',
    `<div class="detail-header"><h3>Order delivery</h3>${badge(detail.status)}</div><div class="identifier">Event ${escape(detail.eventId)}</div>${detail.replayOf ? '<p class="help">This is a replay of an earlier delivery.</p>' : ''}<ol class="attempts">${attempts || '<li><strong>Waiting for the worker</strong><span>The order is saved. A separate worker sends the request.</span></li>'}</ol>${detail.status === 'pending' ? `<p class="help">Next attempt: ${escape(time(detail.nextAttemptAt))}</p>` : ''}${detail.lastError ? `<p class="help">${escape(detail.lastError)}</p>` : ''}${canReplay ? '<button type="button" class="secondary" id="replay">Replay delivery</button><p class="help">Replay sends the same event again. The warehouse ignores an event it has already accepted.</p>' : ''}`,
  )
}

async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    state = await api<State>('/api/state')
    const signature = JSON.stringify(state.products)
    if (signature !== productSignature) {
      const previous = product.value
      product.innerHTML = state.products
        .map(
          (item) =>
            `<option value="${escape(item.sku)}">${escape(item.name)} · ${currency(item.unitPriceCents)}</option>`,
        )
        .join('')
      if (state.products.some((item) => item.sku === previous)) product.value = previous
      productSignature = signature
    }
    updateTotal()
    element('endpoint-status').className = `badge ${state.endpoint?.status ?? ''}`
    element('endpoint-status').textContent = state.endpoint
      ? statusLabel(state.endpoint.status)
      : 'Not connected'
    element('connect').hidden = !!state.endpoint
    element('pause').hidden = !state.endpoint
    element('pause').textContent =
      state.endpoint?.status === 'paused' ? 'Resume deliveries' : 'Pause deliveries'
    if (state.endpoint) {
      element('endpoint-url').textContent = state.endpoint.url
      element('order-help').textContent =
        'Test rollback deliberately rejects the transaction. Neither the order nor its event should appear.'
    }
    if (!busy) element<HTMLSelectElement>('receiver-mode').value = state.receiver.mode
    element('accepted').textContent = String(state.receiver.accepted)
    element('duplicates').textContent = String(state.receiver.duplicates)
    element('order-count').textContent =
      `${state.orders.length} ${state.orders.length === 1 ? 'order' : 'orders'}`
    element('delivery-count').textContent =
      `${state.deliveries.length} ${state.deliveries.length === 1 ? 'delivery' : 'deliveries'}`
    element('worker-state').textContent = state.worker.running
      ? 'Running. Ready to send and retry.'
      : 'Stopped. Queued deliveries will wait.'
    if (!selected && state.deliveries[0]) selected = state.deliveries[0].id
    render(
      'deliveries',
      state.deliveries
        .map((delivery) => {
          const order = state!.orders.find((item) => item.eventId === delivery.eventId)
          return `<button type="button" class="delivery-row ${delivery.id === selected ? 'selected' : ''}" data-delivery="${escape(delivery.id)}" aria-pressed="${delivery.id === selected}"><span><strong>${escape(order?.customer ?? 'Order event')}${delivery.replayOf ? ' · Replay' : ''}</strong><small>${escape(time(delivery.createdAt))} · ${delivery.attemptCount} ${delivery.attemptCount === 1 ? 'attempt' : 'attempts'}</small></span><span class="row-status">${badge(delivery.status)}${delivery.lastStatus ? `<small>HTTP ${delivery.lastStatus}</small>` : ''}</span></button>`
        })
        .join('') ||
        '<p class="empty">Your first delivery will appear here after you place an order.</p>',
    )
    render(
      'orders',
      state.orders
        .map(
          (order) =>
            `<div class="record"><div><strong>${escape(order.customer)}</strong><small>${order.quantity} × ${escape(state!.products.find((item) => item.sku === order.sku)?.name ?? order.sku)}</small><small>${escape(time(order.createdAt))}</small></div><span class="amount">${currency(order.totalCents)}</span></div>`,
        )
        .join('') || '<p class="empty">No orders yet.</p>',
    )
    render(
      'shipments',
      state.shipments
        .map(
          (shipment) =>
            `<div class="record"><div><strong>${escape(shipment.customer)}</strong><small>Order ${escape(shipment.orderId.slice(0, 8))}</small><small>${escape(time(shipment.receivedAt))}</small></div><span class="badge succeeded">Ready to fulfill</span></div>`,
        )
        .join('') || '<p class="empty">Verified orders become shipments here.</p>',
    )
    setBusy(busy)
    await showDetail()
  } catch (error) {
    notice(
      `Cannot refresh the demo. ${error instanceof Error ? error.message : String(error)}`,
      true,
    )
  } finally {
    refreshing = false
  }
}

async function placeOrder(rollback: boolean) {
  if (!form.reportValidity()) return
  await action(async () => {
    let result: { order: Order; publication: { deliveryCount: number; duplicate: boolean } }
    try {
      result = await api('/api/orders', {
        customer: element<HTMLInputElement>('customer').value,
        sku: product.value,
        quantity: Number(quantity.value),
        idempotencyKey: requestKey,
        rollback,
      })
    } catch (error) {
      if (rollback && error instanceof ApiError && error.code === 'DEMO_ROLLBACK') {
        notice(error.message)
        return
      }
      throw error
    }
    requestKey = crypto.randomUUID()
    selected = undefined
    notice(
      `Order saved. ${result.publication.deliveryCount} ${result.publication.deliveryCount === 1 ? 'delivery' : 'deliveries'} queued for the worker.`,
    )
  })
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void placeOrder(false)
})
form.addEventListener('input', () => {
  requestKey = crypto.randomUUID()
  updateTotal()
})
element('rollback').addEventListener('click', () => void placeOrder(true))
element('connect').addEventListener(
  'click',
  () =>
    void action(async () => {
      await api('/api/connect', {})
      notice('Warehouse connected. Place an order to send your first event.')
    }),
)
element('pause').addEventListener(
  'click',
  () =>
    void action(async () => {
      const status = state?.endpoint?.status === 'paused' ? 'active' : 'paused'
      await api('/api/endpoint', { status })
      notice(status === 'active' ? 'Deliveries resumed.' : 'Warehouse endpoint paused.')
    }),
)
element('receiver-mode').addEventListener(
  'change',
  () =>
    void action(async () => {
      const mode = element<HTMLSelectElement>('receiver-mode').value
      await api('/api/receiver', { mode })
      notice(
        mode === 'reject'
          ? 'Warehouse returns HTTP 503. Place an order to watch retries.'
          : 'Warehouse accepts orders again. Replay a failed delivery to recover it.',
      )
    }),
)
element('deliveries').addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-delivery]')
  if (row) {
    selected = row.dataset.delivery
    void refresh()
  }
})
element('detail').addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('#replay') && selected)
    void action(async () => {
      const result = await api<Delivery>(
        `/api/deliveries/${encodeURIComponent(selected!)}/replay`,
        {},
      )
      selected = result.id
      notice('Replay queued. The event ID stays the same.')
    })
})
void refresh()
const timer = setInterval(() => {
  if (!document.hidden) void refresh()
}, 1500)
window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
