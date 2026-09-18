#pragma once
#include <node_api.h>
#import <AppKit/AppKit.h>

// Immutable AX snapshot is prepared by the Activity AX owner. No AX messaging on main.
// Lifecycle calls remain on main; frame/OCR work does not.
void UpdateVisualSource(NSDictionary *snapshot, bool sourceObservation, void (^ready)(void), void (^missingWindow)(void));
void SetVisualSourcePaused(bool paused);
void SetVisualTopologyChanged(void (^changed)(void));
NSString *VisualSurfaceJSON();
const char *VisualSourceStatus();
void InvalidateVisualSource();
void InstallVisualSource(napi_env env, napi_value exports);
