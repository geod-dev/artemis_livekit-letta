import type { ThreadComponents } from '@/components/chat-primitives/chat/thread-context';
import { ConversationAtmosphere } from '@/components/chat/conversation-atmosphere';
import { Mascot } from '@/components/chat/mascot/mascot';
import { BeforeComposer } from '@/components/chat/slots/before-composer';
import { ComposerEffortControl } from '@/components/chat/slots/composer-effort';
import { SystemMessage } from '@/components/chat/slots/system-message';
import { Welcome, WelcomeContinuation } from '@/components/chat/slots/welcome';

/** The chat app's rendering slots for the thread primitives. */
export const THREAD_COMPONENTS: ThreadComponents = {
  Welcome,
  SystemMessage,
  ComposerEffort: ComposerEffortControl,
  BeforeComposer,
  WelcomeFooter: WelcomeContinuation,
  Backdrop: ConversationAtmosphere,
  Overlay: Mascot,
};
