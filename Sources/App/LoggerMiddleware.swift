//
//  LoggerMiddleware.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Vapor

/// Logs all requests that pass through it.
final class LoggerMiddleware: Middleware, ServiceType {
    static func makeService(for worker: Container) throws -> Self {
        return try .init(log: worker.make(Logger.self))
    }
    
    
    let log: Logger
    
    /// Creates a new `LogMiddleware`.
    init(log: Logger) { self.log = log }
    
    /// See `Middleware.respond(to:)`
    func respond(to request: Request, chainingTo next: Responder) throws -> Future<Response> {
        log.verbose("[\(Date())] \(request.http.method) \(request.http.url.path)")
        return try next.respond(to: request)
    }
    
}
