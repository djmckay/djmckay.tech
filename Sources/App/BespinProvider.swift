//
//  BespinProvider.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Vapor

public struct BespinConfig: Service {
    let id: String
    public init(id: String) {
        self.id = id
    }
}

public final class BespinProvider: Provider {
    public static let repositoryName = "bespin-provider"
    
    public init(){}
    
    public func boot(_ config: Config) throws {}
    
    public func didBoot(_ worker: Container) throws -> EventLoopFuture<Void> {
        return .done(on: worker)
    }
    
    public func register(_ services: inout Services) throws {
        services.register { (container) -> BespinClient in
            let httpClient = try container.make(Client.self)
            let logger = try container.make(Logger.self)
            //            let config = try container.make(MailgunConfig.self)
            //            return MailgunClient(client: httpClient, apiKey: config.apiKey, domain: config.domain)
            return BespinClient(client: httpClient, logger: logger)
        }
    }
}
