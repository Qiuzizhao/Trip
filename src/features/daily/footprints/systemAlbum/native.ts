import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type AlbumPermission = 'authorized' | 'limited' | 'undetermined' | 'restricted' | 'denied';
export const photoAlbumNative = Platform.OS === 'ios' ? requireOptionalNativeModule<{
  permission(request: boolean): Promise<AlbumPermission>;
  snapshot(): Promise<string[]>;
  hashFile(uri: string): Promise<string>;
  save(uri: string, hash: string): Promise<boolean>;
}>('TripPhotoAlbum') : null;
