/**
 * True in `wxt` dev and `wxt build --mode development`; false in production builds.
 * Uses MODE rather than DEV because `vite build --mode development` still sets DEV=false.
 */
export const DIAGNOSTICS_ENABLED = import.meta.env.MODE !== 'production';

declare const __BUILD_ID__: string | undefined;

/** When this copy of the code was built. Differs between contexts after a rebuild until they are reloaded. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unbuilt';
