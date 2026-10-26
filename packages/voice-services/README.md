# @artemis/voice-services

Voice providers behind ports: the LiveKit token issuer and the Groq speech-to-text transcriber.

- **Root entry point:** `src/index.ts` exports only the `LiveKitSettings` type. Apps import the implementations through their subpaths.
- **Vendor subpaths** (composition roots only): `./groq` (`src/vendor/groq/transcription.ts`, `createGroqTranscriber`) and `./livekit` (`src/vendor/livekit/tokens.ts`, `createVoiceTokenIssuer`). The gateway's `src/compose.ts` is the only consumer.
- **Why subpaths:** the vendor files cannot be re-exported from the root, because the boundary checker keeps vendor imports behind composition roots.
- **Depends on:** `@artemis/contracts`, `livekit-server-sdk`.
- **Check:** `pnpm check:packages`.
