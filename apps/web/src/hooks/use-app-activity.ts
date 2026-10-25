import { useContext } from 'react';
import { AppActivityContext } from '@/components/chat/context';

/** The app's background tasks and how to open or stop one. Throws outside the chat provider. */
export function useAppActivity() {
  const context = useContext(AppActivityContext);
  if (!context) throw new Error('AppActivityContext is missing');
  return context;
}
