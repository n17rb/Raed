import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'rayed.customer.cache.';

/** Small JSON cache for offline start-up (profile, config, last trip, recent searches). */
export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, value: T | null): Promise<void> {
  try {
    if (value === null) await AsyncStorage.removeItem(PREFIX + key);
    else await AsyncStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the app keeps working from memory.
  }
}

export async function clearCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((key) => key.startsWith(PREFIX)));
  } catch {
    // Nothing to clear.
  }
}
