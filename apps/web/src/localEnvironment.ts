/** True when Electron's bundled execution is disabled; hub environments remain available. */
export function isLocalEnvironmentDisabled(): boolean {
  return window.desktopBridge?.getLocalEnvironmentEnabled?.() === false;
}
