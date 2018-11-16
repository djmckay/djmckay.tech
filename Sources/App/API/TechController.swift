//
//  TechController.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import JWT
import Fluent

struct TechApi {
    static var path:String = "api"
    
}
protocol TechController: RouteCollection {
    associatedtype T
    associatedtype Public
    static var path: String { get }
    func createHandler(_ req: Request, entity: T) throws -> Future<Public>
    func getAllHandler(_ req: Request) throws -> Future<[Public]>
    func getHandler(_ req: Request) throws -> Future<Public>
    func updateHandler(_ req: Request) throws -> Future<Public>
    func deleteHandler(_ req: Request) throws -> Future<HTTPStatus>
}


struct AdminToken: JWTPayload {
    var key: String
    
    func verify(using signer: JWTSigner) throws {
        // nothing to verify
        print("nothing to verify")
    }
}

class AdminJWTMiddleWareProvider: Middleware {
    func respond(to request: Request, chainingTo next: Responder) throws -> EventLoopFuture<Response> {
        guard let bearer = request.http.headers.bearerAuthorization else {
            throw Abort(.unauthorized)
        }
        // parse JWT from token string, using HS-256 signer
        let adminToken = Bundle.main.infoDictionary?["ADMIN_AUTHORIZE_KEY"] as? String ?? Environment.get("ADMIN_AUTHORIZE_KEY") ?? "secret"
        _ = try JWT<AdminToken>(from: bearer.token, verifiedUsing: .hs256(key: adminToken))
        
        return try next.respond(to: request)
        
    }
}
