import type { Platform } from '../core/types';

export const PLATFORM_LABEL: Record<Platform, string> = { android: 'Android', ios: 'iOS', windows: 'Windows', linux: 'Linux', macos: 'macOS' };
export const PLATFORM_ICON: Record<Platform, string> = { android: '▯', ios: '▯', windows: '⊞', linux: '◭', macos: '⌘' };
export const isComputer = (p: Platform | undefined) => p === 'windows' || p === 'linux' || p === 'macos';
