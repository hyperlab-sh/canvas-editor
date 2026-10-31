import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';

const RELOADED_KEY = 'ofk-stale-chunk-reload';
const reloadPage = () => window.location.reload();

/** A new deploy replaces hashed chunks under open tabs: reload once to pick up the new build. Returns whether it reloaded. */
export function reloadOnStaleChunk(reload: () => void = reloadPage): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return false;
    sessionStorage.setItem(RELOADED_KEY, '1');
  } catch { return false; }
  reload();
  return true;
}

type Screen = ComponentType<{ readonly reload: () => void }>;
interface State { failed: boolean; screen: Screen | null; screenFailed: boolean }

/** Last line of defence: any render throw or failed chunk shows a way back instead of a blank page. */
export class V2ErrorBoundary extends Component<{ readonly children: ReactNode; readonly reload?: () => void }, State> {
  state: State = { failed: false, screen: null, screenFailed: false };

  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
    // The themed screen is its own chunk (its styles are large); if that fails too, the plain fallback below stands in.
    import('./V2ErrorScreen').then(
      (module) => this.setState({ screen: module.V2ErrorScreen }),
      () => this.setState({ screenFailed: true }),
    );
  }

  render(): ReactNode {
    const { failed, screen: ErrorScreen, screenFailed } = this.state;
    if (!failed) return this.props.children;
    const reload = this.props.reload ?? reloadPage;
    if (ErrorScreen) return <ErrorScreen reload={reload} />;
    return (
      <div className="ofk-boot">
        {screenFailed && <p role="alert">Something went wrong. <button type="button" onClick={reload}>Reload</button></p>}
      </div>
    );
  }
}
