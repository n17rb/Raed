import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { router, type Href } from 'expo-router';
import type { Advertisement, AdvertisementsResponse } from '@rayed/api-client';
import { AD_BANNER_ASPECT_RATIO, colors, motion, radius } from '@rayed/design-system';
import { api } from '../lib/api';
import { readCache, writeCache } from '../lib/cache';

/** In-app screens an advertisement may open (must match the admin list). */
const AD_SCREENS: Record<string, Href> = {
  wallet: '/wallet',
  promos: '/promos',
  trips: '/trips',
  notifications: '/notifications',
  support: '/support',
  about: '/about',
  profile: '/profile',
};

/**
 * Home advertisement banner (3:1). Up to three banners rotate every few seconds
 * with a smooth slide; the admin controls images, order and duration.
 */
export const AdCarousel = memo(function AdCarousel({
  width,
  onDestination,
  onPromo,
}: {
  width: number;
  onDestination: (ad: Advertisement) => void;
  onPromo: (code: string) => void;
}) {
  const [data, setData] = useState<AdvertisementsResponse | null>(null);
  const [index, setIndex] = useState(0);
  const list = useRef<FlatList<Advertisement>>(null);
  const touching = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void readCache<AdvertisementsResponse>('ads').then((cached) => {
      if (cached && !cancelled) setData((current) => current ?? cached);
    });
    api
      .get<AdvertisementsResponse>('/api/v1/advertisements')
      .then((result) => {
        if (cancelled) return;
        setData(result);
        void writeCache('ads', result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const items = data?.items ?? [];
  const ratio = data?.banner.aspectRatio ?? AD_BANNER_ASPECT_RATIO;
  const height = Math.round(width / ratio);
  const current = items[index];
  const interval = (current?.displaySeconds ? current.displaySeconds * 1000 : null) ?? data?.banner.rotationIntervalMs ?? motion.adRotationIntervalMs;

  useEffect(() => {
    if (items.length < 2) return undefined;
    const timer = setTimeout(() => {
      if (touching.current) return;
      const next = (index + 1) % items.length;
      list.current?.scrollToOffset({ offset: next * width, animated: true });
      setIndex(next);
    }, interval);
    return () => clearTimeout(timer);
  }, [index, interval, items.length, width]);

  const onScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      touching.current = false;
      setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
    },
    [width]
  );

  const open = useCallback(
    (ad: Advertisement) => {
      switch (ad.action.type) {
        case 'URL':
          if (ad.action.value) void Linking.openURL(ad.action.value);
          break;
        case 'DESTINATION':
          if (ad.action.destination) onDestination(ad);
          break;
        case 'PROMO_CODE':
          if (ad.action.value) onPromo(ad.action.value);
          break;
        case 'SCREEN': {
          const target = ad.action.value ? AD_SCREENS[ad.action.value] : undefined;
          if (target) router.push(target);
          break;
        }
        default:
          break;
      }
    },
    [onDestination, onPromo]
  );

  if (items.length === 0) return null;

  return (
    <View style={[styles.wrap, { width, height }]}>
      <FlatList
        ref={list}
        data={items}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => {
          touching.current = true;
        }}
        onMomentumScrollEnd={onScrollEnd}
        getItemLayout={(_, itemIndex) => ({ length: width, offset: width * itemIndex, index: itemIndex })}
        renderItem={({ item }) => (
          <Pressable onPress={() => open(item)} accessibilityRole="imagebutton" accessibilityLabel={item.title}>
            <Image
              source={{ uri: (width < 400 ? item.imageUrlSmall : item.imageUrl) ?? item.imageUrl ?? undefined }}
              style={{ width, height }}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          </Pressable>
        )}
      />
      {items.length > 1 ? (
        <View style={styles.dots} pointerEvents="none">
          {items.map((item, itemIndex) => (
            <View key={item.id} style={[styles.dot, itemIndex === index ? styles.dotActive : null]} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: colors.banner,
  },
  dots: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(15, 30, 79, 0.18)',
  },
  dotActive: {
    width: 14,
    backgroundColor: colors.primary,
  },
});
