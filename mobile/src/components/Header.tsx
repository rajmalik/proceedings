import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography } from '../constants/theme';

interface HeaderProps {
  title?: string;
  showLogo?: boolean;
  showBack?: boolean;
  showSearch?: boolean;
  showProfile?: boolean;
  transparent?: boolean;
  onBack?: () => void;
  onSearch?: () => void;
  onProfile?: () => void;
  rightAction?: React.ReactNode;
}

export function Header({
  title,
  showLogo = true,
  showBack = false,
  showSearch = false,
  showProfile = false,
  transparent = false,
  onBack,
  onSearch,
  onProfile,
  rightAction,
}: HeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[
      styles.container,
      { paddingTop: insets.top },
      transparent && styles.transparentContainer,
    ]}>
      <StatusBar barStyle="dark-content" backgroundColor={transparent ? 'transparent' : colors.surface} />
      <View style={styles.content}>
        <View style={styles.left}>
          {showBack && (
            <TouchableOpacity onPress={onBack} style={styles.iconButton}>
              <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
            </TouchableOpacity>
          )}
<Text style={styles.title}>
            {showLogo ? 'Meridian' : title}
          </Text>
        </View>

        <View style={styles.right}>
          {showSearch && (
            <TouchableOpacity onPress={onSearch} style={styles.iconButton}>
              <Ionicons name="search" size={22} color={colors.onSurface} />
            </TouchableOpacity>
          )}
          {showProfile && (
            <TouchableOpacity onPress={onProfile} style={styles.profileButton}>
              <Ionicons name="person-circle" size={28} color={colors.primary} />
            </TouchableOpacity>
          )}
          {rightAction}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.marginMobile,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  transparentContainer: {
    backgroundColor: 'transparent',
    borderBottomWidth: 0,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    // Brand serif (weight encoded in the family; Georgia/serif were unloaded → system fallback).
    fontFamily: 'Lora_600SemiBold',
    fontSize: 20,
    color: colors.onSurface,
  },
  iconButton: {
    padding: 8,
    marginLeft: -8,
  },
  profileButton: {
    marginLeft: 8,
  },
});

export default Header;
