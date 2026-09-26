import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PlaceDetails, PlaceSuggestion, SavedPlace } from '@rayed/api-client';
import { colors, layout, motion, radius, shadows } from '@rayed/design-system';
import { CircleButton, Icon, RButton, RText, font, type IconName } from '@rayed/ui';
import { api } from '../src/lib/api';
import { distanceText, errorMessage, randomId } from '../src/lib/format';
import { getCurrentLocation } from '../src/lib/location';
import { KIND_LABELS, recordRecent, reverseGeocode, shortAddress, useRecentSearches, useSavedPlaces } from '../src/lib/places';
import { useSession } from '../src/state/session';
import { useTrip, type PlaceValue } from '../src/state/trip';

const LOGO = require('../assets/images/logo.png') as number;

type Target = 'pickup' | 'dropoff';
type SaveKind = 'HOME' | 'WORK' | 'UNIVERSITY' | 'FAVORITE';

interface Row {
  key: string;
  icon: IconName;
  title: string;
  subtitle: string | null;
  meta?: string;
  onPress: () => void;
}

const KIND_ICON: Record<SavedPlace['kind'], IconName> = { HOME: 'home', WORK: 'work', UNIVERSITY: 'university', FAVORITE: 'favorite' };

/** Screen 2 — choose / confirm the destination (search, recent, saved, pick on map). */
export default function Destination() {
  const params = useLocalSearchParams<{ saveKind?: SaveKind }>();
  const saveKind = params.saveKind;
  const insets = useSafeAreaInsets();
  const { profile } = useSession();
  const { pickup, dropoff, setPickup, setDropoff } = useTrip();
  const { places, reload: reloadPlaces } = useSavedPlaces();
  const recent = useRecentSearches();
  const [target, setTarget] = useState<Target>('dropoff');
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const sessionToken = useRef(randomId());
  const inputRef = useRef<TextInput>(null);
  const requestId = useRef(0);

  // Debounced Google Places autocomplete through the API.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setSuggestions([]);
      setSearching(false);
      setSearchError(null);
      return undefined;
    }
    setSearching(true);
    const current = ++requestId.current;
    const timer = setTimeout(() => {
      api
        .post<{ suggestions: PlaceSuggestion[] }>('/api/v1/maps/autocomplete', {
          input: text,
          sessionToken: sessionToken.current,
          near: pickup ? { lat: pickup.lat, lng: pickup.lng } : undefined,
        })
        .then((result) => {
          if (current !== requestId.current) return;
          setSuggestions(result.suggestions);
          setSearchError(null);
        })
        .catch((error: unknown) => {
          if (current !== requestId.current) return;
          setSuggestions([]);
          setSearchError(errorMessage(error));
        })
        .finally(() => {
          if (current === requestId.current) setSearching(false);
        });
    }, motion.autocompleteDebounceMs);
    return () => clearTimeout(timer);
  }, [pickup, query]);

  const finishSave = useCallback(
    async (place: PlaceValue & { title: string }) => {
      if (!saveKind) return false;
      setSaving(true);
      try {
        const body = { title: saveKind === 'FAVORITE' ? place.title : KIND_LABELS[saveKind], address: place.address, googlePlaceId: place.placeId, lat: place.lat, lng: place.lng };
        if (saveKind === 'FAVORITE') await api.post('/api/v1/me/places/saved', body);
        else await api.put(`/api/v1/me/places/saved/${saveKind}`, body);
        await reloadPlaces();
        router.back();
      } catch (error) {
        Alert.alert('تعذّر حفظ العنوان', errorMessage(error));
      } finally {
        setSaving(false);
      }
      return true;
    },
    [reloadPlaces, saveKind]
  );

  const apply = useCallback(
    async (place: PlaceValue & { title: string }) => {
      if (saveKind) {
        await finishSave(place);
        return;
      }
      if (target === 'pickup') {
        setPickup(place);
        setTarget('dropoff');
        setQuery('');
        inputRef.current?.focus();
        return;
      }
      setDropoff(place);
      setQuery('');
    },
    [finishSave, saveKind, setDropoff, setPickup, target]
  );

  const selectSuggestion = useCallback(
    async (suggestion: PlaceSuggestion) => {
      setSelecting(true);
      try {
        const details = await api.get<PlaceDetails>(`/api/v1/maps/places/${suggestion.placeId}`, { query: { sessionToken: sessionToken.current } });
        sessionToken.current = randomId();
        recordRecent({ title: suggestion.title, subtitle: suggestion.subtitle, placeId: suggestion.placeId, lat: details.lat, lng: details.lng });
        await apply({ lat: details.lat, lng: details.lng, address: suggestion.title, placeId: suggestion.placeId, title: suggestion.title });
      } catch (error) {
        Alert.alert('تعذّر اختيار المكان', errorMessage(error));
      } finally {
        setSelecting(false);
      }
    },
    [apply]
  );

  const useCurrentLocation = useCallback(async () => {
    const result = await getCurrentLocation();
    if (!result.ok) {
      Alert.alert('الموقع غير متاح', result.reason === 'DENIED' ? 'اسمح لرايد بالوصول إلى موقعك' : 'تعذّر تحديد موقعك الآن');
      return;
    }
    const address = shortAddress(await reverseGeocode(result.point)) || 'موقعك الحالي';
    setPickup({ ...result.point, address: target === 'pickup' ? address : 'موقعك الحالي' });
    if (target === 'pickup') setTarget('dropoff');
  }, [setPickup, target]);

  const openMapPicker = () =>
    router.push({ pathname: '/pick-on-map', params: { target: saveKind ? 'save' : target, saveKind: saveKind ?? '' } });

  const saveCurrentDestination = async () => {
    if (!dropoff) {
      Alert.alert('حفظ العنوان', 'اختر مكان الوصول أولًا');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/v1/me/places/saved', { title: dropoff.address, address: dropoff.address, googlePlaceId: dropoff.placeId, lat: dropoff.lat, lng: dropoff.lng });
      await reloadPlaces();
      Alert.alert('تم الحفظ', 'أُضيف العنوان إلى وجهاتك المحفوظة');
    } catch (error) {
      Alert.alert('تعذّر حفظ العنوان', errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const rows = useMemo<Row[]>(() => {
    if (query.trim().length >= 2) {
      return suggestions.map((suggestion) => ({
        key: `s-${suggestion.placeId}`,
        icon: 'pin' as IconName,
        title: suggestion.title,
        subtitle: suggestion.subtitle,
        meta: suggestion.distanceM !== null ? distanceText(suggestion.distanceM) : undefined,
        onPress: () => void selectSuggestion(suggestion),
      }));
    }
    const saved: Row[] = places.map((place) => ({
      key: `p-${place.id}`,
      icon: KIND_ICON[place.kind],
      title: place.kind === 'FAVORITE' ? place.title : KIND_LABELS[place.kind],
      subtitle: place.address ?? (place.kind === 'FAVORITE' ? null : place.title),
      onPress: () => void apply({ lat: place.lat, lng: place.lng, address: place.kind === 'FAVORITE' ? place.title : KIND_LABELS[place.kind], placeId: place.placeId ?? undefined, title: place.title }),
    }));
    const recents: Row[] = recent.map((item) => ({
      key: `r-${item.id}`,
      icon: 'history' as IconName,
      title: item.title,
      subtitle: item.subtitle,
      onPress: () => void apply({ lat: item.lat, lng: item.lng, address: item.title, placeId: item.placeId ?? undefined, title: item.title }),
    }));
    return saveKind ? recents : [...saved, ...recents];
  }, [apply, places, query, recent, saveKind, selectSuggestion, suggestions]);

  const title = saveKind ? (saveKind === 'FAVORITE' ? 'اختر الوجهة التي تريد حفظها' : `اختر عنوان ${KIND_LABELS[saveKind]}`) : null;
  const firstName = (profile?.fullName ?? '').split(' ')[0] ?? '';
  const showingSuggestions = query.trim().length >= 2;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <CircleButton icon="back" onPress={() => router.back()} accessibilityLabel="رجوع" size={layout.backButtonSize + 4} />
        <Image source={LOGO} style={styles.logo} resizeMode="contain" />
        <View style={[styles.greeting, shadows.card.native]}>
          <View>
            <RText variant="greetingLabel" color={colors.textSecondary}>
              مرحبا
            </RText>
            <RText variant="greetingName" numberOfLines={1}>
              {firstName}
            </RText>
          </View>
          <Icon name="user" size={20} color={colors.primary} />
        </View>
      </View>

      <Pressable onPress={openMapPicker} style={[styles.mapRow, shadows.card.native]}>
        <Icon name="pin" size={20} color={colors.primary} />
        <RText variant="bodyRegular" color={colors.textSecondary} style={styles.flex}>
          {title ?? 'اختر وجهتك من الخريطة'}
        </RText>
        <Icon name="chevronRight" size={16} color={colors.textSecondary} />
      </Pressable>

      <Pressable onPress={openMapPicker} style={styles.pickOnMap}>
        <View style={styles.targetIcon}>
          <Icon name="target" size={22} color={colors.primary} />
        </View>
        <RText variant="bodyBold" color={colors.primary}>
          اختر من الخريطة
        </RText>
      </Pressable>

      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        ListHeaderComponent={
          searching || selecting ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : searchError ? (
            <RText variant="caption" color={colors.danger} align="center" style={styles.loader}>
              {searchError}
            </RText>
          ) : null
        }
        ListEmptyComponent={
          showingSuggestions && !searching ? (
            <RText variant="bodyRegular" color={colors.textSecondary} align="center" style={styles.loader}>
              لا توجد نتائج مطابقة
            </RText>
          ) : null
        }
        ListFooterComponent={
          showingSuggestions && suggestions.length > 0 ? (
            <RText variant="micro" color={colors.textTertiary} align="center" style={styles.attribution}>
              Powered by Google
            </RText>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable onPress={item.onPress} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
            <View style={styles.rowIcon}>
              <Icon name={item.icon} size={18} color={colors.navy} />
            </View>
            <View style={styles.flex}>
              <RText variant="body" align="left" numberOfLines={1}>
                {item.title}
              </RText>
              {item.subtitle ? (
                <RText variant="caption" color={colors.textSecondary} align="left" numberOfLines={1}>
                  {item.subtitle}
                </RText>
              ) : null}
            </View>
            {item.meta ? (
              <RText variant="caption" color={colors.textSecondary}>
                {item.meta}
              </RText>
            ) : null}
          </Pressable>
        )}
      />

      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.fields}>
          <View style={styles.connector} />
          <Pressable onPress={() => setTarget('pickup')} style={[styles.field, target === 'pickup' ? styles.fieldActive : null]}>
            <View style={styles.pickupDot} />
            <View style={styles.flex}>
              <RText variant="micro" color={colors.textSecondary} align="left">
                مكان الانطلاق
              </RText>
              {target === 'pickup' ? (
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="ابحث عن نقطة الانطلاق"
                  placeholderTextColor={colors.textTertiary}
                  autoFocus
                  style={[styles.input, font('bodyBold'), { color: colors.textPrimary }]}
                />
              ) : (
                <RText variant="bodyBold" align="left" numberOfLines={1}>
                  {pickup?.address ?? 'موقعك الحالي'}
                </RText>
              )}
            </View>
            <Pressable onPress={() => void useCurrentLocation()} hitSlop={10} style={styles.fieldAction} accessibilityLabel="موقعي الحالي">
              <Icon name="navigate" size={18} color={colors.primary} />
            </Pressable>
          </Pressable>

          <Pressable
            onPress={() => {
              setTarget('dropoff');
              inputRef.current?.focus();
            }}
            style={[styles.field, target === 'dropoff' ? styles.fieldActive : null]}
          >
            <Icon name="pinFilled" size={20} color={colors.navy} />
            <View style={styles.flex}>
              <RText variant="micro" color={colors.textSecondary} align="left">
                مكان الوصول
              </RText>
              {target === 'dropoff' ? (
                <TextInput
                  ref={inputRef}
                  value={query}
                  onChangeText={setQuery}
                  placeholder={dropoff?.address ?? 'أدخل الوجهة'}
                  placeholderTextColor={dropoff ? colors.textPrimary : colors.textTertiary}
                  autoFocus={!saveKind}
                  returnKeyType="search"
                  style={[styles.input, font('bodyBold'), { color: colors.textPrimary }]}
                />
              ) : (
                <RText variant="bodyBold" color={dropoff ? colors.textPrimary : colors.textTertiary} align="left" numberOfLines={1}>
                  {dropoff?.address ?? 'أدخل الوجهة'}
                </RText>
              )}
            </View>
            <Icon name="plus" size={18} color={colors.primary} />
          </Pressable>
        </View>

        {!saveKind ? (
          <>
            <RText variant="bodyBold" style={styles.extraTitle}>
              إعدادات إضافية
            </RText>
            <Pressable onPress={() => void saveCurrentDestination()} disabled={saving} style={styles.extraCard}>
              <View style={styles.extraIcon}>
                <Icon name="favorite" size={18} color={colors.primary} />
              </View>
              <View style={styles.flex}>
                <RText variant="tileLabel" align="left">
                  حفظ العنوان
                </RText>
                <RText variant="micro" color={colors.textSecondary} align="left">
                  للرحلات القادمة
                </RText>
              </View>
              {saving ? <ActivityIndicator color={colors.primary} /> : <Icon name="chevronRight" size={16} color={colors.textSecondary} />}
            </Pressable>
            <RButton
              title="تأكيد الوجهة"
              arrow
              disabled={!dropoff || !pickup}
              onPress={() => router.push('/vehicle')}
              style={styles.confirm}
            />
          </>
        ) : saving ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.screenTint },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.screenPaddingHorizontal,
  },
  logo: { width: 96, height: 60 },
  greeting: {
    height: layout.greetingChipHeight + 4,
    borderRadius: radius.xxl,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    minWidth: 104,
    justifyContent: 'flex-end',
  },
  mapRow: {
    marginTop: 16,
    marginHorizontal: layout.screenPaddingHorizontal,
    height: layout.inputHeight + 6,
    borderRadius: radius.xxl,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  pickOnMap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 18,
    marginHorizontal: layout.screenPaddingHorizontal + 4,
  },
  targetIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { flex: 1, marginTop: 10 },
  loader: { marginTop: 16 },
  attribution: { marginVertical: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: layout.screenPaddingHorizontal + 4,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.iconCircle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  bottom: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: layout.sheetPaddingHorizontal,
    paddingTop: 16,
    ...shadows.sheet.native,
  },
  fields: { gap: 12 },
  connector: {
    position: 'absolute',
    left: 25,
    top: 38,
    height: 50,
    width: 1.5,
    backgroundColor: colors.textTertiary,
  },
  field: {
    minHeight: layout.routeFieldHeight + 6,
    borderRadius: radius.lg,
    backgroundColor: colors.screenTintLight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  fieldActive: { borderColor: colors.primarySoft },
  pickupDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.primary,
    marginHorizontal: 3,
  },
  input: { paddingVertical: 2, textAlign: 'left' },
  fieldAction: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  extraTitle: { marginTop: 20, marginBottom: 12 },
  extraCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  extraIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.iconCircle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirm: { marginTop: 18 },
});
