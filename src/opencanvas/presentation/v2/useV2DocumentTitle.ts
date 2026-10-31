import { useEffect } from 'react';

/** The browser tab names the diagram; the default title returns when the editor closes (Home). */
export function useV2DocumentTitle(documentName: string | undefined): void {
  useEffect(() => {
    if (!documentName) return;
    const previous = document.title;
    document.title = `${documentName} · OpenFlowKit`;
    return () => { document.title = previous; };
  }, [documentName]);
}
