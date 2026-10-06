# Outbound webhooks

This context covers application events delivered to customer-controlled HTTP endpoints.

## Language

**Tenant**:
The customer or organizational scope that owns endpoints and delivery history.
_Avoid_: User, account

**Producer**:
The application that reports an event for delivery.
_Avoid_: Worker, receiver

**Event**:
An identified occurrence reported by a producer, with a type and associated data. It remains the same event when sent again.
_Avoid_: Job, delivery, attempt

**Endpoint**:
A tenant-owned destination for webhook requests.
_Avoid_: Receiver, subscription

**Subscription**:
An endpoint's selection of event types to receive.
_Avoid_: Endpoint, filter

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
