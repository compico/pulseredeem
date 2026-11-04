# Architecture

Target environment: Windows 10/11, PulseSync v3.0.3-beta, Yandex Music Desktop 5.125.3, Node.js 22.

Data flow: Twitch Channel Points redemption → URL validation → durable FIFO queue → PulseSync addon bridge → Yandex Music player queue. The dashboard displays queue state and allows removal.

The exact PulseSync queue mutation API has not yet been verified for v3.0.3-beta. Do not guess method names or automate mouse/keyboard input as the primary integration. Inspect the installed SDK declarations and addon API first. Track metadata must also be resolved against the target Yandex Music client version; until then the UI must not fabricate artist/title data.

Security: bind to 127.0.0.1 by default; never commit .env, OAuth tokens, client secrets, or session cookies. The development request endpoint is for loopback testing only and must be disabled/authenticated before exposing the service beyond localhost.

Twitch reward fulfillment must happen only after a redemption has been durably stored. Invalid or over-limit requests should be cancelled to refund points.
