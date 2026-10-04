# BotFleet CursorState → TV-Face Map

BotFleet ships 39 named states (`CursorAvatar.tsx` / `stateForBot`).  Custom avatars currently bypass the reactive mascot — this pack is built for `avatarVariants?: Partial<Record<CursorState, string>>`.

## Lifecycle
| CursorState | TV-Face | Clips |
|-------------|---------|-------|
| sleeping | sleeping | still + hold |
| waking | waking | still |
| idle | resting | still |
| listening | listening | enter/hold/return |
| thinking | thinking | enter/hold/return |
| searching | searching | still + hold |
| working | working | still + hold |

## Reactions
| CursorState | TV-Face |
|-------------|--------|
| happy | happy |
| excited | excited |
| celebrate | celebrate |
| confused | confused |
| curious / surprised | curious |
| sad / shy | sad |
| angry / scared | alerting |
| playful | celebrate |
| proud / laughing | happy |
| bored / drowsy | sleeping |

## Product cycle
| CursorState | TV-Face |
|-------------|--------|
| loading / progress | loading |
| sending / uploading | sending |
| receiving | receiving |
| notifying | notifying |
| writing | typing |
| dictating | speaking |
| alerting | alerting |
| powering-down | powering_down |
| spawning | waking |
| dragging | working |
| bouncing | excited |

## Segments
- `*_enter.gif` intro (resting → expression)
- `*_hold.gif` loop while active
- `*_return.gif` outro (expression → resting)
- `stills/*.png` static fallback

## Download
https://github.com/jaywedgeworth22/botfleet-tv-face/releases/tag/tv-face-v3
