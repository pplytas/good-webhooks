# Record endpoint lifecycle changes independently of sender cleanup

Endpoint management records lifecycle changes without waiting for a sender to update its queue. Senders check current endpoint eligibility before preparing attempts and own their cleanup; Good Webhooks cancels pending deliveries when it observes deletion. This keeps the plugin usable with custom senders and unavailable workers, but a successful management response cannot guarantee that an attempt already prepared for sending will not reach its receiver.
