const PIXEL_BYTES = 4;
const BACKGROUND_DISTANCE = 96;

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function borderColor(
  bitmap: Buffer,
  width: number,
  height: number,
): readonly [number, number, number] {
  const channels = [[], [], []] as [number[], number[], number[]];
  const sample = (x: number, y: number) => {
    const offset = (y * width + x) * PIXEL_BYTES;
    channels[0].push(bitmap[offset] ?? 0);
    channels[1].push(bitmap[offset + 1] ?? 0);
    channels[2].push(bitmap[offset + 2] ?? 0);
  };
  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }
  return channels.map(median) as [number, number, number];
}

export function removeConnectedImageBackground(
  source: Buffer,
  width: number,
  height: number,
): Buffer {
  if (
    width < 1 ||
    height < 1 ||
    source.byteLength !== width * height * PIXEL_BYTES
  ) {
    throw new Error("Unexpected native bitmap dimensions.");
  }

  const bitmap = Buffer.from(source);
  const background = borderColor(bitmap, width, height);
  const visited = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (x: number, y: number) => {
    const index = y * width + x;
    if (visited[index] === 1) return;
    visited[index] = 1;
    const offset = index * PIXEL_BYTES;
    const distance =
      Math.abs((bitmap[offset] ?? 0) - background[0]) +
      Math.abs((bitmap[offset + 1] ?? 0) - background[1]) +
      Math.abs((bitmap[offset + 2] ?? 0) - background[2]);
    if (distance > BACKGROUND_DISTANCE && bitmap[offset + 3] !== 0) return;
    queue[tail] = index;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    if (height > 1) enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    if (width > 1) enqueue(width - 1, y);
  }

  while (head < tail) {
    const index = queue[head];
    head += 1;
    if (index === undefined) break;
    bitmap[index * PIXEL_BYTES + 3] = 0;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }
  return bitmap;
}
