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
export function CallBar() {
  const agent = useAgent();
  const { connectionState } = useSessionContext();
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const label =
    connectionState === 'connecting'
      ? STATE_LABEL.connecting
      : (STATE_LABEL[agent.state] ?? agent.state);

  return (
    <div className="bg-mint animate-pop-in mx-4 mt-1 mb-2 flex items-center gap-3 rounded-full py-2 ps-4 pe-2 text-white">
      <AgentAudioVisualizerBar
        size="icon"
        state={agent.state}
        audioTrack={agent.microphoneTrack}
        className="h-6 w-10 text-white"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-extrabold">On a call: {label}</p>
        {agent.state === 'failed' && agent.failureReasons && (
          <p className="truncate text-xs font-semibold">{agent.failureReasons.join(', ')}</p>
        )}
      </div>
      <Button
        size="icon"
        className="bouncy text-mint rounded-full bg-white hover:bg-white/90"
        onClick={() => void mic.toggle()}
        disabled={mic.pending}
        aria-label={mic.enabled ? 'Mute microphone' : 'Unmute microphone'}
      >
        {mic.enabled ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
      </Button>
    </div>
  );
}
