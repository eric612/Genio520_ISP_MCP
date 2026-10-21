"""Explicit verified BT601 full-range NV21 adapter; no hidden OpenCV limited-range conversion."""
import numpy as np


def dimensions(width, height):
    if not isinstance(width, int) or not isinstance(height, int) or min(width, height) < 2 or width % 2 or height % 2:
        raise ValueError('Positive even NV21 dimensions required')


def rounded(values):
    # Match JavaScript Math.round for these nonnegative clipped output code values.
    return np.floor(np.clip(values, 0, 255) + 0.5).astype(np.uint8)


def decode(data, width, height):
    dimensions(width, height)
    if len(data) != width * height * 3 // 2:
        raise ValueError('Incorrect NV21 byte count')
    src = np.frombuffer(data, np.uint8)
    y = src[:width*height].reshape(height, width).astype(np.float64)
    vu = src[width*height:].reshape(height//2, width//2, 2).astype(np.float64) - 128.0
    v, u = [np.repeat(np.repeat(vu[:, :, k], 2, axis=0), 2, axis=1) for k in (0, 1)]
    r = y + 1.402*v
    b = y + 1.772*u
    g = y - (2*.114*.886/.587)*u - (2*.299*.701/.587)*v
    return np.ascontiguousarray(rounded(np.stack([b, g, r], axis=2)))


def encode(bgr):
    if bgr.dtype != np.uint8 or bgr.ndim != 3 or bgr.shape[2] != 3:
        raise ValueError('BGR uint8 image required')
    height, width = bgr.shape[:2]
    dimensions(width, height)
    b, g, r = [bgr[:, :, k].astype(np.float64) for k in range(3)]
    y = .114*b + .587*g + .299*r
    # Average unquantized chroma over aligned 2x2 blocks, then quantize once.
    v = 128 + (r-y)/(2*.701)
    u = 128 + (b-y)/(2*.886)
    down = lambda c: c.reshape(height//2, 2, width//2, 2).mean(axis=(1, 3))
    vu = rounded(np.stack([down(v), down(u)], axis=2))
    return rounded(y).tobytes() + vu.tobytes()
