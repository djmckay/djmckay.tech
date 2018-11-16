//
//  Social.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Social: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Social
    
    
    var id: UUID?
    var url: String
    var handle: String
    var icon: String
    
    init(url: String, handle: String, icon: String) {
        self.url = url
        self.handle = handle
        self.icon = icon
    }
    
    func convertToPublic() -> Social {
        return self
    }
    
}

extension Social: Content {}
extension Social: Migration {
    static func prepare(on connection: MySQLConnection) -> Future<Void> {
        return Database.create(self, on: connection) { builder in
            try addProperties(to: builder)
        }
    }
    
}
extension Social: Parameter {}

