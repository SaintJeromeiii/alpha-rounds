import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView, TouchableOpacity, StatusBar, Modal, TextInput, Alert, Linking, Platform, AppState } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CYCLE_DURATION_SECONDS = 300;
const NOTIFICATION_CHANNEL_ID = 'round-complete';
const MAX_ACTIVITY_LOGS = 100;

const STORAGE_KEYS = {
  testApps: '@alpha-rounds/testApps',
  activityLogs: '@alpha-rounds/activityLogs',
  cycleState: '@alpha-rounds/cycleState',
};

const DEFAULT_TEST_APPS = [
  { id: '1', name: 'ServiceLog Tracker', developer: 'DevJerome', dayStreak: 5, status: 'pending', packageName: 'com.google.android.apps.docs' },
  { id: '2', name: 'FitTrack Pro', developer: 'AlexM', dayStreak: 12, status: 'completed', packageName: 'com.google.android.apps.fitness' },
  { id: '3', name: 'BudgetBuddy', developer: 'SarahK', dayStreak: 2, status: 'pending', packageName: 'com.google.android.apps.walletnfcrel' },
  { id: '4', name: 'CryptoPulse Overlay', developer: 'CryptoDev', dayStreak: 14, status: 'completed', packageName: 'com.google.android.youtube' },
  { id: '5', name: 'RecipeScaler', developer: 'ChefApps', dayStreak: 8, status: 'pending', packageName: 'com.google.android.apps.maps' },
];

let scheduledRoundNotificationId = null;

const cancelRoundEndNotification = async () => {
  if (!scheduledRoundNotificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(scheduledRoundNotificationId);
  } catch {
    // Notification may already have fired or been cleared.
  }
  scheduledRoundNotificationId = null;
};

const scheduleRoundEndNotification = async (endsAt, appName) => {
  await cancelRoundEndNotification();
  const seconds = Math.max(1, Math.ceil((endsAt - Date.now()) / 1000));

  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    scheduledRoundNotificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Round Complete!',
        body: `${appName} finished. Moving to the next app.`,
        ...(Platform.OS === 'android' && { channelId: NOTIFICATION_CHANNEL_ID }),
      },
      trigger: { seconds },
    });
  } catch {
    // Scheduling may fail if permissions were revoked.
  }
};

const triggerCompletionAlert = async (appName) => {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // Haptics may be unavailable on some devices or simulators.
  }

  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Round Complete!',
        body: `${appName} finished. Moving to the next app.`,
        ...(Platform.OS === 'android' && { channelId: NOTIFICATION_CHANNEL_ID }),
      },
      trigger: null,
    });
  } catch {
    // Notification scheduling may fail if permissions were denied.
  }
};

const formatTimer = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const formatLogTime = (isoTimestamp) => {
  const date = new Date(isoTimestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getRemainingSeconds = (endsAt) => {
  if (!endsAt) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
};

export default function App() {
  const [isHydrated, setIsHydrated] = useState(false);
  const [testApps, setTestApps] = useState(DEFAULT_TEST_APPS);
  const [activityLogs, setActivityLogs] = useState([]);
  const [appState, setAppState] = useState(AppState.currentState);

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [newAppName, setNewAppName] = useState('');
  const [newDevName, setNewDevName] = useState('');
  const [newPackageName, setNewPackageName] = useState('');

  const [currentActiveApp, setCurrentActiveApp] = useState(null);
  const [isCycleActive, setIsCycleActive] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(CYCLE_DURATION_SECONDS);
  const [timerEndsAt, setTimerEndsAt] = useState(null);
  const [isTimerPaused, setIsTimerPaused] = useState(false);

  const testAppsRef = useRef(testApps);
  const currentActiveAppRef = useRef(currentActiveApp);
  const timerEndsAtRef = useRef(timerEndsAt);
  const isAdvancingRef = useRef(false);
  const pausedRemainingRef = useRef(CYCLE_DURATION_SECONDS);

  const appendActivityLog = useCallback((type, message, appName = null) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      type,
      message,
      appName,
    };
    setActivityLogs((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY_LOGS));
  }, []);

  const beginTimer = useCallback((durationSeconds, appName) => {
    const endsAt = Date.now() + durationSeconds * 1000;
    timerEndsAtRef.current = endsAt;
    setTimerEndsAt(endsAt);
    setTimerSeconds(durationSeconds);
    scheduleRoundEndNotification(endsAt, appName);
  }, []);

  useEffect(() => {
    testAppsRef.current = testApps;
  }, [testApps]);

  useEffect(() => {
    currentActiveAppRef.current = currentActiveApp;
  }, [currentActiveApp]);

  useEffect(() => {
    timerEndsAtRef.current = timerEndsAt;
  }, [timerEndsAt]);

  useEffect(() => {
    const hydrate = async () => {
      try {
        const [appsJson, logsJson, cycleJson] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.testApps),
          AsyncStorage.getItem(STORAGE_KEYS.activityLogs),
          AsyncStorage.getItem(STORAGE_KEYS.cycleState),
        ]);

        const hydratedApps = appsJson ? JSON.parse(appsJson) : DEFAULT_TEST_APPS;
        setTestApps(hydratedApps);
        testAppsRef.current = hydratedApps;

        if (logsJson) {
          setActivityLogs(JSON.parse(logsJson));
        }

        if (cycleJson) {
          const cycle = JSON.parse(cycleJson);
          if (cycle?.isCycleActive && cycle.currentActiveAppId) {
            const app = hydratedApps.find((item) => item.id === cycle.currentActiveAppId);
            if (app && app.status === 'pending') {
              setCurrentActiveApp(app);
              currentActiveAppRef.current = app;
              setIsCycleActive(true);
              setIsTimerPaused(Boolean(cycle.isTimerPaused));

              if (cycle.isTimerPaused) {
                const pausedRemaining = cycle.pausedRemainingSeconds ?? CYCLE_DURATION_SECONDS;
                pausedRemainingRef.current = pausedRemaining;
                setTimerSeconds(pausedRemaining);
                setTimerEndsAt(null);
                timerEndsAtRef.current = null;
              } else if (cycle.timerEndsAt) {
                const remaining = getRemainingSeconds(cycle.timerEndsAt);
                timerEndsAtRef.current = cycle.timerEndsAt;
                setTimerEndsAt(cycle.timerEndsAt);
                setTimerSeconds(remaining);
                if (remaining > 0) {
                  scheduleRoundEndNotification(cycle.timerEndsAt, app.name);
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn('[Alpha Rounds] Failed to hydrate storage:', error);
      } finally {
        setIsHydrated(true);
      }
    };

    hydrate();
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    AsyncStorage.setItem(STORAGE_KEYS.testApps, JSON.stringify(testApps));
  }, [testApps, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    AsyncStorage.setItem(STORAGE_KEYS.activityLogs, JSON.stringify(activityLogs));
  }, [activityLogs, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;

    const cycleState = isCycleActive && currentActiveApp
      ? {
          isCycleActive: true,
          currentActiveAppId: currentActiveApp.id,
          timerEndsAt: isTimerPaused ? null : timerEndsAtRef.current,
          isTimerPaused,
          pausedRemainingSeconds: isTimerPaused ? timerSeconds : null,
        }
      : null;

    AsyncStorage.setItem(STORAGE_KEYS.cycleState, JSON.stringify(cycleState));
  }, [isCycleActive, currentActiveApp, isTimerPaused, timerSeconds, timerEndsAt, isHydrated]);

  useEffect(() => {
    const setupNotifications = async () => {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
          name: 'Testing Rounds',
          description: 'Alerts when a testing round completes',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#6366F1',
        });
      }

      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') {
        await Notifications.requestPermissionsAsync();
      }
    };

    setupNotifications();
  }, []);

  const toggleAppStatus = (id) => {
    setTestApps((prevApps) => {
      const target = prevApps.find((app) => app.id === id);
      const nextStatus = target?.status === 'pending' ? 'completed' : 'pending';
      if (target) {
        appendActivityLog(
          'status_toggle',
          `${target.name} marked as ${nextStatus}`,
          target.name
        );
      }
      return prevApps.map((app) =>
        app.id === id ? { ...app, status: nextStatus } : app
      );
    });
  };

  const launchTargetApp = useCallback(async (packageName) => {
    const pkg = packageName?.trim();
    if (!pkg) return;

    if (Platform.OS !== 'android') {
      Alert.alert('Android Only', 'Package launching is only supported on Android devices.');
      return;
    }

    const intentUrl = `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${pkg};end`;

    try {
      await Linking.openURL(intentUrl);
      return;
    } catch {
      // Fall through to Play Store deep link if the app is not installed.
    }

    try {
      await Linking.openURL(`market://details?id=${pkg}`);
    } catch {
      Alert.alert(
        'Unable to Launch App',
        `Could not open "${pkg}". Verify the package name and that the app is installed.`
      );
    }
  }, []);

  const addApp = () => {
    const trimmedName = newAppName.trim();
    const trimmedDev = newDevName.trim();
    const trimmedPackage = newPackageName.trim();
    if (!trimmedName || !trimmedDev || !trimmedPackage) return;

    const newApp = {
      id: String(Date.now()),
      name: trimmedName,
      developer: trimmedDev,
      packageName: trimmedPackage,
      dayStreak: 1,
      status: 'pending',
    };

    setTestApps((prevApps) => [newApp, ...prevApps]);
    appendActivityLog('app_added', `Added ${trimmedName} to the queue`, trimmedName);
    setNewAppName('');
    setNewDevName('');
    setNewPackageName('');
    setIsModalVisible(false);
  };

  const advanceToNextApp = useCallback(() => {
    const activeApp = currentActiveAppRef.current;
    if (!activeApp || isAdvancingRef.current) return;

    isAdvancingRef.current = true;
    cancelRoundEndNotification();

    const updatedApps = testAppsRef.current.map((app) =>
      app.id === activeApp.id ? { ...app, status: 'completed' } : app
    );

    const nextPending = updatedApps.find((app) => app.status === 'pending');

    setTestApps(updatedApps);
    appendActivityLog('round_complete', `Completed round for ${activeApp.name}`, activeApp.name);

    if (nextPending) {
      triggerCompletionAlert(activeApp.name);
      setCurrentActiveApp(nextPending);
      currentActiveAppRef.current = nextPending;
      setIsTimerPaused(false);
      beginTimer(CYCLE_DURATION_SECONDS, nextPending.name);
    } else {
      setCurrentActiveApp(null);
      currentActiveAppRef.current = null;
      setIsCycleActive(false);
      setIsTimerPaused(false);
      setTimerSeconds(CYCLE_DURATION_SECONDS);
      setTimerEndsAt(null);
      timerEndsAtRef.current = null;
      appendActivityLog('cycle_complete', 'All apps in the queue are complete');
      Alert.alert(
        'Cycle Complete! 🎉',
        'All apps in your testing queue have been completed. Outstanding work!'
      );
    }

    setTimeout(() => {
      isAdvancingRef.current = false;
    }, 0);
  }, [appendActivityLog, beginTimer]);

  const startCycle = () => {
    const firstPending = testApps.find((app) => app.status === 'pending');
    if (!firstPending) {
      Alert.alert('No Pending Apps', 'All apps in your queue are already completed.');
      return;
    }

    setCurrentActiveApp(firstPending);
    currentActiveAppRef.current = firstPending;
    setIsTimerPaused(false);
    setIsCycleActive(true);
    beginTimer(CYCLE_DURATION_SECONDS, firstPending.name);
    appendActivityLog('cycle_start', `Started automated cycle with ${firstPending.name}`, firstPending.name);
  };

  const cancelCycle = async () => {
    await cancelRoundEndNotification();
    if (currentActiveApp) {
      appendActivityLog('cycle_cancel', `Cancelled cycle during ${currentActiveApp.name}`, currentActiveApp.name);
    }
    setIsCycleActive(false);
    setCurrentActiveApp(null);
    currentActiveAppRef.current = null;
    setIsTimerPaused(false);
    setTimerSeconds(CYCLE_DURATION_SECONDS);
    setTimerEndsAt(null);
    timerEndsAtRef.current = null;
  };

  const skipCurrentApp = () => {
    if (!currentActiveApp) return;
    appendActivityLog('round_skip', `Skipped ${currentActiveApp.name}`, currentActiveApp.name);
    cancelRoundEndNotification();
    timerEndsAtRef.current = Date.now();
    setTimerEndsAt(Date.now());
    setTimerSeconds(0);
  };

  const toggleTimerPause = async () => {
    if (!currentActiveApp) return;

    if (!isTimerPaused) {
      const remaining = getRemainingSeconds(timerEndsAtRef.current);
      pausedRemainingRef.current = remaining;
      await cancelRoundEndNotification();
      setTimerEndsAt(null);
      timerEndsAtRef.current = null;
      setTimerSeconds(remaining);
      setIsTimerPaused(true);
      appendActivityLog('timer_pause', `Paused at ${formatTimer(remaining)}`, currentActiveApp.name);
      return;
    }

    const remaining = pausedRemainingRef.current ?? timerSeconds;
    setIsTimerPaused(false);
    beginTimer(remaining, currentActiveApp.name);
    appendActivityLog('timer_resume', `Resumed with ${formatTimer(remaining)} left`, currentActiveApp.name);
  };

  const syncTimerFromClock = useCallback(() => {
    if (!isCycleActive || isTimerPaused || !timerEndsAtRef.current) return;

    const remaining = getRemainingSeconds(timerEndsAtRef.current);
    setTimerSeconds(remaining);

    if (remaining === 0) {
      advanceToNextApp();
    }
  }, [isCycleActive, isTimerPaused, advanceToNextApp]);

  useEffect(() => {
    if (!isCycleActive || isTimerPaused) return;

    syncTimerFromClock();
    const interval = setInterval(syncTimerFromClock, 1000);
    return () => clearInterval(interval);
  }, [isCycleActive, isTimerPaused, syncTimerFromClock]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppState(nextState);
      if (nextState === 'active') {
        syncTimerFromClock();
      }
    });

    return () => subscription.remove();
  }, [syncTimerFromClock]);

  useEffect(() => {
    if (!isHydrated || !isCycleActive || isTimerPaused || !timerEndsAt) return;
    const remaining = getRemainingSeconds(timerEndsAt);
    if (remaining === 0) {
      advanceToNextApp();
    }
  }, [isHydrated, isCycleActive, isTimerPaused, timerEndsAt, advanceToNextApp]);

  useEffect(() => {
    if (!currentActiveApp?.packageName) return;
    launchTargetApp(currentActiveApp.packageName);
  }, [currentActiveApp, launchTargetApp]);

  const totalApps = testApps.length;
  const completedApps = testApps.filter(app => app.status === 'completed').length;
  const pendingApps = testApps.filter(app => app.status === 'pending').length;
  const progressPercent = totalApps > 0 ? (completedApps / totalApps) * 100 : 0;
  const isAppInBackground = appState !== 'active';

  const clearActivityLogs = () => {
    setActivityLogs([]);
  };

  if (!isHydrated) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.container}>
          <StatusBar barStyle="light-content" />
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>Loading Alpha Rounds…</Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      {isCycleActive && currentActiveApp ? (
        <View style={styles.activeTestContainer}>
          <Text style={styles.activeTestLabel}>ACTIVE TEST MODE</Text>

          {isAppInBackground && !isTimerPaused && (
            <View style={styles.backgroundBadge}>
              <Text style={styles.backgroundBadgeText}>
                Background — wall-clock timer active
              </Text>
            </View>
          )}

          <Text style={styles.activeTimer}>{formatTimer(timerSeconds)}</Text>

          <View style={styles.activeAppCard}>
            <Text style={styles.activeAppSubtitle}>NOW TESTING</Text>
            <Text style={styles.activeAppName}>{currentActiveApp.name}</Text>
            <Text style={styles.activeAppMeta}>
              by {currentActiveApp.developer} • Streak: Day {currentActiveApp.dayStreak}/14
            </Text>
          </View>

          <View style={styles.activeProgressRow}>
            <Text style={styles.activeProgressText}>
              {completedApps} / {totalApps} completed
            </Text>
            <Text style={styles.activeProgressText}>
              {pendingApps} remaining
            </Text>
          </View>

          <TouchableOpacity
            style={styles.pauseButton}
            activeOpacity={0.8}
            onPress={toggleTimerPause}
          >
            <Text style={styles.pauseButtonText}>
              {isTimerPaused ? '▶  Resume' : '⏸  Pause'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.skipButton}
            activeOpacity={0.8}
            onPress={skipCurrentApp}
          >
            <Text style={styles.skipButtonText}>Skip App</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.cancelCycleButton}
            activeOpacity={0.8}
            onPress={cancelCycle}
          >
            <Text style={styles.cancelCycleText}>Cancel Cycle</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
      <View style={styles.dashboardHeader}>
        <Text style={styles.dashboardTitle}>Alpha Rounds</Text>
        <TouchableOpacity
          style={styles.addButton}
          activeOpacity={0.8}
          onPress={() => setIsModalVisible(true)}
        >
          <Text style={styles.addButtonText}>+</Text>
        </TouchableOpacity>
      </View>
      
      {/* 1. GLOBAL PROGRESS HEADER */}
      <View style={styles.headerCard}>
        <Text style={styles.headerSubtitle}>DAILY PROGRESS</Text>
        <Text style={styles.headerTitle}>{completedApps} / {totalApps} Apps Completed</Text>

        <View style={styles.statsRow}>
          <View style={styles.statChip}>
            <Text style={styles.statValue}>{pendingApps}</Text>
            <Text style={styles.statLabel}>Pending</Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statValue}>{completedApps}</Text>
            <Text style={styles.statLabel}>Done</Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statValue}>{Math.round(progressPercent)}%</Text>
            <Text style={styles.statLabel}>Progress</Text>
          </View>
        </View>
        
        <View style={styles.progressBarBackground}>
          <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
        </View>

        {Platform.OS === 'android' && (
          <View style={styles.tipCard}>
            <Text style={styles.tipTitle}>Reliable background timers</Text>
            <Text style={styles.tipBody}>
              Exclude Alpha Rounds from battery optimization so rounds finish on schedule while you test other apps.
            </Text>
            <TouchableOpacity activeOpacity={0.8} onPress={() => Linking.openSettings()}>
              <Text style={styles.tipLink}>Open system app settings</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Primary Action Button */}
        <TouchableOpacity
          style={[styles.primaryButton, pendingApps === 0 && styles.primaryButtonDisabled]}
          activeOpacity={0.8}
          onPress={startCycle}
          disabled={pendingApps === 0}
        >
          <Text style={styles.primaryButtonText}>Start Automated Test Cycle</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.dashboardScroll}
        contentContainerStyle={styles.dashboardScrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Your Testing Queue</Text>
          <Text style={styles.sectionCount}>{testApps.length} apps</Text>
        </View>

          {testApps.map((app) => (
            <View key={app.id} style={styles.appRow}>
              <View style={[
                styles.statusDot,
                app.status === 'completed' ? styles.statusDotCompleted : styles.statusDotPending,
              ]} />
              <View style={styles.appInfo}>
                <Text style={styles.appName}>{app.name}</Text>
                <Text style={styles.appMeta}>by {app.developer} • Streak: Day {app.dayStreak}/14</Text>
                <Text style={styles.appPackage} numberOfLines={1}>{app.packageName}</Text>
              </View>

              {/* Right Column: Dynamic Status Action Badge */}
              <TouchableOpacity 
                style={[
                  styles.statusBadge, 
                  app.status === 'completed' ? styles.badgeCompleted : styles.badgePending
                ]}
                activeOpacity={0.7}
                onPress={() => toggleAppStatus(app.id)}
              >
                <Text style={[
                  styles.statusText, 
                  app.status === 'completed' ? styles.statusTextCompleted : styles.statusTextPending
                ]}>
                  {app.status === 'completed' ? '✓ Done' : 'Launch'}
                </Text>
              </TouchableOpacity>
            </View>
          ))}

      <View style={styles.logSection}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Activity Log</Text>
          {activityLogs.length > 0 && (
            <TouchableOpacity onPress={clearActivityLogs} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.clearLogsText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.logCard}>
          {activityLogs.length === 0 ? (
            <Text style={styles.logEmpty}>Session events will appear here and persist across restarts.</Text>
          ) : (
            activityLogs.slice(0, 25).map((log) => (
              <View key={log.id} style={styles.logRow}>
                <Text style={styles.logTime}>{formatLogTime(log.timestamp)}</Text>
                <Text style={styles.logMessage}>{log.message}</Text>
              </View>
            ))
          )}
        </View>
      </View>
      </ScrollView>

      <Modal
        visible={isModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add to Queue</Text>
              <TouchableOpacity
                style={styles.modalCloseButton}
                activeOpacity={0.7}
                onPress={() => setIsModalVisible(false)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              Enter the app and developer details to add a new testing target.
            </Text>

            <Text style={styles.inputLabel}>App Name</Text>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. ServiceLog Tracker"
              placeholderTextColor="#71717A"
              value={newAppName}
              onChangeText={setNewAppName}
              autoCapitalize="words"
            />

            <Text style={styles.inputLabel}>Developer Name</Text>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. DevJerome"
              placeholderTextColor="#71717A"
              value={newDevName}
              onChangeText={setNewDevName}
              autoCapitalize="words"
            />

            <Text style={styles.inputLabel}>Android Package Name</Text>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. com.google.android.youtube"
              placeholderTextColor="#71717A"
              value={newPackageName}
              onChangeText={setNewPackageName}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                activeOpacity={0.8}
                onPress={() => setIsModalVisible(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalSubmitButton}
                activeOpacity={0.8}
                onPress={addApp}
              >
                <Text style={styles.modalSubmitText}>Add App</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
        </>
      )}
    </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121214', // Sleek dark mode theme
  },
  dashboardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  dashboardTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#1A1A1E',
    borderWidth: 1,
    borderColor: '#6366F1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    color: '#6366F1',
    fontSize: 28,
    fontWeight: '300',
    lineHeight: 30,
  },
  headerCard: {
    backgroundColor: '#1A1A1E',
    padding: 24,
    margin: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A32',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  headerSubtitle: {
    color: '#A1A1AA',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 16,
  },
  progressBarBackground: {
    height: 8,
    backgroundColor: '#2A2A32',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 20,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#6366F1', // Indigo active accent color
    borderRadius: 4,
  },
  primaryButton: {
    backgroundColor: '#6366F1',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    backgroundColor: '#3F3F46',
    opacity: 0.7,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#A1A1AA',
    fontSize: 16,
    fontWeight: '600',
  },
  dashboardScroll: {
    flex: 1,
  },
  dashboardScrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  sectionCount: {
    color: '#71717A',
    fontSize: 13,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  statChip: {
    flex: 1,
    backgroundColor: '#121214',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A32',
  },
  statValue: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 2,
  },
  statLabel: {
    color: '#71717A',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tipCard: {
    backgroundColor: '#121214',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A32',
    padding: 14,
    marginBottom: 16,
  },
  tipTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
  },
  tipBody: {
    color: '#A1A1AA',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  tipLink: {
    color: '#6366F1',
    fontSize: 14,
    fontWeight: '700',
  },
  appRow: {
    backgroundColor: '#1A1A1E',
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2A2A32',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 12,
  },
  statusDotPending: {
    backgroundColor: '#71717A',
  },
  statusDotCompleted: {
    backgroundColor: '#10B981',
  },
  appInfo: {
    flex: 1,
    paddingRight: 16,
  },
  appName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  appMeta: {
    color: '#A1A1AA',
    fontSize: 13,
  },
  appPackage: {
    color: '#71717A',
    fontSize: 11,
    marginTop: 4,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },
  logSection: {
    marginTop: 8,
  },
  logCard: {
    backgroundColor: '#1A1A1E',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A32',
    padding: 12,
    minHeight: 120,
    maxHeight: 200,
  },
  logEmpty: {
    color: '#71717A',
    fontSize: 13,
    lineHeight: 18,
    padding: 8,
  },
  logRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A32',
    gap: 12,
  },
  logTime: {
    color: '#6366F1',
    fontSize: 12,
    fontWeight: '700',
    width: 52,
  },
  logMessage: {
    color: '#E4E4E7',
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },
  clearLogsText: {
    color: '#71717A',
    fontSize: 13,
    fontWeight: '600',
  },
  backgroundBadge: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    borderWidth: 1,
    borderColor: '#6366F1',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 16,
  },
  backgroundBadgeText: {
    color: '#A5B4FC',
    fontSize: 12,
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 80,
    alignItems: 'center',
  },
  badgePending: {
    backgroundColor: '#2A2A32',
    borderWidth: 1,
    borderColor: '#3F3F46',
  },
  badgeCompleted: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: '#10B981',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
  },
  statusTextPending: {
    color: '#E4E4E7',
  },
  statusTextCompleted: {
    color: '#10B981',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#1A1A1E',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A32',
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -10,
  },
  modalCloseText: {
    color: '#A1A1AA',
    fontSize: 20,
    fontWeight: '600',
  },
  modalSubtitle: {
    color: '#A1A1AA',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  inputLabel: {
    color: '#A1A1AA',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  textInput: {
    backgroundColor: '#121214',
    borderWidth: 1,
    borderColor: '#2A2A32',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#FFFFFF',
    fontSize: 16,
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2A2A32',
    borderWidth: 1,
    borderColor: '#3F3F46',
  },
  modalCancelText: {
    color: '#E4E4E7',
    fontSize: 16,
    fontWeight: '600',
  },
  modalSubmitButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6366F1',
  },
  modalSubmitText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  activeTestContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activeTestLabel: {
    color: '#6366F1',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 24,
  },
  activeTimer: {
    color: '#FFFFFF',
    fontSize: 88,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
    letterSpacing: 4,
    marginBottom: 40,
  },
  activeAppCard: {
    width: '100%',
    backgroundColor: '#1A1A1E',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A32',
    padding: 24,
    alignItems: 'center',
    marginBottom: 24,
  },
  activeAppSubtitle: {
    color: '#A1A1AA',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  activeAppName: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 8,
  },
  activeAppMeta: {
    color: '#A1A1AA',
    fontSize: 14,
    textAlign: 'center',
  },
  activeProgressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 32,
    paddingHorizontal: 8,
  },
  activeProgressText: {
    color: '#71717A',
    fontSize: 13,
    fontWeight: '600',
  },
  pauseButton: {
    width: '100%',
    backgroundColor: '#6366F1',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  pauseButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  skipButton: {
    width: '100%',
    backgroundColor: '#1A1A1E',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A32',
    marginBottom: 12,
  },
  skipButtonText: {
    color: '#E4E4E7',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelCycleButton: {
    width: '100%',
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  cancelCycleText: {
    color: '#71717A',
    fontSize: 15,
    fontWeight: '600',
  },
});