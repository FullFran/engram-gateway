/**
 * Web admin panel (#17): server-rendered pages at `/ui` behind the browser
 * session, calling the same application services as the admin and account APIs.
 */
export { UI_PATH, createUiRouter } from './presentation/http/ui-router.js';
export type { UiIdentify, UiRouterOptions, UiSession } from './presentation/http/ui-router.js';
export { CsrfTokens } from './presentation/http/csrf.js';
