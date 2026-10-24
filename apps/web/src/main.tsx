import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/figtree';
import { AuthGate } from '@/components/auth-gate';
import { ChatApp } from '@/components/chat/chat-app';
import { applyTheme, getStoredTheme } from '@/lib/theme';
import '@/styles/globals.css';

applyTheme(getStoredTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <ChatApp assistantName={import.meta.env.ASSISTANT_NAME} />
    </AuthGate>
  </StrictMode>
);
