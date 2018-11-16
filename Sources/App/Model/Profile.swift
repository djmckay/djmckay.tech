//
//  Profile.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Profile: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Profile
    
    
    var id: UUID?
    var name: String
    var summary: String
    var action: String
    var phone: String
    var email: String
    var address: String
    
    init(summary: String, name: String, action: String, phone: String, email: String, address: String) {
        self.summary = summary
        self.name = name
        self.action = action
        self.phone = phone
        self.email = email
        self.address = address
    }
    
    func convertToPublic() -> Profile {
        return self
    }
    
}

extension Profile: Content {}
extension Profile: Migration {
    static func prepare(on connection: MySQLConnection) -> Future<Void> {
        return Database.create(self, on: connection) { builder in
            try addProperties(to: builder)
        }
    }
    
}
extension Profile: Parameter {}
