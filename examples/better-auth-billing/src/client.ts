import { createAuthClient } from 'better-auth/client'
import { goodWebhooksClient } from 'good-webhooks/better-auth/client'
import { eventTypes } from './event-types.ts'
import type { WebhookEndpointDTO } from 'good-webhooks/better-auth'
import type { Delivery, DeliveryDetail } from 'good-webhooks'

const auth = createAuthClient({
  baseURL: location.origin,
  plugins: [goodWebhooksClient({ eventTypes })],
})
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!
const html = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
const short = (value: string) => value.slice(0, 8)
const time = (value: string | Date) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const money = (cents: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(cents / 100)
const badge = (status: string) =>
  `<span class="badge ${html(status)}">${html(status.replaceAll('_', ' '))}</span>`
const empty = (text: string) => `<p class="empty">${text}</p>`
const previousMarkup = new WeakMap<HTMLElement, string>()
function updateMarkup(selector: string, markup: string) {
  const element = $(selector)
  if (previousMarkup.get(element) === markup) return
  element.innerHTML = markup
  previousMarkup.set(element, markup)
}
let refreshVersion = 0
let signUp = true
let signedIn = false
let busy = false
let selectedDelivery: string | null = null
let pendingSecret: { endpointId: string; secret: string } | null = null
let workspace: Workspace | null = null
let endpoints: WebhookEndpointDTO<(typeof eventTypes)[number]>[] = []
type Invoice = { id: string; customer: string; total: number; status: string; created_at: string }
type Workspace = {
  receiverOrigin: string
  invoices: Invoice[]
  receivers: { endpoint_id: string; mode: 'healthy' | 'reject'; route_id: string }[]
  outcomes: {
    endpoint_id: string
    invoice_id: string
    customer: string
    total: number
    status: string
  }[]
  requests: { endpoint_id: string; event_id: string | null; outcome: string; received_at: string }[]
  deliveries: { items: Delivery[]; nextCursor: string | null }
}
function message(text: string, error = false) {
  $('#message').textContent = text
  $('#message').classList.toggle('error', error)
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) {
    if (response.status === 401) await showSession()
    throw new Error(data.error ?? `Request failed (${response.status})`)
  }
  return data
}
function unwrap<T>(result: { data: T | null; error: { message?: string } | null }): T {
  if (result.error || result.data === null)
    throw new Error(result.error?.message ?? 'Request failed')
  return result.data
}
async function action(work: () => Promise<void>) {
  if (busy) return
  busy = true
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  buttons.forEach((button) => (button.disabled = true))
  try {
    await work()
  } catch (error) {
    message(error instanceof Error ? error.message : 'Request failed', true)
  } finally {
    busy = false
    buttons.forEach((button) => (button.disabled = false))
  }
}
async function showSession() {
  ++refreshVersion
  const result = await auth.getSession()
  if (result.error) throw new Error(result.error.message ?? 'Unable to load the session')
  const session = result.data
  signedIn = Boolean(session)
  $('#auth-panel').hidden = signedIn
  $('#workspace').hidden = !signedIn
  $('#account').hidden = !signedIn
  $('#account-name').textContent = session?.user.name ?? ''
  if (signedIn) await refresh()
  else {
    workspace = null
    endpoints = []
    selectedDelivery = null
    pendingSecret = null
    $('#signing-secret').setAttribute('value', '')
    $<HTMLInputElement>('#signing-secret').value = ''
    $('#secret-panel').hidden = true
    for (const id of [
      'endpoints',
      'invoices',
      'deliveries',
      'attempts',
      'receivers',
      'outcomes',
      'requests',
    ])
      updateMarkup(`#${id}`, '')
  }
}
async function refresh() {
  if (!signedIn) return
  const version = ++refreshVersion
  const [state, endpointResult] = await Promise.all([
    api<Workspace>('/workspace'),
    auth.goodWebhooks.list({}),
  ])
  if (!signedIn || version !== refreshVersion) return
  workspace = state
  endpoints = unwrap(endpointResult)
  render()
  if (selectedDelivery) await inspect(selectedDelivery)
  $('#refresh-status').textContent = `Updated ${time(new Date())}`
}
function endpointName(id: string) {
  return endpoints.find((endpoint) => endpoint.id === id)?.description || `Endpoint ${short(id)}`
}
function render() {
  const state = workspace!
  updateMarkup(
    '#endpoints',
    endpoints.length
      ? endpoints
          .map(
            (endpoint) =>
              `<article class="endpoint"><div class="topline"><strong>${html(endpoint.description || 'Invoice endpoint')}</strong>${badge(endpoint.status)}</div><p>${html(endpoint.url)}</p><p>${html(endpoint.eventTypes.join(', '))}</p><div class="actions"><button class="secondary small" data-endpoint="${html(endpoint.id)}" data-operation="${endpoint.status === 'paused' ? 'resume' : 'pause'}">${endpoint.status === 'paused' ? 'Resume' : 'Pause'}</button><button class="secondary small danger" data-endpoint="${html(endpoint.id)}" data-operation="remove">Remove</button>${state.receivers.some((r) => r.endpoint_id === endpoint.id) ? '<span class="subtext">Receiver connected</span>' : '<span class="subtext">Secret transfer needed</span>'}</div></article>`,
          )
          .join('')
      : empty('Create your first endpoint to receive invoice events.'),
  )
  updateMarkup(
    '#invoices',
    state.invoices.length
      ? `<table><thead><tr><th>Customer</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${state.invoices.map((invoice) => `<tr><td>${html(invoice.customer)}<span class="subtext">${short(invoice.id)} · ${time(invoice.created_at)}</span></td><td>${money(invoice.total)}</td><td>${badge(invoice.status)}</td><td>${invoice.status === 'open' ? `<button class="secondary small" data-pay="${invoice.id}">Record payment</button>` : ''}</td></tr>`).join('')}</tbody></table>`
      : empty('Your invoices will appear here. Add an endpoint before creating one.'),
  )
  updateMarkup(
    '#deliveries',
    state.deliveries.items.length
      ? `<table><thead><tr><th>Delivery</th><th>Status</th><th>Attempts</th><th></th></tr></thead><tbody>${state.deliveries.items.map((delivery) => `<tr><td><button class="row-action" data-inspect="${delivery.id}">#${delivery.id} · ${html(endpointName(delivery.endpointId))}</button><span class="subtext">Event ${short(delivery.eventId)}${delivery.replayOf ? ` · Replay of #${delivery.replayOf}` : ''}</span></td><td>${badge(delivery.status)}</td><td>${delivery.attemptCount}</td><td>${!delivery.replayOf && ['succeeded', 'failed'].includes(delivery.status) && endpoints.some((endpoint) => endpoint.id === delivery.endpointId && endpoint.status === 'active') ? `<button class="secondary small" data-replay="${delivery.id}">Replay</button>` : ''}</td></tr>`).join('')}</tbody></table><p class="hint">Latest ${state.deliveries.items.length} deliveries${state.deliveries.nextCursor ? ' (limited to 50)' : ''}.</p>`
      : empty('No deliveries yet. Create an endpoint, then create an invoice.'),
  )
  updateMarkup(
    '#receivers',
    state.receivers.length
      ? state.receivers
          .map(
            (receiver) =>
              `<div class="receiver-control"><div><strong>${html(endpointName(receiver.endpoint_id))}</strong>${badge(receiver.mode)}</div><button class="secondary small" data-mode="${receiver.mode === 'healthy' ? 'reject' : 'healthy'}" data-receiver="${html(receiver.endpoint_id)}">${receiver.mode === 'healthy' ? 'Reject deliveries' : 'Restore receiver'}</button></div>`,
          )
          .join('')
      : empty('Transfer an endpoint’s signing secret to connect the receiver.'),
  )
  updateMarkup(
    '#outcomes',
    state.outcomes.length
      ? `<table><thead><tr><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>${state.outcomes.map((invoice) => `<tr><td>${html(invoice.customer)}<span class="subtext">${short(invoice.invoice_id)} · ${html(endpointName(invoice.endpoint_id))}</span></td><td>${money(invoice.total)}</td><td>${badge(invoice.status)}</td></tr>`).join('')}</tbody></table>`
      : empty('The receiver has not recorded an invoice yet.'),
  )
  updateMarkup(
    '#requests',
    state.requests.length
      ? state.requests
          .map(
            (request) =>
              `<div class="request"><span>${badge(request.outcome)} <span class="subtext">${request.event_id ? `Event ${short(request.event_id)}` : 'Signature verification failed'}</span></span><time>${time(request.received_at)}</time></div>`,
          )
          .join('')
      : empty('Requests will appear here after the worker sends an event.'),
  )
}
async function inspect(id: string) {
  selectedDelivery = id
  const detail = await api<DeliveryDetail>(`/deliveries/${id}`)
  if (!signedIn || selectedDelivery !== id) return
  $('#attempts').hidden = false
  updateMarkup(
    '#attempts',
    `<div class="section-heading"><h3>Delivery #${id}</h3>${badge(detail.status)}</div><p class="hint">${html(detail.lastError || 'Select an attempt below to read the receiver response.')}</p>${detail.attempts.length ? detail.attempts.map((attempt) => `<div class="attempt"><div>Attempt ${attempt.number} ${badge(attempt.outcome)}<span class="subtext">${time(attempt.startedAt)}${attempt.responseStatus ? ` · HTTP ${attempt.responseStatus}` : ''}</span></div><pre>${html(attempt.responseBody || attempt.error || 'Waiting for the receiver response')}</pre></div>`).join('') : '<p class="hint">The worker has not attempted this delivery yet.</p>'}`,
  )
}
$('#auth-toggle').addEventListener('click', () => {
  signUp = !signUp
  $('#name-label').hidden = !signUp
  $<HTMLInputElement>('[name=name]').required = signUp
  $('#auth-heading').textContent = signUp ? 'Create an account' : 'Sign in'
  $('#auth-submit').textContent = signUp ? 'Create account' : 'Sign in'
  $('#auth-toggle').textContent = signUp
    ? 'Already have an account? Sign in'
    : 'New here? Create an account'
  $<HTMLInputElement>('[name=password]').autocomplete = signUp ? 'new-password' : 'current-password'
})
$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void action(async () => {
    const form = new FormData($<HTMLFormElement>('#auth-form'))
    const credentials = { email: String(form.get('email')), password: String(form.get('password')) }
    if (signUp) unwrap(await auth.signUp.email({ ...credentials, name: String(form.get('name')) }))
    else unwrap(await auth.signIn.email(credentials))
    $<HTMLInputElement>('[name=password]').value = ''
    message('Signed in. Create an endpoint to start receiving invoice events.')
    await showSession()
  })
})
$('#sign-out').addEventListener(
  'click',
  () =>
    void action(async () => {
      unwrap(await auth.signOut())
      message('Signed out.')
      await showSession()
    }),
)
$('#endpoint-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void action(async () => {
    if (pendingSecret)
      throw new Error(
        'Transfer or copy the current signing secret before creating another endpoint.',
      )
    const form = new FormData($<HTMLFormElement>('#endpoint-form'))
    const selected = eventTypes.filter((type) =>
      form.has(type === 'invoice.created' ? 'created' : 'paid'),
    )
    if (!selected.length) throw new Error('Choose at least one event')
    const result = unwrap(
      await auth.goodWebhooks.create({
        description: String(form.get('description')),
        url: `${workspace!.receiverOrigin}/webhooks/${crypto.randomUUID()}`,
        eventTypes: selected,
      }),
    )
    pendingSecret = { endpointId: result.endpoint.id, secret: result.secret }
    $<HTMLInputElement>('#signing-secret').value = result.secret
    $('#secret-panel').hidden = false
    message('Endpoint created. Transfer its signing secret to the receiver.')
    await refresh()
  })
})
$('#copy-secret').addEventListener(
  'click',
  () =>
    void action(async () => {
      if (pendingSecret) {
        await navigator.clipboard.writeText(pendingSecret.secret)
        message('Signing secret copied. Transfer it to the receiver to begin delivery.')
      }
    }),
)
$('#connect-receiver').addEventListener(
  'click',
  () =>
    void action(async () => {
      if (!pendingSecret) return
      await api('/receivers/connect', pendingSecret)
      pendingSecret = null
      $<HTMLInputElement>('#signing-secret').value = ''
      $('#secret-panel').hidden = true
      message('Receiver connected. Create an invoice to send its first event.')
      await refresh()
    }),
)
$('#invoice-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void action(async () => {
    const form = new FormData($<HTMLFormElement>('#invoice-form'))
    const result = await api<{ publication: { deliveryCount: number } }>('/invoices', {
      customer: String(form.get('customer')),
      total: Math.round(Number(form.get('amount')) * 100),
    })
    message(
      `Invoice created. ${result.publication.deliveryCount} ${result.publication.deliveryCount === 1 ? 'delivery' : 'deliveries'} queued.`,
    )
    await refresh()
  })
})
$('#workspace').addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button')
  if (!button) return
  const data = button.dataset
  if (!Object.keys(data).length) return
  void action(async () => {
    if (data.endpoint) {
      if (data.operation === 'pause') unwrap(await auth.goodWebhooks.pause({ id: data.endpoint }))
      if (data.operation === 'resume') unwrap(await auth.goodWebhooks.resume({ id: data.endpoint }))
      if (data.operation === 'remove') {
        unwrap(await auth.goodWebhooks.remove({ id: data.endpoint }))
        if (pendingSecret?.endpointId === data.endpoint) {
          pendingSecret = null
          $<HTMLInputElement>('#signing-secret').value = ''
          $('#secret-panel').hidden = true
        }
      }
      message(
        `Endpoint ${data.operation === 'pause' ? 'paused' : data.operation === 'resume' ? 'resumed' : 'removed'}.`,
      )
    } else if (data.pay) {
      await api(`/invoices/${data.pay}/pay`, {})
      message('Payment recorded. The invoice.paid event is queued.')
    } else if (data.replay) {
      await api(`/deliveries/${data.replay}/replay`, {})
      message('Replay queued with the original event ID.')
    } else if (data.inspect) {
      await inspect(data.inspect)
      return
    } else if (data.receiver) {
      await api(`/receivers/${data.receiver}/mode`, { mode: data.mode })
      message(
        data.mode === 'reject'
          ? 'Receiver will return HTTP 503. Create an invoice to observe retries.'
          : 'Receiver restored. Replay a failed delivery to send it again.',
      )
    }
    await refresh()
  })
})
// Sessions may be null without an error.
void (async () => {
  try {
    await showSession()
  } catch (error) {
    message(error instanceof Error ? error.message : 'Unable to load the session', true)
  }
})()
setInterval(() => {
  if (signedIn && !busy && !document.hidden)
    void refresh().catch((error) => {
      $('#refresh-status').textContent = 'Refresh failed'
      message(error.message, true)
    })
}, 1_500)
