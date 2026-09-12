import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Alert, Text, View } from 'react-native';

import { Header, IconButton, Screen } from '@/src/shared/components';
import { colors } from '@/src/shared/theme';
import { styles } from './styles';

export type Item = Record<string, any> & { id: string };

export const today = () => new Date().toISOString().slice(0, 10);

export function ScreenShell({
  title,
  subtitle,
  onBack,
  rightAction,
  onSettings,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  rightAction?: React.ReactNode;
  onSettings?: () => void;
  children: React.ReactNode;
}) {
  const action = onBack
    ? <IconButton name="chevron-back" label="返回" transparent onPress={onBack} />
    : onSettings
      ? <IconButton name="settings-outline" label="设置" transparent onPress={onSettings} />
      : undefined;

  return (
    <Screen>
      <Header
        title={title}
        subtitle={subtitle}
        action={action}
        rightAction={rightAction}
      />
      {children}
    </Screen>
  );
}

export function SectionCard({ children, style }: { children: React.ReactNode; style?: any }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Tag({
  label,
  icon,
  tone = 'gray',
  color,
  backgroundColor,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: 'gray' | 'blue' | 'green' | 'red' | 'purple' | 'orange';
  color?: string;
  backgroundColor?: string;
}) {
  const toneStyle = styles[`tag_${tone}`];
  const textColor = color || toneStyle.color;
  return (
    <View style={[styles.tag, toneStyle, backgroundColor ? { backgroundColor } : null, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
      {icon ? <Ionicons name={icon} size={12} color={textColor} /> : null}
      <Text style={{ color: textColor, fontSize: 13, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function confirmRemove(label: string, onConfirm: () => void) {
  Alert.alert('删除确认', `确定删除「${label}」吗？`, [
    { text: '取消', style: 'cancel' },
    { text: '删除', style: 'destructive', onPress: onConfirm },
  ]);
}

export function SelectPills({
  value,
  options,
  onChange,
  accent = colors.primary,
}: {
  value: string;
  options: ({ label: string; value: string } | string)[];
  onChange: (value: string) => void;
  accent?: string;
}) {
  return (
    <View style={styles.pills}>
      {options.map((opt) => {
        const optValue = typeof opt === 'string' ? opt : opt.value;
        const optLabel = typeof opt === 'string' ? opt : opt.label;
        const selected = optValue === value;
        return (
          <View key={optValue} style={[styles.pill, selected && { backgroundColor: `${accent}22`, borderColor: accent }]}>
            <Text onPress={() => onChange(optValue)} style={[styles.pillText, selected && { color: accent }]}>
              {optLabel}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
