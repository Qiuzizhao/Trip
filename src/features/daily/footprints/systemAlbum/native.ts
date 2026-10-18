import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type DuplicatePreview = {
  token: string;
  scanned: number;
  skipped: number;
  removeCount: number;
  groups: { id: string; copies: number; keepCount: number; removeCount: number; thumbnailUri?: string }[];
};
export type AlbumPermission = 'authorized' | 'limited' | 'undetermined' | 'restricted' | 'denied';
export const photoAlbumNative = Platform.OS === 'ios' ? requireOptionalNativeModule<{
  findDuplicates?(): Promise<DuplicatePreview>;
  deleteDuplicates?(token: string): Promise<number>;
  cancelDuplicateScan?(): void;
  addListener?(event: 'duplicateScanProgress', listener: (progress: { scanned: number; total: number }) => void): { remove(): void };
  permission(request: boolean): Promise<AlbumPermission>;
  rememberSavedHashes?(hashes: string[]): Promise<void>;
  reconcileAlbum?(): Promise<string[]>;
  snapshot(): Promise<string[]>;
  hashFile(uri: string): Promise<string>;
  save(uri: string, hash: string, location: string): Promise<boolean>;
}>('TripPhotoAlbum') : null;
