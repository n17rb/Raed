import { useEffect } from 'react';
import { I18nManager, Platform, StyleSheet, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  NotoSansArabic_400Regular,
  NotoSansArabic_500Medium,
  NotoSansArabic_600SemiBold,
  NotoSansArabic_700Bold,
} from '@expo-google-fonts/noto-sans-arabic';
import { colors } from '@rayed/design-system';
import { OfflineBanner } from '@rayed/ui';
import { SessionProvider, useSession } from '../src/state/session';
import { TripProvider, useTrip } from '../src/state/trip';
import { CallProvider } from '../src/call/CallProvider';
import { targetFromData } from '../src/lib/push';

// The reference screens are laid out left-to-right with Arabic text; keep that
// layout on every device language.
I18nManager.allowRTL(false);
I18nManager.forceRTL(false);

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

function NotificationRouter() {
  const { status } = useSession();
  const { refresh } = useTrip();
  useEffect(() => {
    if (status !== 'signedIn') return;
    const open = (data: Record<string, unknown> | undefined) => {
      const target = targetFromData(data);
      void refresh();
      if (target.screen === 'chat' && target.id) router.push({ pathname: '/chat', params: { tripId: target.id } });
      else if (target.screen === 'trip') router.push('/trip');
      else if (target.screen === 'support' && target.id) router.push({ pathname: '/support/[id]', params: { id: target.id } });
      else router.push('/notifications');
    };
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response.notification.request.content.data as Record<string, unknown>);
    });
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      open(response.notification.request.content.data as Record<string, unknown>);
    });
    return () => subscription.remove();
  }, [refresh, status]);
  return null;
}

export default function RootLayout() {
  // iOS uses the system Arabic font (SF Arabic); Android loads Noto Sans Arabic.
  const [fontsLoaded, fontError] = useFonts(
    Platform.OS === 'android'
      ? { NotoSansArabic_400Regular, NotoSansArabic_500Medium, NotoSansArabic_600SemiBold, NotoSansArabic_700Bold }
      : {}
  );
  const ready = fontsLoaded || fontError !== null;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <TripProvider>
          <CallProvider>
            <View style={styles.root}>
              <StatusBar style="dark" />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.background },
                  animation: 'slide_from_right',
                  animationDuration: 220,
                }}
              >
                <Stack.Screen name="index" options={{ animation: 'none' }} />
                <Stack.Screen name="home" options={{ animation: 'fade', gestureEnabled: false }} />
                <Stack.Screen name="trip" options={{ animation: 'fade', gestureEnabled: false }} />
              </Stack>
              <NotificationRouter />
              <OfflineBanner />
            </View>
          </CallProvider>
        </TripProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
