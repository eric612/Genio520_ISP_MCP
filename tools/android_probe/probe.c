/* USB deployment probe, independent of the IMG_ENHANCE algorithms. */
#include <stdio.h>
#include <stdint.h>

int main(int argc, char **argv) {
    uint8_t pixels[8];
    if (argc != 3) {
        fprintf(stderr, "usage: %s input.raw output.raw\n", argv[0]);
        return 2;
    }
    FILE *input = fopen(argv[1], "rb");
    if (input == NULL) {
        perror("open input");
        return 3;
    }
    size_t count = fread(pixels, 1, sizeof(pixels), input);
    int extra = fgetc(input);
    int read_error = ferror(input);
    fclose(input);
    if (count != sizeof(pixels) || extra != EOF || read_error) {
        fprintf(stderr, "expected exactly 8 input bytes\n");
        return 4;
    }
    for (size_t i = 0; i < sizeof(pixels); ++i) {
        unsigned value = (unsigned)pixels[i] * 2u;
        pixels[i] = (uint8_t)(value > 255u ? 255u : value);
    }
    FILE *output = fopen(argv[2], "wb");
    if (output == NULL) {
        perror("open output");
        return 5;
    }
    size_t written = fwrite(pixels, 1, sizeof(pixels), output);
    int close_error = fclose(output);
    if (written != sizeof(pixels) || close_error != 0) {
        fprintf(stderr, "failed to write output\n");
        return 6;
    }
#ifdef __aarch64__
    puts("{\"probe\":\"android-native-usb\",\"abi\":\"arm64-v8a\",\"pixels\":8,\"status\":\"ok\"}");
    return 0;
#else
    fprintf(stderr, "this probe requires an ARM64 build\n");
    return 7;
#endif
}
