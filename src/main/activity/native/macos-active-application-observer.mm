#include <node_api.h>

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#include <array>
#include <cstdint>
#include <memory>
#include <string>

namespace {

enum class AccessibilityStatus {
  kAvailable,
  kPermissionRequired,
  kUnavailable,
};

struct ActiveApplicationEvent {
  AccessibilityStatus accessibilityStatus;
  std::string appId;
  std::string appName;
  std::string windowTitle;
};

napi_threadsafe_function callbackFunction = nullptr;
id workspaceActivationObserver = nil;
NSRunningApplication *currentApplication = nil;
AXObserverRef accessibilityObserver = nullptr;
AXUIElementRef accessibilityApplication = nullptr;
AXUIElementRef focusedWindow = nullptr;
AccessibilityStatus accessibilityStatus =
    AccessibilityStatus::kPermissionRequired;
uint64_t applicationGeneration = 0;
uint64_t focusedWindowRefreshGeneration = 0;

// NSWorkspace activation can arrive before the activated application publishes
// its AX focused window. This bounded, activation-scoped recovery schedule is a
// CharaMate correctness heuristic, not a macOS protocol timing guarantee.
constexpr std::array<int64_t, 4> kFocusedWindowRefreshDelayMs = {0, 50, 150,
                                                                 300};

std::string Utf8(NSString *value) {
  if (value == nil) return {};
  const char *text = value.UTF8String;
  return text == nullptr ? std::string() : std::string(text);
}

NSString *StringAttribute(AXUIElementRef element, CFStringRef attribute) {
  if (element == nullptr) return nil;
  CFTypeRef value = nullptr;
  const AXError result =
      AXUIElementCopyAttributeValue(element, attribute, &value);
  if (result != kAXErrorSuccess || value == nullptr) return nil;
  NSString *text = nil;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    text = [(__bridge NSString *)value copy];
  }
  CFRelease(value);
  return text;
}

const char *AccessibilityStatusText(AccessibilityStatus status) {
  switch (status) {
    case AccessibilityStatus::kAvailable:
      return "available";
    case AccessibilityStatus::kPermissionRequired:
      return "permission_required";
    case AccessibilityStatus::kUnavailable:
      return "unavailable";
  }
  return "unavailable";
}

void SetString(napi_env env, napi_value object, const char *name,
               const std::string &text) {
  if (text.empty()) return;
  napi_value value;
  if (napi_create_string_utf8(env, text.c_str(), text.size(), &value) !=
      napi_ok) {
    return;
  }
  napi_set_named_property(env, object, name, value);
}

void CallJavascript(napi_env env, napi_value callback, void *, void *data) {
  std::unique_ptr<ActiveApplicationEvent> event(
      static_cast<ActiveApplicationEvent *>(data));
  if (env == nullptr || callback == nullptr || event == nullptr) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  napi_value payload;
  if (napi_create_object(env, &payload) == napi_ok) {
    SetString(env, payload, "accessibilityStatus",
              AccessibilityStatusText(event->accessibilityStatus));
    SetString(env, payload, "appId", event->appId);
    SetString(env, payload, "appName", event->appName);
    SetString(env, payload, "windowTitle", event->windowTitle);
    napi_value receiver;
    if (napi_get_undefined(env, &receiver) == napi_ok) {
      napi_call_function(env, receiver, callback, 1, &payload, nullptr);
    }
  }
  napi_close_handle_scope(env, scope);
}

void EmitApplication() {
  if (currentApplication == nil || callbackFunction == nullptr) return;
  NSString *applicationName = currentApplication.localizedName;
  if (applicationName.length == 0) return;

  auto event = std::make_unique<ActiveApplicationEvent>();
  event->accessibilityStatus = accessibilityStatus;
  event->appName = Utf8(applicationName);
  event->appId = Utf8(currentApplication.bundleIdentifier);
  event->windowTitle = Utf8(StringAttribute(focusedWindow, kAXTitleAttribute));
  if (napi_call_threadsafe_function(callbackFunction, event.get(),
                                    napi_tsfn_nonblocking) == napi_ok) {
    event.release();
  }
}

bool HasFocusedWindowTitle() {
  NSString *title = StringAttribute(focusedWindow, kAXTitleAttribute);
  if (title == nil) return false;
  return [title
             stringByTrimmingCharactersInSet:
                 NSCharacterSet.whitespaceAndNewlineCharacterSet]
             .length > 0;
}

void RemoveAccessibilityObserver() {
  if (accessibilityObserver != nullptr && focusedWindow != nullptr) {
    AXObserverRemoveNotification(accessibilityObserver, focusedWindow,
                                 kAXTitleChangedNotification);
  }
  if (accessibilityObserver != nullptr &&
      accessibilityApplication != nullptr) {
    AXObserverRemoveNotification(accessibilityObserver,
                                 accessibilityApplication,
                                 kAXFocusedWindowChangedNotification);
  }
  if (accessibilityObserver != nullptr) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(),
                          AXObserverGetRunLoopSource(accessibilityObserver),
                          kCFRunLoopCommonModes);
  }
  if (focusedWindow != nullptr) {
    CFRelease(focusedWindow);
    focusedWindow = nullptr;
  }
  if (accessibilityApplication != nullptr) {
    CFRelease(accessibilityApplication);
    accessibilityApplication = nullptr;
  }
  if (accessibilityObserver != nullptr) {
    CFRelease(accessibilityObserver);
    accessibilityObserver = nullptr;
  }
}

void ObserveFocusedWindow() {
  if (accessibilityApplication == nullptr ||
      accessibilityObserver == nullptr) {
    return;
  }
  if (focusedWindow != nullptr) {
    AXObserverRemoveNotification(accessibilityObserver, focusedWindow,
                                 kAXTitleChangedNotification);
    CFRelease(focusedWindow);
    focusedWindow = nullptr;
  }
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(accessibilityApplication,
                                    kAXFocusedWindowAttribute,
                                    &value) == kAXErrorSuccess &&
      value != nullptr && CFGetTypeID(value) == AXUIElementGetTypeID()) {
    focusedWindow = static_cast<AXUIElementRef>(value);
    AXObserverAddNotification(accessibilityObserver, focusedWindow,
                              kAXTitleChangedNotification, nullptr);
  } else if (value != nullptr) {
    CFRelease(value);
  }
}

void ScheduleFocusedWindowRefresh(uint64_t expectedApplicationGeneration,
                                  uint64_t expectedRefreshGeneration,
                                  size_t attemptIndex);

void RefreshFocusedWindow(uint64_t expectedApplicationGeneration,
                          uint64_t expectedRefreshGeneration,
                          size_t attemptIndex) {
  if (expectedApplicationGeneration != applicationGeneration ||
      expectedRefreshGeneration != focusedWindowRefreshGeneration ||
      currentApplication == nil || accessibilityApplication == nullptr ||
      accessibilityObserver == nullptr) {
    return;
  }

  ObserveFocusedWindow();
  if (HasFocusedWindowTitle()) {
    ++focusedWindowRefreshGeneration;
    EmitApplication();
    return;
  }
  ScheduleFocusedWindowRefresh(expectedApplicationGeneration,
                               expectedRefreshGeneration, attemptIndex + 1);
}

void ScheduleFocusedWindowRefresh(uint64_t expectedApplicationGeneration,
                                  uint64_t expectedRefreshGeneration,
                                  size_t attemptIndex) {
  if (attemptIndex >= kFocusedWindowRefreshDelayMs.size()) return;
  const int64_t delayMs = kFocusedWindowRefreshDelayMs[attemptIndex];
  dispatch_block_t refresh = ^{
    @autoreleasepool {
      RefreshFocusedWindow(expectedApplicationGeneration,
                           expectedRefreshGeneration, attemptIndex);
    }
  };
  if (delayMs == 0) {
    dispatch_async(dispatch_get_main_queue(), refresh);
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), refresh);
}

void StartFocusedWindowRefresh() {
  const uint64_t refreshGeneration = ++focusedWindowRefreshGeneration;
  ScheduleFocusedWindowRefresh(applicationGeneration, refreshGeneration, 0);
}

void AccessibilityChanged(AXObserverRef, AXUIElementRef,
                          CFStringRef notification, void *) {
  @autoreleasepool {
    if (CFEqual(notification, kAXFocusedWindowChangedNotification)) {
      ObserveFocusedWindow();
    }
    if (!HasFocusedWindowTitle()) {
      EmitApplication();
      StartFocusedWindowRefresh();
      return;
    }
    ++focusedWindowRefreshGeneration;
    EmitApplication();
  }
}

void ObserveApplication(NSRunningApplication *application) {
  ++applicationGeneration;
  ++focusedWindowRefreshGeneration;
  RemoveAccessibilityObserver();
  currentApplication = application;
  if (application == nil) return;

  if (!AXIsProcessTrusted()) {
    accessibilityStatus = AccessibilityStatus::kPermissionRequired;
    EmitApplication();
    return;
  }

  accessibilityApplication =
      AXUIElementCreateApplication(application.processIdentifier);
  const AXError observerResult =
      accessibilityApplication == nullptr
          ? kAXErrorFailure
          : AXObserverCreate(application.processIdentifier,
                             AccessibilityChanged, &accessibilityObserver);
  if (observerResult != kAXErrorSuccess || accessibilityObserver == nullptr) {
    accessibilityStatus = AccessibilityStatus::kUnavailable;
    EmitApplication();
    return;
  }

  accessibilityStatus = AccessibilityStatus::kAvailable;
  AXObserverAddNotification(accessibilityObserver, accessibilityApplication,
                            kAXFocusedWindowChangedNotification, nullptr);
  CFRunLoopAddSource(CFRunLoopGetMain(),
                     AXObserverGetRunLoopSource(accessibilityObserver),
                     kCFRunLoopCommonModes);
  ObserveFocusedWindow();
  EmitApplication();
  if (!HasFocusedWindowTitle()) StartFocusedWindowRefresh();
}

void StopObservation() {
  @autoreleasepool {
    ++applicationGeneration;
    ++focusedWindowRefreshGeneration;
    if (workspaceActivationObserver != nil) {
      [NSWorkspace.sharedWorkspace.notificationCenter
          removeObserver:workspaceActivationObserver];
      workspaceActivationObserver = nil;
    }
    RemoveAccessibilityObserver();
    currentApplication = nil;
    if (callbackFunction != nullptr) {
      napi_threadsafe_function callback = callbackFunction;
      callbackFunction = nullptr;
      napi_release_threadsafe_function(callback, napi_tsfn_abort);
    }
  }
}

napi_value Stop(napi_env env, napi_callback_info) {
  StopObservation();
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value ThrowError(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value Subscribe(napi_env env, napi_callback_info info) {
  size_t argumentCount = 1;
  napi_value arguments[1];
  if (napi_get_cb_info(env, info, &argumentCount, arguments, nullptr,
                       nullptr) != napi_ok ||
      argumentCount != 1) {
    return ThrowError(env, "subscribe requires one callback");
  }
  napi_valuetype argumentType;
  if (napi_typeof(env, arguments[0], &argumentType) != napi_ok ||
      argumentType != napi_function) {
    return ThrowError(env, "subscribe callback must be a function");
  }
  if (callbackFunction != nullptr) {
    return ThrowError(env, "the active application observer is already active");
  }

  napi_value resourceName;
  if (napi_create_string_utf8(env, "CharaMateActiveApplicationObserver",
                              NAPI_AUTO_LENGTH, &resourceName) != napi_ok ||
      napi_create_threadsafe_function(
          env, arguments[0], nullptr, resourceName, 64, 1, nullptr, nullptr,
          nullptr, CallJavascript, &callbackFunction) != napi_ok) {
    callbackFunction = nullptr;
    return ThrowError(env, "unable to create active application callback");
  }
  napi_unref_threadsafe_function(env, callbackFunction);

  @autoreleasepool {
    NSNotificationCenter *notificationCenter =
        NSWorkspace.sharedWorkspace.notificationCenter;
    workspaceActivationObserver = [notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(NSNotification *notification) {
                  NSRunningApplication *application =
                      notification.userInfo[NSWorkspaceApplicationKey];
                  ObserveApplication(application);
                }];
    ObserveApplication(NSWorkspace.sharedWorkspace.frontmostApplication);
  }

  napi_value stopFunction;
  if (napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr,
                           &stopFunction) != napi_ok) {
    StopObservation();
    return ThrowError(env, "unable to create observer stop function");
  }
  return stopFunction;
}

void Cleanup(void *) { StopObservation(); }

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"subscribe", nullptr, Subscribe, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  if (napi_define_properties(env, exports, 1, properties) != napi_ok ||
      napi_add_env_cleanup_hook(env, Cleanup, nullptr) != napi_ok) {
    return ThrowError(env, "unable to initialize active application observer");
  }
  return exports;
}
