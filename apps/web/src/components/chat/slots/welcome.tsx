import { useContext, useEffect, useState } from 'react';
import { ArrowUpRightIcon } from 'lucide-react';
import { EasterEggContext } from '@/components/chat/context';
import { greetingsFor, pickGreeting } from '@/content/greetings';
import { useChatThread } from '@/hooks/use-chat-thread';
import { cn } from '@/lib/shadcn/utils';

/**
 * New chat: the assistant says hello with one big line, a fresh one each time.
 * Picked after mount (it depends on the clock and randomness), with the space
 * reserved so nothing moves when it appears.
 */
export function Welcome() {
  const { assistantName } = useChatThread();
  const setMascotEasterEgg = useContext(EasterEggContext);
  const [greeting, setGreeting] = useState<string | null>(null);
  const chooseAnotherGreeting = () => {
    const choices = greetingsFor(new Date().getHours(), assistantName).filter(
      (line) => line !== greeting
    );
    const next = choices[Math.floor(Math.random() * choices.length)] ?? greeting ?? 'Hello';
    setGreeting(next);
    setMascotEasterEgg(next === 'Hit me.');
  };
  useEffect(() => {
    const next = pickGreeting(assistantName);
    setGreeting(next);
    setMascotEasterEgg(next === 'Hit me.');
    return () => setMascotEasterEgg(false);
  }, [assistantName, setMascotEasterEgg]);

  return (
    <div className="artemis-welcome">
      {/* The thread's mascot settles into this box. */}
      <div className="welcome-character">
        <span className="character-orbit" aria-hidden="true" />
        <span data-mascot-anchor="welcome" className="welcome-mascot-anchor" />
      </div>
      <h2
        key={greeting ?? 'pending'}
        onDoubleClick={chooseAnotherGreeting}
        className={cn(
          'aui-welcome-title font-display max-w-full text-balance select-none',
          greeting ? 'animate-pop-in [animation-delay:90ms]' : 'invisible'
        )}
      >
        {greeting ?? 'Hello'}
      </h2>
    </div>
  );
}

export function WelcomeStats() {
  const { conversationStats } = useChatThread();
  return (
    <>
      {conversationStats && (
        <dl className="welcome-stats" aria-label="Conversation activity">
          <div>
            <dt>Conversations</dt>
            <dd>{conversationStats.total.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Active this week</dt>
            <dd>{conversationStats.activeThisWeek.toLocaleString()}</dd>
          </div>
        </dl>
      )}
    </>
  );
}

export function WelcomeContinuation({ tabIndex = 0 }: { tabIndex?: number }) {
  const { recentConversation, resumeConversation } = useChatThread();
  return (
    <>
      {recentConversation && (
        <button
          type="button"
          tabIndex={tabIndex}
          className="welcome-resume"
          onClick={() => resumeConversation(recentConversation.id)}
        >
          <span className="resume-label">Continue</span>
          <span className="resume-title">
            {recentConversation.title || 'Untitled conversation'}
          </span>
          {recentConversation.updatedAt &&
            Number.isFinite(Date.parse(recentConversation.updatedAt)) && (
              <time dateTime={recentConversation.updatedAt}>
                {new Date(recentConversation.updatedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
            )}
          <ArrowUpRightIcon aria-hidden="true" />
        </button>
      )}
    </>
  );
}
