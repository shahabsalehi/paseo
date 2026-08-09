# Auto-speak final responses in Paseo

Status: parked after task definition. No implementation has started.

## Objective

Add and evaluate a provider-independent Paseo voice response mode that speaks the final
assistant message after a turn completes. The experiment must show whether this is more reliable
and faster end to end than requiring each agent runtime to discover and call Paseo's `speak`
tool.

This checkout is isolated from `personal-assistant-v2` and the installed Paseo daemon. Development
must use checkout-local state and must never restart or modify the production daemon on port 6767.

## Workflow being fixed

1. The user starts voice mode in Paseo and speaks.
2. Paseo transcribes the audio and sends the text to the selected runtime.
3. The runtime produces a useful final answer.
4. Paseo should play that final answer through the configured TTS provider exactly once.

Today, step 4 depends on the runtime receiving and calling the `speak` tool. Pi and Codex have open
bugs where voice mode activates but the tool is unavailable or unusable:

- https://github.com/getpaseo/paseo/issues/1892
- https://github.com/getpaseo/paseo/issues/119

The open fixes preserve the runtime-specific MCP dependency:

- https://github.com/getpaseo/paseo/pull/1893
- https://github.com/getpaseo/paseo/pull/2351

The broader auto-TTS request was closed as product feedback rather than implemented:

- https://github.com/getpaseo/paseo/issues/662

## Hypothesis

Paseo already receives ordered `assistant_message` timeline events, an explicit
`turn_completed` event, and owns TTS playback, acknowledgement, and cancellation. A response mode
implemented at that boundary can remove speech-tool availability from the critical path while
remaining independent of Claude, Codex, Pi, OMP, and ACP tool injection.

The experiment is successful only if measurements and tests support this hypothesis. Do not treat
the proposed architecture as decided before the comparison is complete.

## Proposed comparison

### Control: tool-directed speech

- Keep the existing voice prompt and `speak` tool behavior.
- Record whether the runtime receives the tool, whether it calls it, time to the call, time to first
  audio, and whether playback completes.

### Candidate: final-message speech

- Let the runtime return ordinary assistant messages.
- Track only messages from the active foreground turn.
- After `turn_completed`, select the last non-empty `assistant_message`.
- Send it directly through the existing per-client TTS manager.
- Speak it exactly once to the client that owns the active voice session.
- Reuse current playback acknowledgements and barge-in cancellation.
- Do not expose or instruct the runtime to call `speak` in this mode.

The candidate name is `autoSpeakFinal`. The final configuration shape is deliberately undecided.
Compare a boolean with an explicit response-mode enum before changing a persisted or wire schema.

## Boundaries

In scope:

- Active Paseo voice-mode sessions.
- The last visible assistant message from a successfully completed foreground turn.
- Existing local and OpenAI-compatible TTS providers.
- Pi, OMP, Codex, and one working control provider.
- Playback ownership, cancellation, deduplication, and failure handling.
- Markdown-to-speech normalization needed for understandable playback.

Out of scope:

- Speaking reasoning, tool traces, progress events, permissions, errors, or background agents.
- Speaking ordinary text chats when voice mode is off.
- Streaming temporary model output before the final answer is known.
- Replacing Paseo's STT, TTS engine, client, relay, or transport.
- Editing `personal-assistant-v2`.
- Publishing an issue or pull request before local evidence and maintainer direction.

## Acceptance criteria

Correctness:

- A completed spoken turn plays the last final assistant message exactly once.
- Reasoning, commentary/progress, tool output, and earlier assistant messages are never spoken.
- Failed, canceled, empty, background, and replayed/history turns do not trigger speech.
- A reconnect or timeline rehydration does not replay old audio.
- Starting a new spoken turn cancels queued synthesis and playback from the old turn.
- Two connected clients do not both speak unless multi-device playback is explicitly requested.
- A TTS failure leaves the text response intact and does not fail or stall the agent turn.

Compatibility:

- Existing tool-directed voice mode remains available during the experiment.
- No production daemon or user Paseo home is used.
- Any protocol addition is optional and follows `docs/protocol-compatibility.md`.
- Local Kokoro and an OpenAI-compatible TTS endpoint both exercise the same orchestration path.

Evidence:

- Regression tests fail against the control implementation for the missing-tool scenario.
- Focused unit tests cover final selection, exactly-once behavior, cancellation, and failure.
- A real isolated daemon test proves the emitted audio and playback acknowledgement flow.
- Manual runs cover Pi and OMP plus at least one existing working provider.
- Results include raw commands, logs, and a short video or screen recording where practical.

## Measurements

Capture the following for identical prompts and final text:

| Measurement | Definition |
| --- | --- |
| Runtime completion | Spoken input committed to `turn_completed` |
| Speech dispatch overhead | `turn_completed` to TTS request start |
| Time to first audio | Spoken input committed to first playable client audio |
| TTS first-audio cost | TTS request start to first playable client audio |
| Playback completion | Spoken input committed to final playback acknowledgement |
| Reliability | Successful spoken responses divided by attempts |

Run cold and warm trials. Record at least ten warm trials for short, medium, and long final
responses. Preserve failures rather than averaging them away.

Prior local observations may guide test sizes but are not PR evidence:

| Text length | Installed Paseo local Kokoro synthesis |
| ---: | ---: |
| 25 characters | 1.45 s |
| 76 characters | 3.74 s |
| 116 characters | 4.15 s |
| 274 characters | 10.44 s |

## Implementation plan

1. **Map current main**
   - Read the voice session, voice prompt, agent timeline, TTS manager, config schema, protocol, and
     existing tests.
   - Confirm event ordering and ownership with logs rather than inference.

2. **Build the comparison harness**
   - Start an isolated daemon using this checkout's `.dev/paseo-home` on a non-production port.
   - Add deterministic fixtures for a turn containing reasoning, tool activity, multiple assistant
     messages, and completion.
   - Capture timestamped runtime, TTS, audio-output, and acknowledgement events.

3. **Write failing behavioral tests**
   - Missing `speak` tool still yields spoken final output in the candidate mode.
   - Only the last assistant message is selected.
   - Duplicate completion, reconnect, cancellation, and TTS failure are safe.

4. **Implement the smallest server slice**
   - Add per-voice-session candidate-mode state.
   - Track the last assistant message for the active foreground turn.
   - Dispatch synthesis asynchronously on successful completion.
   - Reuse the existing TTS manager and audio protocol.

5. **Remove the tool dependency in candidate mode**
   - Replace the speak-only voice prompt with instructions for a concise normal final response.
   - Do not register or expose `speak` for candidate-mode sessions.
   - Preserve all non-speech Paseo tools.

6. **Harden semantics**
   - Add exactly-once identity, active-client ownership, abort propagation, length limits, and
     conservative Markdown normalization.
   - Make TTS errors observable in logs without contaminating the agent timeline or turn status.

7. **Run focused verification**
   - Run only changed test files with `--bail=1`.
   - Run repository typecheck, lint, and formatting as required by `AGENTS.md`.
   - Do not run the full local test suite.

8. **Run real comparison**
   - Compare control and candidate modes with Pi, OMP, Codex, and a working control provider.
   - Test local Kokoro and one OpenAI-compatible TTS endpoint.
   - Report latency distributions, failures, behavioral differences, and resource use.

9. **Make an upstream decision**
   - If the candidate is not materially more reliable, stop and document the result.
   - If it wins, open a workflow-focused GitHub Discussion referencing the existing issues and PRs.
   - Ask whether maintainers prefer an optional response mode or a fallback policy.
   - Prepare a focused draft PR only after direction is positive.

## Expected files during implementation

- `packages/server/src/server/session/voice/voice-session.ts`
- `packages/server/src/server/voice-config.ts`
- `packages/server/src/server/agent/tts-manager.ts`
- `packages/server/src/server/session.ts`
- `packages/server/src/server/persisted-config.ts`
- Collocated focused tests for each changed behavior

Protocol or app files are not assumed. Add them only if the experiment proves that server-local
configuration and the existing audio messages cannot meet the acceptance criteria.

## Resume point

When this task is resumed, begin with step 1. Do not install dependencies, change code, start a
daemon, or alter live configuration before re-reading the repository instructions and confirming
the production daemon remains untouched.
