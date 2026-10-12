import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { buildAssetUrl } from '@/src/shared/api';
import { postcardColors } from '../_shared/styles';
import { FootprintThumbnail } from './FootprintThumbnail';

export function FootprintCoverPicker({
  visible, images, onSelect, onClose,
}: {
  visible: boolean;
  images: string[];
  onSelect: (uri: string) => void;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(width - 32, 560);
  const photoSize = (cardWidth - 40 - 20) / 3;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="关闭首图选择" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={[styles.card, { width: cardWidth }]}>
          <Text accessibilityRole="header" style={styles.title}>设置首图</Text>
          <Text style={styles.hint}>选择一张照片作为足迹封面</Text>
          <FlatList
            data={images}
            numColumns={3}
            keyExtractor={(uri) => uri}
            style={{ flexGrow: 0 }}
            columnWrapperStyle={{ gap: 10 }}
            renderItem={({ item: uri, index }) => (
              <Pressable
                accessibilityLabel={`第 ${index + 1} 张照片${index === 0 ? '，当前首图' : '，设为首图'}`}
                accessibilityRole="button"
                accessibilityState={{ selected: index === 0 }}
                onPress={() => onSelect(uri)}
                style={[styles.photo, { width: photoSize, height: photoSize }, index === 0 && styles.selected]}
              >
                <FootprintThumbnail uri={buildAssetUrl(uri) || uri} style={{ width: '100%', height: '100%' }} />
                {index === 0 ? (
                  <View pointerEvents="none" style={styles.badge}>
                    <Ionicons name="checkmark" size={13} color="#fff" />
                    <Text style={styles.badgeText}>首图</Text>
                  </View>
                ) : null}
              </Pressable>
            )}
          />
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.cancel}>
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,23,42,0.45)' },
  card: { maxHeight: '80%', padding: 20, borderRadius: 24, backgroundColor: '#FFFCF6' },
  title: { fontSize: 20, fontWeight: '800', color: postcardColors.ink },
  hint: { fontSize: 13, color: postcardColors.inkFaint, marginTop: 6, marginBottom: 18 },
  photo: { borderRadius: 12, overflow: 'hidden', marginBottom: 10, borderWidth: 2, borderColor: 'transparent' },
  selected: { borderColor: postcardColors.sun },
  badge: { position: 'absolute', bottom: 4, left: 4, flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: '#9A6A15' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  cancel: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelText: { fontSize: 15, fontWeight: '700', color: postcardColors.inkSoft },
});
