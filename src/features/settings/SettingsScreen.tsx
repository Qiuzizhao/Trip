import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Header, IconButton, Screen } from '@/src/shared/components';
import { colors, radius, shadow, spacing, useThemeColors } from '@/src/shared/theme';

export function SettingsScreen() {
  const themeColors = useThemeColors();

  return (
    <Screen>
      <Header
        title="设置"
        action={<IconButton name="chevron-back" label="返回足迹" transparent onPress={() => router.back()} />}
      />
      <View style={styles.background}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Pressable onPress={() => router.push('/auth' as never)} style={({ pressed }) => [styles.settingRow, pressed && styles.cardPressed]}>
            <View style={styles.settingIconWrap}>
              <Ionicons name="person-circle-outline" size={22} color={themeColors.primary} />
            </View>
            <View style={styles.settingRowText}>
              <Text style={styles.helperTitle}>账号设置</Text>
              <Text style={styles.helperText}>登录、注册、退出账号</Text>
            </View>
            <Ionicons name="chevron-forward" size={19} color={colors.muted} />
          </Pressable>
          <View style={styles.bottomSpacer} />
        </ScrollView>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
  },
  settingRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 72,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...shadow,
  },
  cardPressed: {
    opacity: 0.72,
    transform: [{ scale: 0.99 }],
  },
  settingIconWrap: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.lg,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  settingRowText: {
    flex: 1,
    gap: 2,
  },
  helperTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  helperText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  bottomSpacer: {
    height: spacing.xxl,
  },
});
