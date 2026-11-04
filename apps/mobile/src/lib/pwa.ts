// Phones: nothing to set up (the app is installed from the APK).
export function setupWeb(): void {}
export function canInstall(): boolean { return false; }
export async function promptInstall(): Promise<boolean> { return false; }
export function installHint(): string | null { return null; }
export function onInstallAvailable(_fn: () => void): () => void { return () => undefined; }
