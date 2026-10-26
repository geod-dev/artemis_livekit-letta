# Web app visual design

The interface uses opaque ink surfaces in dark mode and warm paper surfaces in
light mode. Cyan belongs to the character; primary actions use cyan in dark mode
and clay in light mode. Conversation content stays quiet and readable.

## Styling ownership

Paths in this section are relative to `apps/web/src/`.

- `styles/globals.css` and `styles/base.css`: the stylesheet entry point and the base
  element rules.
- `styles/tokens.css`: palette primitives, semantic colors, typography, geometry,
  and shared motion curves. Theme previews use the same palette primitives.
- `styles/app-shell.css`: application, navigation, authentication, settings, and
  reusable `.surface-panel` material. No wallpaper or backdrop filtering.
- `styles/welcome.css`: welcome composition, statistics, resume action, and starters.
- `styles/conversation-atmosphere.css`: desktop dark-mode conversation lighting,
  with static idle/tool states and motion confined to thinking and measured speech.
- `styles/controls.css`: composer, effort slider, statuses, and theme previews.
- `styles/interactions.css`: character expressions, motion, and reduced motion.
- `styles/responsive-shell.css`: responsive shells and shared touch behaviour.
- `styles/responsive-chrome.css`: viewport-height handling for the chrome and settings page.
- `styles/responsive-phone.css`: the phone layout below 768px (top bar, docking, drawers).
- `styles/responsive-touch.css`: short-viewport adjustments and touch sizing.
- `styles/generative-ui/`: structured tool output vocabulary, split by component:
  `actions.css`, `data-display.css`, `form-controls.css`, `layout-and-cards.css`, and
  `text-and-facts.css`.

## Code layout

Paths are relative to `apps/web/src/`. The app imports only `@artemis/contracts` from the
workspace, and the boundary checker denies Node built-ins and server-only SDKs in this tree.

- `components/chat/`: the chat application shell, sidebar, conversation list, welcome and
  composer slots (`slots/`), and the mascot (`mascot/`). The thread-level React contexts are in
  `components/chat/context.ts`, and the provider composition is in `chat-app.tsx`.
- `components/chat-primitives/`: the wrappers around assistant-ui primitives. `chat/` holds the
  thread and messages, `composer/` the composer, `tools/` the tool-call renderers, and `utils/`
  small helpers.
- `components/media/`: shared media primitives used by chat and the files panel: attachments,
  images, files and their icons, the media player, and `markdown/` for rendered Markdown, links and
  sources.
- `components/tasks/`: background task bubbles, labels, and the stop control.
- `components/files/`: the workspace file panel.
- `components/voice/`: the call bar, dictation, the agent audio visualizer, and the start-audio button.
- `components/settings/` and `components/ui/`: the settings dialog and MCP server editor, and the
  shared UI primitives.
- `hooks/`: every `use-*.ts` hook lives here, and no hook is defined inside a component folder.
  Hooks that are not `use-*` helpers, such as `voice-recording-end.ts`, sit beside them.
- `lib/`: pure logic (formatting, state merging, protocol helpers). The unit tests here run with tsx.
- `content/`: fixed copy, such as greetings and welcome suggestions.

The web app has no `index.ts` barrel files. Import the module that defines a symbol. The hooks
location is a convention; no tool enforces it.

## Character continuity

One mascot is portaled into a fixed viewport overlay. Its anchors use
`getBoundingClientRect()`, so page scroll offsets never become travel coordinates.
The parent controls travel; the SVG controls breathing, state expressions, and
welcome-only parallax. Keep these transforms separate. Do not mount extra mascot
instances in messages, settings, or voice controls.

Text runtime, LiveKit state, and recorder state drive the character's activity.
Only a completed response triggers its completion gesture. Sleeping eyes do not
blink again. Reduced motion disables expressive animation, parallax, and travel
interpolation; the real microphone waveform remains useful feedback.

## Useful information

Statistics come from successfully loaded conversation summaries. “Active this
week” counts conversations updated since local Monday, not messages or tasks.
Unavailable statistics stay hidden.
The resume action selects the most recently updated conversation. Starter ideas
rotate across three distinct areas and populate the composer for editing.

Desktop places the welcome composer high in the workspace. Phones dock it at the
bottom, with starters and the resume action above it. Preserve the existing
conversation runtime, attachment restrictions, and voice integration when editing
these components.

Conversation lighting never mounts on mobile, in light mode, or on the welcome
screen. Its soft radial textures animate with transforms only while thinking.
Speech opacity follows the agent's output audio, with its analyser mounted only
while speaking on a visible desktop without reduced motion. Reading streamed
prose returns the lights to idle; completed tools cannot keep them active.
