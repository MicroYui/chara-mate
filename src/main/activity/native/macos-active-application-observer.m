#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static NSRunningApplication *currentApplication = nil;
static AXObserverRef accessibilityObserver = NULL;
static AXUIElementRef accessibilityApplication = NULL;
static AXUIElementRef focusedWindow = NULL;

static NSString *StringAttribute(AXUIElementRef element, CFStringRef attribute) {
  if (element == NULL) return nil;
  CFTypeRef value = NULL;
  AXError result = AXUIElementCopyAttributeValue(element, attribute, &value);
  if (result != kAXErrorSuccess || value == NULL) return nil;
  NSString *text = nil;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    text = [(__bridge NSString *)value copy];
  }
  CFRelease(value);
  return text;
}

static void EmitApplication(void) {
  if (currentApplication == nil) return;
  NSString *applicationName = currentApplication.localizedName;
  if (applicationName.length == 0) return;

  NSMutableDictionary<NSString *, NSString *> *event =
      [NSMutableDictionary dictionaryWithObject:applicationName
                                         forKey:@"appName"];
  NSString *applicationId = currentApplication.bundleIdentifier;
  if (applicationId.length > 0) event[@"appId"] = applicationId;
  NSString *windowTitle = StringAttribute(focusedWindow, kAXTitleAttribute);
  if (windowTitle.length > 0) event[@"windowTitle"] = windowTitle;

  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:event
                                                 options:0
                                                   error:&error];
  if (data == nil) {
    fprintf(stderr, "Unable to serialize foreground application: %s\n",
            error.localizedDescription.UTF8String);
    return;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void RemoveAccessibilityObserver(void) {
  if (accessibilityObserver != NULL) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(),
                          AXObserverGetRunLoopSource(accessibilityObserver),
                          kCFRunLoopDefaultMode);
  }
  if (focusedWindow != NULL) {
    CFRelease(focusedWindow);
    focusedWindow = NULL;
  }
  if (accessibilityApplication != NULL) {
    CFRelease(accessibilityApplication);
    accessibilityApplication = NULL;
  }
  if (accessibilityObserver != NULL) {
    CFRelease(accessibilityObserver);
    accessibilityObserver = NULL;
  }
}

static void ObserveFocusedWindow(void) {
  if (accessibilityApplication == NULL || accessibilityObserver == NULL) return;
  if (focusedWindow != NULL) {
    AXObserverRemoveNotification(accessibilityObserver, focusedWindow,
                                 kAXTitleChangedNotification);
    CFRelease(focusedWindow);
    focusedWindow = NULL;
  }
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(accessibilityApplication,
                                    kAXFocusedWindowAttribute,
                                    &value) == kAXErrorSuccess &&
      value != NULL && CFGetTypeID(value) == AXUIElementGetTypeID()) {
    focusedWindow = (AXUIElementRef)value;
    AXObserverAddNotification(accessibilityObserver, focusedWindow,
                              kAXTitleChangedNotification, NULL);
  } else if (value != NULL) {
    CFRelease(value);
  }
}

static void AccessibilityChanged(AXObserverRef observer,
                                 AXUIElementRef element,
                                 CFStringRef notification,
                                 void *context) {
  (void)observer;
  (void)element;
  (void)context;
  @autoreleasepool {
    if (CFEqual(notification, kAXFocusedWindowChangedNotification)) {
      ObserveFocusedWindow();
    }
    EmitApplication();
  }
}

static void ObserveApplication(NSRunningApplication *application) {
  RemoveAccessibilityObserver();
  currentApplication = application;
  if (application == nil) return;

  accessibilityApplication =
      AXUIElementCreateApplication(application.processIdentifier);
  if (accessibilityApplication != NULL &&
      AXObserverCreate(application.processIdentifier, AccessibilityChanged,
                       &accessibilityObserver) == kAXErrorSuccess &&
      accessibilityObserver != NULL) {
    AXObserverAddNotification(accessibilityObserver, accessibilityApplication,
                              kAXFocusedWindowChangedNotification, NULL);
    CFRunLoopAddSource(CFRunLoopGetMain(),
                       AXObserverGetRunLoopSource(accessibilityObserver),
                       kCFRunLoopDefaultMode);
    ObserveFocusedWindow();
  }
  EmitApplication();
}

@interface WorkspaceActivationObserver : NSObject
- (void)applicationActivated:(NSNotification *)notification;
@end

@implementation WorkspaceActivationObserver
- (void)applicationActivated:(NSNotification *)notification {
  NSRunningApplication *application = notification.userInfo[NSWorkspaceApplicationKey];
  ObserveApplication(application);
}
@end

int main(void) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    WorkspaceActivationObserver *observer =
        [[WorkspaceActivationObserver alloc] init];
    [workspace.notificationCenter
        addObserver:observer
           selector:@selector(applicationActivated:)
               name:NSWorkspaceDidActivateApplicationNotification
             object:nil];
    ObserveApplication(workspace.frontmostApplication);
    [NSRunLoop.mainRunLoop run];
    [workspace.notificationCenter removeObserver:observer];
    RemoveAccessibilityObserver();
  }
  return 0;
}
