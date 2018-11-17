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
    var downloadURL: String?
    
    init(summary: String, name: String, action: String, phone: String, email: String, address: String, downloadURL: String? = nil) {
        self.summary = summary
        self.name = name
        self.action = action
        self.phone = phone
        self.email = email
        self.address = address
        self.downloadURL = downloadURL
    }
    
    func convertToPublic() -> Profile {
        return self
    }
    
}

extension Profile: Content {}
extension Profile: Migration {
    static func prepare(on connection: MySQLConnection) -> Future<Void> {
        return Database.create(self, on: connection) { builder in
            builder.field(for: \.id)
            builder.field(for: \.name)
            builder.field(for: \.action)
            builder.field(for: \.phone)
            builder.field(for: \.email)
            builder.field(for: \.address)
            builder.field(for: \.summary, type: .longtext)
        }
    }
    
}
extension Profile: Parameter {}
