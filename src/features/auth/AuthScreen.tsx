import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Header, PrimaryButton, Screen, SheetTextInput } from '@/src/shared/components';
import { clearAccountLocalData } from '@/src/local/localDataRepository';
import { colors, radius, spacing } from '@/src/shared/theme';
import {
  getCurrentSession,
  isSupabaseConfigured,
  signInWithEmailPassword,
  signOut,
  signUpWithEmailPassword,
} from '@/src/sync/supabaseClient';

type Mode = 'signIn' | 'signUp';
const headerVisualOffset = 22;

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    void getCurrentSession()
      .then((session) => setUserEmail(session?.user.email ?? null))
      .catch(() => setUserEmail(null));
  }, []);

  const submit = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password || loading) return;
    setLoading(true);
    try {
      const result = mode === 'signIn'
        ? await signInWithEmailPassword(trimmedEmail, password)
        : await signUpWithEmailPassword(trimmedEmail, password);
      setUserEmail(result.user?.email ?? trimmedEmail);
      Alert.alert(mode === 'signIn' ? '登录成功' : '注册成功', '现在可以回到足迹页手动同步。', [
        { text: '好的', onPress: () => router.replace('/') },
      ]);
    } catch (err) {
      Alert.alert(mode === 'signIn' ? '登录失败' : '注册失败', err instanceof Error ? err.message : '请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    try {
      await signOut();
      await clearAccountLocalData();
      setUserEmail(null);
      Alert.alert('已退出登录', '本机上的账号足迹已清空。', [
        { text: '好的', onPress: () => router.replace('/') },
      ]);
    } catch (err) {
      Alert.alert('退出失败', err instanceof Error ? err.message : '请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Header
        title="账号"
        action={(
          <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={() => router.back()} style={styles.headerButton}>
            <Ionicons name="chevron-back" size={23} color={colors.text} />
          </Pressable>
        )}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <View style={styles.content}>
          {!isSupabaseConfigured() ? (
            <View style={styles.card}>
              <Text style={styles.title}>还没有配置同步服务</Text>
              <Text selectable style={styles.body}>
                请先设置 EXPO_PUBLIC_SUPABASE_URL 和 EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY，然后重启 Expo。
              </Text>
            </View>
          ) : userEmail ? (
            <View style={styles.card}>
              <Text style={styles.title}>已登录</Text>
              <Text selectable style={styles.body}>{userEmail}</Text>
              <PrimaryButton label="退出登录" icon="log-out-outline" tone="plain" disabled={loading} onPress={logout} />
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.modeRow}>
                <Pressable onPress={() => setMode('signIn')} style={[styles.modeButton, mode === 'signIn' && styles.modeButtonActive]}>
                  <Text style={[styles.modeText, mode === 'signIn' && styles.modeTextActive]}>登录</Text>
                </Pressable>
                <Pressable onPress={() => setMode('signUp')} style={[styles.modeButton, mode === 'signUp' && styles.modeButtonActive]}>
                  <Text style={[styles.modeText, mode === 'signUp' && styles.modeTextActive]}>注册</Text>
                </Pressable>
              </View>
              <SheetTextInput
                autoCapitalize="none"
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="邮箱"
                placeholderTextColor={colors.faint}
                sheet={false}
                style={styles.input}
                value={email}
              />
              <SheetTextInput
                onChangeText={setPassword}
                placeholder="密码"
                placeholderTextColor={colors.faint}
                secureTextEntry
                sheet={false}
                style={styles.input}
                value={password}
              />
              <PrimaryButton
                label={mode === 'signIn' ? '登录' : '注册'}
                icon={mode === 'signIn' ? 'log-in-outline' : 'person-add-outline'}
                disabled={loading || !email.trim() || password.length < 6}
                onPress={submit}
              />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  headerButton: {
    alignItems: 'center',
    borderRadius: radius.full,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  content: {
    alignSelf: 'center',
    flex: 1,
    justifyContent: 'center',
    maxWidth: 430,
    padding: spacing.lg,
    transform: [{ translateY: -headerVisualOffset }],
    width: '100%',
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
  },
  body: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  modeRow: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.full,
    flexDirection: 'row',
    padding: 4,
  },
  modeButton: {
    alignItems: 'center',
    borderRadius: radius.full,
    flex: 1,
    justifyContent: 'center',
    minHeight: 40,
  },
  modeButtonActive: {
    backgroundColor: colors.surface,
  },
  modeText: {
    color: colors.muted,
    fontSize: 15,
    fontWeight: '700',
  },
  modeTextActive: {
    color: colors.text,
  },
  input: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg,
    color: colors.text,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
});
