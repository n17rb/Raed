import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { colors, radius } from '@rayed/design-system';
import { RButton, RInput, RText, font } from '@rayed/ui';
import { api } from '../../src/lib/api';
import { errorMessage, randomId } from '../../src/lib/format';
import { Page } from '../../src/components/Page';
import { useTrip } from '../../src/state/trip';

const CATEGORIES = [
  { key: 'GENERAL', label: 'استفسار عام' },
  { key: 'TRIP', label: 'مشكلة في رحلة' },
  { key: 'PAYMENT', label: 'الدفع والأسعار' },
  { key: 'ACCOUNT', label: 'الحساب' },
  { key: 'SAFETY', label: 'السلامة' },
  { key: 'LOST_ITEM', label: 'غرض مفقود' },
] as const;

export default function NewTicket() {
  const { trip } = useTrip();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['key']>('GENERAL');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (subject.trim().length < 2 || body.trim().length < 1) {
      Alert.alert('مركز المساعدة', 'اكتب عنوان المشكلة ووصفها');
      return;
    }
    setSending(true);
    try {
      const result = await api.post<{ ticket: { id: string } }>('/api/v1/support/tickets', {
        subject: subject.trim(),
        category,
        body: body.trim(),
        clientMessageId: randomId(),
        tripId: category === 'TRIP' && trip ? trip.id : undefined,
      });
      router.replace({ pathname: '/support/[id]', params: { id: result.ticket.id } });
    } catch (error) {
      Alert.alert('تعذّر الإرسال', errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <Page title="محادثة جديدة">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <RText variant="bodyBold">نوع المشكلة</RText>
        <View style={styles.chips}>
          {CATEGORIES.map((item) => (
            <Pressable key={item.key} onPress={() => setCategory(item.key)} style={[styles.chip, category === item.key ? styles.chipActive : null]}>
              <RText variant="tileLabel" color={category === item.key ? colors.textOnPrimary : colors.textPrimary}>
                {item.label}
              </RText>
            </Pressable>
          ))}
        </View>
        <RInput label="العنوان" value={subject} onChangeText={setSubject} maxLength={120} placeholder="مثال: الكابتن لم يصل" />
        <RText variant="caption" color={colors.textSecondary}>
          الرسالة
        </RText>
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          maxLength={2000}
          placeholder="السلام عليكم، عندي مشكلة…"
          placeholderTextColor={colors.textTertiary}
          style={[styles.body, font('bodyRegular'), { color: colors.textPrimary }]}
        />
        <RButton title="إرسال" arrow onPress={() => void submit()} loading={sending} />
      </ScrollView>
    </Page>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
  chip: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  body: { minHeight: 140, borderRadius: radius.lg, backgroundColor: colors.searchField, padding: 14, textAlignVertical: 'top', textAlign: 'right' },
});
