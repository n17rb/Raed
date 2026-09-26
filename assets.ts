import type { ImageSourcePropType } from 'react-native';

const ECONOMIC = require('../../assets/images/car-economic.webp') as ImageSourcePropType;
const COMFORT = require('../../assets/images/car-comfort.webp') as ImageSourcePropType;

/**
 * Category images come from the dashboard. These bundled reference images are
 * only used while a category has no uploaded image (or while offline).
 */
export function categoryImage(code: string | null | undefined, url: string | null | undefined): ImageSourcePropType | null {
  if (url) return { uri: url };
  if (code === 'ECONOMIC') return ECONOMIC;
  if (code === 'COMFORT') return COMFORT;
  return null;
}

/** Plain white car shown on the captain card until the admin uploads the captain's own car photo. */
export function fallbackCarImage(): ImageSourcePropType {
  return COMFORT;
}
