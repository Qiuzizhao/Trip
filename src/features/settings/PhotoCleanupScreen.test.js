import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { photoAlbumNative as native } from '@/src/features/daily/footprints/systemAlbum/native';
import { PhotoCleanupScreen } from './PhotoCleanupScreen';

jest.mock('@/src/features/daily/footprints/systemAlbum/native', () => ({ photoAlbumNative: {
  permission: jest.fn(), findDuplicates: jest.fn(), deleteDuplicates: jest.fn(),
  addListener: jest.fn(), cancelDuplicateScan: jest.fn(),
} }));
jest.mock('@/src/features/daily/footprints/systemAlbum/sync', () => ({ pauseSystemAlbumSync: jest.fn(() => jest.fn()) }));
jest.mock('expo-router', () => ({ router: { back: jest.fn() } }));
jest.mock('@/src/shared/components', () => {
  const React = require('react');
  const { View, Pressable, Text } = require('react-native');
  return {
    Screen: ({ children }) => React.createElement(View, null, children),
    Header: () => null, IconButton: () => null,
    PrimaryButton: ({ label, disabled, onPress }) => React.createElement(Pressable,
      { testID: label, disabled, onPress: disabled ? undefined : onPress }, React.createElement(Text, null, label)),
  };
});
const preview = {
  token: 'native-reviewed-plan', scanned: 3, skipped: 0, removeCount: 2,
  groups: [{ id: 'same-heif', copies: 3, keepCount: 1, removeCount: 2 }],
};
let tree;
beforeEach(() => {
  jest.clearAllMocks();
  native.permission.mockResolvedValue('authorized');
  native.findDuplicates.mockResolvedValue(preview);
  native.deleteDuplicates.mockResolvedValue(2);
  native.addListener.mockReturnValue({ remove: jest.fn() });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(async () => { if (tree) await act(async () => { tree.unmount(); }); tree = undefined; });
async function openAndScan() {
  await act(async () => { tree = create(<PhotoCleanupScreen />); });
  expect(native.findDuplicates).not.toHaveBeenCalled();
  expect(native.deleteDuplicates).not.toHaveBeenCalled();
  await act(async () => { tree.root.findByProps({ testID: '扫描 Trip 重复照片' }).props.onPress(); });
}

test('opening and scanning is read-only; cancelling confirmation deletes nothing', async () => {
  await openAndScan();
  expect(native.findDuplicates).toHaveBeenCalledTimes(1);
  expect(native.deleteDuplicates).not.toHaveBeenCalled();
  await act(async () => { tree.root.findByProps({ testID: '确认清理 2 张副本' }).props.onPress(); });
  const actions = Alert.alert.mock.calls.at(-1)[2];
  expect(actions.some((a) => a.text === '取消' && a.style === 'cancel')).toBe(true);
  expect(native.deleteDuplicates).not.toHaveBeenCalled();
});

test('only explicit confirmation can submit the opaque native deletion plan', async () => {
  await openAndScan();
  await act(async () => { tree.root.findByProps({ testID: '确认清理 2 张副本' }).props.onPress(); });
  expect(native.deleteDuplicates).not.toHaveBeenCalled();
  const continueAction = Alert.alert.mock.calls.at(-1)[2].find((a) => a.text === '继续');
  await act(async () => { continueAction.onPress(); });
  expect(native.deleteDuplicates).toHaveBeenCalledTimes(1);
  expect(native.deleteDuplicates).toHaveBeenCalledWith('native-reviewed-plan');
});
