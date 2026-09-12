import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import React, { PropsWithChildren, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  TextInputProps,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, shadow, spacing, useThemeColors } from '@/src/shared/theme';

const componentStyles = {
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    alignItems: 'center' as const,
    backgroundColor: colors.brandSoft,
    flexDirection: 'row' as const,
    height: 44,
    paddingHorizontal: spacing.lg,
    zIndex: 10,
  },
  headerSide: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    width: 44,
  },
  headerText: {
    alignItems: 'center' as const,
    flex: 1,
    justifyContent: 'center' as const,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700' as const,
    textAlign: 'center' as const,
  },
  iconButton: {
    alignItems: 'center' as const,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.xl,
    height: 44,
    justifyContent: 'center' as const,
    width: 44,
  },
  iconButtonTransparent: {
    backgroundColor: 'transparent',
    elevation: 0,
    shadowOpacity: 0,
  },
  button: {
    alignItems: 'center' as const,
    backgroundColor: colors.primary,
    borderRadius: radius.xl,
    flexDirection: 'row' as const,
    gap: spacing.sm,
    justifyContent: 'center' as const,
    minHeight: 50,
    paddingHorizontal: spacing.xl,
  },
  buttonDanger: {
    backgroundColor: colors.danger,
  },
  buttonPlain: {
    backgroundColor: colors.primarySoft,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonContent: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    gap: spacing.sm,
    justifyContent: 'center' as const,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700' as const,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.98 }],
  },
  field: {
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  fieldLabel: {
    color: colors.textSoft,
    fontSize: 13,
    fontWeight: '700' as const,
    marginBottom: 6,
    marginLeft: 4,
  },
  input: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg,
    color: colors.text,
    fontSize: 16,
    minHeight: 54,
    paddingHorizontal: spacing.lg,
  },
  inputMultiline: {
    minHeight: 120,
    paddingTop: spacing.lg,
    textAlignVertical: 'top' as const,
  },
};

export function Screen({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();
  return (
    <View style={componentStyles.screen}>
      <StatusBar style="dark" backgroundColor={colors.brandSoft} translucent />
      <View style={{ height: insets.top, backgroundColor: colors.brandSoft }} />
      {children}
    </View>
  );
}

export function Header({
  title,
  action,
  rightAction,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  rightAction?: React.ReactNode;
  centered?: boolean;
}) {
  return (
    <View style={componentStyles.header}>
      <View style={componentStyles.headerSide}>{action}</View>
      <View style={componentStyles.headerText}>
        <Text style={componentStyles.title} numberOfLines={1}>{title}</Text>
      </View>
      <View style={componentStyles.headerSide}>{rightAction}</View>
    </View>
  );
}

export function IconButton({
  name,
  onPress,
  color,
  label,
  transparent,
}: {
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  color?: string;
  label?: string;
  soft?: boolean;
  transparent?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        componentStyles.iconButton,
        transparent && componentStyles.iconButtonTransparent,
        pressed && componentStyles.pressed,
      ]}
    >
      <Ionicons name={name} size={21} color={color || colors.text} />
    </Pressable>
  );
}

export function PrimaryButton({
  label,
  onPress,
  icon,
  disabled,
  tone = 'primary',
  style,
  textStyle,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  tone?: 'primary' | 'danger' | 'plain';
  style?: object | object[];
  textStyle?: object | object[];
}) {
  const themeColors = useThemeColors();
  const plain = tone === 'plain';
  const iconColor = plain ? themeColors.primary : '#fff';

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        componentStyles.button,
        { backgroundColor: themeColors.primary },
        tone === 'danger' && componentStyles.buttonDanger,
        plain && [componentStyles.buttonPlain, { backgroundColor: themeColors.primarySoft }],
        disabled && componentStyles.buttonDisabled,
        pressed && !disabled && componentStyles.pressed,
        style,
      ]}
    >
      <View style={componentStyles.buttonContent}>
        {icon ? <Ionicons name={icon} size={18} color={iconColor} /> : null}
        <Text style={[componentStyles.buttonText, plain && { color: themeColors.primary }, textStyle]}>{label}</Text>
      </View>
    </Pressable>
  );
}

export function SheetTextInput({ value, onChangeText, onBlur, sheet: _sheet, ...props }: TextInputProps & { sheet?: boolean }) {
  const [localValue, setLocalValue] = useState(value == null ? '' : String(value));
  const localValueRef = useRef(localValue);
  const composingRef = useRef(false);

  useEffect(() => {
    if (composingRef.current) return;
    const nextValue = value == null ? '' : String(value);
    localValueRef.current = nextValue;
    setLocalValue(nextValue);
  }, [value]);

  const syncText = (text: string) => {
    localValueRef.current = text;
    setLocalValue(text);
  };

  const inputProps: TextInputProps & Record<string, unknown> = {
    ...props,
    value: localValue,
    onChangeText: (text: string) => {
      if (Platform.OS === 'web' && composingRef.current) {
        syncText(text);
        return;
      }
      syncText(text);
      onChangeText?.(text);
    },
    onBlur: (event) => {
      composingRef.current = false;
      onChangeText?.(localValueRef.current);
      onBlur?.(event);
    },
  };

  if (Platform.OS === 'web') {
    inputProps.onCompositionStart = () => {
      composingRef.current = true;
    };
    inputProps.onCompositionEnd = (event: any) => {
      composingRef.current = false;
      const text = String(event?.currentTarget?.value ?? event?.target?.value ?? localValueRef.current);
      syncText(text);
      onChangeText?.(text);
    };
  }

  return <TextInput {...inputProps} />;
}

export function Field({ label, sheet = true, ...props }: TextInputProps & { label: string; sheet?: boolean }) {
  return (
    <View style={componentStyles.field}>
      <Text style={componentStyles.fieldLabel}>{label}</Text>
      <SheetTextInput
        placeholderTextColor={colors.faint}
        style={[componentStyles.input, props.multiline && componentStyles.inputMultiline]}
        sheet={sheet}
        scrollEnabled={props.multiline ? false : props.scrollEnabled}
        {...props}
      />
    </View>
  );
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function dateString(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDate(value?: string) {
  if (!value) return new Date();
  const parts = value.split('-').map(Number);
  if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) return new Date(parts[0], parts[1] - 1, parts[2]);
  return new Date();
}

function buildCalendarDays(viewDate: Date) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const cells: { date: Date; currentMonth: boolean }[] = [];

  for (let i = firstWeekday - 1; i >= 0; i -= 1) {
    cells.push({ date: new Date(year, month - 1, prevDays - i), currentMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ date: new Date(year, month, day), currentMonth: true });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    cells.push({ date: new Date(year, month + 1, cells.length - firstWeekday - daysInMonth + 1), currentMonth: false });
  }
  return cells;
}

export function DateField({
  label,
  value,
  onChangeText,
}: {
  label?: string;
  value?: string;
  onChangeText: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => parseDate(value));
  const days = useMemo(() => buildCalendarDays(viewDate), [viewDate]);

  const chooseDate = (date: Date) => {
    onChangeText(dateString(date));
    setOpen(false);
  };

  return (
    <View style={componentStyles.field}>
      {label ? <Text style={componentStyles.fieldLabel}>{label}</Text> : null}
      <Pressable
        onPress={() => {
          setViewDate(parseDate(value));
          setOpen(true);
        }}
        style={({ pressed }) => [
          componentStyles.input,
          { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
          pressed && componentStyles.pressed,
        ]}
      >
        <Text style={{ color: value ? colors.text : colors.faint, fontSize: 16, fontWeight: '700' }}>
          {value || '选择日期'}
        </Text>
        <Ionicons name="calendar-outline" size={20} color={colors.primary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.24)', flex: 1, justifyContent: 'center', padding: spacing.lg }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={{ backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.xxl, borderWidth: 1, padding: spacing.lg, width: '100%', maxWidth: 360, ...shadow }}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.md }}>
              <IconButton name="chevron-back" label="上个月" onPress={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))} transparent />
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>
                {viewDate.getFullYear()}年{viewDate.getMonth() + 1}月
              </Text>
              <IconButton name="chevron-forward" label="下个月" onPress={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))} transparent />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
              {days.map(({ date, currentMonth }) => {
                const selected = dateString(date) === value;
                return (
                  <Pressable
                    key={date.toISOString()}
                    onPress={() => chooseDate(date)}
                    style={{
                      alignItems: 'center',
                      backgroundColor: selected ? colors.primary : colors.surfaceMuted,
                      borderRadius: radius.md,
                      height: 40,
                      justifyContent: 'center',
                      opacity: currentMonth ? 1 : 0.35,
                      width: '13.1%',
                    }}
                  >
                    <Text style={{ color: selected ? '#fff' : colors.textSoft, fontSize: 14, fontWeight: '700' }}>
                      {date.getDate()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

export function StateView({
  loading,
  error,
  onRetry,
}: {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <View style={{ alignItems: 'center', gap: spacing.sm, padding: spacing.lg }}>
        <ActivityIndicator color={colors.primary} />
        <Text style={{ color: colors.muted, fontSize: 14 }}>加载中...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ backgroundColor: colors.dangerSoft, borderRadius: radius.lg, gap: spacing.sm, padding: spacing.lg }}>
        <Text style={{ color: colors.danger, fontSize: 14, fontWeight: '700' }}>{error}</Text>
        {onRetry ? <PrimaryButton label="重试" tone="plain" onPress={onRetry} /> : null}
      </View>
    );
  }

  return null;
}
