// Native input for the Bun host. CoreGraphics struct arguments stay in C;
// Bun's FFI boundary only carries scalars and UTF-16 buffers.
#include <ApplicationServices/ApplicationServices.h>
#include <stdbool.h>
#include <stdint.h>
#include <math.h>

static CGEventSourceRef source;
static unsigned buttons;

int relay_input_trusted(void) { return AXIsProcessTrusted(); }
int relay_input_request(void) {
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    bool trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    return trusted;
}

static CGEventSourceRef event_source(void) {
    if (!source) source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    return source;
}

static CGPoint cursor_location(void) {
    CGEventRef event = CGEventCreate(NULL);
    if (!event) return CGPointZero;
    CGPoint point = CGEventGetLocation(event);
    CFRelease(event);
    return point;
}

static void post(CGEventRef event) {
    if (event) { CGEventPost(kCGHIDEventTap, event); CFRelease(event); }
}

void relay_input_move(double dx, double dy) {
    if (!relay_input_trusted() || !isfinite(dx) || !isfinite(dy)) return;
    CGPoint point = cursor_location();
    point.x += dx; point.y += dy;
    CGDirectDisplayID displays[32]; uint32_t count = 0;
    if (CGGetActiveDisplayList(32, displays, &count) == kCGErrorSuccess && count) {
        CGRect bounds = CGDisplayBounds(displays[0]);
        for (uint32_t i = 1; i < count; i++) bounds = CGRectUnion(bounds, CGDisplayBounds(displays[i]));
        point.x = fmax(CGRectGetMinX(bounds), fmin(CGRectGetMaxX(bounds) - 1, point.x));
        point.y = fmax(CGRectGetMinY(bounds), fmin(CGRectGetMaxY(bounds) - 1, point.y));
    }
    CGEventType type = buttons & 1 ? kCGEventLeftMouseDragged :
        buttons & 2 ? kCGEventRightMouseDragged : kCGEventMouseMoved;
    post(CGEventCreateMouseEvent(event_source(), type, point,
        buttons & 2 ? kCGMouseButtonRight : kCGMouseButtonLeft));
}

void relay_input_button(int right, int down) {
    if (!relay_input_trusted()) return;
    unsigned bit = right ? 2 : 1;
    if (down) buttons |= bit; else buttons &= ~bit;
    CGEventType type = right ? (down ? kCGEventRightMouseDown : kCGEventRightMouseUp) :
        (down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp);
    post(CGEventCreateMouseEvent(event_source(), type, cursor_location(),
        right ? kCGMouseButtonRight : kCGMouseButtonLeft));
}

void relay_input_scroll(double dx, double dy) {
    if (!relay_input_trusted() || !isfinite(dx) || !isfinite(dy)) return;
    // CG scroll axes are signed integer pixels; the host model rounds deltas.
    post(CGEventCreateScrollWheelEvent(event_source(), kCGScrollEventUnitPixel, 2,
        (int32_t)dy, (int32_t)dx));
}

// Existing EventPoster callers use Linux keycodes. Preserve that contract at
// the platform boundary; Linux Ctrl shortcuts become macOS Command shortcuts.
static int mac_key(int code) {
    static const int codes[128] = {
        [1]=53, [2]=18, [3]=19, [4]=20, [5]=21, [6]=23, [7]=22,
        [8]=26, [9]=28, [10]=25, [11]=29, [12]=27, [13]=24, [14]=51,
        [15]=48, [16]=12, [17]=13, [18]=14, [19]=15, [20]=17, [21]=16,
        [22]=32, [23]=34, [24]=31, [25]=35, [26]=33, [27]=30, [28]=36,
        [29]=55, [30]=0, [31]=1, [32]=2, [33]=3, [34]=5, [35]=4,
        [36]=38, [37]=40, [38]=37, [39]=41, [40]=39, [41]=50, [42]=56,
        [43]=42, [44]=6, [45]=7, [46]=8, [47]=9, [48]=11, [49]=45,
        [50]=46, [51]=43, [52]=47, [53]=44, [54]=60, [56]=58, [57]=49,
        [97]=54, [100]=61, [103]=126, [105]=123, [106]=124, [108]=125
    };
    if (code < 1 || code >= 128) return -1;
    if (code != 30 && codes[code] == 0) return -1;
    return codes[code];
}

void relay_input_key(int code, unsigned modifiers) {
    if (!relay_input_trusted()) return;
    int key = mac_key(code);
    if (key < 0) return;
    CGEventFlags flags = 0;
    if (modifiers & 1) flags |= kCGEventFlagMaskShift;
    if (modifiers & 2) flags |= kCGEventFlagMaskCommand;
    if (modifiers & 4) flags |= kCGEventFlagMaskAlternate;
    for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(event_source(), (CGKeyCode)key, down);
        if (event) { CGEventSetFlags(event, flags); post(event); }
    }
}

void relay_input_text(const UniChar *text, unsigned length) {
    if (!relay_input_trusted()) return;
    while (length) {
        unsigned chunk = length > 20 ? 20 : length;
        if (chunk < length && text[chunk - 1] >= 0xD800 && text[chunk - 1] <= 0xDBFF) chunk--;
        for (int down = 1; down >= 0; down--) {
            CGEventRef event = CGEventCreateKeyboardEvent(event_source(), 0, down);
            if (event) { CGEventKeyboardSetUnicodeString(event, chunk, text); post(event); }
        }
        text += chunk; length -= chunk;
    }
}

void relay_input_close(void) {
    if (buttons & 1) relay_input_button(0, 0);
    if (buttons & 2) relay_input_button(1, 0);
    if (source) { CFRelease(source); source = NULL; }
}
