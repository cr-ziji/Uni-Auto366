//
// Auto366-Bridging-Header.h
//
// React Native exposes its Objective-C API to the Swift files of the app
// through this header. `Auto366Net.swift` subclasses `RCTEventEmitter` and
// uses the promise blocks declared in `RCTBridgeModule.h`; `Auto366Files.swift`
// additionally needs `RCTPresentedViewController()` to present the system
// document picker / share sheet from the top-most view controller.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>
