export function checkBrowserUpdate(currentVersion: string, fetchImpl?: typeof fetch): Promise<{ available: false; version: string } | { available: true; version: string; url: string; size: number }>;
