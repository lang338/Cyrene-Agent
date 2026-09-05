# Spec: Task alert (scheduled task popup with voice broadcast)

## Objective

When a scheduled task fires, show the user a desktop popup with the task result and, when a TTS engine is configured, play a synthesized voice broadcast of it. To avoid model latency at fire time, the announcement text is pre-generated (and the audio warm-cached) at task creation/edit time.

This feature lives in the scheduler (main process) because it completes the task lifecycle end-to-end: creation → execution → user notification. It is not a plugin and does not use the plugin API.

## Scope

- Pre-generate announcement content via an independent LLM call when a task is created or edited (`pregenerateTaskAlert`), storing it on the task as `alertContent` / `alertContentError` / `alertPregeneratedAt` / `alertPregenerating`.
- Warm the TTS cache right after pre-generation so the fire-time playback needs no synthesis.
- At fire time, if trusted pre-generated content exists, run the fast path: record history (`reason: "预生成播报"`), emit `scheduler.started` with `pregenerated: true`, and show the popup directly — no model call.
- Fall back to the original real-time execution path when pre-generation failed, is still in flight (`alertPregenerating`), or the content is blank. Both outcomes still pop up (success shows the reply, failure shows the error with `isError: true`).
- Single non-framed always-on-top popup window at the bottom-right corner, manually closed by the user.
- TTS text is truncated at 1000 characters. Failed tasks do not synthesize voice.

## Out of scope

- Queueing multiple alerts: when a second alert fires while one popup is visible, the old popup is closed and replaced (see lifecycle decisions below).
- Pre-generation for plugin-created tasks (the upstream `plugin-host` scheduler service does not route through the pre-generation trigger; plugin tasks always use the real-time path).
- Re-generating the announcement at fire time to reflect changed context. The pre-generated text is a snapshot taken at create/edit time by design: instant popup + zero fire-time model cost outweigh text freshness for a reminder.
- Notification channels other than the popup (no toast/tray/OSC integration yet).

## Data and interfaces

- Task fields (persisted by `scheduler-store`): `alertContent`, `alertContentError`, `alertPregeneratedAt`, `alertPregenerating`. The in-flight flag exists so the runner never trusts a possibly-stale `alertContent` while regeneration is running.
- Dedicated IPC channels (`IPC.TASK_ALERT_DATA` / `IPC.TASK_ALERT_AUDIO` / `IPC.TASK_ALERT_*` control channels) between the main process and the popup page; the popup renderer talks only through the `taskAlert` preload API with context isolation enabled.
- TTS requests are built by `buildTaskAlertTtsRequest(settings, text)` — a pure function mapping `GeneralSettings` to the engine payload and cache key, shared by both pre-generation warm-up and fire-time synthesis. Its format semantics differ from the channel TTS path: the engine default format is used, not a channel-imposed one.
- Synthesized audio is written to `cyrene-tts-cache` keyed by engine settings + text, so the fire-time synthesis of the same text is an instant cache hit.

## Lifecycle

### Popup window

- `showTaskAlertWindow(payload)` closes the existing popup (if any), resets module-level pending state, creates a fresh window, and registers `did-finish-load` / `closed` handlers.
- Because a popup can be closed before `did-finish-load` fires, both the data payload and the audio are staged in module-level variables and flushed on load completion.
- The `closed` handler clears the cached window reference only when the closed window is still the registered one (guards against stale references after a replacement).
- If the popup process dies or the window is destroyed, the reference guard makes later audio pushes no-ops instead of errors.

### Voice

- TTS synthesis is asynchronous and may complete at any point relative to the window lifecycle. `sendTaskAlertAudio(taskId, audio)` therefore verifies ownership: if `activeTaskAlertId` no longer matches the payload's task, the audio is dropped (prevents task A's voice over task B's text after a takeover).
- If the popup is still loading, the audio is staged and flushed together with the data on `did-finish-load`; otherwise it is pushed immediately.
- A new alert resets `pendingAudio` before rebuilding the window, so staged audio from the replaced alert can never leak into the replacement.

### Application exit

- The whole chain is fire-and-forget: any failure logs a warning and returns; nothing about the alert affects the task run result. There is no persisted pending-alert state — an abrupt exit during synthesis simply drops that voice (the popup still shows the text next time).

## Security boundaries

- The popup page loads from a built renderer entry with `contextIsolation: true`, `nodeIntegration: false`, and a dedicated preload exposing only the alert API.
- Main-process validation: audio ownership is checked in the main process before any IPC send; the renderer cannot request arbitrary audio.
- The pre-generation LLM call reuses the scheduler's model settings resolution (profile-expanded), and never injects its output into the user's chat context.

## Testing strategy

- `task-alert-pregen.test.ts`: content generation success/blank/error, TTS warm-cache failure not blocking content.
- `task-alert-tts.test.ts`: pure-function contract for all five engine payloads and cache keys, text truncation, cache hit/miss/write paths, engine failure mapped to `{ error }`.
- `task-alert-window.test.ts`: staged data flush, takeover semantics (window replaced, stale audio dropped, staged audio reset), direct push after load, failure/blank tasks skipping TTS, fire-and-forget on window creation failure.
- `scheduler-runner.test.ts` (task-alert section): fast path vs real-time fallback decision matrix (`alertContent` present / `alertPregenerating` / missing / blank) and popup payloads on success and failure.
