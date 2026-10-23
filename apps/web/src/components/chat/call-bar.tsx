import { Track } from 'livekit-client';
import { MicIcon, MicOffIcon } from 'lucide-react';
import { useAgent, useSessionContext, useTrackToggle } from '@livekit/components-react';
import { AgentAudioVisualizerBar } from '@/components/agents-ui/agent-audio-visualizer-bar';
import { Button } from '@/components/ui/button';

const STATE_LABEL: Record<string, string> = {
  connecting: 'Connecting…',
  'pre-connect-buffering': 'Connecting… (you can start talking)',
  initializing: 'Assistant is joining…',
  idle: 'Connected',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  disconnected: 'Call ended',
  failed: 'Call failed',
};

/** Visible active-call state: agent status and microphone control. */
export function CallBar({ mascotActive }: { mascotActive: boolean }) {
  const agent = useAgent();
  const { connectionState } = useSessionContext();
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const label =
    connectionState === 'connecting'
      ? STATE_LABEL.connecting
      : (STATE_LABEL[agent.state] ?? agent.state);

  return (
    <div className="call-bar animate-pop-in flex items-center" data-voice-state={agent.state}>
      {mascotActive && (
        <span data-mascot-anchor="voice" className="block size-10 shrink-0" aria-hidden="true" />
      )}
      <AgentAudioVisualizerBar
        size="icon"
        state={agent.state}
        audioTrack={agent.microphoneTrack}
        className="call-bar-visualizer h-6 w-10"
      />
      <div className="min-w-0 flex-1">
        <p className="call-bar-label text-sm" role="status">
          {label}
        </p>
        {agent.state === 'failed' && agent.failureReasons && (
          <p className="truncate text-xs font-semibold">{agent.failureReasons.join(', ')}</p>
        )}
      </div>
      <Button
        size="icon"
        className="call-bar-mic bouncy hover:bg-accent rounded-full"
        onClick={() => void mic.toggle()}
        disabled={mic.pending}
        aria-label={mic.enabled ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={!mic.enabled}
      >
        {mic.enabled ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
      </Button>
    </div>
  );
}
