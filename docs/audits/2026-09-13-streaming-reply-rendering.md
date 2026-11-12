# Streaming Reply Rendering

ChatView supplied live text to TurnPresence, but its answering flag stayed false until a settled message arrived.  TurnPresence therefore hid the live bubble.  The live ChatMarkdown also omitted its existing streaming flag.

The fix shows the live reply as soon as text exists and enables the 250 ms highlight debounce.  Settled replies retain immediate highlighting and take over without duplicating the bubble.

## Verification

A private browser fixture rendered the real ChatView, store contexts, ChatMarkdown, and Shiki with synthetic messages and blocked external network traffic.  At 2.4 seconds of simulated streaming, the partial code was visible and highlighting had run zero times.  After completion, the full code was visible with exactly one highlighting call.  No browser errors or Vite overlays occurred.  Screenshots capture both states.

The fixture used temporary files outside the repository and did not send messages to a provider or modify the running app.  Typecheck passed before the rendering correction; the complete updated branch gate is pending.

## Reconnection Review

The real StoreProvider was exercised in Chrome with controlled EventSource frames.  A resumable hello retains its partial reply; a non-resumable hello clears rendered text, reasoning, unflushed animation-frame deltas, and pre-boundary queued frames before hydration.  The next turn starts with only its new text.  The browser receipt reported all four cases passing with no page errors; the existing store suite passed 48 tests.
