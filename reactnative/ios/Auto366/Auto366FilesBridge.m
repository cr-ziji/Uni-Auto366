//
// Auto366FilesBridge.m
//
// Objective-C bridge for the Swift `Auto366Files` module. React Native's legacy
// module registry discovers Objective-C classes, so a Swift module has to be
// declared with `RCT_EXTERN_MODULE` and every exported method has to be listed
// with `RCT_EXTERN_METHOD`.
//
// Keep the selectors in sync with the `@objc(...)` annotations in
// `Auto366Files.swift`.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(Auto366Files, NSObject)

RCT_EXTERN_METHOD(pickFiles:(nullable NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pickSaveTarget:(NSString *)fileName
                  mimeType:(nullable NSString *)mimeType
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(writeToUri:(NSString *)uri
                  base64:(NSString *)base64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(saveToDownloads:(NSString *)path
                  fileName:(NSString *)fileName
                  mimeType:(nullable NSString *)mimeType
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(openFile:(NSString *)path
                  mimeType:(nullable NSString *)mimeType
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(shareFile:(NSString *)path
                  mimeType:(nullable NSString *)mimeType
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// 同步读：`fs` polyfill 的 `readFileSync` 靠它在 JS 线程上按需取字节。
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(readFileBase64Sync:(NSString *)path)

@end
