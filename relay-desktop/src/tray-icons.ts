// Maps a tray status + menu-bar appearance onto its icon asset. Electron's
// nativeImage resolves the matching "@2x" file by naming convention, so only the
// 1x basename is needed here. Kept free of Electron imports for unit testing.

import type { TrayStatus } from './tray-status';

export function trayIconFile(status: TrayStatus, dark: boolean): string {
  return `tray-${status}-${dark ? 'dark' : 'light'}.png`;
}

/** Every basename trayIconFile can return — the test asserts each one ships. */
export const TRAY_ICON_FILES: string[] = (['connected', 'connecting', 'offline'] as TrayStatus[])
  .flatMap(status => [trayIconFile(status, false), trayIconFile(status, true)]);
