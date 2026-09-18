#include "macos-visual-source.h"
#include "macos-visual-geometry.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <Vision/Vision.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <mach/mach_time.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include <cstring>

namespace {
std::atomic<uint64_t> generation{0};
std::atomic<uint64_t> availabilityRevision{0};
bool paused = false;
bool screenPermissionRequested = false;
napi_threadsafe_function changeCallback = nullptr;
NSString *binding = nil;
bool bindingFailed = false;
void FailBinding(uint64_t expected, void (^ready)(void));
NSDictionary *surface = nil;
NSString *actor = @"unknown";
std::atomic_bool changeScheduled{false};
void (^topologyChanged)(void) = nil;
uint64_t topologyRevision = 0;
NSString *sourceStatus = @"unavailable";
SCStream *stream = nil;
void (^refreshBinding)(void) = nil;
dispatch_queue_t captureQueue = dispatch_queue_create("CharaMateVisualFrames", DISPATCH_QUEUE_SERIAL);
dispatch_group_t stopping = dispatch_group_create();
std::mutex frameMutex;
struct Frame {
  CVPixelBufferRef pixels;
  NSDictionary *surface;
  NSString *actor;
  NSDate *capturedAt;
  NSDate *receivedAt;
  uint64_t generation, sequence, availability;
  Frame(CVPixelBufferRef p, NSDictionary *s, NSString *a, NSDate *c, NSDate *r, uint64_t g, uint64_t n)
      : pixels(CVPixelBufferRetain(p)), surface(s), actor(a), capturedAt(c), receivedAt(r), generation(g), sequence(n), availability(availabilityRevision.load()) {}
  ~Frame() { CVPixelBufferRelease(pixels); }
};
std::shared_ptr<Frame> latest;
uint64_t sequence = 0;
uint64_t consumedSequence = 0;
NSString *JSONString(id value) {
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  return bytes ? [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding] : nil;
}
NSString *Timestamp(NSDate *date) {
  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:date];
}
bool SamePixels(CVPixelBufferRef left, CVPixelBufferRef right) {
  if (CVPixelBufferGetWidth(left) != CVPixelBufferGetWidth(right) || CVPixelBufferGetHeight(left) != CVPixelBufferGetHeight(right)) return false;
  if (CVPixelBufferLockBaseAddress(left, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return false;
  if (CVPixelBufferLockBaseAddress(right, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
    CVPixelBufferUnlockBaseAddress(left, kCVPixelBufferLock_ReadOnly); return false;
  }
  bool same = true;
  const auto *a = (const uint8_t *)CVPixelBufferGetBaseAddress(left);
  const auto *b = (const uint8_t *)CVPixelBufferGetBaseAddress(right);
  size_t bytes = CVPixelBufferGetWidth(left) * 4;
  if (!a || !b) same = false;
  else for (size_t row = 0; row < CVPixelBufferGetHeight(left); ++row)
    if (std::memcmp(a + row * CVPixelBufferGetBytesPerRow(left), b + row * CVPixelBufferGetBytesPerRow(right), bytes) != 0) { same = false; break; }
  CVPixelBufferUnlockBaseAddress(right, kCVPixelBufferLock_ReadOnly);
  CVPixelBufferUnlockBaseAddress(left, kCVPixelBufferLock_ReadOnly);
  return same;
}
struct Change { NSString *json; };
void NotifyChange(const std::shared_ptr<Frame> &frame) {
  // Deliver metadata only; one queued notice suffices because capture keeps the newest pixels.
  if (!changeCallback) return;
  auto change = std::make_unique<Change>();
  change->json = JSONString(@{@"surface":frame->surface,@"actor":frame->actor,
    @"capturedAt":Timestamp(frame->capturedAt),@"sequence":@(frame->sequence)});
  if (napi_call_threadsafe_function(changeCallback, change.get(), napi_tsfn_nonblocking) == napi_ok) change.release();
}
void ClearFrame() { std::lock_guard<std::mutex> lock(frameMutex); ++availabilityRevision; latest.reset(); consumedSequence = 0; }
void StopStream() {
  SCStream *old = stream;
  stream = nil;
  if (!old) return;
  dispatch_group_enter(stopping);
  [old stopCaptureWithCompletionHandler:^(NSError *) { dispatch_group_leave(stopping); }];
}

}

@interface CharaMateVisualOutput : NSObject<SCStreamOutput, SCStreamDelegate>
@property(nonatomic) uint64_t generation;
@property(nonatomic, strong) NSDictionary *surface;
@property(nonatomic, strong) NSString *actor;
@property(nonatomic, copy) void (^ready)(void);
@end
@implementation CharaMateVisualOutput
- (void)stream:(SCStream *)source didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
  (void)source;
  if (type != SCStreamOutputTypeScreen || self.generation != generation.load() || !CMSampleBufferIsValid(buffer)) return;
  NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(buffer, false);
  NSDictionary *info = attachments.firstObject;
  SCFrameStatus status = (SCFrameStatus)[info[SCStreamFrameInfoStatus] integerValue];
  if (status != SCFrameStatusComplete) {
    if (status == SCFrameStatusBlank || status == SCFrameStatusSuspended || status == SCFrameStatusStopped) {
      ClearFrame();
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self.generation == generation.load() && ![sourceStatus isEqualToString:@"unavailable"]) {
          sourceStatus = @"unavailable"; if (self.ready) self.ready();
        }
      });
    }
    return;
  }
  CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(buffer);
  if (!pixels) return;
  NSDate *received = [NSDate date];
  uint64_t displayTime = [info[SCStreamFrameInfoDisplayTime] unsignedLongLongValue];
  if (!displayTime) return; // Do not invent a capture time from a delayed callback.
  mach_timebase_info_data_t timebase; mach_timebase_info(&timebase);
  double age = ((double)mach_absolute_time() - (double)displayTime) * timebase.numer / timebase.denom / 1e9;
  NSDate *captured = [received dateByAddingTimeInterval:-age];
  bool first = false, changed = false;
  std::shared_ptr<Frame> observed;
  {
    std::lock_guard<std::mutex> lock(frameMutex);
    if (self.generation != generation.load()) return;
    first = !latest;
    changed = first || !SamePixels(latest->pixels, pixels);
    latest = std::make_shared<Frame>(pixels, self.surface, self.actor, captured, received, self.generation, ++sequence);
    observed = latest;
  }
  if (changed && !changeScheduled.exchange(true)) dispatch_async(dispatch_get_main_queue(), ^{
    changeScheduled.store(false);
    // Take only the newest metadata when main can run. Queued blocks do not retain pixel buffers.
    std::shared_ptr<Frame> current;
    { std::lock_guard<std::mutex> lock(frameMutex); current = latest; }
    if (current && current->generation == generation.load() && current->availability == availabilityRevision.load()) NotifyChange(current);
  });
  // Only readiness is an application event; subsequent frames are a bounded pixel buffer.
  if (first && self.ready) {
    const uint64_t frameGeneration = observed->generation, frameAvailability = observed->availability;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (frameGeneration == generation.load() && frameAvailability == availabilityRevision.load()) { sourceStatus = @"available"; self.ready(); }
    });
  }
}
- (void)stream:(SCStream *)source didStopWithError:(NSError *)error {
  (void)source; (void)error;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.generation != generation.load()) return;
    FailBinding(self.generation, self.ready);
  });
}
@end

namespace {
CharaMateVisualOutput *output = nil;
void FailBinding(uint64_t expected, void (^ready)(void)) {
  if (expected != generation.load()) return;
  ++generation; bindingFailed = true; surface = nil; sourceStatus = @"unavailable";
  ClearFrame(); StopStream(); output = nil;
  if (ready) ready();
}
}
void InvalidateVisualSource() {
  ++generation; binding = nil; bindingFailed = false; surface = nil; sourceStatus = @"unavailable";
  ClearFrame(); StopStream(); output = nil;
}
NSString *VisualSurfaceJSON() { return surface ? JSONString(surface) : nil; }
const char *VisualSourceStatus() { return sourceStatus.UTF8String; }
void UpdateVisualSource(NSDictionary *snapshot, bool sourceObservation, void (^ready)(void), void (^missingWindow)(void)) {
  refreshBinding = ready;
  NSDictionary *rect = snapshot[@"bounds"];
  CGRect windowRect = CGRectMake([rect[@"x"] doubleValue], [rect[@"y"] doubleValue], [rect[@"width"] doubleValue], [rect[@"height"] doubleValue]);
  NSString *title = snapshot[@"windowTitle"] ?: @"";
  NSString *nextActor = snapshot[@"actor"] ?: @"unknown";
  bool protectedContent = [snapshot[@"protected"] boolValue];
  pid_t processId = [snapshot[@"processId"] intValue];
  bool valid = processId > 0 && windowRect.size.width > 0 && windowRect.size.height > 0 && [snapshot[@"windowIdentity"] length] > 0;
  NSString *next = [NSString stringWithFormat:@"%d|%@|%@|%@|%@|%d|%d|%llu", processId,
    snapshot[@"windowIdentity"], NSStringFromRect(windowRect), title, nextActor, protectedContent, paused, topologyRevision];
  // A failed stream can be retried by a new observation, never its own readiness notice.
  if ([binding isEqualToString:next] && !(bindingFailed && sourceObservation)) return;
  InvalidateVisualSource(); binding = next; actor = nextActor;
  if (paused || protectedContent || !valid) { sourceStatus = protectedContent ? @"protected" : @"unavailable"; return; }
  if (@available(macOS 13.0, *)) {
    if (!CGPreflightScreenCaptureAccess()) {
      if (!screenPermissionRequested) { screenPermissionRequested = true; CGRequestScreenCaptureAccess(); }
      if (!CGPreflightScreenCaptureAccess()) return;
    }
    const uint64_t expected = generation.load();
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (expected != generation.load()) return;
        if (error || !content) { FailBinding(expected, ready); return; }
        SCWindow *matched = nil;
        for (SCWindow *candidate in content.windows) {
          if (candidate.owningApplication.processID != processId || !CGRectEqualToRect(candidate.frame, windowRect)) continue;
          if (matched) return; // Ambiguous identity is unavailable, never a guessed main-screen capture.
          matched = candidate;
        }
        if (!matched) {
          // AX can precede the compositor transition. Do not cache a failed match.
          binding = nil; if (missingWindow) missingWindow(); return;
        }
        std::vector<CGRect> displayFrames;
        for (SCDisplay *candidate in content.displays) displayFrames.push_back(candidate.frame);
        auto region = SelectVisibleDisplayRegion(windowRect, displayFrames);
        if (!region) return;
        SCDisplay *display = content.displays[region->index]; CGRect visible = region->globalRect;
        CGFloat scale = 0;
        for (NSScreen *screen in NSScreen.screens)
          if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == display.displayID) scale = screen.backingScaleFactor;
        if (!(scale > 0)) return;
        NSString *epoch = NSUUID.UUID.UUIDString;
        NSMutableDictionary *metadata = [@{
          @"id": [NSString stringWithFormat:@"display:%u/window:%u", display.displayID, matched.windowID],
          @"epoch": epoch, @"displayId": [NSString stringWithFormat:@"%u", display.displayID],
          @"windowId": [NSString stringWithFormat:@"%u", matched.windowID],
          @"processId": @(processId), @"appName": snapshot[@"appName"] ?: @"Unknown application",
          @"bounds": @{@"x": @(visible.origin.x), @"y": @(visible.origin.y), @"width": @(visible.size.width), @"height": @(visible.size.height)},
          @"scaleFactor": @(scale), @"clipped": @(!CGRectEqualToRect(visible, windowRect))
        } mutableCopy];
        if ([snapshot[@"appId"] length]) metadata[@"appId"] = snapshot[@"appId"];
        if (title.length) metadata[@"windowTitle"] = title;
        surface = [metadata copy];
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        SCStreamConfiguration *configuration = [SCStreamConfiguration new];
        configuration.sourceRect = region->sourceRect;
        configuration.width = (size_t)ceil(visible.size.width * scale);
        configuration.height = (size_t)ceil(visible.size.height * scale);
        configuration.pixelFormat = kCVPixelFormatType_32BGRA;
        configuration.showsCursor = NO;
        configuration.capturesAudio = NO;
        // 5 fps bounds capture work, not attention or model cadence; measured in the Decision record.
        configuration.minimumFrameInterval = CMTimeMake(1, 5);
        configuration.queueDepth = 3;
        output = [CharaMateVisualOutput new]; output.generation = expected;
        output.surface = surface; output.actor = nextActor; output.ready = ready;
        stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:output];
        NSError *addError = nil;
        if (![stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:captureQueue error:&addError]) {
          FailBinding(expected, ready); return;
        }
        SCStream *starting = stream;
        dispatch_group_enter(stopping);
        [starting startCaptureWithCompletionHandler:^(NSError *startError) {
          dispatch_async(dispatch_get_main_queue(), ^{
            if (expected != generation.load()) {
              [starting stopCaptureWithCompletionHandler:^(NSError *) { dispatch_group_leave(stopping); }];
              return;
            }
            if (startError) FailBinding(expected, ready);
            else if (ready) ready();
            dispatch_group_leave(stopping);
          });
        }];
      });
    }];
  }
}

namespace {
napi_value Undefined(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
napi_value JSObject(napi_env env, NSString *json) {
  napi_value global, object, parse, text, result;
  napi_get_global(env, &global); napi_get_named_property(env, global, "JSON", &object);
  napi_get_named_property(env, object, "parse", &parse);
  napi_create_string_utf8(env, json.UTF8String, NAPI_AUTO_LENGTH, &text);
  if (napi_call_function(env, object, parse, 1, &text, &result) != napi_ok) return Undefined(env);
  return result;
}
struct Work {
  napi_async_work work; napi_deferred deferred;
  std::shared_ptr<Frame> frame;
  NSData *input = nil, *png = nil;
  NSArray *regions = nil;
  NSDictionary *metadata = nil;
  std::string error;
  uint64_t coalesced = 0;
  enum Kind { OCR, MASK, STOP } kind;
};
NSData *EncodePNG(CGImageRef image) {
  NSMutableData *png = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, CFSTR("public.png"), 1, nullptr);
  if (!destination) return nil;
  CGImageDestinationAddImage(destination, image, nullptr);
  bool ok = CGImageDestinationFinalize(destination); CFRelease(destination);
  return ok ? png : nil;
}
void Execute(napi_env, void *data) {
  Work *work = (Work *)data;
  @autoreleasepool {
    if (work->kind == Work::STOP) { dispatch_group_wait(stopping, DISPATCH_TIME_FOREVER); return; }
    if (work->kind == Work::MASK) {
      CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)work->input, nullptr);
      CGImageRef image = source ? CGImageSourceCreateImageAtIndex(source, 0, nullptr) : nullptr;
      if (source) CFRelease(source);
      if (!image) { work->error = "Invalid visual PNG"; return; }
      size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
      CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
      CGContextRef canvas = CGBitmapContextCreate(nullptr, width, height, 8, width * 4, colors, kCGImageAlphaPremultipliedLast);
      CGColorSpaceRelease(colors);
      if (!canvas) { CGImageRelease(image); work->error = "Cannot allocate visual redaction image"; return; }
      CGContextDrawImage(canvas, CGRectMake(0, 0, width, height), image);
      CGContextSetRGBFillColor(canvas, 0, 0, 0, 1);
      for (NSDictionary *box in work->regions) {
        // Vision boxes are converted to top-left at the boundary. Expand to whole pixels.
        CGFloat x = floor([box[@"x"] doubleValue] * width), y = floor((1 - [box[@"y"] doubleValue] - [box[@"height"] doubleValue]) * height);
        CGFloat w = ceil([box[@"width"] doubleValue] * width) + 2, h = ceil([box[@"height"] doubleValue] * height) + 2;
        CGContextFillRect(canvas, CGRectMake(x - 1, y - 1, w, h));
      }
      CGImageRef redacted = CGBitmapContextCreateImage(canvas); work->png = EncodePNG(redacted);
      CGImageRelease(redacted); CGContextRelease(canvas); CGImageRelease(image);
      if (!work->png) work->error = "Cannot encode redacted visual PNG";
      return;
    }
    if (!work->frame || work->frame->generation != generation.load() || work->frame->availability != availabilityRevision.load()) return;
    CIContext *context = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @NO}];
    CIImage *input = [CIImage imageWithCVPixelBuffer:work->frame->pixels];
    CGImageRef image = [context createCGImage:input fromRect:input.extent];
    if (!image) { work->error = "Cannot read visual frame"; return; }
    VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
    request.revision = VNRecognizeTextRequestRevision3;
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.recognitionLanguages = @[@"zh-Hans", @"en-US"];
    request.usesLanguageCorrection = NO;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[request] error:&error]) {
      CGImageRelease(image); work->error = "Apple Vision could not read the frame"; return;
    }
    NSMutableArray *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
      VNRecognizedText *text = [observation topCandidates:1].firstObject;
      NSString *trimmed = [text.string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (!trimmed.length) continue;
      CGRect box = observation.boundingBox;
      CGFloat x = fmax(0, box.origin.x), y = fmax(0, 1 - box.origin.y - box.size.height);
      CGFloat w = fmin(box.size.width, 1 - x), h = fmin(box.size.height, 1 - y);
      if (w <= 0 || h <= 0) continue;
      [lines addObject:@{@"text": trimmed, @"confidence": @(text.confidence), @"bounds": @{@"x": @(x), @"y": @(y), @"width": @(w), @"height": @(h)}}];
    }
    work->png = EncodePNG(image);
    work->metadata = @{
      @"actor": work->frame->actor, @"width": @(CGImageGetWidth(image)), @"height": @(CGImageGetHeight(image)),
      @"visual": @{@"surface": work->frame->surface,
        @"capturedAt": Timestamp(work->frame->capturedAt), @"receivedAt": Timestamp(work->frame->receivedAt),
        @"sequence": @(work->frame->sequence), @"coalescedFrames": @(work->coalesced),
        @"ocr": @{@"engine": @"apple_vision", @"revision": @(request.revision), @"languages": request.recognitionLanguages,
          @"status": lines.count ? @"complete" : @"empty", @"lines": lines}}
    };
    CGImageRelease(image);
    if (!work->png) work->error = "Cannot encode visual frame";
  }
}
void Complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Work> work((Work *)data);
  if (status != napi_ok || !work->error.empty()) {
    napi_value message, error;
    napi_create_string_utf8(env, work->error.empty() ? "Visual work cancelled" : work->error.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error); napi_reject_deferred(env, work->deferred, error);
  } else if (work->kind == Work::STOP || !work->png || (work->frame && (work->frame->generation != generation.load() || work->frame->availability != availabilityRevision.load()))) {
    napi_resolve_deferred(env, work->deferred, Undefined(env));
  } else {
    napi_value result, bytes;
    napi_create_buffer_copy(env, work->png.length, work->png.bytes, nullptr, &bytes);
    if (work->kind == Work::MASK) result = bytes;
    else { result = JSObject(env, JSONString(work->metadata)); napi_set_named_property(env, result, "bytes", bytes); }
    napi_resolve_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->work);
}
void ChangedJavascript(napi_env env, napi_value callback, void *, void *data) {
  std::unique_ptr<Change> change((Change *)data);
  if (!env || !callback || !change) return;
  napi_value value = JSObject(env, change->json);
  napi_value receiver = Undefined(env);
  napi_call_function(env, receiver, callback, 1, &value, nullptr);
}
void ReleaseChanges() {
  if (!changeCallback) return;
  auto callback = changeCallback; changeCallback = nullptr;
  napi_release_threadsafe_function(callback, napi_tsfn_abort);
}
napi_value UnsubscribeChanges(napi_env env, napi_callback_info) { ReleaseChanges(); return Undefined(env); }
napi_value SubscribeChanges(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_valuetype type;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1 || napi_typeof(env,args[0],&type) != napi_ok || type != napi_function || changeCallback) {
    napi_throw_type_error(env,nullptr,"One visual change callback is required"); return Undefined(env);
  }
  napi_value name; napi_create_string_utf8(env,"CharaMateVisualChanges",NAPI_AUTO_LENGTH,&name);
  if (napi_create_threadsafe_function(env,args[0],nullptr,name,1,1,nullptr,nullptr,nullptr,ChangedJavascript,&changeCallback) != napi_ok) {
    changeCallback = nullptr; napi_throw_error(env,nullptr,"Cannot observe visual changes"); return Undefined(env);
  }
  napi_unref_threadsafe_function(env,changeCallback);
  napi_value stop; napi_create_function(env,"stopVisualChanges",NAPI_AUTO_LENGTH,UnsubscribeChanges,nullptr,&stop); return stop;
}
void CleanupVisual(void *) { SetVisualTopologyChanged(nil); InvalidateVisualSource(); ReleaseChanges(); }
napi_value Queue(napi_env env, std::unique_ptr<Work> work) {
  napi_value promise, name;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_string_utf8(env, "CharaMateVisualSource", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, Execute, Complete, work.get(), &work->work);
  napi_queue_async_work(env, work->work); work.release(); return promise;
}
napi_value Pull(napi_env env, napi_callback_info) {
  auto work = std::make_unique<Work>(); work->kind = Work::OCR;
  { std::lock_guard<std::mutex> lock(frameMutex); work->frame = latest;
    if (latest) { work->coalesced = consumedSequence && latest->sequence > consumedSequence ? latest->sequence - consumedSequence - 1 : 0; consumedSequence = latest->sequence; } }
  return Queue(env, std::move(work));
}

napi_value Stop(napi_env env, napi_callback_info) {
  InvalidateVisualSource(); auto work = std::make_unique<Work>(); work->kind = Work::STOP; return Queue(env, std::move(work));
}
napi_value Mask(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; void *bytes; size_t length;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok) { napi_throw_type_error(env, nullptr, "redactVisual requires PNG and regions JSON"); return Undefined(env); }
  size_t jsonLength = 0;
  if (napi_get_value_string_utf8(env, args[1], nullptr, 0, &jsonLength) != napi_ok) { napi_throw_type_error(env, nullptr, "Invalid visual redaction regions"); return Undefined(env); }
  std::vector<char> json(jsonLength + 1); napi_get_value_string_utf8(env, args[1], json.data(), json.size(), &jsonLength);
  id regions = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json.data() length:jsonLength] options:0 error:nil];
  if (![regions isKindOfClass:NSArray.class]) { napi_throw_type_error(env, nullptr, "Invalid visual redaction regions"); return Undefined(env); }
  for (id region in regions) {
    if (![region isKindOfClass:NSDictionary.class]) { napi_throw_type_error(env, nullptr, "Invalid visual redaction box"); return Undefined(env); }
    for (NSString *key in @[@"x", @"y", @"width", @"height"]) {
      id value = region[key];
      if (![value isKindOfClass:NSNumber.class] || !isfinite([value doubleValue]) || [value doubleValue] < 0 || [value doubleValue] > 1) { napi_throw_type_error(env, nullptr, "Invalid visual redaction coordinate"); return Undefined(env); }
    }
  }
  auto work = std::make_unique<Work>(); work->kind = Work::MASK;
  work->input = [NSData dataWithBytes:bytes length:length]; work->regions = regions;
  return Queue(env, std::move(work));
}
}
void SetVisualSourcePaused(bool next) {
  if (paused == next) return;
  paused = next; InvalidateVisualSource();
}
void VisualDisplayChanged(CGDirectDisplayID, CGDisplayChangeSummaryFlags flags, void *) {
  if (flags & kCGDisplayBeginConfigurationFlag) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    ++topologyRevision; InvalidateVisualSource();
    if (topologyChanged) topologyChanged();
  });
}
void SetVisualTopologyChanged(void (^changed)(void)) {
  if (topologyChanged) CGDisplayRemoveReconfigurationCallback(VisualDisplayChanged, nullptr);
  topologyChanged = [changed copy];
  if (topologyChanged) CGDisplayRegisterReconfigurationCallback(VisualDisplayChanged, nullptr);
}
void InstallVisualSource(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"subscribeVisualChanges", nullptr, SubscribeChanges, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pullVisual", nullptr, Pull, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"redactVisual", nullptr, Mask, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stopVisual", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, properties);
  napi_add_env_cleanup_hook(env,CleanupVisual,nullptr);
}
