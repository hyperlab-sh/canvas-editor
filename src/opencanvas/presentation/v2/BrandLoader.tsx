import { useState } from 'react';

/** One loop of the mark: the logo unfolds into a three-box flow, the arrows run, and it folds back. */
export const BRAND_LOADER_CYCLE_MS = 3000;

/**
 * The OpenFlowKit mark unfolding into a small flowchart: every wait in the app, from the HTML
 * before any script (index.html carries the same SVG; BrandLoader.test keeps them identical)
 * to route chunks, redirects and document loads. Styles live in index.css so they apply pre-JS.
 */
export function BrandLoaderMark(): React.JSX.Element {
  return (
    <svg className="ofk-loader-mark" viewBox="0 0 96 64" aria-hidden="true">
      <path className="ofk-loader-edge" pathLength="1" d="M32 18H64" />
      <path className="ofk-loader-edge" pathLength="1" d="M76 25V39" />
      <path className="ofk-loader-edge" pathLength="1" d="M20 25V46H64" />
      <path className="ofk-loader-flow" pathLength="1" d="M32 18H64" />
      <path className="ofk-loader-flow" pathLength="1" d="M76 25V39" />
      <path className="ofk-loader-flow" pathLength="1" d="M20 25V46H64" />
      <rect className="ofk-loader-node" data-node="a" x="8" y="11" width="24" height="14" rx="4" />
      <rect className="ofk-loader-node" data-node="c" x="64" y="11" width="24" height="14" rx="4" />
      <rect className="ofk-loader-node" data-node="b" x="64" y="39" width="24" height="14" rx="4" />
      <g transform="translate(28 12)">
        <g className="ofk-loader-logo">
          <rect x="6" y="6" width="28" height="28" fill="#fff" />
          <path fill="#E95420" d="M20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20C0 8.95431 8.95431 0 20 0ZM14.5156 10C13.3098 10 12.2776 10.4353 11.4189 11.3057C10.5603 12.176 10.1309 13.2222 10.1309 14.4443C10.1309 15.111 10.2634 15.7316 10.5283 16.3057C10.7931 16.8795 11.1538 17.37 11.6104 17.7773L9.55566 21.2227C9.02593 22.1115 8.87516 22.9768 9.10352 23.8193C9.33189 24.6619 9.75675 25.3428 10.3779 25.8613C10.999 26.3797 11.7255 26.6671 12.5566 26.7227C13.3878 26.7781 14.1869 26.481 14.9541 25.833L26.4639 15.833C26.7743 15.5739 27.0942 15.4587 27.4229 15.4863C27.7515 15.5141 28.035 15.6295 28.2725 15.833C28.5099 16.0367 28.6652 16.301 28.7383 16.625C28.8114 16.9491 28.7478 17.278 28.5469 17.6113L26.4092 21.2227C26.263 21.1856 26.1123 21.1572 25.957 21.1387C25.8018 21.1202 25.6419 21.1113 25.4775 21.1113C24.2717 21.1113 23.2395 21.5466 22.3809 22.417C21.5223 23.2873 21.0928 24.3335 21.0928 25.5557C21.0928 26.7778 21.5222 27.824 22.3809 28.6943C23.2395 29.5647 24.2717 30 25.4775 30C26.6834 30 27.7155 29.5647 28.5742 28.6943C29.4329 27.824 29.8623 26.7778 29.8623 25.5557C29.8623 24.889 29.7298 24.2684 29.4648 23.6943C29.2 23.1205 28.8393 22.63 28.3828 22.2227L30.4375 18.7773C30.9673 17.8885 31.1225 17.0232 30.9033 16.1807C30.6841 15.3381 30.2647 14.6572 29.6436 14.1387C29.0225 13.6202 28.2914 13.3286 27.4512 13.2637C26.6108 13.1989 25.8064 13.4906 25.0391 14.1387L13.5293 24.167C13.2188 24.4261 12.899 24.5413 12.5703 24.5137C12.2416 24.4859 11.9581 24.3705 11.7207 24.167C11.4832 23.9633 11.328 23.699 11.2549 23.375C11.1818 23.0509 11.2453 22.722 11.4463 22.3887L13.5566 18.7773C13.7028 18.8144 13.8581 18.8428 14.0225 18.8613C14.1868 18.8798 14.3512 18.8887 14.5156 18.8887C15.7214 18.8887 16.7536 18.4534 17.6123 17.583C18.4709 16.7127 18.9004 15.6665 18.9004 14.4443C18.9004 13.2222 18.471 12.176 17.6123 11.3057C16.7536 10.4353 15.7214 10 14.5156 10Z" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Where in its loop a loader already on screen is (the HTML one, or the fallback before this). One still in its
 * invisible first 300 ms is not on screen yet: the new one waits out its own, so a fast load never pops one in.
 */
function continuedPhaseMs(): number | null {
  const shown = document.querySelector('.ofk-loader');
  // A screen loader fades its mark, not itself (its ground shows at once): either one still hidden means not on screen yet.
  const mark = shown?.querySelector('.ofk-loader-mark');
  if (!shown || Number(getComputedStyle(shown).opacity) < 0.5 || (mark && Number(getComputedStyle(mark).opacity) < 0.5)) return null;
  const animation = shown.querySelector('.ofk-loader-logo')?.getAnimations?.()[0];
  const progress = animation?.effect?.getComputedTiming().progress;
  return typeof progress === 'number' ? progress * BRAND_LOADER_CYCLE_MS : null;
}

/**
 * `screen` fills the viewport on the canvas ground (route chunks, redirects); without it the mark
 * sits in a state screen beside its own caption. A loader that replaces another picks up its loop
 * where that one was, so handing over from the HTML to React never restarts or blinks.
 * `cover` lies over a screen that is still getting ready (above its chrome); `leaving` fades it into that screen.
 */
export function BrandLoader({ label, screen = false, cover = false, leaving = false, ground }: {
  readonly label?: string; readonly screen?: boolean; readonly cover?: boolean; readonly leaving?: boolean;
  /** The ground it lies on (a cover takes the editor's canvas colour, so the app's own theme shows, not the OS's). */
  readonly ground?: string;
}): React.JSX.Element {
  const [phase] = useState(continuedPhaseMs);
  return (
    <div
      className={screen ? 'ofk-loader ofk-loader-screen' : 'ofk-loader'}
      data-fade={phase === null || undefined}
      data-cover={cover || undefined}
      data-leaving={leaving || undefined}
      style={{ ...(phase === null ? {} : { '--ofk-loader-phase': `${-Math.round(phase)}ms` }), ...(ground ? { background: ground } : {}) } as React.CSSProperties}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <BrandLoaderMark />
    </div>
  );
}
