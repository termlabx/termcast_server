import { spawn } from 'node:child_process';

/** Pure: choose the OS command + args to open a URL. */
export function openCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  switch (platform) {
    case 'darwin': return { cmd: 'open', args: [url] };
    // `start` needs an empty title arg so a quoted URL isn't treated as the title.
    case 'win32': return { cmd: 'cmd', args: ['/c', 'start', '', url] };
    default: return { cmd: 'xdg-open', args: [url] };
  }
}

/** Best-effort open; never throws — prints a fallback hint on failure. */
export function openUrl(url: string): void {
  const { cmd, args } = openCommand(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open this URL manually: ${url}`));
    child.unref();
  } catch {
    console.log(`Open this URL manually: ${url}`);
  }
}
