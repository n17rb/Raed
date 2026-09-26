import { useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Constants from 'expo-constants';
import { colors, radius } from '@rayed/design-system';
import { Icon, RText } from '@rayed/ui';
import { Page } from '../src/components/Page';
import { useSession } from '../src/state/session';

const LOGO = require('../assets/images/logo.png') as number;

type Section = 'about' | 'terms' | 'privacy';

export default function About() {
  const { config } = useSession();
  const [open, setOpen] = useState<Section>('about');
  const info = config?.settings.app_info;
  const support = config?.settings.support;
  const sections: Array<{ key: Section; title: string; text: string }> = [
    { key: 'about', title: 'عن رايد', text: info?.aboutAr ?? '' },
    { key: 'terms', title: 'شروط الاستخدام', text: info?.termsAr ?? '' },
    { key: 'privacy', title: 'سياسة الخصوصية', text: info?.privacyAr ?? '' },
  ];

  return (
    <Page title="حول التطبيق">
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.logoBox}>
          <Image source={LOGO} resizeMode="contain" style={styles.logo} />
          <RText variant="caption" color={colors.textSecondary} align="center">
            {`الإصدار ${Constants.expoConfig?.version ?? info?.version ?? ''}`}
          </RText>
        </View>
        {sections.map((section) => (
          <View key={section.key} style={styles.card}>
            <Pressable onPress={() => setOpen(section.key)} style={styles.cardHead}>
              <RText variant="bodyBold" align="left">
                {section.title}
              </RText>
              <Icon name={open === section.key ? 'chevronLeft' : 'chevronRight'} size={16} color={colors.chevron} />
            </Pressable>
            {open === section.key ? (
              <RText variant="bodyRegular" color={colors.textMuted} style={styles.body}>
                {section.text || 'سيتم نشر هذا المحتوى قريبًا من فريق رايد.'}
              </RText>
            ) : null}
          </View>
        ))}
        {support?.phoneNumber || support?.whatsappNumber ? (
          <View style={styles.card}>
            <RText variant="bodyBold" align="left">
              تواصل معنا
            </RText>
            {support.phoneNumber ? (
              <Pressable onPress={() => void Linking.openURL(`tel:${support.phoneNumber}`)} style={styles.contact}>
                <Icon name="phone" size={18} color={colors.primary} />
                <RText variant="body" color={colors.primary}>
                  {support.phoneNumber}
                </RText>
              </Pressable>
            ) : null}
            {support.whatsappNumber ? (
              <Pressable onPress={() => void Linking.openURL(`https://wa.me/${(support.whatsappNumber ?? '').replace(/\D/g, '')}`)} style={styles.contact}>
                <Icon name="whatsapp" size={18} color={colors.primary} />
                <RText variant="body" color={colors.primary}>
                  {support.whatsappNumber}
                </RText>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Page>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  logoBox: { alignItems: 'center', gap: 6, marginVertical: 8 },
  logo: { width: 130, height: 80 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 16, gap: 10 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  body: { lineHeight: 24 },
  contact: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
