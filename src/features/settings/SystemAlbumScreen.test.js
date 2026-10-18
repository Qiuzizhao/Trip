import React from 'react';
import { Switch } from 'react-native';
import { act, create } from 'react-test-renderer';
import { router } from 'expo-router';
import { getSystemAlbumState, restoreSystemAlbum } from '@/src/features/daily/footprints/systemAlbum/sync';
import { SettingsScreen } from './SettingsScreen';
import { SystemAlbumScreen } from './SystemAlbumScreen';

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }));
jest.mock('@/src/features/daily/footprints/systemAlbum/native', () => ({ photoAlbumNative: { reconcileAlbum: jest.fn() } }));
jest.mock('@/src/features/daily/footprints/systemAlbum/sync', () => ({
  getSystemAlbumState: jest.fn(), subscribeSystemAlbum: jest.fn(() => jest.fn()), restoreSystemAlbum: jest.fn(),
}));
jest.mock('@/src/local/repositories/appSettingsRepository', () => ({
  defaultAppSettings: { localOnlyMode: false }, getAppSettings: jest.fn(async () => ({ localOnlyMode: false })),
  subscribeAppSettings: jest.fn(() => jest.fn()), updateAppSettings: jest.fn(),
}));
jest.mock('@/src/shared/components', () => {
  const React = require('react');
  const { View, Pressable, Text } = require('react-native');
  return {
    Screen: ({ children }) => React.createElement(View, null, children), Header: () => null, IconButton: () => null,
    PrimaryButton: ({ label, disabled, onPress }) => React.createElement(Pressable,
      { testID: label, disabled, onPress: disabled ? undefined : onPress }, React.createElement(Text, null, label)),
  };
});
let tree;
beforeEach(() => {
  jest.clearAllMocks();
  getSystemAlbumState.mockReturnValue({ phase: 'idle', completed: 0, total: 0, failed: 0 });
  restoreSystemAlbum.mockResolvedValue(undefined);
});
afterEach(async () => { if (tree) await act(async () => { tree.unmount(); }); tree = undefined; });

test('opening first-level Settings only navigates to the album page, without restoring', async () => {
  await act(async () => { tree = create(<SettingsScreen />); });
  expect(restoreSystemAlbum).not.toHaveBeenCalled();
  await act(async () => { tree.root.findByProps({ accessibilityLabel: 'Trip 系统相簿设置' }).props.onPress(); });
  expect(router.push).toHaveBeenCalledWith('/settings/system-album');
  expect(restoreSystemAlbum).not.toHaveBeenCalled();
});

test('opening second-level Settings does nothing; manual restore defaults to album scope', async () => {
  await act(async () => { tree = create(<SystemAlbumScreen />); });
  expect(tree.root.findByType(Switch).props.value).toBe(false);
  expect(restoreSystemAlbum).not.toHaveBeenCalled();
  await act(async () => { tree.root.findByProps({ testID: '开始核对并恢复' }).props.onPress(); });
  expect(restoreSystemAlbum).toHaveBeenCalledWith(false);
});

test('enabling full-library search only changes the option; it still requires the Start button', async () => {
  await act(async () => { tree = create(<SystemAlbumScreen />); });
  await act(async () => { tree.root.findByType(Switch).props.onValueChange(true); });
  expect(restoreSystemAlbum).not.toHaveBeenCalled();
  await act(async () => { tree.root.findByProps({ testID: '开始核对并恢复' }).props.onPress(); });
  expect(restoreSystemAlbum).toHaveBeenCalledWith(true);
  await act(async () => { tree.unmount(); tree = create(<SystemAlbumScreen />); });
  expect(tree.root.findByType(Switch).props.value).toBe(false);
});
