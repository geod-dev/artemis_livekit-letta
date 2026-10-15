# Artemis interface

The interface uses opaque ink surfaces in dark mode and warm paper surfaces in
light mode. Cyan belongs to the character; primary actions use cyan in dark mode
and clay in light mode. Conversation content stays quiet and readable.

## Styling ownership

- `styles/tokens.css`: palette primitives, semantic colors, typography, geometry,
  and shared motion curves. Theme previews use the same palette primitives.
- `styles/app-shell.css`: application, navigation, authentication, settings, and
  reusable `.surface-panel` material. No wallpaper or backdrop filtering.
- `styles/welcome.css`: welcome composition, statistics, resume action, and starters.
- `styles/conversation-atmosphere.css`: desktop dark-mode conversation lighting,
  with static idle/tool states and motion confined to thinking and measured speech.
- `styles/controls.css`: composer, effort slider, statuses, and theme previews.
- `styles/interactions.css`: character expressions, motion, and reduced motion.
- `styles/responsive.css`: mobile composition, bottom docking, touch targets,
  safe areas, and drawer transitions.
- `styles/generative-ui.css`: structured tool output vocabulary.

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
