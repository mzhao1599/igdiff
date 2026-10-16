/**
 * True in `wxt` dev and `wxt build --mode development`; false in production builds.
 * Uses MODE rather than DEV because `vite build --mode development` still sets DEV=false.
 */
export const DIAGNOSTICS_ENABLED = import.meta.env.MODE !== 'production';
