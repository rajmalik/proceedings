import React from 'react';
import { View, TouchableOpacity, StyleSheet, Platform, Dimensions } from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  withSpring,
  interpolateColor,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { colors, spacing, borderRadius } from '../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TAB_BAR_WIDTH = SCREEN_WIDTH - spacing.md * 2;
const TAB_BAR_HEIGHT = 70;

type TabIconName = 'home' | 'people' | 'newspaper' | 'chatbubbles' | 'person';

const tabIcons: Record<string, { focused: TabIconName; unfocused: `${TabIconName}-outline` }> = {
  Home: { focused: 'home', unfocused: 'home-outline' },
  Find: { focused: 'people', unfocused: 'people-outline' },
  News: { focused: 'newspaper', unfocused: 'newspaper-outline' },
  Discussions: { focused: 'chatbubbles', unfocused: 'chatbubbles-outline' },
  Profile: { focused: 'person', unfocused: 'person-outline' },
};

const tabLabels: Record<string, string> = {
  Home: 'Home',
  Find: 'Groups',
  News: 'News',
  Discussions: 'Discussions',
  Profile: 'Profile',
};

interface TabItemProps {
  route: any;
  index: number;
  state: any;
  descriptors: any;
  navigation: any;
}

function TabItem({ route, index, state, descriptors, navigation }: TabItemProps) {
  const isFocused = state.index === index;
  const icons = tabIcons[route.name];
  const label = tabLabels[route.name];

  const scale = useSharedValue(1);

  const onPress = () => {
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });

    if (!isFocused && !event.defaultPrevented) {
      // Light haptic on tab switch (A4 policy: navigation taps = light).
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      navigation.navigate(route.name);
    }
  };

  const onPressIn = () => {
    scale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
  };

  const onPressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const iconColor = isFocused ? colors.primary : colors.outline;
  const iconName = isFocused ? icons.focused : icons.unfocused;

  return (
    <TouchableOpacity
      key={route.key}
      accessibilityRole="button"
      accessibilityState={isFocused ? { selected: true } : {}}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={styles.tabItem}
      activeOpacity={1}
    >
      <Animated.View style={[styles.tabContent, animatedStyle]}>
        {isFocused && <View style={styles.activeIndicator} />}
        <Ionicons name={iconName} size={22} color={iconColor} />
        <Animated.Text style={[styles.tabLabel, { color: iconColor }]} numberOfLines={1}>
          {label}
        </Animated.Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

export function FloatingTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomPadding = Math.max(insets.bottom, 10);

  return (
    <View style={[styles.container, { bottom: bottomPadding }]}>
      <BlurView
        intensity={80}
        tint="light"
        style={styles.blurContainer}
      >
        <View style={styles.tabBarInner}>
          {state.routes.map((route, index) => (
            <TabItem
              key={route.key}
              route={route}
              index={index}
              state={state}
              descriptors={descriptors}
              navigation={navigation}
            />
          ))}
        </View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    alignItems: 'center',
  },
  blurContainer: {
    width: TAB_BAR_WIDTH,
    height: TAB_BAR_HEIGHT,
    borderRadius: borderRadius.xl + 8, // More rounded
    overflow: 'hidden',
    // Glass effect styling
    backgroundColor: Platform.OS === 'ios'
      ? 'rgba(255, 255, 255, 0.7)'
      : 'rgba(255, 255, 255, 0.95)',
    // Shadow for floating effect (normalized to the shadow-color token)
    shadowColor: colors.shadowTint,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    // Border for glass edge
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.8)',
  },
  tabBarInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: spacing.sm,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
  },
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  activeIndicator: {
    position: 'absolute',
    top: -8,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '500',
    marginTop: 4,
  },
});

export default FloatingTabBar;
