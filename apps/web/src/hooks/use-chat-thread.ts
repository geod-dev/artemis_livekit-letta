import { useContext } from 'react';
import { ChatThreadContext } from '@/components/chat/context';

export function useChatThread() {
  const state = useContext(ChatThreadContext);
  if (!state) throw new Error('ChatThreadContext is missing');
  return state;
}
