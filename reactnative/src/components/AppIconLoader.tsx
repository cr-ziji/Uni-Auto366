/**
 * The loading indicator of the native shell.
 *
 * It replaces the generic spinner that used to spin on a black background:
 * the application icon itself is the animation element, so the first thing
 * the user sees is the product rather than an anonymous "loading" widget.
 *
 * The animation is a slow breathing pulse (scale + opacity). It runs on the
 * native driver, therefore it keeps animating smoothly while the JavaScript
 * thread is busy booting the ported main process - which is exactly the
 * situation this screen exists for.
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet} from 'react-native';

/** The application icon (the same artwork the launcher uses). */
const APP_ICON = require('../../app_icon.png');

const PULSE_DURATION_MS = 1100;

export interface AppIconLoaderProps {
  /** Edge length of the icon in dp. */
  size?: number;
  /** Accessibility label (defaults to the product name). */
  label?: string;
}

export function AppIconLoader({
  size = 88,
  label = 'Auto366',
}: AppIconLoaderProps): React.JSX.Element {
  // 0 = "relaxed", 1 = "expanded"; the value is interpolated below.
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: PULSE_DURATION_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: PULSE_DURATION_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [pulse]);

  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1.06],
  });
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.7, 1],
  });

  return (
    <Animated.Image
      source={APP_ICON}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      resizeMode="contain"
      style={[
        styles.icon,
        {width: size, height: size, opacity, transform: [{scale}]},
      ]}
    />
  );
}

const styles = StyleSheet.create({
  icon: {
    // The artwork itself carries the shape - no extra background, otherwise
    // the icon would look like a sticker on a card.
    backgroundColor: 'transparent',
  },
});

export default AppIconLoader;
