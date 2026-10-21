import Constants from 'expo-constants';

/**
 * API base URL. Set EXPO_PUBLIC_API_URL when building (e.g. https://api.yourdomain.com).
 * Default 10.0.2.2 reaches the development machine from the Android emulator.
 */
export const API_URL: string = (
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'http://10.0.2.2:3000'
).replace(/\/$/, '');

export const APP_VERSION: string = Constants.expoConfig?.version ?? '0.0.0';
