#pragma once

#include <CoreGraphics/CoreGraphics.h>
#include <cstddef>
#include <optional>
#include <vector>

struct VisibleDisplayRegion {
  size_t index;
  CGRect globalRect;
  CGRect sourceRect;
};

// Preserve the largest visible intersection rule. Equal intersections retain
// the supplied display order; a window outside every display has no source.
inline std::optional<VisibleDisplayRegion> SelectVisibleDisplayRegion(
    CGRect window, const std::vector<CGRect> &displays) {
  std::optional<VisibleDisplayRegion> selected;
  CGFloat area = 0;
  for (size_t i = 0; i < displays.size(); ++i) {
    CGRect visible = CGRectIntersection(displays[i], window);
    CGFloat nextArea = CGRectIsNull(visible) ? 0 : visible.size.width * visible.size.height;
    if (nextArea <= area) continue;
    area = nextArea;
    selected = VisibleDisplayRegion{i, visible,
      CGRectOffset(visible, -displays[i].origin.x, -displays[i].origin.y)};
  }
  return selected;
}
