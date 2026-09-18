#include <node_api.h>
#include "macos-visual-source.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#include <array>
#include <atomic>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <algorithm>
#include <limits>
#include <string>

namespace {

enum class AccessibilityStatus {
  kAvailable,
  kPermissionRequired,
  kUnavailable,
};

struct ActiveApplicationEvent {
  uint64_t generation = 0;
  AccessibilityStatus accessibilityStatus;
  std::string appId;
  std::string appName;
  std::string windowTitle;
  std::string actor;
  std::string boundary;
  std::string lifecycle;
  std::string contentText;
  std::string contentStatus;
  bool contentTruncated = false;
  std::string surfaceJSON;
  std::string visualStatus;
  std::string inputOrigin;
  std::string observedAt;
  uint32_t clicks = 0;
  uint32_t keystrokes = 0;
  uint32_t scrolls = 0;
};

napi_threadsafe_function callbackFunction = nullptr;
id workspaceActivationObserver = nil;
id workspaceLaunchObserver = nil;
id workspaceTerminateObserver = nil;
id globalInputMonitor = nil;
id localInputMonitor = nil;
dispatch_source_t observationTimer = nil;
uint32_t pendingClicks = 0;
uint32_t pendingKeystrokes = 0;
uint32_t pendingScrolls = 0;
bool pendingContentChange = false;
std::atomic_bool sourcePaused{false};
std::atomic_bool sourceActive{false};
std::atomic<uint64_t> requestedGeneration{0};
uint64_t currentGeneration = 0;
NSString *focusedWindowIdentity = nil;
std::string pendingInputOrigin = "unknown";
std::thread axThread;
std::mutex axJoinMutex;
std::atomic_bool axJoined{true};
// N-API callback and stop completion are owned exclusively by Main.
napi_ref stopPromiseReference = nullptr;
bool stopPending = false;
bool environmentClosing = false;
void JoinAXOwner() {
  std::lock_guard<std::mutex> lock(axJoinMutex);
  if (axThread.joinable()) axThread.join();
  axJoined.store(true);
}
std::mutex axMutex;
std::condition_variable axReady;
CFRunLoopRef axLoop = nullptr;
void PostAX(void (^work)(void)) {
  std::lock_guard<std::mutex> lock(axMutex);
  if (!axLoop) return;
  CFRunLoopPerformBlock(axLoop, kCFRunLoopDefaultMode, work);
  CFRunLoopWakeUp(axLoop);
}
void StartAXOwner() {
  axJoined.store(false);
  axThread = std::thread([] {
    @autoreleasepool {
      CFRunLoopSourceContext context{}; context.perform = [](void *) {};
      CFRunLoopSourceRef keepAlive = CFRunLoopSourceCreate(nullptr, 0, &context);
      { std::lock_guard<std::mutex> lock(axMutex); axLoop = CFRunLoopGetCurrent(); CFRetain(axLoop); }
      CFRunLoopAddSource(CFRunLoopGetCurrent(), keepAlive, kCFRunLoopDefaultMode);
      axReady.notify_one();
      CFRunLoopRun();
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), keepAlive, kCFRunLoopDefaultMode); CFRelease(keepAlive);
      { std::lock_guard<std::mutex> lock(axMutex); CFRelease(axLoop); axLoop = nullptr; }
    }
  });
  std::unique_lock<std::mutex> lock(axMutex); axReady.wait(lock, [] { return axLoop != nullptr; });
}
NSDictionary *currentApplication = nil;
NSDictionary *ApplicationSnapshot(NSRunningApplication *application) {
  if (!application) return nil;
  return @{ @"processId": @(application.processIdentifier), @"appName": application.localizedName ?: @"",
    @"appId": application.bundleIdentifier ?: @"" };
}
struct InputCounts { uint32_t clicks = 0, keystrokes = 0, scrolls = 0; };
std::mutex inputMutex;
std::array<InputCounts, 3> inputMailbox{};
uint64_t inputGeneration = 0;
bool inputWakeScheduled = false;
const std::array<const char *, 3> inputOrigins = {"hid_reported", "synthetic_reported", "unknown"};
void ClearInputMailbox() {
  std::lock_guard<std::mutex> lock(inputMutex);
  inputMailbox = {}; inputGeneration = requestedGeneration.load(); inputWakeScheduled = false;
}
std::mutex transitionMutex;
NSDictionary *nextApplication = nil;
uint64_t nextApplicationGeneration = 0;
bool transitionScheduled = false;
AXObserverRef accessibilityObserver = nullptr;
AXUIElementRef accessibilityApplication = nullptr;
AXUIElementRef focusedWindow = nullptr;
AXUIElementRef focusedElement = nullptr;
AccessibilityStatus accessibilityStatus =
    AccessibilityStatus::kPermissionRequired;
uint64_t applicationGeneration = 0;
uint64_t focusedWindowRefreshGeneration = 0;
uint64_t visualRefreshGeneration = 0;
size_t visualRefreshAttempt = 0;
bool visualRefreshScheduled = false;
void ResetVisualRefresh() { ++visualRefreshGeneration; visualRefreshAttempt = 0; visualRefreshScheduled = false; }
void RequestVisualRefresh();

// NSWorkspace activation can arrive before the activated application publishes
// its AX focused window. This bounded, activation-scoped recovery schedule is a
// CharaMate correctness heuristic, not a macOS protocol timing guarantee.
// One local batching window bounds AX/input callbacks. This is an engineering
// heuristic measured with synthetic traces, not a biological timing constant.
constexpr int64_t kObservationBatchMs = 1000;
constexpr NSUInteger kContentCharacterLimit = 4096;
constexpr std::array<int64_t, 4> kFocusedWindowRefreshDelayMs = {0, 50, 150,
                                                                 300};

std::string Utf8(NSString *value) {
  if (value == nil) return {};
  const char *text = value.UTF8String;
  return text == nullptr ? std::string() : std::string(text);
}

bool CanReadAX() { return sourceActive.load() && !sourcePaused.load() && currentGeneration == requestedGeneration.load(); }

NSString *StringAttribute(AXUIElementRef element, CFStringRef attribute) {
  if (!CanReadAX() || element == nullptr) return nil;
  CFTypeRef value = nullptr;
  const AXError result =
      AXUIElementCopyAttributeValue(element, attribute, &value);
  if (result != kAXErrorSuccess || value == nullptr) {
    if (value != nullptr) CFRelease(value);
    return nil;
  }
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

void SetCount(napi_env env, napi_value object, const char *name, uint32_t count) {
  napi_value value;
  if (napi_create_uint32(env, count, &value) == napi_ok)
    napi_set_named_property(env, object, name, value);
}

bool IsSecureElement(AXUIElementRef element) {
  NSString *subrole = StringAttribute(element, kAXSubroleAttribute);
  return [subrole isEqualToString:(__bridge NSString *)kAXSecureTextFieldSubrole];
}

void ReadFocusedContent(ActiveApplicationEvent &event) {
  event.contentStatus = "unavailable";
  event.contentTruncated = false;
  if (focusedElement == nullptr) return;
  // Check before reading any value, selected text or description.
  if (IsSecureElement(focusedElement)) {
    event.contentStatus = "protected";
    return;
  }
  NSMutableOrderedSet<NSString *> *parts = [NSMutableOrderedSet orderedSet];
  for (CFStringRef attribute : {kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute}) {
    NSString *text = StringAttribute(focusedElement, attribute);
    text = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (text.length) [parts addObject:text];
  }
  NSString *text = [[parts array] componentsJoinedByString:@" · "];
  if (!text.length) return;
  if (text.length > kContentCharacterLimit) {
    // Keep the existing UTF-16 capture limit without producing a split surrogate.
    NSUInteger end = kContentCharacterLimit;
    const unichar last = [text characterAtIndex:end - 1];
    const unichar next = [text characterAtIndex:end];
    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF)
      --end;
    text = [text substringToIndex:end];
    event.contentTruncated = true;
  }
  event.contentText = Utf8(text);
  if (!event.contentText.empty()) event.contentStatus = "available";
}

void CallJavascript(napi_env env, napi_value callback, void *, void *data) {
  std::unique_ptr<ActiveApplicationEvent> event(
      static_cast<ActiveApplicationEvent *>(data));
  if (env == nullptr || callback == nullptr || event == nullptr) return;
  if (!sourceActive.load() || sourcePaused.load() || event->generation != requestedGeneration.load()) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  napi_value payload;
  if (napi_create_object(env, &payload) == napi_ok) {
    SetString(env, payload, "accessibilityStatus",
              AccessibilityStatusText(event->accessibilityStatus));
    SetString(env, payload, "appId", event->appId);
    SetString(env, payload, "appName", event->appName);
    SetString(env, payload, "windowTitle", event->windowTitle);
    SetString(env, payload, "actor", event->actor);
    SetString(env, payload, "boundary", event->boundary);
    SetString(env, payload, "lifecycle", event->lifecycle);
    SetString(env, payload, "contentStatus", event->contentStatus);
    SetString(env, payload, "visualStatus", event->visualStatus);
    SetString(env, payload, "observedAt", event->observedAt);
    if (!event->surfaceJSON.empty()) {
      napi_value global, json, parse, text, surface;
      napi_get_global(env, &global);
      napi_get_named_property(env, global, "JSON", &json);
      napi_get_named_property(env, json, "parse", &parse);
      napi_create_string_utf8(env, event->surfaceJSON.c_str(), event->surfaceJSON.size(), &text);
      if (napi_call_function(env, json, parse, 1, &text, &surface) == napi_ok)
        napi_set_named_property(env, payload, "surface", surface);
    }
    if (!event->contentText.empty()) {
      napi_value content;
      if (napi_create_object(env, &content) == napi_ok) {
        SetString(env, content, "source", "accessibility");
        SetString(env, content, "scope", "focused_element");
        SetString(env, content, "text", event->contentText);
        if (event->contentTruncated) {
          napi_value truncated;
          if (napi_get_boolean(env, true, &truncated) == napi_ok)
            napi_set_named_property(env, content, "truncated", truncated);
        }
        napi_set_named_property(env, payload, "content", content);
      }
    }
    if (event->clicks || event->keystrokes || event->scrolls) {
      napi_value interaction;
      if (napi_create_object(env, &interaction) == napi_ok) {
        SetCount(env, interaction, "clicks", event->clicks);
        SetCount(env, interaction, "keystrokes", event->keystrokes);
        SetCount(env, interaction, "scrolls", event->scrolls);
        napi_set_named_property(env, payload, "interaction", interaction);
        SetString(env, payload, "inputOrigin", event->inputOrigin);
      }
    }
    napi_value receiver;
    if (napi_get_undefined(env, &receiver) == napi_ok) {
      napi_call_function(env, receiver, callback, 1, &payload, nullptr);
    }
  }
  napi_close_handle_scope(env, scope);
}

bool ReadWindowFrame(CGRect *rect) {
  if (!CanReadAX() || !focusedWindow) return false;
  CFTypeRef p = nullptr, sizeValue = nullptr;
  AXUIElementCopyAttributeValue(focusedWindow, kAXPositionAttribute, &p);
  if (CanReadAX()) AXUIElementCopyAttributeValue(focusedWindow, kAXSizeAttribute, &sizeValue);
  CGPoint point{}; CGSize size{};
  bool valid = p && sizeValue && CFGetTypeID(p) == AXValueGetTypeID() && CFGetTypeID(sizeValue) == AXValueGetTypeID()
    && AXValueGetValue((AXValueRef)p, kAXValueTypeCGPoint, &point)
    && AXValueGetValue((AXValueRef)sizeValue, kAXValueTypeCGSize, &size) && size.width > 0 && size.height > 0;
  if (p) CFRelease(p); if (sizeValue) CFRelease(sizeValue);
  if (valid) *rect = CGRectMake(point.x, point.y, size.width, size.height);
  return valid;
}
void EmitApplication(const char *boundary = "window", const char *lifecycle = "", NSDictionary *subject = nil, bool sourceObservation = true) {
  if (sourcePaused.load() || !sourceActive.load() || currentGeneration != requestedGeneration.load()) return;
  NSDictionary *application = subject ?: currentApplication;
  if (application == nil) return;
  NSString *applicationName = application[@"appName"];
  if (applicationName.length == 0) return;
  const uint64_t expected = currentGeneration;
  auto event = std::make_shared<ActiveApplicationEvent>();
  event->generation = expected; event->accessibilityStatus = accessibilityStatus;
  event->appName = Utf8(applicationName); event->appId = Utf8(application[@"appId"]);
  event->actor = subject ? "system" : "unknown";
  event->boundary = boundary; event->lifecycle = lifecycle;
  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  NSMutableDictionary *visualSnapshot = nil;
  if (subject == nil) {
    NSString *title = StringAttribute(focusedWindow, kAXTitleAttribute) ?: @"";
    event->windowTitle = Utf8(title); ReadFocusedContent(*event);
    CGRect frame{}; bool hasFrame = ReadWindowFrame(&frame);
    visualSnapshot = [@{@"processId":application[@"processId"], @"appName":applicationName,
      @"appId":application[@"appId"] ?: @"", @"windowTitle":title,
      @"windowIdentity":focusedWindowIdentity ?: @"", @"actor":@"unknown",
      @"protected":@(event->contentStatus == "protected"),
      @"bounds":@{@"x":@(frame.origin.x),@"y":@(frame.origin.y),@"width":@(hasFrame ? frame.size.width : 0),@"height":@(hasFrame ? frame.size.height : 0)}} mutableCopy];
    // Readiness reprojects the surface; it must not consume an actual AX/input notice.
    if (sourceObservation) {
      event->clicks = pendingClicks; event->keystrokes = pendingKeystrokes; event->scrolls = pendingScrolls;
      event->inputOrigin = pendingInputOrigin;
      pendingClicks = pendingKeystrokes = pendingScrolls = 0; pendingContentChange = false;
    }
  }
  event->observedAt = Utf8([formatter stringFromDate:[NSDate date]]);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!sourceActive.load() || sourcePaused.load() || expected != requestedGeneration.load()) return;
    if (visualSnapshot) {
      UpdateVisualSource(visualSnapshot, sourceObservation, ^{ PostAX(^{ EmitApplication("window", "", nil, false); }); },
        ^{ PostAX(^{ if (expected == requestedGeneration.load()) RequestVisualRefresh(); }); });
      event->surfaceJSON = Utf8(VisualSurfaceJSON()); event->visualStatus = VisualSourceStatus();
    }
    auto delivered = std::make_unique<ActiveApplicationEvent>(*event);
    if (callbackFunction && napi_call_threadsafe_function(callbackFunction, delivered.get(), napi_tsfn_nonblocking) == napi_ok) delivered.release();
  });
}

void CancelObservationTimer() {
  if (observationTimer != nil) {
    dispatch_source_cancel(observationTimer);
    observationTimer = nil;
  }
}

void FlushObservation() {
  CancelObservationTimer();
  std::array<InputCounts, 3> inputs{};
  { std::lock_guard<std::mutex> lock(inputMutex);
    if (inputGeneration == currentGeneration) inputs = inputMailbox;
    inputMailbox = {}; inputWakeScheduled = false;
  }
  bool delivered = false;
  for (size_t i = 0; i < inputs.size(); ++i) {
    const auto &counts = inputs[i];
    if (!counts.clicks && !counts.keystrokes && !counts.scrolls) continue;
    pendingClicks = counts.clicks; pendingKeystrokes = counts.keystrokes; pendingScrolls = counts.scrolls;
    pendingInputOrigin = inputOrigins[i];
    EmitApplication(pendingContentChange ? "content" : "interaction"); delivered = true;
  }
  if (!delivered && pendingContentChange) EmitApplication("content");
}

void ScheduleObservation() {
  if (observationTimer != nil || !CanReadAX()) return;
  observationTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  dispatch_source_set_timer(observationTimer,
    dispatch_time(DISPATCH_TIME_NOW, kObservationBatchMs * NSEC_PER_MSEC), DISPATCH_TIME_FOREVER, 0);
  dispatch_source_set_event_handler(observationTimer, ^{ PostAX(^{ @autoreleasepool { FlushObservation(); } }); });
  dispatch_resume(observationTimer);
}

void CountInput(NSEvent *event) {
  if (sourcePaused.load() || !sourceActive.load()) return;
  // These fields report origin, not human identity; no characters or keyCode are read.
  CGEventRef cg = event.CGEvent;
  const int64_t pid = cg ? CGEventGetIntegerValueField(cg, kCGEventSourceUnixProcessID) : -1;
  const int64_t state = cg ? CGEventGetIntegerValueField(cg, kCGEventSourceStateID) : -1;
  const size_t origin = cg && pid == 0 && state == kCGEventSourceStateHIDSystemState ? 0 : cg && pid > 0 ? 1 : 2;
  const uint64_t expected = requestedGeneration.load();
  bool wake = false;
  { std::lock_guard<std::mutex> lock(inputMutex);
    if (inputGeneration != expected) { inputMailbox = {}; inputGeneration = expected; inputWakeScheduled = false; }
    auto &counts = inputMailbox[origin]; uint32_t *count = nullptr;
    switch (event.type) {
      case NSEventTypeKeyDown: count = &counts.keystrokes; break;
      case NSEventTypeLeftMouseDown: case NSEventTypeRightMouseDown: case NSEventTypeOtherMouseDown: count = &counts.clicks; break;
      case NSEventTypeScrollWheel: count = &counts.scrolls; break;
      default: return;
    }
    if (*count < std::numeric_limits<uint32_t>::max()) ++*count;
    if (!inputWakeScheduled) { inputWakeScheduled = true; wake = true; }
  }
  if (wake) PostAX(^{
    if (sourcePaused.load() || expected != currentGeneration || expected != requestedGeneration.load()) return;
    ScheduleObservation();
  });
}

void RemoveFocusedElement() {
  if (focusedElement == nullptr) return;
  if (accessibilityObserver != nullptr) {
    AXObserverRemoveNotification(accessibilityObserver, focusedElement, kAXValueChangedNotification);
    AXObserverRemoveNotification(accessibilityObserver, focusedElement, kAXSelectedTextChangedNotification);
  }
  CFRelease(focusedElement);
  focusedElement = nullptr;
}

void ObserveFocusedElement() {
  RemoveFocusedElement();
  if (!CanReadAX() || accessibilityApplication == nullptr || accessibilityObserver == nullptr) return;
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(accessibilityApplication, kAXFocusedUIElementAttribute, &value) == kAXErrorSuccess &&
      value != nullptr && CFGetTypeID(value) == AXUIElementGetTypeID()) {
    focusedElement = static_cast<AXUIElementRef>(value);
    if (!CanReadAX()) return;
    if (!IsSecureElement(focusedElement)) {
      AXObserverAddNotification(accessibilityObserver, focusedElement, kAXValueChangedNotification, nullptr);
      AXObserverAddNotification(accessibilityObserver, focusedElement, kAXSelectedTextChangedNotification, nullptr);
    }
  } else if (value != nullptr) CFRelease(value);
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
  RemoveFocusedElement();
  if (accessibilityObserver != nullptr && focusedWindow != nullptr) {
    AXObserverRemoveNotification(accessibilityObserver, focusedWindow,
                                 kAXTitleChangedNotification);
    AXObserverRemoveNotification(accessibilityObserver, focusedWindow, kAXMovedNotification);
    AXObserverRemoveNotification(accessibilityObserver, focusedWindow, kAXResizedNotification);
  }
  if (accessibilityObserver != nullptr &&
      accessibilityApplication != nullptr) {
    AXObserverRemoveNotification(accessibilityObserver,
                                 accessibilityApplication,
                                 kAXFocusedWindowChangedNotification);
    AXObserverRemoveNotification(accessibilityObserver, accessibilityApplication,
                                 kAXFocusedUIElementChangedNotification);
  }
  if (accessibilityObserver != nullptr) {
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(),
                          AXObserverGetRunLoopSource(accessibilityObserver),
                          kCFRunLoopCommonModes);
  }
  if (focusedWindow != nullptr) {
    CFRelease(focusedWindow);
    focusedWindow = nullptr;
    focusedWindowIdentity = nil;
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
  if (!CanReadAX() || accessibilityApplication == nullptr || accessibilityObserver == nullptr) return;
  AXUIElementRef previous = focusedWindow;
  if (previous) {
    AXObserverRemoveNotification(accessibilityObserver, previous, kAXTitleChangedNotification);
    AXObserverRemoveNotification(accessibilityObserver, previous, kAXMovedNotification);
    AXObserverRemoveNotification(accessibilityObserver, previous, kAXResizedNotification);
  }
  focusedWindow = nullptr;
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(accessibilityApplication, kAXFocusedWindowAttribute, &value) == kAXErrorSuccess
      && value && CFGetTypeID(value) == AXUIElementGetTypeID()) {
    focusedWindow = static_cast<AXUIElementRef>(value);
    if (!previous || !CFEqual(previous, focusedWindow)) { focusedWindowIdentity = NSUUID.UUID.UUIDString; ResetVisualRefresh(); }
    if (!CanReadAX()) { if (previous) CFRelease(previous); return; }
    AXObserverAddNotification(accessibilityObserver, focusedWindow, kAXTitleChangedNotification, nullptr);
    AXObserverAddNotification(accessibilityObserver, focusedWindow, kAXMovedNotification, nullptr);
    AXObserverAddNotification(accessibilityObserver, focusedWindow, kAXResizedNotification, nullptr);
  } else { if (value) CFRelease(value); focusedWindowIdentity = nil; }
  if (previous) CFRelease(previous);
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
  ObserveFocusedElement();
  if (HasFocusedWindowTitle()) {
    ++focusedWindowRefreshGeneration;
    EmitApplication("window", "", nil, false);
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
    PostAX(refresh);
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs * NSEC_PER_MSEC),
                 dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ PostAX(refresh); });
}

// Reuse the existing bounded source-recovery schedule for AX/compositor skew.
// No match remains unavailable if this schedule is exhausted; a later actual
// source change starts a new source generation rather than guessing a window.
void RequestVisualRefresh() {
  if (!CanReadAX() || visualRefreshScheduled || visualRefreshAttempt >= kFocusedWindowRefreshDelayMs.size()) return;
  const uint64_t sourceGeneration = currentGeneration, refreshGeneration = visualRefreshGeneration;
  const int64_t delayMs = kFocusedWindowRefreshDelayMs[visualRefreshAttempt++];
  visualRefreshScheduled = true;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs * NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    PostAX(^{
      if (!CanReadAX() || sourceGeneration != currentGeneration || refreshGeneration != visualRefreshGeneration) return;
      visualRefreshScheduled = false; EmitApplication("window", "", nil, false);
    });
  });
}

void StartFocusedWindowRefresh() {
  const uint64_t refreshGeneration = ++focusedWindowRefreshGeneration;
  ScheduleFocusedWindowRefresh(applicationGeneration, refreshGeneration, 0);
}

void AccessibilityChanged(AXObserverRef observer, AXUIElementRef,
                          CFStringRef notification, void *) {
  @autoreleasepool {
    if (sourcePaused.load() || !sourceActive.load() || currentGeneration != requestedGeneration.load() || observer != accessibilityObserver) return;
    if (CFEqual(notification, kAXValueChangedNotification) ||
        CFEqual(notification, kAXSelectedTextChangedNotification)) {
      pendingContentChange = true;
      ScheduleObservation();
      return;
    }
    FlushObservation();
    if (CFEqual(notification, kAXFocusedUIElementChangedNotification)) {
      ObserveFocusedElement();
      // Focus may enter a secure AX element; invalidate its image context immediately.
      EmitApplication("content");
      return;
    }
    if (CFEqual(notification, kAXMovedNotification) || CFEqual(notification, kAXResizedNotification)) ResetVisualRefresh();
    if (CFEqual(notification, kAXFocusedWindowChangedNotification)) {
      ObserveFocusedWindow();
      ObserveFocusedElement();
    }
    EmitApplication("window");
    if (!HasFocusedWindowTitle()) StartFocusedWindowRefresh();
    else ++focusedWindowRefreshGeneration;
  }
}

void ObserveApplication(NSDictionary *application) {
  if (sourcePaused.load()) return;
  CancelObservationTimer();
  pendingClicks = pendingKeystrokes = pendingScrolls = 0; pendingContentChange = false;
  ++applicationGeneration;
  ++focusedWindowRefreshGeneration; ResetVisualRefresh();
  RemoveAccessibilityObserver();
  currentApplication = application;
  if (application == nil) return;

  if (!AXIsProcessTrusted()) {
    accessibilityStatus = AccessibilityStatus::kPermissionRequired;
    EmitApplication("application", "activated");
    return;
  }

  accessibilityApplication =
      AXUIElementCreateApplication([application[@"processId"] intValue]);
  const AXError observerResult =
      accessibilityApplication == nullptr
          ? kAXErrorFailure
          : AXObserverCreate([application[@"processId"] intValue],
                             AccessibilityChanged, &accessibilityObserver);
  if (observerResult != kAXErrorSuccess || accessibilityObserver == nullptr) {
    accessibilityStatus = AccessibilityStatus::kUnavailable;
    EmitApplication("application", "activated");
    return;
  }

  accessibilityStatus = AccessibilityStatus::kAvailable;
  AXObserverAddNotification(accessibilityObserver, accessibilityApplication,
                            kAXFocusedWindowChangedNotification, nullptr);
  AXObserverAddNotification(accessibilityObserver, accessibilityApplication,
                            kAXFocusedUIElementChangedNotification, nullptr);
  CFRunLoopAddSource(CFRunLoopGetCurrent(),
                     AXObserverGetRunLoopSource(accessibilityObserver),
                     kCFRunLoopCommonModes);
  ObserveFocusedWindow();
  ObserveFocusedElement();
  EmitApplication("application", "activated");
  if (!HasFocusedWindowTitle()) StartFocusedWindowRefresh();
}

void StopAXObservation() {
  ++applicationGeneration; ++focusedWindowRefreshGeneration; ResetVisualRefresh();
  CancelObservationTimer(); pendingClicks = pendingKeystrokes = pendingScrolls = 0; pendingContentChange = false;
  RemoveAccessibilityObserver(); currentApplication = nil;
}
void ObserveCurrent(NSRunningApplication *application) {
  const uint64_t expected = ++requestedGeneration;
  NSDictionary *snapshot = ApplicationSnapshot(application);
  ClearInputMailbox(); InvalidateVisualSource();
  bool schedule = false;
  { std::lock_guard<std::mutex> lock(transitionMutex);
    nextApplication = snapshot; nextApplicationGeneration = expected;
    if (!transitionScheduled) { transitionScheduled = true; schedule = true; }
  }
  if (!schedule) return;
  PostAX(^{
    NSDictionary *next; uint64_t generation;
    { std::lock_guard<std::mutex> lock(transitionMutex);
      next = nextApplication; generation = nextApplicationGeneration; transitionScheduled = false;
    }
    if (generation != requestedGeneration.load() || sourcePaused.load() || !sourceActive.load()) return;
    currentGeneration = generation; ObserveApplication(next);
  });
}

void StopObservation() {
  if (!sourceActive.exchange(false)) return;
  ++requestedGeneration; ClearInputMailbox(); SetVisualSourcePaused(true); SetVisualTopologyChanged(nil); InvalidateVisualSource();
  if (globalInputMonitor) [NSEvent removeMonitor:globalInputMonitor];
  if (localInputMonitor) [NSEvent removeMonitor:localInputMonitor];
  globalInputMonitor = localInputMonitor = nil;
  for (id token in @[workspaceLaunchObserver ?: NSNull.null, workspaceTerminateObserver ?: NSNull.null, workspaceActivationObserver ?: NSNull.null])
    if (token != NSNull.null) [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:token];
  workspaceLaunchObserver = workspaceTerminateObserver = workspaceActivationObserver = nil;
  if (callbackFunction) {
    auto callback = callbackFunction; callbackFunction = nullptr;
    napi_release_threadsafe_function(callback, napi_tsfn_abort);
  }
  PostAX(^{ StopAXObservation(); CFRunLoopStop(CFRunLoopGetCurrent()); });
}
struct StopWork { napi_async_work work; napi_deferred deferred; };
napi_value Stop(napi_env env, napi_callback_info) {
  if (stopPromiseReference) {
    napi_value previous; napi_get_reference_value(env, stopPromiseReference, &previous); return previous;
  }
  StopObservation();
  auto work = new StopWork(); napi_value promise, name;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_reference(env, promise, 1, &stopPromiseReference); stopPending = true;
  napi_create_string_utf8(env, "CharaMateActivityStop", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, [](napi_env, void *) { JoinAXOwner(); },
    [](napi_env env, napi_status, void *data) {
      auto work = static_cast<StopWork *>(data); stopPending = false;
      if (!environmentClosing) {
        napi_value value; napi_get_undefined(env, &value); napi_resolve_deferred(env, work->deferred, value);
      }
      napi_delete_async_work(env, work->work); delete work;
    }, work, &work->work);
  napi_queue_async_work(env, work->work); return promise;
}

napi_value ThrowError(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value SetPaused(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; bool next;
  if (napi_get_cb_info(env,info,&count,args,nullptr,nullptr) != napi_ok || count != 1 || napi_get_value_bool(env,args[0],&next) != napi_ok)
    return ThrowError(env,"setPaused requires a boolean");
  bool previous = sourcePaused.exchange(next);
  SetVisualSourcePaused(next);
  if (previous != next && sourceActive.load()) {
    ++requestedGeneration; ClearInputMailbox();
    if (next) PostAX(^{ StopAXObservation(); });
    else ObserveCurrent(NSWorkspace.sharedWorkspace.frontmostApplication);
  }
  napi_value result; napi_get_undefined(env,&result); return result;
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
  if (callbackFunction != nullptr || !axJoined.load() || stopPending) {
    return ThrowError(env, "the active application observer is already active");
  }

  if (stopPromiseReference) { napi_delete_reference(env, stopPromiseReference); stopPromiseReference = nullptr; }
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
  StartAXOwner(); sourceActive.store(true);

  @autoreleasepool {
    NSNotificationCenter *notificationCenter =
        NSWorkspace.sharedWorkspace.notificationCenter;
    workspaceLaunchObserver = [notificationCenter
        addObserverForName:NSWorkspaceDidLaunchApplicationNotification object:nil
        queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
          NSDictionary *application = ApplicationSnapshot(notification.userInfo[NSWorkspaceApplicationKey]);
          PostAX(^{ EmitApplication("application", "launched", application); });
        }];
    workspaceTerminateObserver = [notificationCenter
        addObserverForName:NSWorkspaceDidTerminateApplicationNotification object:nil
        queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
          NSDictionary *application = ApplicationSnapshot(notification.userInfo[NSWorkspaceApplicationKey]);
          PostAX(^{ EmitApplication("application", "terminated", application); });
        }];
    const NSEventMask inputMask = NSEventMaskKeyDown | NSEventMaskLeftMouseDown |
      NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown | NSEventMaskScrollWheel;
    globalInputMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:inputMask handler:^(NSEvent *event) { CountInput(event); }];
    localInputMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:inputMask handler:^NSEvent *(NSEvent *event) { CountInput(event); return event; }];
    workspaceActivationObserver = [notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(NSNotification *notification) {
                  NSRunningApplication *application =
                      notification.userInfo[NSWorkspaceApplicationKey];
                  ObserveCurrent(application);
                }];
    SetVisualTopologyChanged(^{ if (!sourcePaused.load()) ObserveCurrent(NSWorkspace.sharedWorkspace.frontmostApplication); });
    if (!sourcePaused.load()) ObserveCurrent(NSWorkspace.sharedWorkspace.frontmostApplication);
  }

  napi_value stopFunction;
  if (napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr,
                           &stopFunction) != napi_ok) {
    StopObservation();
    return ThrowError(env, "unable to create observer stop function");
  }
  return stopFunction;
}

void Cleanup(void *) { environmentClosing = true; StopObservation(); JoinAXOwner(); }

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
      {"subscribe", nullptr, Subscribe, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"setPaused", nullptr, SetPaused, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok ||
      napi_add_env_cleanup_hook(env, Cleanup, nullptr) != napi_ok) {
    return ThrowError(env, "unable to initialize active application observer");
  }
  InstallVisualSource(env, exports);
  return exports;
}
