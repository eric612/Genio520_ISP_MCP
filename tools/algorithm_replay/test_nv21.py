import unittest
import numpy as np
from nv21 import decode, encode


class ColorContract(unittest.TestCase):
    def test_neutral_endpoints_and_exact_neutral_roundtrip(self):
        for y in [0, 16, 128, 235, 255]:
            data = bytes([y]*16 + [128]*8)
            bgr = decode(data, 4, 4)
            self.assertTrue(np.all(bgr == y))
            self.assertEqual(encode(bgr), data)

    def test_vu_order_and_full_range_red_patch(self):
        bgr = decode(bytes([76]*16 + [255, 85]*4), 4, 4)
        self.assertGreater(int(bgr[:, :, 2].mean()), 250)
        self.assertLess(int(bgr[:, :, 0].mean()), 3)
        swapped = decode(bytes([76]*16 + [85, 255]*4), 4, 4)
        self.assertGreater(int(swapped[:, :, 0].mean()), 250)

    def test_encode_averages_spatial_chroma_instead_of_taking_one_corner(self):
        image = np.zeros((2, 2, 3), np.uint8)
        image[0, 0] = [0, 0, 255]
        image[1, 1] = [255, 0, 0]
        data = encode(image)
        self.assertEqual(len(data), 6)
        self.assertNotEqual(data[4:], encode(np.full_like(image, image[0, 0]))[4:])

    def test_invalid_layout_is_rejected(self):
        with self.assertRaises(ValueError):
            decode(bytes(12), 3, 2)
        with self.assertRaises(ValueError):
            decode(bytes(15), 4, 4)
        with self.assertRaises(ValueError):
            encode(np.zeros((4, 4, 3), np.float32))


if __name__ == '__main__':
    unittest.main()
