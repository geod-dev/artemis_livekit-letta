import { useEffect, useRef } from 'react';
import type { WorkspaceSelection } from '@/components/files/workspace-panel';

/**
 * On a phone the workspace is a full-screen dialog, so its list and detail views
 * are history entries: the system back gesture steps back through them, and
 * closing the dialog unwinds the entries it pushed.
 */
export function useWorkspaceHistory({
  mobile,
  selection,
  setSelection,
  onClose,
}: {
  mobile: boolean;
  selection: WorkspaceSelection;
  setSelection: (selection: WorkspaceSelection) => void;
  onClose: () => void;
}) {
  const navigation = useRef({ key: crypto.randomUUID(), depth: 0 });
  const closeRef = useRef(onClose);
  const selectionRef = useRef(selection);
  closeRef.current = onClose;
  selectionRef.current = selection;
  useEffect(() => {
    if (!mobile) return;
    const state = navigation.current;
    // Delay until the mounted view survives React's development effect replay.
    const frame = requestAnimationFrame(() => {
      const base = window.history.state;
      window.history.pushState({ ...base, workspace: state.key, detail: false }, '');
      state.depth = 1;
      if (selectionRef.current) {
        window.history.pushState(
          { ...base, workspace: state.key, detail: true, selection: selectionRef.current },
          ''
        );
        state.depth = 2;
      }
    });
    const pop = () => {
      if (window.history.state?.workspace !== state.key) {
        state.depth = 0;
        closeRef.current();
      } else if (!window.history.state.detail) {
        state.depth = 1;
        setSelection(null);
      } else if (window.history.state.selection) {
        state.depth = 2;
        setSelection(window.history.state.selection);
      }
    };
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('popstate', pop);
      cancelAnimationFrame(frame);
      if (state.depth && window.history.state?.workspace === state.key)
        window.history.go(-state.depth);
      state.depth = 0;
    };
  }, [mobile, setSelection]);
  useEffect(() => {
    if (!mobile) return;
    const state = navigation.current;
    if (selection && state.depth === 1) {
      window.history.pushState({ ...window.history.state, detail: true, selection }, '');
      state.depth = 2;
    } else if (!selection && state.depth === 2) {
      state.depth = 1;
      window.history.back();
    }
  }, [mobile, selection]);
}
