# Outbound webhooks

This context covers application events delivered to customer-controlled HTTP endpoints.

## Language

**Scope**:
An isolated collection of endpoints, events, and delivery history. A named scope can represent a user, organization, account, workspace, or another grouping chosen by the producer.
_Avoid_: Tenant, session, permission

**Application scope**:
The default scope for webhooks that belong to the application. It excludes all named scopes.
_Avoid_: Global access, all customers

**Producer**:
The application that reports an event for delivery.
_Avoid_: Worker, receiver

**Worker**:
The executor of pending webhook deliveries and their sending attempts, including retries.
_Avoid_: Producer, receiver

**Event**:
An identified occurrence reported by a producer, with a type and associated data. It remains the same event when sent again.
_Avoid_: Job, delivery, attempt

**Endpoint**:
A destination for webhook requests that belongs to one scope.
_Avoid_: Receiver, subscription

**Endpoint management**:
The registration and maintenance of webhook destinations, their ownership, and their subscriptions.
_Avoid_: Publication, delivery

**Paused endpoint**:
An endpoint temporarily ineligible for new sending attempts. Its subscriptions remain in effect.
_Avoid_: Disabled endpoint, deleted endpoint

**Deleted endpoint**:
An endpoint permanently ineligible for new sending attempts.
_Avoid_: Paused endpoint

**Subscription**:
An endpoint's selection of event types to receive.
_Avoid_: Endpoint, filter

**Signing secret**:
A secret shared by a sender and receiver to authenticate webhook messages.
_Avoid_: API key, encryption key

**Storage encryption key**:
A key that protects stored signing secrets and lets authorized services recover them.
_Avoid_: Signing secret, API key

**Delivery**:
The effort to send one event to one endpoint. A delivery can require multiple attempts.
_Avoid_: Event, attempt, request

**Attempt**:
One effort to transmit a delivery to its endpoint and obtain a response.
_Avoid_: Delivery, event

**Retry**:
A further attempt within the same delivery after an unsuccessful or inconclusive attempt.
_Avoid_: Replay, new event

**Replay**:
A deliberate request to deliver a previously recorded event again.
_Avoid_: Retry, new event

**Receiver**:
The customer's application that accepts and processes webhook requests.
_Avoid_: Endpoint, user
