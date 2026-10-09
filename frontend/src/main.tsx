import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/figtree';
import { ChatApp } from '@/components/chat/chat-app';
import '@/styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatApp assistantName={import.meta.env.ASSISTANT_NAME} />
  </StrictMode>
);
