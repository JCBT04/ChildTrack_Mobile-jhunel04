// services/NotificationService.js - IMPROVED VERSION
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = "https://childtrack-backend.onrender.com";
const POLLING_INTERVAL = 30000; // 30 seconds (changed from 5)
const LAST_CHECK_KEY = 'notification_last_check';
const NOTIFIED_KEY = 'notification_notified_items';

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

class NotificationService {
  constructor() {
    this.notificationListener = null;
    this.responseListener = null;
    this.pollingInterval = null;
    this.isPolling = false;
    this.permissionStatus = null;
  }

  // Request notification permissions with better error handling
  async requestPermissions() {
    if (!Device.isDevice) {
      console.warn('[NotificationService] Push notifications only work on physical devices');
      return null;
    }

    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        console.log('[NotificationService] Requesting permissions...');
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      this.permissionStatus = finalStatus;
      
      if (finalStatus !== 'granted') {
        console.warn('[NotificationService] Permission denied:', finalStatus);
        return null;
      }

      console.log('[NotificationService] ✅ Permissions granted');
      return finalStatus;
    } catch (error) {
      console.error('[NotificationService] Error requesting permissions:', error);
      return null;
    }
  }

  // Setup Android channels
  async setupAndroidChannel() {
    if (Platform.OS === 'android') {
      try {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Default',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#3498db',
          sound: true,
        });

        await Notifications.setNotificationChannelAsync('attendance', {
          name: 'Attendance Notifications',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#27ae60',
          sound: true,
        });

        await Notifications.setNotificationChannelAsync('events', {
          name: 'Event Notifications',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#3498db',
          sound: true,
        });

        await Notifications.setNotificationChannelAsync('guardians', {
          name: 'Guardian Notifications',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#e74c3c',
          sound: true,
        });

        console.log('[NotificationService] ✅ Android channels configured');
      } catch (error) {
        console.error('[NotificationService] Error setting up channels:', error);
      }
    }
  }

  // Initialize notification service
  async initialize() {
    try {
      console.log('[NotificationService] Starting initialization...');
      
      const permission = await this.requestPermissions();
      if (!permission) {
        console.warn('[NotificationService] Cannot initialize without permissions');
        return false;
      }

      await this.setupAndroidChannel();
      
      // Load last check times
      await this.loadLastCheckTimes();
      
      // Start polling
      this.startPolling();
      
      console.log('[NotificationService] ✅ Initialization complete');
      return true;
    } catch (error) {
      console.error('[NotificationService] Initialization error:', error);
      return false;
    }
  }

  // Load last check times from storage
  async loadLastCheckTimes() {
    try {
      const stored = await AsyncStorage.getItem(LAST_CHECK_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        console.log('[NotificationService] Loaded last check times:', parsed);
      }
    } catch (error) {
      console.error('[NotificationService] Error loading last check times:', error);
    }
  }

  // Save last check times
  async saveLastCheckTimes(type, identifier) {
    try {
      const stored = await AsyncStorage.getItem(LAST_CHECK_KEY);
      const data = stored ? JSON.parse(stored) : {};
      data[type] = identifier;
      await AsyncStorage.setItem(LAST_CHECK_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('[NotificationService] Error saving check times:', error);
    }
  }

  // Get last check identifier
  async getLastCheck(type) {
    try {
      const stored = await AsyncStorage.getItem(LAST_CHECK_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        return data[type] || null;
      }
    } catch (error) {
      console.error('[NotificationService] Error getting last check:', error);
    }
    return null;
  }

  // Start polling
  startPolling() {
    if (this.isPolling) {
      console.log('[NotificationService] Already polling');
      return;
    }

    console.log('[NotificationService] Starting polling...');
    this.isPolling = true;
    
    // Check immediately on start
    this.checkForNewData();
    
    // Then check at intervals
    this.pollingInterval = setInterval(() => {
      this.checkForNewData();
    }, POLLING_INTERVAL);
  }

  // Stop polling
  stopPolling() {
    if (this.pollingInterval) {
      console.log('[NotificationService] Stopping polling');
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.isPolling = false;
    }
  }

  // Main check function
  async checkForNewData() {
    try {
      const parentRaw = await AsyncStorage.getItem('parent');
      if (!parentRaw) {
        console.log('[NotificationService] No parent data, skipping check');
        return;
      }

      const parent = JSON.parse(parentRaw);
      const studentLrn = parent.student_lrn || parent.student;
      const studentName = parent.student_name;

      if (!studentLrn && !studentName) {
        console.log('[NotificationService] No student info, skipping check');
        return;
      }

      console.log('[NotificationService] Checking for updates...');

      // Run all checks
      await Promise.all([
        this.checkAttendance(studentLrn, studentName),
        this.checkEvents(parent),
        this.checkGuardians(studentLrn, studentName),
      ]);

    } catch (error) {
      console.error('[NotificationService] Check error:', error);
    }
  }

  // Check attendance
  async checkAttendance(studentLrn, studentName) {
    try {
      const response = await fetch(`${BACKEND_URL}/api/attendance/public/`);
      if (!response.ok) return;

      const data = await response.json();
      const attendanceList = Array.isArray(data) ? data : (data.results || []);

      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      const todayRecords = attendanceList.filter(record => {
        const matchesLrn = studentLrn && record.student_lrn === studentLrn;
        const matchesName = studentName && record.student_name?.toLowerCase() === studentName.toLowerCase();
        const isToday = record.date === todayStr;
        return (matchesLrn || matchesName) && isToday;
      });

      console.log('[NotificationService] Attendance records for today:', todayRecords.length);
      if (todayRecords.length === 0) {
        console.log('[NotificationService] No attendance records matched for student today.');
        return;
      }

      // Get the most recent record
      const latestRecord = todayRecords.sort((a, b) => {
        const timeA = new Date(a.created_at || a.timestamp || a.date);
        const timeB = new Date(b.created_at || b.timestamp || b.date);
        return timeB - timeA;
      })[0];

      console.log('[NotificationService] Latest attendance record:', latestRecord);
      const normalizedStatus = (latestRecord.status || '').toLowerCase().trim().replace(/\s|-|_/g, '');
      console.log('[NotificationService] Normalized status:', normalizedStatus);

      const currentIdentifier = `${latestRecord.id}-${normalizedStatus}`;
      const lastCheck = await this.getLastCheck('attendance');

      if (lastCheck !== currentIdentifier) {
        console.log('[NotificationService] Attendance change detected. lastCheck:', lastCheck, 'current:', currentIdentifier);
        await this.saveLastCheckTimes('attendance', currentIdentifier);

        // Only send notification if this is not the first check
        if (lastCheck !== null) {
          console.log('[NotificationService] 🔔 New attendance detected:', latestRecord.status);
          await this.sendAttendanceNotification(latestRecord);
        } else {
          console.log('[NotificationService] First check - skipping notification');
        }
      } else {
        console.log('[NotificationService] No change in attendance since last check');
      }
    } catch (error) {
      console.error('[NotificationService] Attendance check error:', error);
    }
  }

  // Send attendance notification
  async sendAttendanceNotification(record) {
    const id = record.id || `${record.student_lrn || record.student}-${record.status}`;
    try {
      const already = await this.hasBeenNotified('attendance', id);
      if (already) {
        console.log('[NotificationService] Attendance notification already sent for', id);
        return;
      }
    } catch (e) {
      console.warn('[NotificationService] hasBeenNotified check failed', e);
    }
    const status = (record.status || '').toLowerCase().trim().replace(/[\s_-]/g, '');
    let title = 'Attendance Update';
    let body = `${record.student_name} is in the classroom`;
    let channelId = 'attendance';

    if (status === 'pickup') {
      title = 'Child Picked Up';
      body = `${record.student_name} has been picked up`;
    } else if (status === 'dropoff') {
      title = 'Child Dropped Off';
      body = `${record.student_name} is in the classroom`;
    } else if (status === 'present') {
      title = 'Child Present';
      body = `${record.student_name} is marked present`;
    } else if (status === 'absent') {
      title = 'Absence Recorded';
      body = `${record.student_name} is marked absent`;
    } else if (status === 'late') {
      title = 'Late Arrival';
      body = `${record.student_name} arrived late`;
    }

    await this.scheduleLocalNotification(title, body, {
      type: 'attendance',
      student_id: record.student_lrn,
      status: record.status,
    }, channelId);

    try {
      await this.markNotified('attendance', id);
    } catch (e) {
      console.warn('[NotificationService] markNotified failed for attendance', e);
    }
  }

  // Check events - UPDATED WITH BETTER FILTERING
  async checkEvents(parent) {
    try {
      // Get section and teacher info
      const section = parent.student_section || parent.student?.section;
      const teacher = parent.teacher_name || parent.student_teacher;
      
      console.log('[NotificationService] ========== EVENT CHECK ==========');
      console.log('[NotificationService] Checking events for section:', section, 'teacher:', teacher);
      
      // Fetch ALL events (no URL filters to match Events.js behavior)
      const response = await fetch(`${BACKEND_URL}/api/parents/events/`);
      if (!response.ok) {
        console.log('[NotificationService] Events fetch failed:', response.status);
        return;
      }

      const data = await response.json();
      const eventsList = Array.isArray(data) ? data : (data.results || []);
      
      console.log('[NotificationService] Total events fetched:', eventsList.length);

      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Filter events using SAME logic as Events.js
      const upcomingEvents = eventsList.filter(event => {
        // Check date first
        if (!event.scheduled_at) return false;
        const eventDate = new Date(event.scheduled_at);
        if (isNaN(eventDate.getTime())) return false;
        
        const eventStart = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
        
        // Only upcoming events (today or future, within 7 days)
        if (eventStart < todayStart || eventDate > weekFromNow) return false;

        // Check if event is general (no section AND no teacher)
        const isGeneralEvent = (!event.section || event.section.trim() === '') && 
                              (!event.teacher_name || event.teacher_name.trim() === '');
        
        // If student has no section/teacher, only show general events
        if ((!section || section.trim() === '') && (!teacher || teacher.trim() === '')) {
          console.log(`[NotificationService] Event "${event.title}" - Student has no section/teacher, is general: ${isGeneralEvent}`);
          return isGeneralEvent;
        }
        
        // General events are visible to everyone
        if (isGeneralEvent) {
          console.log(`[NotificationService] Event "${event.title}" - General event, visible to all`);
          return true;
        }
        
        // Check section match
        let sectionMatches = false;
        if (!section || section.trim() === '') {
          sectionMatches = !event.section || event.section.trim() === '';
        } else if (!event.section || event.section.trim() === '') {
          sectionMatches = true;
        } else {
          sectionMatches = event.section.toLowerCase().trim() === section.toLowerCase().trim();
        }
        
        // Check teacher match
        let teacherMatches = false;
        if (!teacher || teacher.trim() === '') {
          teacherMatches = !event.teacher_name || event.teacher_name.trim() === '';
        } else if (!event.teacher_name || event.teacher_name.trim() === '') {
          teacherMatches = true;
        } else {
          teacherMatches = event.teacher_name.toLowerCase().trim() === teacher.toLowerCase().trim();
        }
        
        const passes = sectionMatches && teacherMatches;
        console.log(`[NotificationService] Event "${event.title}" - Section: ${sectionMatches ? '✓' : '✗'}, Teacher: ${teacherMatches ? '✓' : '✗'}, Result: ${passes ? 'INCLUDE' : 'EXCLUDE'}`);
        
        return passes;
      });

      console.log('[NotificationService] Filtered upcoming events:', upcomingEvents.length);
      
      if (upcomingEvents.length === 0) {
        console.log('[NotificationService] No upcoming events found');
        // Clear the last check if no events
        await this.saveLastCheckTimes('events', '');
        return;
      }

      // Sort by created_at (newest first) to find the most recently created event
      upcomingEvents.sort((a, b) => {
        const aCreated = new Date(a.created_at || a.scheduled_at);
        const bCreated = new Date(b.created_at || b.scheduled_at);
        return bCreated - aCreated;
      });

      const newestEvent = upcomingEvents[0];
      const currentIdentifier = `event-${newestEvent.id}-${newestEvent.created_at || newestEvent.scheduled_at}`;
      const lastCheck = await this.getLastCheck('events');

      console.log('[NotificationService] Newest event:', newestEvent.title);
      console.log('[NotificationService] Current identifier:', currentIdentifier);
      console.log('[NotificationService] Last check:', lastCheck);

      if (lastCheck !== currentIdentifier) {
        await this.saveLastCheckTimes('events', currentIdentifier);

        // If we've seen events before, notify on change. If this is the first time
        // we run (lastCheck === null) we still want to notify if the event was
        // created very recently (likely the user just added it).
        const FIRST_NOTIFY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
        if (lastCheck !== null) {
          console.log('[NotificationService] 🔔 New event detected:', newestEvent.title);
          await this.sendEventNotification(newestEvent);
        } else {
          // Determine creation time
          let createdTime = new Date(newestEvent.created_at || newestEvent.scheduled_at || Date.now());
          if (isNaN(createdTime.getTime())) createdTime = new Date();
          const ageMs = Date.now() - createdTime.getTime();
          console.log('[NotificationService] New event created_at:', (newestEvent.created_at || newestEvent.scheduled_at));
          console.log('[NotificationService] Computed createdTime:', createdTime.toISOString(), 'ageMs:', ageMs, 'thresholdMs:', FIRST_NOTIFY_WINDOW_MS);

          // Treat future timestamps (ageMs < 0) as recent and notify
          if (ageMs <= FIRST_NOTIFY_WINDOW_MS || ageMs < 0) {
            console.log('[NotificationService] First check but event is recent/future - sending notification:', newestEvent.title);
            await this.sendEventNotification(newestEvent);
          } else {
            console.log('[NotificationService] First check - event not recent, skipping notification');
          }
        }
      } else {
        console.log('[NotificationService] No new events detected');
      }
      
      console.log('[NotificationService] ========== EVENT CHECK COMPLETE ==========');
    } catch (error) {
      console.error('[NotificationService] Events check error:', error);
    }
  }

  // Force notify upcoming events (bypass last-check logic) - useful for debugging
  async forceNotifyUpcomingEvents(parent = null) {
    try {
      const storedParentRaw = parent ? null : await AsyncStorage.getItem('parent');
      if (!parent && storedParentRaw) parent = JSON.parse(storedParentRaw);

      const section = parent ? (parent.student_section || parent.student?.section) : null;
      const teacher = parent ? (parent.teacher_name || parent.student_teacher) : null;

      const response = await fetch(`${BACKEND_URL}/api/parents/events/`);
      if (!response.ok) {
        console.log('[NotificationService] forceNotifyUpcomingEvents: Events fetch failed:', response.status);
        return;
      }
      const data = await response.json();
      const eventsList = Array.isArray(data) ? data : (data.results || []);

      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const upcomingEvents = eventsList.filter(event => {
        if (!event.scheduled_at) return false;
        const eventDate = new Date(event.scheduled_at);
        if (isNaN(eventDate.getTime())) return false;
        const eventStart = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
        if (eventStart < todayStart || eventDate > weekFromNow) return false;

        const isGeneralEvent = (!event.section || event.section.trim() === '') && (!event.teacher_name || event.teacher_name.trim() === '');
        if ((!section || section.trim() === '') && (!teacher || teacher.trim() === '')) return isGeneralEvent;
        if (isGeneralEvent) return true;

        let sectionMatches = false;
        if (!section || section.trim() === '') {
          sectionMatches = !event.section || event.section.trim() === '';
        } else if (!event.section || event.section.trim() === '') {
          sectionMatches = true;
        } else {
          sectionMatches = event.section.toLowerCase().trim() === section.toLowerCase().trim();
        }

        let teacherMatches = false;
        if (!teacher || teacher.trim() === '') {
          teacherMatches = !event.teacher_name || event.teacher_name.trim() === '';
        } else if (!event.teacher_name || event.teacher_name.trim() === '') {
          teacherMatches = true;
        } else {
          teacherMatches = event.teacher_name.toLowerCase().trim() === teacher.toLowerCase().trim();
        }

        return sectionMatches && teacherMatches;
      });

      console.log('[NotificationService] forceNotifyUpcomingEvents: found', upcomingEvents.length, 'upcoming events');

      for (const evt of upcomingEvents) {
        try {
          await this.sendEventNotification(evt);
        } catch (e) {
          console.warn('[NotificationService] forceNotifyUpcomingEvents: failed to send for', evt.id, e);
        }
      }
    } catch (e) {
      console.error('[NotificationService] forceNotifyUpcomingEvents error:', e);
    }
  }

  // Send event notification
  async sendEventNotification(event) {
    const id = event.id || (`event-${event.title || ''}-${event.scheduled_at || ''}`);
    try {
      const already = await this.hasBeenNotified('events', id);
      if (already) {
        console.log('[NotificationService] Event notification already sent for', id);
        return;
      }
    } catch (e) {
      console.warn('[NotificationService] hasBeenNotified check failed', e);
    }
    const eventDate = new Date(event.scheduled_at);
    const dateStr = eventDate.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      year: 'numeric'
    });

    await this.scheduleLocalNotification(
      'New Event',
      `${event.title} - ${dateStr}`,
      {
        type: 'event',
        event_id: event.id,
        event_type: event.event_type,
      },
      'events'
    );

    try {
      await this.markNotified('events', id);
    } catch (e) {
      console.warn('[NotificationService] markNotified failed for events', e);
    }
  }

  // Check guardians
  async checkGuardians(studentLrn, studentName) {
    try {
      const response = await fetch(`${BACKEND_URL}/api/guardian/public/`);
      if (!response.ok) return;

      const data = await response.json();
      const guardiansList = Array.isArray(data) ? data : (data.results || []);

      const pendingGuardians = guardiansList.filter(guardian => {
        const matchesLrn = studentLrn && guardian.student_lrn === studentLrn;
        const matchesName = studentName && guardian.student_name?.toLowerCase() === studentName.toLowerCase();
        const isPending = ['pending', 'unregistered'].includes(guardian.status?.toLowerCase());
        return (matchesLrn || matchesName) && isPending;
      });

      const currentGuardianIds = pendingGuardians.map(g => g.id).sort().join(',');
      const lastCheck = await this.getLastCheck('guardians');

      if (lastCheck !== currentGuardianIds) {
        await this.saveLastCheckTimes('guardians', currentGuardianIds);

        if (lastCheck !== null && pendingGuardians.length > 0) {
          const newestGuardian = pendingGuardians.reduce((newest, current) => {
            const currentDate = new Date(current.created_at);
            const newestDate = new Date(newest.created_at);
            return currentDate > newestDate ? current : newest;
          }, pendingGuardians[0]);

          console.log('[NotificationService] 🔔 New guardian request:', newestGuardian.name);
          await this.sendGuardianNotification(newestGuardian);
        }
      }
    } catch (error) {
      console.error('[NotificationService] Guardians check error:', error);
    }
  }

  // Send guardian notification
  async sendGuardianNotification(guardian) {
    const id = guardian.id || (`guardian-${guardian.name || ''}-${guardian.created_at || ''}`);
    try {
      const already = await this.hasBeenNotified('guardians', id);
      if (already) {
        console.log('[NotificationService] Guardian notification already sent for', id);
        return;
      }
    } catch (e) {
      console.warn('[NotificationService] hasBeenNotified check failed', e);
    }
    await this.scheduleLocalNotification(
      'Guardian Approval Request',
      `${guardian.name} is requesting to be added as a guardian`,
      {
        type: 'unregistered',
        guardian_id: guardian.id,
        guardian_name: guardian.name,
      },
      'guardians'
    );

    try {
      await this.markNotified('guardians', id);
    } catch (e) {
      console.warn('[NotificationService] markNotified failed for guardians', e);
    }
  }

  // Check if an item was already notified
  async hasBeenNotified(type, id) {
    try {
      const raw = await AsyncStorage.getItem(NOTIFIED_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw) || {};
      const list = Array.isArray(obj[type]) ? obj[type] : [];
      return list.includes(String(id));
    } catch (e) {
      console.error('[NotificationService] Error reading notified items:', e);
      return false;
    }
  }

  // Mark an item as notified
  async markNotified(type, id) {
    try {
      const raw = await AsyncStorage.getItem(NOTIFIED_KEY);
      const obj = raw ? (JSON.parse(raw) || {}) : {};
      if (!obj[type] || !Array.isArray(obj[type])) obj[type] = [];
      const sid = String(id);
      if (!obj[type].includes(sid)) {
        obj[type].push(sid);
        // Keep array reasonably small (optional): keep last 200 entries
        if (obj[type].length > 200) obj[type] = obj[type].slice(-200);
        await AsyncStorage.setItem(NOTIFIED_KEY, JSON.stringify(obj));
      }
    } catch (e) {
      console.error('[NotificationService] Error marking notified item:', e);
    }
  }

  // Setup listeners
  setupListeners(navigation) {
    console.log('[NotificationService] Setting up listeners...');

    this.notificationListener = Notifications.addNotificationReceivedListener(notification => {
      console.log('[NotificationService] 📩 Notification received:', notification.request.content.title);
      
      const data = notification.request.content.data;
      if (data.badge) {
        Notifications.setBadgeCountAsync(parseInt(data.badge));
      }
    });

    this.responseListener = Notifications.addNotificationResponseReceivedListener(response => {
      console.log('[NotificationService] 👆 Notification tapped');
      
      const data = response.notification.request.content.data;
      
      if (data.type === 'attendance' || data.type === 'pickup') {
        navigation.navigate('attendance');
      } else if (data.type === 'event') {
        if (data.event_id) {
          navigation.navigate('event', { id: data.event_id });
        } else {
          navigation.navigate('event');
        }
      } else if (data.type === 'guardian' || data.type === 'unregistered') {
        navigation.navigate('unregistered');
      } else {
        navigation.navigate('notification');
      }
    });
  }

  // Remove listeners
  removeListeners() {
    console.log('[NotificationService] Removing listeners...');
    if (this.notificationListener) {
      try { this.notificationListener.remove && this.notificationListener.remove(); } catch (e) { /* ignore */ }
    }
    if (this.responseListener) {
      try { this.responseListener.remove && this.responseListener.remove(); } catch (e) { /* ignore */ }
    }
    this.stopPolling();
  }

  // Schedule local notification
  async scheduleLocalNotification(title, body, data = {}, channelId = 'default') {
    try {
      console.log('[NotificationService] 📤 Sending notification:', title);
      
      const content = {
        title,
        body,
        data,
        sound: 'default',
      };

      const options = {
        content,
        trigger: null,
      };

      if (Platform.OS === 'android') {
        options.android = {
          channelId,
          sound: 'default',
          priority: Notifications.AndroidNotificationPriority.HIGH,
        };
      }

      await Notifications.scheduleNotificationAsync(options);
      
      console.log('[NotificationService] ✅ Notification sent successfully');
    } catch (error) {
      console.error('[NotificationService] ❌ Error sending notification:', error);
    }
  }

  // Utility methods
  async getBadgeCount() {
    return await Notifications.getBadgeCountAsync();
  }

  async setBadgeCount(count) {
    await Notifications.setBadgeCountAsync(count);
  }

  async clearAllNotifications() {
    await Notifications.dismissAllNotificationsAsync();
    await Notifications.setBadgeCountAsync(0);
  }

  getPermissionStatus() {
    return this.permissionStatus;
  }
}

export default new NotificationService();