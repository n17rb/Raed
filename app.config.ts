import type { ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

const config: ExpoConfig = {
  name: IS_DEV ? 'رايد (تطوير)' : 'رايد',
  slug: 'rayed-customer',
  scheme: 'rayed',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  splash: {
    image: './assets/images/splash-logo.png',
    resizeMode: 'contain',
    backgroundColor: '#FCFDFF',
  },
  ios: {
    bundleIdentifier: IS_DEV ? 'com.rayed.customer.dev' : 'com.rayed.customer',
    supportsTablet: false,
    config: {
      googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_KEY,
    },
    infoPlist: {
      NSLocationWhenInUseUsageDescription: 'يستخدم رايد موقعك لتحديد نقطة الانطلاق وإيجاد أقرب كابتن لك.',
      NSMicrophoneUsageDescription: 'يستخدم رايد الميكروفون للاتصال بالكابتن عبر الإنترنت.',
      NSCameraUsageDescription: 'يستخدم رايد الكاميرا لالتقاط صورة حسابك.',
      NSPhotoLibraryUsageDescription: 'يستخدم رايد الصور لاختيار صورة حسابك.',
      UIBackgroundModes: ['audio', 'voip', 'remote-notification'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: IS_DEV ? 'com.rayed.customer.dev' : 'com.rayed.customer',
    adaptiveIcon: {
      foregroundImage: './assets/images/icon.png',
      backgroundColor: '#FFFFFF',
    },
    config: {
      googleMaps: { apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY },
    },
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'RECORD_AUDIO',
      'MODIFY_AUDIO_SETTINGS',
      'POST_NOTIFICATIONS',
      'CAMERA',
    ],
    edgeToEdgeEnabled: true,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-logo.png',
        imageWidth: 180,
        resizeMode: 'contain',
        backgroundColor: '#FCFDFF',
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission: 'يستخدم رايد موقعك لتحديد نقطة الانطلاق وإيجاد أقرب كابتن لك.',
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/images/icon.png',
        color: '#1F7BFB',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'يستخدم رايد الصور لاختيار صورة حسابك.',
        cameraPermission: 'يستخدم رايد الكاميرا لالتقاط صورة حسابك.',
      },
    ],
    [
      '@config-plugins/react-native-webrtc',
      {
        microphonePermission: 'يستخدم رايد الميكروفون للاتصال بالكابتن عبر الإنترنت.',
      },
    ],
  ],
  experiments: {
    typedRoutes: false,
  },
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    captainJoinUrl: process.env.EXPO_PUBLIC_CAPTAIN_JOIN_URL,
    eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID },
  },
};

export default config;
