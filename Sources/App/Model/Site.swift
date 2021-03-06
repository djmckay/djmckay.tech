//
//  Site.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL
import Authentication

final class Site: BaseUserTrackable {
    var createdAt: Date?
    
    var updatedAt: Date?
    
    typealias Public = Site
    
    
    var id: UUID?
    var brand: String
    var title: String
    var header: String
    var about: String
    var avatar: String?
    var avatarByLine: String?
    
    init(brand: String, title: String, header: String, about: String, avatar: String, avatarByLine: String) {
        self.brand = brand
        self.title = title
        self.header = header
        self.about = about
        self.avatar = avatar
        self.avatarByLine = avatarByLine
    }
    func convertToPublic() -> Site {
        return self
    }
    
}

extension Site: Content {}
extension Site: Migration {
    static func prepare(on connection: MySQLConnection) -> Future<Void> {
        return Database.create(self, on: connection) { builder in
            builder.field(for: \.id)
            builder.field(for: \.brand)
            builder.field(for: \.title)
            builder.field(for: \.header)
            builder.field(for: \.about, type: .longtext)
            builder.field(for: \.createdAt)
            builder.field(for: \.updatedAt)
            builder.field(for: \.avatar)
            builder.field(for: \.avatarByLine)
        }
    }
    
}
extension Site: Parameter {}
