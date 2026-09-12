import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage, type ImageStyle } from 'expo-image';
import React from 'react';
import { Modal, Pressable, StyleSheet, View, type StyleProp } from 'react-native';

import { spacing } from '@/src/shared/theme';

type FootprintImagePreviewModalProps = {
  action?: React.ReactNode;
  contentFit?: 'contain' | 'cover';
  imageStyle?: StyleProp<ImageStyle>;
  onClose: () => void;
  uri: string | null;
};

export function FootprintImagePreviewModal({
  action,
  contentFit = 'contain',
  imageStyle,
  onClose,
  uri,
}: FootprintImagePreviewModalProps) {
  return (
    <Modal
      animationType="fade"
      transparent
      visible={Boolean(uri)}
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable accessibilityLabel="关闭图片预览" accessibilityRole="button" style={styles.closeButton} onPress={onClose}>
          <Ionicons name="close" size={26} color="#fff" />
        </Pressable>
        {uri ? (
          <ExpoImage
            cachePolicy="memory-disk"
            contentFit={contentFit}
            priority="high"
            source={{ uri }}
            style={[styles.image, imageStyle]}
            transition={0}
          />
        ) : null}
        {action ? <View pointerEvents="box-none" style={styles.actionWrap}>{action}</View> : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actionWrap: {
    bottom: spacing.xl,
    left: spacing.lg,
    position: 'absolute',
    right: spacing.lg,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    position: 'absolute',
    right: spacing.lg,
    top: spacing.xl,
    width: 36,
    zIndex: 2,
  },
  image: {
    height: '100%',
    width: '100%',
  },
  overlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    flex: 1,
    justifyContent: 'center',
    padding: 0,
  },
});
