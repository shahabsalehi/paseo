# Auto-speak final response: local report

Status: implemented and measured locally. This report and the benchmark are experiment artifacts
and must be excluded from any pull request.

## Objective and scope

Evaluate an opt-in voice response mode that lets Paseo speak the final assistant message after a
successful spoken turn. The comparison asks whether server-owned final speech is more reliable and
faster than requiring each agent runtime to discover and call Paseo's `speak` tool.

The candidate is confined to the server voice session and configuration path. It reuses the
existing transcription, TTS, audio-output, playback-acknowledgement, and cancellation machinery.
It does not add early model-output speech or change the audio protocol.

## Implementation shape

- `features.voiceMode.responseMode` is an opt-in persisted and environment-configurable enum.
  `toolDirected` remains the default; `autoSpeakFinal` selects the candidate.
- The voice session creates a unique `clientMessageId` before sending spoken input. Automatic
  speech arms for that identity and begins tracking only after the matching
  `user_message.clientMessageId`, so another session or unrelated turn cannot claim the response.
- Typed `turn_completed`, `turn_failed`, and `turn_canceled` events drive terminal behavior.
  Completion can dispatch the accumulated final assistant text; failure and cancellation clear it.
  No response-content regex or error-prefix filtering is used.
- Automatic mode does not register the `speak` handler or caller context. Its spoken-input wrapper
  requests one concise normal response suitable for speech and a concise clarification when the
  transcription is ambiguous.
- A non-aborted TTS failure produces a visible activity error while leaving the assistant text
  available to read.
- Dispatch starts after completion and uses the existing TTS sentence segmentation, synthesis
  prefetch, playback acknowledgement, and abort behavior.

## Upstream status

Discussion: https://github.com/getpaseo/paseo/discussions/3149

No pull request is pending. Await maintainer direction in the Discussion before preparing one.

## Evidence

### End-to-end voice latency

Warm trials used identical spoken input, local Parakeet STT, local Kokoro TTS, an isolated daemon,
and immediate simulated playback acknowledgement. Latency is audio commit to first audio.

| Provider and mode       | Result | Mean (ms) | p50 (ms) | p95 (ms) | Note                                                              |
| ----------------------- | -----: | --------: | -------: | -------: | ----------------------------------------------------------------- |
| Claude `autoSpeakFinal` |  10/10 |     3,410 |    3,331 |    4,416 | Normal final, no `speak` call                                     |
| Codex `autoSpeakFinal`  |  10/10 |     3,943 |    3,727 |    5,360 | Normal final, no `speak` call                                     |
| Claude `toolDirected`   |  10/10 |     6,333 |    6,638 |    7,905 | Exactly one `speak` call per turn                                 |
| Codex `toolDirected`    |    0/1 |         — |        — |        — | Activation failed because the thread already had an active writer |

For Claude, automatic speech reduced mean commit-to-audio latency by 46% and median latency by
about 50% relative to tool-directed speech. The single Codex control activation failure is a setup
failure, not a failure-rate estimate.

### Fresh local Kokoro benchmark

| Text length | Mean (ms) |  p50 (ms) |  p95 (ms) | STT round-trip similarity | Clipping |
| ----------- | --------: | --------: | --------: | ------------------------: | -------: |
| Short       |  1,138.36 |  1,136.20 |  1,168.95 |                     1.000 |       0% |
| Medium      |  5,014.87 |  5,010.82 |  5,074.54 |                     0.947 |       0% |
| Long        | 11,114.67 | 10,963.19 | 11,620.67 |                     1.000 |       0% |

### Verification

| Check                                     | Result                            |
| ----------------------------------------- | --------------------------------- |
| Focused tests                             | 106 passed                        |
| Typecheck                                 | Passed                            |
| Lint                                      | 3,335 files; 0 warnings, 0 errors |
| Deterministic fake-Codex/local-speech E2E | Passed in 10.72 s                 |

## Limitations

- Playback acknowledgements were immediate, so the timings cover transport flow rather than
  physical playback duration. Physical devices, iOS, Android, web, and Electron were not exercised.
- Pi, OMP, and OpenCode binaries were unavailable and were not tested.
- No commercial voice system or OpenAI/Gemini voice path was tested, so this evidence does not
  establish parity with those products.
- Claude can report a zero-token `subtype: success` result for an error-looking response without a
  typed failure. That false-error ambiguity remains; content inspection is deliberately not used.
- First audio still begins about 1.45 seconds after completion for a short response, and the client
  has no preparing-speech state.
- Automatic speech waits for completion. It does not stream provisional sentences before
  `turn_completed`, so it cannot match systems that begin speaking while the model is still
  generating.

## Recommendation

Await maintainer feedback in Discussion 3149 and do not open a pull request yet. If direction is
positive, prepare a focused implementation PR and exclude this report and the local benchmark
artifact from it.
