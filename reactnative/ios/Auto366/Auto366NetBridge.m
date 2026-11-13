//
// Auto366NetBridge.m
//
// Objective-C bridge for the Swift `Auto366Net` module. React Native's legacy
// module registry discovers Objective-C classes, so a Swift module has to be
// declared with `RCT_EXTERN_MODULE` and every exported method has to be listed
// with `RCT_EXTERN_METHOD`.
//
// Keep the selectors in sync with the `@objc(...)` annotations in
// `Auto366Net.swift`.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(Auto366Net, RCTEventEmitter)

RCT_EXTERN_METHOD(listen:(NSString *)serverId
                  host:(NSString *)host
                  port:(nonnull NSNumber *)port
                  tlsResource:(nullable NSString *)tlsResource
                  tlsPassword:(nullable NSString *)tlsPassword
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(closeServer:(NSString *)serverId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(connect:(NSString *)socketId
                  host:(NSString *)host
                  port:(nonnull NSNumber *)port
                  tls:(BOOL)tls
                  servername:(nullable NSString *)servername
                  timeoutMs:(nonnull NSNumber *)timeoutMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(resume:(NSString *)socketId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(suspend:(NSString *)socketId)

RCT_EXTERN_METHOD(write:(NSString *)socketId
                  data:(NSString *)base64)

RCT_EXTERN_METHOD(write:(NSString *)socketId
                  data:(NSString *)base64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(shutdown:(NSString *)socketId)

RCT_EXTERN_METHOD(close:(NSString *)socketId)

RCT_EXTERN_METHOD(setTimeout:(NSString *)socketId
                  milliseconds:(nonnull NSNumber *)milliseconds)

RCT_EXTERN_METHOD(setNoDelay:(NSString *)socketId
                  value:(BOOL)value)

RCT_EXTERN_METHOD(tunnel:(NSString *)socketId
                  host:(NSString *)host
                  port:(nonnull NSNumber *)port
                  restBase64:(nullable NSString *)restBase64
                  useTls:(BOOL)useTls
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
