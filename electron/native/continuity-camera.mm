/*
 * Continuity Camera for the attachment menu (macOS only).
 *
 * The paperclip opens a native context menu: "Choose File…" plus the
 * nearby iPhone/iPad's Take Photo / Scan Documents / Add Sketch, which
 * AppKit inserts itself. Electron has no API for this (electron#18382):
 * AppKit only offers those items when the view under the menu accepts an
 * image through the services system (NSServicesMenuRequestor), and
 * Chromium's RenderWidgetHostViewCocoa accepts text only. So its answer
 * is hooked: an image return type with nothing to send is handed to a
 * small responder that forwards the captured image to JS.
 *
 * Measured on macOS 26 (2026-10-28): AppKit populates a context menu
 * shown with +popUpContextMenu:withEvent:forView:, not a plain popup, and
 * not a menu carrying an NSMenuItemImportFromDeviceIdentifier placeholder.
 *
 * Built by scripts/build-continuity-camera.mjs; loaded by
 * electron/continuity-camera.cjs.
 */

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static napi_threadsafe_function gOnImage = nullptr;
static NSResponder* gResponder = nil;

/* Photos arrive as JPEG; anything else (PNG, HEIC, TIFF) is re-encoded so
 * the renderer only ever sees a format every model provider accepts. */
static NSData* JPEGFromPasteboard(NSPasteboard* pboard) {
	NSData* jpeg = [pboard dataForType:@"public.jpeg"];
	if (jpeg) return jpeg;
	NSImage* image = [[NSImage alloc] initWithPasteboard:pboard];
	if (!image) return nil;
	CGImageRef cg = [image CGImageForProposedRect:nil context:nil hints:nil];
	if (!cg) return nil;
	NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage:cg];
	return [rep representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor: @0.85}];
}

@interface LHContinuityResponder : NSResponder <NSServicesMenuRequestor>
@end

@implementation LHContinuityResponder
- (BOOL)readSelectionFromPasteboard:(NSPasteboard*)pboard {
	NSData* data = gOnImage ? JPEGFromPasteboard(pboard) : nil;
	if (!data) return NO;
	napi_call_threadsafe_function(gOnImage, (void*)CFBridgingRetain(data), napi_tsfn_nonblocking);
	return YES;
}

- (BOOL)writeSelectionToPasteboard:(NSPasteboard*)pboard types:(NSArray<NSPasteboardType>*)types {
	return NO;
}
@end

/* Menu target + delegate: records "Choose File…", and shows a hint while
 * AppKit has no device items (Bluetooth or Wi-Fi off, no phone nearby),
 * dropping it once a device appears. AppKit adds the device items after
 * the menu opens, possibly to its own copy of the menu, so our items are
 * recognized by tag and the hint is re-checked on every item added to any
 * menu, plus on a short timer while the menu tracks. */
static const NSInteger kFileTag = 0x4C4846;
static const NSInteger kHintTag = 0x4C4848;

static BOOL HasDeviceItems(NSMenu* menu) {
	for (NSMenuItem* item in menu.itemArray) {
		if (item.tag == kFileTag || item.tag == kHintTag || item.isSeparatorItem) continue;
		if (item.submenu) continue; // Services
		return YES;
	}
	return NO;
}

static void DropHintIfDevices(NSMenu* menu) {
	NSInteger index = [menu indexOfItemWithTag:kHintTag];
	if (index >= 0 && HasDeviceItems(menu)) [menu removeItemAtIndex:index];
}

@interface LHMenuController : NSObject <NSMenuDelegate>
@property(nonatomic) BOOL choseFile;
@property(nonatomic, strong) NSMenuItem* hintItem;
@property(nonatomic, strong) id addObserver;
@property(nonatomic, strong) NSTimer* timer;
@end

@implementation LHMenuController
- (void)chooseFile:(NSMenuItem*)item {
	self.choseFile = YES;
}

- (void)menuWillOpen:(NSMenu*)menu {
	if (!HasDeviceItems(menu) && [menu indexOfItemWithTag:kHintTag] < 0) [menu addItem:self.hintItem];
	self.addObserver = [NSNotificationCenter.defaultCenter addObserverForName:NSMenuDidAddItemNotification object:nil queue:nil usingBlock:^(NSNotification* note) {
		NSMenu* changed = note.object;
		// Not mid-insertion: AppKit may still be adding the device items.
		if ([changed isKindOfClass:[NSMenu class]]) dispatch_async(dispatch_get_main_queue(), ^{ DropHintIfDevices(changed); });
	}];
	__weak NSMenu* weakMenu = menu;
	self.timer = [NSTimer timerWithTimeInterval:0.1 repeats:YES block:^(NSTimer*) {
		NSMenu* strongMenu = weakMenu;
		if (strongMenu) DropHintIfDevices(strongMenu);
	}];
	[NSRunLoop.currentRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
}

- (void)menuDidClose:(NSMenu*)menu {
	if (self.addObserver) [NSNotificationCenter.defaultCenter removeObserver:self.addObserver];
	self.addObserver = nil;
	[self.timer invalidate];
	self.timer = nil;
}
@end

static void CallOnImage(napi_env env, napi_value callback, void*, void* raw) {
	NSData* data = (NSData*)CFBridgingRelease(raw);
	if (!env || !callback) return;
	napi_value buffer, global;
	void* bytes = nullptr;
	if (napi_create_buffer_copy(env, data.length, data.bytes, &bytes, &buffer) != napi_ok) return;
	napi_get_global(env, &global);
	napi_call_function(env, global, callback, 1, &buffer, nullptr);
}

static NSView* ViewFromHandle(napi_env env, napi_value handle) {
	void* data = nullptr;
	size_t length = 0;
	if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok || length < sizeof(void*)) return nil;
	return (__bridge NSView*)*reinterpret_cast<void**>(data);
}

static bool HookChromiumView() {
	Class cls = NSClassFromString(@"RenderWidgetHostViewCocoa");
	SEL sel = @selector(validRequestorForSendType:returnType:);
	Method method = cls ? class_getInstanceMethod(cls, sel) : nullptr;
	if (!method) return false;
	IMP original = method_getImplementation(method);
	IMP hooked = imp_implementationWithBlock(^id(id self, NSPasteboardType sendType, NSPasteboardType returnType) {
		id requestor = ((id(*)(id, SEL, id, id))original)(self, sel, sendType, returnType);
		if (!requestor && !sendType && returnType && [[NSImage imageTypes] containsObject:returnType]) return gResponder;
		return requestor;
	});
	// Add on the class itself if it only inherits the method, so
	// NSResponder's implementation stays untouched for every other view.
	if (!class_addMethod(cls, sel, hooked, method_getTypeEncoding(method))) method_setImplementation(method, hooked);
	return true;
}

// init(onImage: (jpeg: Buffer) => void): boolean
static napi_value Init(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1], result;
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	bool ok = gResponder != nil;
	if (!ok && argc == 1) {
		napi_value name;
		napi_create_string_utf8(env, "continuity-camera", NAPI_AUTO_LENGTH, &name);
		if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallOnImage, &gOnImage) == napi_ok) {
			napi_unref_threadsafe_function(env, gOnImage);
			gResponder = [[LHContinuityResponder alloc] init];
			ok = HookChromiumView();
		}
	}
	napi_get_boolean(env, ok, &result);
	return result;
}

// popup(windowHandle: Buffer, x: number, y: number, labels: {file, hint}): "file" | null
// x/y: content-view coordinates from the top-left, in points (CSS px × zoom).
static napi_value Popup(napi_env env, napi_callback_info info) {
	size_t argc = 4;
	napi_value argv[4], result;
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	napi_get_null(env, &result);
	NSView* handleView = argc == 4 ? ViewFromHandle(env, argv[0]) : nil;
	NSWindow* window = handleView.window;
	NSView* content = window.contentView;
	if (!content) return result;
	double x = 0, y = 0;
	napi_get_value_double(env, argv[1], &x);
	napi_get_value_double(env, argv[2], &y);
	auto label = [&](const char* key) -> NSString* {
		napi_value value;
		char buffer[256] = {0};
		size_t length = 0;
		if (napi_get_named_property(env, argv[3], key, &value) != napi_ok) return @"";
		napi_get_value_string_utf8(env, value, buffer, sizeof buffer, &length);
		return [NSString stringWithUTF8String:buffer] ?: @"";
	};

	LHMenuController* controller = [[LHMenuController alloc] init];
	NSMenu* menu = [[NSMenu alloc] initWithTitle:@""];
	menu.delegate = controller;
	NSMenuItem* fileItem = [[NSMenuItem alloc] initWithTitle:label("file") action:@selector(chooseFile:) keyEquivalent:@""];
	fileItem.target = controller;
	fileItem.tag = kFileTag;
	[menu addItem:fileItem];
	controller.hintItem = [[NSMenuItem alloc] initWithTitle:label("hint") action:nil keyEquivalent:@""];
	controller.hintItem.enabled = NO;
	controller.hintItem.tag = kHintTag;
	menu.autoenablesItems = NO;

	// AppKit asks the view the context menu is shown for: Chromium's view,
	// i.e. the window's first responder while the page has focus.
	NSView* target = [window.firstResponder isKindOfClass:[NSView class]] ? (NSView*)window.firstResponder : content;
	NSPoint inContent = NSMakePoint(x, content.isFlipped ? y : content.bounds.size.height - y);
	NSEvent* event = [NSEvent mouseEventWithType:NSEventTypeRightMouseDown
	                                    location:[content convertPoint:inContent toView:nil]
	                               modifierFlags:0
	                                   timestamp:NSProcessInfo.processInfo.systemUptime
	                                windowNumber:window.windowNumber
	                                     context:nil
	                                 eventNumber:0
	                                  clickCount:1
	                                    pressure:1];
	[NSMenu popUpContextMenu:menu withEvent:event forView:target];

	if (controller.choseFile) napi_create_string_utf8(env, "file", NAPI_AUTO_LENGTH, &result);
	return result;
}

static napi_value Register(napi_env env, napi_value exports) {
	napi_property_descriptor props[] = {
		{"init", nullptr, Init, nullptr, nullptr, nullptr, napi_default, nullptr},
		{"popup", nullptr, Popup, nullptr, nullptr, nullptr, napi_default, nullptr},
	};
	napi_define_properties(env, exports, 2, props);
	return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Register)
