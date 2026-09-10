---
'zooid': patch
---

Bind the webhook `event` variable for every provider, not just GitHub. `match:`
predicates and `${...}` placeholders now see the event name wherever the provider
puts it — the `X-GitHub-Event` header for GitHub, `body.type` for Stripe and
Standard Webhooks, `body.event.type` for Slack — so a filter reads the same
whichever service is calling. `provider: custom` leaves it unset, since only the
operator's verifier knows that payload's shape.
