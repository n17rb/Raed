import type { ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@rayed/design-system';
import { CircleButton, RText } from '@rayed/ui';

const LOGO = require('../../assets/images/logo.png') as number;
const CASTLE = require('../../assets/images/castle.jpg') as number;

/** Login / OTP / name screens: splash background, logo at the top, castle at the bottom. */
export function AuthLayout({
  title,
  subtitle,
  onBack,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  return (
    <View style={styles.screen}>
      <Image source={CASTLE} resizeMode="cover" style={[styles.castle, { width, height: width * (448 / 944) }]} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.topRow}>{onBack ? <CircleButton icon="back" onPress={onBack} accessibilityLabel="رجوع" /> : <View />}</View>
          <Image source={LOGO} resizeMode="contain" style={styles.logo} />
          <RText variant="screenTitle" align="center">
            {title}
          </RText>
          {subtitle ? (
            <RText variant="bodyRegular" color={colors.textSecondary} align="center" style={styles.subtitle}>
              {subtitle}
            </RText>
          ) : null}
          <View style={styles.body}>{children}</View>
          {footer}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.splashBackground },
  flex: { flex: 1 },
  castle: { position: 'absolute', bottom: 0, left: 0, opacity: 0.35 },
  content: { flexGrow: 1, paddingHorizontal: 24 },
  topRow: { height: 44, flexDirection: 'row' },
  logo: { width: 150, height: 94, alignSelf: 'center', marginTop: 24, marginBottom: 28 },
  subtitle: { marginTop: 8 },
  body: { marginTop: 32, gap: 16 },
});
