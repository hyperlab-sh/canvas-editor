/** The one place the local service is named: the app is served by it, so its own origin unless a build points elsewhere. */
export const SERVICE_ORIGIN: string = import.meta.env.VITE_SERVICE_ORIGIN ?? (typeof window === 'undefined' ? '' : window.location.origin);
